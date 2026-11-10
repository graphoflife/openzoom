/**
 * BCF (BIM Collaboration Format) import / export.
 *
 * Writes BCF-XML 2.1 (default) or 3.0, reads 2.0 / 2.1 / 3.0.
 * Pure module: zip via fflate, XML via ./xml.js (written as element trees,
 * read with an injectable DOMParser, browser default).
 */
import { zipSync, unzipSync, strFromU8 } from 'fflate';
import { E, xmlDoc, parseXml, lname, elems, children, child, textOf, text, descendants, attr } from './xml.js';
import { uuid } from './util.js';

/**
 * @typedef {object} BcfCamera
 * @property {'perspective'|'orthographic'} type
 * @property {number[]} position   [x,y,z] IFC world coordinates (Z-up, metres)
 * @property {number[]} direction  [x,y,z]
 * @property {number[]} up         [x,y,z]
 * @property {number} [fov]              perspective FieldOfView (degrees)
 * @property {number} [viewToWorldScale] orthographic ViewToWorldScale
 * @property {number} [aspectRatio]      written for BCF 3.0 only
 */

/**
 * @typedef {object} BcfViewpoint
 * @property {string} guid
 * @property {string|null} snapshot  data URL (png/jpeg) or null
 * @property {BcfCamera|null} camera
 * @property {{selection:string[], visibilityDefault:boolean, exceptions:string[],
 *   coloring:{color:string, guids:string[]}[],
 *   viewSetupHints:{spacesVisible:boolean, spaceBoundariesVisible:boolean, openingsVisible:boolean}}} components
 * @property {{location:number[], direction:number[]}[]} clippingPlanes
 * @property {{start:number[], end:number[]}[]} lines
 */

/**
 * @typedef {object} BcfComment
 * @property {string} guid
 * @property {string} date
 * @property {string} author
 * @property {string} comment
 * @property {string} modifiedDate
 * @property {string} modifiedAuthor
 * @property {string|null} viewpointGuid
 */

/**
 * @typedef {object} BcfIssue
 * @property {string} guid
 * @property {string} title
 * @property {string} description
 * @property {string} status
 * @property {string} type
 * @property {string} priority
 * @property {string} assignedTo
 * @property {string} stage
 * @property {string[]} labels
 * @property {string} dueDate
 * @property {string} creationDate
 * @property {string} creationAuthor
 * @property {string} modifiedDate
 * @property {string} modifiedAuthor
 * @property {number|null} index
 * @property {string[]} referencedModels
 * @property {BcfComment[]} comments
 * @property {BcfViewpoint[]} viewpoints
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const XSD_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const COLOR_RE = /^[0-9A-F]{6}([0-9A-F]{2})?$/;
const DEFAULT_CAMERA = { type: 'perspective', position: [0, 0, 0], direction: [0, 1, 0], up: [0, 0, 1], fov: 60 };

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Convert an RGB colour (channels 0–255) to a BCF colour string.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} [a] optional alpha 0–255; when given and < 255 the result is
 *   'AARRGGBB' (BCF puts alpha first), otherwise 'RRGGBB'
 * @returns {string} upper-case hex, e.g. 'FF8000'
 */
export function colorToBcf(r, g, b, a) {
  const hex = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))
    .toString(16).padStart(2, '0').toUpperCase();
  const rgb = hex(r) + hex(g) + hex(b);
  return a === undefined || a === null || Math.round(Number(a)) >= 255 ? rgb : hex(a) + rgb;
}

/**
 * Parse a BCF colour string ('RRGGBB' or 'AARRGGBB', optional leading '#').
 * @param {string} str
 * @returns {{r:number, g:number, b:number, a:number}|null} all channels 0–255
 *   (a = 255 when the string has no alpha); null if the string is invalid
 */
