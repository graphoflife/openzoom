import * as THREE from 'three';
import { exportBCF, importBCF, colorToBcf, bcfToColor } from './bcf.js';
import { uuid } from './util.js';
import { isGated } from './ifc-classes.js';
import { packRgb, unpackRgb } from './models.js';
import { blankView } from './state.js';

// BCF view setup hints for the gated categories
const HINTS = { spaces: 'spacesVisible', openings: 'openingsVisible' };

// Tiny IndexedDB key/value store (issues contain snapshots, too big for localStorage).
const DB = 'openzoom';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function kvGet(key) {
  try {
    const db = await idb();
    return await new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); });
  } catch { return undefined; }
}
export async function kvSet(key, value) {
  try {
    const db = await idb();
    await new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); tx.oncomplete = res; tx.onerror = res; });
  } catch { /* private mode */ }
}

/** BCF issues: create from the current view, restore viewpoints, import/export. */
export class IssueManager extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.issues = [];
    this.selected = null;
    kvGet('issues').then((list) => { if (Array.isArray(list) && !this.issues.length) { this.issues = list; this.changed(false); } });
  }

  changed(persist = true) {
    if (persist) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => kvSet('issues', this.issues), 400);
    }
    this.dispatchEvent(new Event('change'));
  }

  author() { return this.app.settings.get('author') || 'OpenZoom'; }

  /** Project file part: the issue list. */
  serialize() { return this.issues; }

  load(list = []) {
    this.issues = list;
    this.changed();
  }

  /** The current camera as a BCF camera (IFC coordinates). */
  captureCamera() {
    const app = this.app;
    const M = app.models;
    const cam = app.viewer.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    return cam.isOrthographicCamera
      ? { type: 'orthographic', position: M.toIfc(cam.position), direction: M.dirToIfc(dir), up: M.dirToIfc(up), viewToWorldScale: (cam.top - cam.bottom) / cam.zoom, aspectRatio: app.viewer.aspect }
      : { type: 'perspective', position: M.toIfc(cam.position), direction: M.dirToIfc(dir), up: M.dirToIfc(up), fov: cam.fov, aspectRatio: app.viewer.aspect };
  }

  /** Capture camera, visibility, colours, selection and clipping as a BCF viewpoint. */
  captureViewpoint() {
    const app = this.app;
    const M = app.models;
    const camera = this.captureCamera();
    const visible = [], hidden = [];
    const colors = new Map();
    const hints = { spacesVisible: false, spaceBoundariesVisible: false, openingsVisible: false };
    for (const m of M.models) {
      for (let i = 0; i < m.count; i++) {
        if (!m.hasGeom[i]) continue;
        const el = m.elements[i];
        if (!el.guid) continue;
        const vis = m.visible && m.isVisible(i);
        (vis ? visible : hidden).push(el.guid);
        if (vis && isGated(el)) hints[HINTS[el.category]] = true;
        const color = m.colorOf(i);
        if (vis && color >= 0) {
          const key = colorToBcf(...unpackRgb(color));
          if (!colors.has(key)) colors.set(key, []);
          colors.get(key).push(el.guid);
        }
      }
    }
    const defaultVisible = visible.length >= hidden.length;
    const selection = [];
    for (const gid of app.state.selection) { const el = M.element(gid); if (el?.guid) selection.push(el.guid); }
    return {
      guid: uuid(),
      snapshot: this.snapshot(),
      camera,
      components: {
        selection,
        visibilityDefault: defaultVisible,
        exceptions: defaultVisible ? hidden : visible,
        coloring: [...colors].map(([color, guids]) => ({ color, guids })),
        viewSetupHints: hints,
      },
      clippingPlanes: app.sections.toBcf(),
      lines: app.measure.toBcfLines(),
    };
  }

  snapshot() {
    const src = this.app.viewer.canvas;
    this.app.viewer.render();
    const w = Math.min(1280, src.width);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = Math.round((src.height / src.width) * w);
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, c.width, c.height);
    this.app.annotations?.drawOnto(g, c.width, c.height);
    return c.toDataURL('image/png');
  }

  create(fields = {}) {
    const now = new Date().toISOString();
    const issue = {
      guid: uuid(), title: fields.title || `Issue ${this.issues.length + 1}`, description: fields.description || '',
      status: 'Open', type: fields.type || 'Issue', priority: fields.priority || 'Normal', assignedTo: '', stage: '', labels: fields.labels || [],
      dueDate: '', creationDate: now, creationAuthor: this.author(), modifiedDate: '', modifiedAuthor: '', index: this.issues.length + 1,
      referencedModels: this.app.models.models.map((m) => m.name), comments: [], viewpoints: [this.captureViewpoint()],
    };
    this.issues.push(issue);
    this.selected = issue;
    this.changed();
    return issue;
  }

  touch(issue) {
    issue.modifiedDate = new Date().toISOString();
    issue.modifiedAuthor = this.author();
    this.changed();
  }

  remove(issue) {
    this.issues = this.issues.filter((i) => i !== issue);
    if (this.selected === issue) this.selected = null;
    this.changed();
  }

  /** Apply a BCF viewpoint to the 3D view. */
  showViewpoint(vp) {
    if (!vp) return;
    const app = this.app;
    const M = app.models;
    const c = vp.components || {};
    if (M.models.length) {
      const exc = new Set(c.exceptions || []);
      const def = c.visibilityDefault !== false;
      const hints = c.viewSetupHints || {};
      const revealed = new Set(Object.keys(HINTS).filter((k) => hints[HINTS[k]]));
      const colorOf = new Map();
      for (const col of c.coloring || []) {
        const rgb = bcfToColor(col.color);
        if (rgb) for (const g of col.guids) colorOf.set(g, packRgb([rgb.r, rgb.g, rgb.b]));
      }
      const view = blankView(M.models);
      for (const { model: m, vis, color } of view) {
        // BCF has no model switch: element visibility carries it, so show the model itself
        m.visible = true;
        for (let i = 0; i < m.count; i++) {
          const el = m.elements[i];
          // spaces/openings follow the view setup hints unless listed explicitly
          if (exc.has(el.guid)) vis[i] = def ? 0 : 1;
          else vis[i] = def && (!isGated(el) || revealed.has(el.category)) ? 1 : 0;
          color[i] = colorOf.get(el.guid) ?? -1;
        }
      }
      app.state.applyView(view, { revealed });
      const sel = [];
      for (const g of c.selection || []) { const gid = M.findByGuid(g); if (gid >= 0) sel.push(gid); }
      app.state.select(sel);
    }
    app.sections.fromBcf(vp.clippingPlanes || []);
    this.applyCamera(vp.camera);
  }

  /** Move the camera to a BCF camera (IFC coordinates). */
  applyCamera(cam) {
    const app = this.app;
    const M = app.models;
    if (cam && cam.position) {
      const pos = M.fromIfc(cam.position);
      const dir = M.dirFromIfc(cam.direction).normalize();
      const up = cam.up ? M.dirFromIfc(cam.up).normalize() : new THREE.Vector3(0, 1, 0);
      const dist = Math.max(app.controls.sceneRadius * 0.5, 5);
      const target = pos.clone().addScaledVector(dir, dist);
      if (cam.type === 'orthographic') {
        app.controls.setProjection('orthographic');
        app.controls.flyTo(pos, target, true, up, cam.viewToWorldScale || 20);
      } else {
        app.controls.setProjection('perspective');
        if (cam.fov) { app.viewer.perspCam.fov = THREE.MathUtils.clamp(cam.fov, 20, 100); app.viewer.perspCam.updateProjectionMatrix(); }
        app.controls.flyTo(pos, target, true, up);
      }
    }
  }

  exportBcf(version = '2.1') {
    const name = this.app.models.models[0]?.project?.name || 'OpenZoom';
    return exportBCF(this.issues, { version, projectName: name });
  }

  async importBcf(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const res = importBCF(buf);
    for (const issue of res.issues) {
      const idx = this.issues.findIndex((i) => i.guid === issue.guid);
      if (idx >= 0) this.issues[idx] = issue; else this.issues.push(issue);
    }
    this.changed();
    return res.issues.length;
  }
}