export function bcfToColor(str) {
  const s = String(str ?? '').trim().replace(/^#/, '');
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return null;
  const n = (i) => parseInt(s.slice(i, i + 2), 16);
  return s.length === 8
    ? { r: n(2), g: n(4), b: n(6), a: n(0) }
    : { r: n(0), g: n(2), b: n(4), a: 255 };
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const str = (v) => (blank(v) ? '' : String(v).trim());
const uniq = (list) => [...new Set((Array.isArray(list) ? list : []).map(str).filter(Boolean))];
const normColor = (v) => {
  const s = str(v).replace(/^#/, '').toUpperCase();
  return COLOR_RE.test(s) ? s : '';
};

function sniffImage(bytes) {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writing (element trees, see xml.js)
// ---------------------------------------------------------------------------

// Optional text element: omitted when blank.
const opt = (name, v) => (blank(v) ? null : E(name, null, String(v)));

// Number with at most 6 decimals, no '-0'.
function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}

// xs:dateTime; valid strings pass through, other parseable values become ISO.
function fmtDate(v) {
  if (blank(v)) return '';
  const s = String(v).trim();
  if (XSD_DATETIME.test(s)) return s;
  const d = new Date(v instanceof Date || typeof v === 'number' ? v : s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

const vec = (p) => (Array.isArray(p) ? p : p && typeof p === 'object' ? [p.x, p.y, p.z] : []);
function point(name, p) {
  const [x, y, z] = vec(p);
  return E(name, null, E('X', null, num(x)), E('Y', null, num(y)), E('Z', null, num(z)));
}

// Lower-case UUID, regenerated when missing, malformed or already used.
function uniqueGuid(g, used) {
  let s = str(g).toLowerCase();
  if (!UUID_RE.test(s) || used.has(s)) s = uuid();
  used.add(s);
  return s;
}

function decodeSnapshot(snap) {
  let bytes = null;
  let mime = '';
  if (snap instanceof Uint8Array) {
    bytes = snap;
  } else if (typeof snap === 'string') {
    const m = /^data:([^,]*),/i.exec(snap);
    if (!m || !/;base64/i.test(m[1])) return null;
    try {
      const bin = atob(snap.slice(m[0].length).replace(/\s+/g, ''));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      return null;
    }
    mime = m[1].toLowerCase();
  }
  if (!bytes || !bytes.length) return null;
  const ext = sniffImage(bytes)?.ext || (/jpe?g/.test(mime) ? 'jpg' : 'png');
  return { bytes, ext };
}

// Normalised topic fields (shared by markup and extensions.xml).
function topicFields(issue, now) {
  return {
    type: str(issue.type) || 'Issue',
    status: str(issue.status) || 'Open',
    title: str(issue.title) || 'Untitled',
    priority: str(issue.priority),
    labels: uniq(issue.labels),
    creationDate: fmtDate(issue.creationDate) || now,
    creationAuthor: str(issue.creationAuthor) || 'unknown',
    modifiedDate: fmtDate(issue.modifiedDate),
    modifiedAuthor: str(issue.modifiedAuthor),
    dueDate: fmtDate(issue.dueDate),
    assignedTo: str(issue.assignedTo),
    stage: str(issue.stage),
    description: blank(issue.description) ? '' : String(issue.description),
  };
}

function visinfoEl(vp, guid, v3) {
  const c = vp.components || {};
  const h = c.viewSetupHints || {};
  const hints = E('ViewSetupHints', {
    SpacesVisible: !!h.spacesVisible,
    SpaceBoundariesVisible: !!h.spaceBoundariesVisible,
    OpeningsVisible: !!h.openingsVisible,
  });
  const comps = (ids) => uniq(ids).map((id) => E('Component', { IfcGuid: id }));
  const selection = comps(c.selection);
  const exceptions = comps(c.exceptions);
  const coloring = (Array.isArray(c.coloring) ? c.coloring : [])
    .map((col) => {
      const color = normColor(col?.color);
      const ids = comps(col?.guids);
      if (!color || !ids.length) return null;
      return E('Color', { Color: color }, v3 ? E('Components', null, ids) : ids);
    })
    .filter(Boolean);

  // 2.1: ViewSetupHints first in Components; 3.0: inside Visibility
  const components = E('Components', null,
    v3 ? null : hints,
    selection.length ? E('Selection', null, selection) : null,
    E('Visibility', { DefaultVisibility: c.visibilityDefault !== false },
      v3 ? hints : null,
      exceptions.length ? E('Exceptions', null, exceptions) : null),
    coloring.length ? E('Coloring', null, coloring) : null);

  const lines = (Array.isArray(vp.lines) ? vp.lines : [])
    .map((l) => E('Line', null, point('StartPoint', l?.start), point('EndPoint', l?.end)));
  const planes = (Array.isArray(vp.clippingPlanes) ? vp.clippingPlanes : [])
    .map((p) => E('ClippingPlane', null, point('Location', p?.location), point('Direction', p?.direction)));

  return E('VisualizationInfo', { Guid: guid },
    components,
    cameraEl(vp.camera, v3),
    lines.length ? E('Lines', null, lines) : null,
    planes.length ? E('ClippingPlanes', null, planes) : null);
}

function cameraEl(cam, v3) {
  if (!cam) {
    if (!v3) return null; // camera is mandatory in 3.0
    cam = DEFAULT_CAMERA;
  }
  const ortho = cam.type === 'orthographic' || cam.type === 'ortho';
  const base = [
    point('CameraViewPoint', cam.position),
    point('CameraDirection', cam.direction),
    point('CameraUpVector', cam.up || [0, 0, 1]),
  ];
  const ar = Number(cam.aspectRatio) > 0 ? Number(cam.aspectRatio) : 1;
  const aspect = v3 ? E('AspectRatio', null, num(ar)) : null;
  if (ortho) {
    const scale = Number(cam.viewToWorldScale);
    return E('OrthogonalCamera', null, base,
      E('ViewToWorldScale', null, num(Number.isFinite(scale) && scale > 0 ? scale : 1)), aspect);
  }
  const fov = Number(cam.fov);
  return E('PerspectiveCamera', null, base,
    E('FieldOfView', null, num(fov > 0 && fov < 180 ? fov : 60)), aspect);
}

function markupEl(issue, tGuid, vps, vpMap, used, v3, now) {
  const f = topicFields(issue, now);
  const idx = issue.index === null || issue.index === undefined || issue.index === '' ? NaN : Number(issue.index);

  const files = uniq(issue.referencedModels)
    .map((name) => E('File', { [v3 ? 'IsExternal' : 'isExternal']: true }, E('Filename', null, name)));
  const header = files.length ? E('Header', null, v3 ? E('Files', null, files) : files) : null;

  const comments = (Array.isArray(issue.comments) ? issue.comments : []).map((c) => {
    const vpGuid = blank(c.viewpointGuid) ? null : vpMap.get(str(c.viewpointGuid).toLowerCase()) || null;
    return E('Comment', { Guid: uniqueGuid(c.guid, used) },
      E('Date', null, fmtDate(c.date) || now),
      E('Author', null, str(c.author) || 'unknown'),
      // 2.1: required (may be empty); 3.0: optional, non-empty
      v3 ? opt('Comment', c.comment) : E('Comment', null, String(c.comment ?? '')),
      vpGuid ? E('Viewpoint', { Guid: vpGuid }) : null,
      opt('ModifiedDate', fmtDate(c.modifiedDate)),
      opt('ModifiedAuthor', c.modifiedAuthor));
  });

  const vpEntry = (name) => (v) => E(name, { Guid: v.guid },
    E('Viewpoint', null, v.file),
    v.snapshot ? E('Snapshot', null, v.snapshot) : null,
    E('Index', null, String(v.index)));

  const topicKids = [
    E('Title', null, f.title),
    opt('Priority', f.priority),
    Number.isFinite(idx) ? E('Index', null, String(Math.trunc(idx))) : null,
    v3
      ? (f.labels.length ? E('Labels', null, f.labels.map((l) => E('Label', null, l))) : null)
      : f.labels.map((l) => E('Labels', null, l)),
    E('CreationDate', null, f.creationDate),
    E('CreationAuthor', null, f.creationAuthor),
    opt('ModifiedDate', f.modifiedDate),
    opt('ModifiedAuthor', f.modifiedAuthor),
    opt('DueDate', f.dueDate),
    opt('AssignedTo', f.assignedTo),
    opt('Stage', f.stage),
    opt('Description', f.description),
  ];
  const topicAttrs = { Guid: tGuid, TopicType: f.type, TopicStatus: f.status };

  if (v3) {
    return E('Markup', null, header,
      E('Topic', topicAttrs, topicKids,
        comments.length ? E('Comments', null, comments) : null,
        vps.length ? E('Viewpoints', null, vps.map(vpEntry('ViewPoint'))) : null));
  }
  return E('Markup', null, header, E('Topic', topicAttrs, topicKids), comments, vps.map(vpEntry('Viewpoints')));
}

function extensionsEl(issues, now) {
  const types = new Set();
  const statuses = new Set();
  const priorities = new Set();
  const labels = new Set();
  const users = new Set();
  const stages = new Set();
  const addUser = (u) => { if (!blank(u)) users.add(str(u)); };
  for (const issue of issues) {
    const f = topicFields(issue, now);
    types.add(f.type);
    statuses.add(f.status);
    if (f.priority) priorities.add(f.priority);
    f.labels.forEach((l) => labels.add(l));
    if (f.stage) stages.add(f.stage);
    [f.creationAuthor, f.modifiedAuthor, f.assignedTo].forEach(addUser);
    for (const c of Array.isArray(issue.comments) ? issue.comments : []) {
      addUser(str(c.author) || 'unknown');
      addUser(c.modifiedAuthor);
    }
  }
  const group = (name, item, set) => (set.size ? E(name, null, [...set].map((v) => E(item, null, v))) : null);
  return E('Extensions', null,
    group('TopicTypes', 'TopicType', types),
    group('TopicStatuses', 'TopicStatus', statuses),
    group('Priorities', 'Priority', priorities),
    group('TopicLabels', 'TopicLabel', labels),
    group('Users', 'User', users),
    group('Stages', 'Stage', stages));
}

/**
 * Export issues as a BCF zip (.bcf / .bcfzip).
 *
 * Layout: `bcf.version`, `project.bcfp` (+ `extensions.xml` for 3.0) and one
 * folder per topic GUID with `markup.bcf`, `viewpoint*.bcfv` and snapshots.
 * In 2.1 the first viewpoint is `viewpoint.bcfv` / `snapshot.png|jpg`, further
 * ones `viewpoint_<guid>.bcfv` / `snapshot_<guid>.png|jpg`; 3.0 names all by GUID.
 * GUIDs are written lower case; missing, malformed or duplicate GUIDs are replaced.
 *
 * @param {BcfIssue[]} issues
 * @param {object} [options]
 * @param {'2.1'|'3.0'} [options.version='2.1']
 * @param {string} [options.projectName='Projekt']
 * @param {string} [options.projectId] defaults to a new GUID
 * @returns {Uint8Array} zip bytes
 */
export function exportBCF(issues, { version = '2.1', projectName = 'Projekt', projectId } = {}) {
  const v3 = String(version).trim().startsWith('3');
  const list = Array.isArray(issues) ? issues.filter(Boolean) : [];
  const now = new Date().toISOString();
  const used = new Set();
  const files = {};

  files['bcf.version'] = xmlDoc(v3
    ? E('Version', { VersionId: '3.0' })
    : E('Version', { VersionId: '2.1' }, E('DetailedVersion', null, '2.1')));
  const project = E('Project', { ProjectId: str(projectId) || uuid() }, opt('Name', projectName));
  files['project.bcfp'] = xmlDoc(v3
    ? E('ProjectInfo', null, project)
    : E('ProjectExtension', null, project, E('ExtensionSchema')));
  if (v3) files['extensions.xml'] = xmlDoc(extensionsEl(list, now));

  for (const issue of list) {
    const tGuid = uniqueGuid(issue.guid, used);
    const vpMap = new Map(); // original guid (lower) -> written guid
    const vps = (Array.isArray(issue.viewpoints) ? issue.viewpoints : []).filter(Boolean).map((vp, i) => {
      const guid = uniqueGuid(vp.guid, used);
      if (!blank(vp.guid) && !vpMap.has(str(vp.guid).toLowerCase())) vpMap.set(str(vp.guid).toLowerCase(), guid);
      const first = !v3 && i === 0;
      const file = first ? 'viewpoint.bcfv' : `viewpoint_${guid}.bcfv`;
      files[`${tGuid}/${file}`] = xmlDoc(visinfoEl(vp, guid, v3));
      const img = decodeSnapshot(vp.snapshot);
      let snapshot = null;
      if (img) {
        snapshot = `${first ? 'snapshot' : `snapshot_${guid}`}.${img.ext}`;
        files[`${tGuid}/${snapshot}`] = [img.bytes, { level: 0 }]; // already compressed
      }
      return { guid, file, snapshot, index: i };
    });
    files[`${tGuid}/markup.bcf`] = xmlDoc(markupEl(issue, tGuid, vps, vpMap, used, v3, now));
  }

  return zipSync(files, { level: 6 });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function bool(v, def) {
  if (blank(v)) return def;
  return /^(true|1)$/i.test(String(v).trim());
}

function numOr(v, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function pt(el, def) {
  return el ? ['X', 'Y', 'Z'].map((k) => numOr(text(el, k), 0)) : def.slice();
}

function decodeText(b) {
  if (b.length > 1 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) && typeof TextDecoder === 'function') {
    return new TextDecoder(b[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(b);
  }
  const head = strFromU8(b.subarray(0, 120), true);
  if (/encoding\s*=\s*["'](iso-8859-1|latin-?1|windows-1252)["']/i.test(head)) return strFromU8(b, true);
  return strFromU8(b).replace(/^﻿/, '');
}

function toDataUrl(bytes, name) {
  const mime = sniffImage(bytes)?.mime || (/\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const join = (dir, p) => (dir ? `${dir}/${p}` : p);

function defaultComponents() {
  return {
    selection: [],
    visibilityDefault: true,
    exceptions: [],
    coloring: [],
    viewSetupHints: { spacesVisible: false, spaceBoundariesVisible: false, openingsVisible: false },
  };
}

function readVisInfo(vi) {
  const out = { camera: null, components: defaultComponents(), clippingPlanes: [], lines: [] };
  if (!vi) return out;
  const c = out.components;
  const comps = child(vi, 'Components');
  if (comps) {
    const ids = (el) => uniq(descendants(el, 'Component').map((x) => attr(x, 'IfcGuid')));
    const vis = child(comps, 'Visibility');
    const hints = child(comps, 'ViewSetupHints') || child(vis, 'ViewSetupHints');
    c.selection = ids(child(comps, 'Selection'));
    if (vis) {
      c.visibilityDefault = bool(attr(vis, 'DefaultVisibility'), false);
      c.exceptions = ids(child(vis, 'Exceptions'));
    }
    if (hints) {
      c.viewSetupHints = {
        spacesVisible: bool(attr(hints, 'SpacesVisible'), false),
        spaceBoundariesVisible: bool(attr(hints, 'SpaceBoundariesVisible'), false),
        openingsVisible: bool(attr(hints, 'OpeningsVisible'), false),
      };
    }
    const byColor = new Map();
    const addColor = (color, guids) => {
      if (!color || !guids.length) return;
      if (!byColor.has(color)) byColor.set(color, []);
      byColor.get(color).push(...guids);
    };
    for (const col of children(child(comps, 'Coloring'), 'Color')) addColor(normColor(attr(col, 'Color')), ids(col));
    // BCF 2.0: flat <Component IfcGuid Selected Visible Color/> list
    for (const comp of children(comps, 'Component')) {
      const id = attr(comp, 'IfcGuid');
      if (!id) continue;
      if (bool(attr(comp, 'Selected'), false)) c.selection.push(id);
      if (!bool(attr(comp, 'Visible'), true)) c.exceptions.push(id);
      addColor(normColor(attr(comp, 'Color')), [id]);
    }
    c.selection = uniq(c.selection);
    c.exceptions = uniq(c.exceptions);
    c.coloring = [...byColor].map(([color, guids]) => ({ color, guids: uniq(guids) }));
  }

  const pc = child(vi, 'PerspectiveCamera');
  const oc = child(vi, 'OrthogonalCamera');
  const camEl = pc || oc;
  if (camEl) {
    const cam = {
      type: pc ? 'perspective' : 'orthographic',
      position: pt(child(camEl, 'CameraViewPoint'), [0, 0, 0]),
      direction: pt(child(camEl, 'CameraDirection'), [0, 1, 0]),
      up: pt(child(camEl, 'CameraUpVector'), [0, 0, 1]),
    };
    if (pc) cam.fov = numOr(text(pc, 'FieldOfView'), 60);
    else cam.viewToWorldScale = numOr(text(oc, 'ViewToWorldScale'), 1);
    const ar = parseFloat(text(camEl, 'AspectRatio'));
    if (ar > 0) cam.aspectRatio = ar;
    out.camera = cam;
  }

  out.lines = children(child(vi, 'Lines'), 'Line').map((l) => ({
    start: pt(child(l, 'StartPoint'), [0, 0, 0]),
    end: pt(child(l, 'EndPoint'), [0, 0, 0]),
  }));
  out.clippingPlanes = children(child(vi, 'ClippingPlanes'), 'ClippingPlane').map((p) => ({
    location: pt(child(p, 'Location'), [0, 0, 0]),
    direction: pt(child(p, 'Direction'), [0, 0, 1]),
  }));
  return out;
}

/**
 * Import a BCF zip (BCF-XML 2.0, 2.1 or 3.0).
 *
 * Tolerant: namespaces/prefixes are ignored, missing fields get defaults,
 * zips with an extra top-level folder work, viewpoints may be referenced by
 * file name only, and unlisted `*.bcfv` files in a topic folder are picked up.
 *
 * @param {ArrayBuffer|Uint8Array} data zip bytes
 * @param {object} [options]
 * @param {typeof DOMParser} [options.DOMParser=globalThis.DOMParser] DOMParser
 *   implementation (inject e.g. @xmldom/xmldom outside the browser)
 * @returns {{version:string, projectName:string, projectId:string, issues:BcfIssue[], warnings:string[]}}
 */
export function importBCF(data, { DOMParser: DP = globalThis.DOMParser } = {}) {
  if (typeof DP !== 'function') throw new Error('importBCF: no DOMParser available (pass { DOMParser })');
  let bytes;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]') bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else throw new TypeError('importBCF: expected ArrayBuffer or Uint8Array');

  let raw;
  try {
    raw = unzipSync(bytes, { filter: (f) => /\.(bcf|bcfv|bcfp|version|xml|png|jpe?g)$/i.test(f.name) });
  } catch (err) {
    throw new Error(`importBCF: not a valid BCF zip (${err && err.message})`);
  }

  // lower-case path -> { path, bytes }
  const entries = new Map();
  for (const [p, d] of Object.entries(raw)) {
    const path = p.replace(/\\/g, '/').replace(/^(\.?\/)+/, '');
    if (!path || path.endsWith('/') || path.startsWith('__MACOSX/')) continue;
    entries.set(path.toLowerCase(), { path, bytes: d });
  }

  const warnings = [];
  const parse = (key) => {
    const f = key && entries.get(key);
    if (!f) return null;
    try {
      const root = parseXml(decodeText(f.bytes), DP);
      if (!root) warnings.push(`Invalid XML: ${f.path}`);
      return root;
    } catch (err) {
      warnings.push(`Invalid XML: ${f.path} (${err && err.message})`);
      return null;
    }
  };
  const keys = [...entries.keys()];
  const shallowest = (name) => keys
    .filter((k) => basename(k) === name)
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];

  const verRoot = parse(shallowest('bcf.version'));
  let version = verRoot ? attr(verRoot, 'VersionId') || text(verRoot, 'DetailedVersion') : '';
  const projRoot = parse(shallowest('project.bcfp'));
  const projEl = projRoot && (lname(projRoot) === 'Project' ? projRoot : descendants(projRoot, 'Project')[0]);
  const projectName = projEl ? text(projEl, 'Name') : '';
  const projectId = projEl ? attr(projEl, 'ProjectId') : '';

  let looksV3 = false;
  const issues = [];
  for (const key of keys.filter((k) => basename(k) === 'markup.bcf')) {
    const root = parse(key);
    const topic = root && child(root, 'Topic');
    if (!topic) {
      if (root) warnings.push(`No Topic in ${entries.get(key).path}`);
      continue;
    }
    if (child(topic, 'Comments') || child(topic, 'Viewpoints')) looksV3 = true;
    const dir = dirname(key);
    const folder = basename(dirname(entries.get(key).path));
    const resolve = (ref) => {
      if (blank(ref)) return null;
      const r = String(ref).trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').toLowerCase();
      return [join(dir, r), r, join(dir, basename(r))].find((k) => entries.has(k)) || null;
    };

    // Viewpoint entries: 2.x <Viewpoints Guid> siblings of Topic, 3.0 Topic/Viewpoints/ViewPoint
    const vpEls = [];
    for (const parent of [root, topic]) {
      for (const v of children(parent, 'Viewpoints')) {
        const inner = elems(v).filter((x) => lname(x).toLowerCase() === 'viewpoint' && (attr(x, 'Guid') || elems(x).length));
        if (inner.length) vpEls.push(...inner);
        else if (elems(v).length || attr(v, 'Guid')) vpEls.push(v);
      }
    }

    const usedFiles = new Set();
    const refMap = new Map(); // lower guid (markup or visinfo) -> viewpoint guid
    const viewpoints = [];
    const addViewpoint = (guidAttr, vpKey, snapKey, order) => {
      const vi = vpKey ? parse(vpKey) : null;
      const viGuid = vi ? attr(vi, 'Guid') : '';
      const guid = guidAttr || viGuid || uuid();
      if (vpKey) usedFiles.add(vpKey);
      if (snapKey) usedFiles.add(snapKey);
      for (const g of [guid, viGuid]) if (g && !refMap.has(g.toLowerCase())) refMap.set(g.toLowerCase(), guid);
      const snap = snapKey ? entries.get(snapKey) : null;
      viewpoints.push({
        order,
        vp: { guid, snapshot: snap ? toDataUrl(snap.bytes, snap.path) : null, ...readVisInfo(vi) },
      });
    };

    vpEls.forEach((el, i) => {
      const g = attr(el, 'Guid');
      const vpKey = resolve(text(el, 'Viewpoint'))
        || (g && (resolve(`${g}.bcfv`) || resolve(`viewpoint_${g}.bcfv`)))
        || (i === 0 ? resolve('viewpoint.bcfv') : null);
      const snapKey = resolve(text(el, 'Snapshot'))
        || (g && ['png', 'jpg', 'jpeg'].map((e) => resolve(`${g}.${e}`) || resolve(`snapshot_${g}.${e}`)).find(Boolean))
        || (i === 0 ? resolve('snapshot.png') || resolve('snapshot.jpg') : null);
      if (!vpKey && !snapKey) return;
      const idx = intOrNull(text(el, 'Index'));
      addViewpoint(g, vpKey, snapKey, idx === null ? Infinity : idx);
    });

    // Unlisted viewpoint files (BCF 1.0/2.0 exporters without a Viewpoints list)
    for (const k of keys) {
      if (dirname(k) !== dir || !k.endsWith('.bcfv') || usedFiles.has(k)) continue;
      const stem = basename(k).slice(0, -5);
      const snapNames = stem === 'viewpoint' ? ['snapshot.png', 'snapshot.jpg'] : [`${stem}.png`, `${stem}.jpg`];
      const snapKey = snapNames.map(resolve).find((s) => s && !usedFiles.has(s)) || null;
      addViewpoint('', k, snapKey, Infinity);
    }
    viewpoints.sort((a, b) => a.order - b.order); // stable

    const commentEls = [
      ...children(root, 'Comment'),
      ...children(topic, 'Comment'),
      ...children(child(topic, 'Comments'), 'Comment'),
    ];
    const comments = commentEls.map((c) => {
      const ref = attr(child(c, 'Viewpoint'), 'Guid');
      return {
        guid: attr(c, 'Guid') || uuid(),
        date: text(c, 'Date'),
        author: text(c, 'Author'),
        comment: text(c, 'Comment'),
        modifiedDate: text(c, 'ModifiedDate'),
        modifiedAuthor: text(c, 'ModifiedAuthor'),
        viewpointGuid: ref ? refMap.get(ref.toLowerCase()) || null : null,
      };
    });

    const labels = [];
    for (const l of [...children(topic, 'Labels'), ...children(topic, 'Label')]) {
      const inner = children(l, 'Label');
      if (inner.length) inner.forEach((x) => labels.push(textOf(x)));
      else labels.push(textOf(l));
    }

    const header = child(root, 'Header');
    const referencedModels = uniq(descendants(header, 'File').map((f) => text(f, 'Filename') || basename(text(f, 'Reference').replace(/\\/g, '/'))));

    issues.push({
      guid: attr(topic, 'Guid') || (UUID_RE.test(folder) ? folder : uuid()),
      title: text(topic, 'Title'),
      description: text(topic, 'Description'),
      status: attr(topic, 'TopicStatus') || text(topic, 'TopicStatus') || 'Open',
      type: attr(topic, 'TopicType') || text(topic, 'TopicType') || 'Issue',
      priority: text(topic, 'Priority'),
      assignedTo: text(topic, 'AssignedTo'),
      stage: text(topic, 'Stage'),
      labels: uniq(labels),
      dueDate: text(topic, 'DueDate'),
      creationDate: text(topic, 'CreationDate'),
      creationAuthor: text(topic, 'CreationAuthor'),
      modifiedDate: text(topic, 'ModifiedDate'),
      modifiedAuthor: text(topic, 'ModifiedAuthor'),
      index: intOrNull(text(topic, 'Index')),
      referencedModels,
      comments,
      viewpoints: viewpoints.map((v) => v.vp),
    });
  }

  if (!version) version = looksV3 ? '3.0' : '2.1';
  return { version, projectName, projectId, issues, warnings };
}
