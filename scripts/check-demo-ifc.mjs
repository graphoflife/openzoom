#!/usr/bin/env node
/**
 * Validates the generated demo IFC files.
 *
 *  1. Text-level STEP checks: header, IFC4 attribute counts per entity (taken from
 *     web-ifc's own IFC4 schema typings), dangling references, GlobalId format and
 *     uniqueness, pure-ASCII encoding.
 *  2. Loads each model with web-ifc (COORDINATE_TO_ORIGIN: false), streams all meshes
 *     and reports schema, mesh counts per IFC class, colours, the bounding box of all
 *     transformed vertices (+ interpretation of units / up-axis), geometry coverage of
 *     all building / MEP elements, whether IfcSpace / IfcOpeningElement are streamed,
 *     opening cuts in walls (mesh volume vs. Qto NetVolume) and umlaut decoding.
 *
 * Usage: node scripts/check-demo-ifc.mjs [file.ifc ...]
 * Exit code 1 if any check fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as WebIFC from 'web-ifc';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILES = ['public/demo/Demo_Architektur.ifc', 'public/demo/Demo_HLS.ifc'].map((f) => path.join(ROOT, f));
const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => path.resolve(f)) : DEFAULT_FILES;

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const ok = (msg) => console.log(`  ok   ${msg}`);

// ---------------------------------------------------------------------------
// IFC4 schema (attribute counts) from web-ifc's typings
// ---------------------------------------------------------------------------

function loadIfc4Schema() {
  const require = createRequire(import.meta.url);
  const dts = path.join(path.dirname(require.resolve('web-ifc')), 'ifc-schema.d.ts');
  const lines = fs.readFileSync(dts, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('export declare namespace IFC4 {'));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('export declare namespace '));
  const schema = new Map(); // UPPERCASE name -> { count, firstParam }
  let cls = null;
  for (let i = start; i < end; i++) {
    const c = lines[i].match(/^\s+class (\w+)/);
    if (c) cls = c[1];
    const m = lines[i].match(/^\s+constructor\((.*)\);\s*$/);
    if (m && cls) {
      const params = splitTopLevel(m[1], '(<[', ')>]');
      schema.set(cls.toUpperCase(), { count: params.length, firstParam: params[0]?.split(':')[0].trim() });
      cls = null;
    }
  }
  return schema;
}

function splitTopLevel(s, open, close) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (open.includes(ch)) depth++;
    else if (close.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------------------------------------------------------------------------
// Minimal STEP parser
// ---------------------------------------------------------------------------

/** Splits a STEP argument list at top-level commas (strings and nested lists respected). */
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") {
        if (s[i + 1] === "'") cur += s[++i];
        else inStr = false;
      }
      continue;
    }
    if (ch === "'") inStr = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out;
}

function stripStrings(s) {
  return s.replace(/'(?:[^']|'')*'/g, "''");
}

function parseStep(text) {
  const header = text.slice(0, text.indexOf('DATA;'));
  const data = text.slice(text.indexOf('DATA;') + 5, text.lastIndexOf('ENDSEC;'));
  const statements = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === "'") inStr = !inStr; // '' toggles twice -> unchanged
    if (ch === ';' && !inStr) {
      statements.push(cur.trim());
      cur = '';
    } else cur += ch === '\n' || ch === '\r' ? '' : ch;
  }
  const entities = new Map();
  for (const st of statements) {
    if (!st) continue;
    const m = st.match(/^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\((.*)\)$/s);
    if (!m) throw new Error(`Cannot parse statement: ${st.slice(0, 120)}`);
    const args = splitArgs(m[3]);
    const refs = [...stripStrings(m[3]).matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
    entities.set(Number(m[1]), { type: m[2], args, refs });
  }
  return { header, entities };
}

function textChecks(file, text, schema) {
  console.log('\n[STEP text checks]');
  const bytes = Buffer.from(text, 'utf8');
  const nonAscii = bytes.findIndex((b) => b > 0x7e);
  if (nonAscii >= 0) fail(`non-ASCII byte at offset ${nonAscii}`);
  else ok(`pure ASCII, ${(bytes.length / 1024).toFixed(1)} KiB${bytes.length > 2 * 1024 * 1024 ? ' (> 2 MB!)' : ''}`);
  if (bytes.length > 2 * 1024 * 1024) fail('file larger than 2 MB');

  const { header, entities } = parseStep(text);
  const headerOk =
    header.includes("FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');") &&
    header.includes("FILE_SCHEMA(('IFC4'));") &&
    header.includes('FILE_NAME(');
  if (headerOk) ok('header FILE_DESCRIPTION / FILE_NAME / FILE_SCHEMA(IFC4)');
  else fail('header incomplete');

  const mismatches = new Map();
  const unknown = new Set();
  const guids = new Map();
  const badGuids = [];
  let dangling = 0;
  for (const [id, e] of entities) {
    const def = schema.get(e.type);
    if (!def) {
      unknown.add(e.type);
      continue;
    }
    // web-ifc's constructors omit attributes re-declared as DERIVED, which STEP writes as '*'
    const explicit = e.args.filter((a) => a !== '*').length;
    if (explicit !== def.count) mismatches.set(e.type, `${e.type}: ${explicit} explicit attributes, schema expects ${def.count} (e.g. #${id})`);
    if (def.firstParam === 'GlobalId') {
      const g = e.args[0].replace(/^'|'$/g, '');
      if (!/^[0-3][0-9A-Za-z_$]{21}$/.test(g)) badGuids.push(`#${id} ${g}`);
      if (guids.has(g)) badGuids.push(`duplicate ${g} (#${guids.get(g)}, #${id})`);
      guids.set(g, id);
    }
    for (const r of e.refs) if (!entities.has(r)) dangling++;
  }
  const typesUsed = new Set([...entities.values()].map((e) => e.type));
  if (unknown.size) fail(`entity types not in IFC4: ${[...unknown].join(', ')}`);
  if (mismatches.size) for (const m of mismatches.values()) fail(m);
  else ok(`attribute counts match IFC4 schema for all ${entities.size} entities (${typesUsed.size} entity types)`);
  if (dangling) fail(`${dangling} dangling references`);
  else ok('no dangling references');
  if (badGuids.length) fail(`GlobalId problems: ${badGuids.slice(0, 5).join('; ')}`);
  else ok(`${guids.size} GlobalIds, all 22-char IFC base64 and unique`);
  return entities;
}

// ---------------------------------------------------------------------------
// web-ifc checks
// ---------------------------------------------------------------------------

const ELEMENT_CLASSES = [
  'IfcWall', 'IfcSlab', 'IfcColumn', 'IfcBeam', 'IfcWindow', 'IfcDoor', 'IfcSpace', 'IfcCovering', 'IfcStairFlight', 'IfcRailing',
  'IfcDuctSegment', 'IfcDuctFitting', 'IfcAirTerminal', 'IfcPipeSegment', 'IfcPipeFitting', 'IfcCableCarrierSegment',
];
// containers whose geometry comes from aggregated parts
const CONTAINER_CLASSES = ['IfcStair', 'IfcRoof'];

const newBox = () => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
function grow(box, x, y, z) {
  if (x < box[0]) box[0] = x;
  if (y < box[1]) box[1] = y;
  if (z < box[2]) box[2] = z;
  if (x > box[3]) box[3] = x;
  if (y > box[4]) box[4] = y;
  if (z > box[5]) box[5] = z;
}
const fmtBox = (b, d = 3) => `min (${b.slice(0, 3).map((v) => v.toFixed(d)).join(', ')})  max (${b.slice(3).map((v) => v.toFixed(d)).join(', ')})`;
const size = (b) => [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
const toArray = (v) => (Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v) : Array.from({ length: v.size() }, (_, i) => v.get(i)));
const ids = (vec) => toArray(vec);

/** Streams meshes and collects per-element statistics in output (viewer) coordinates. */
function collectMeshes(api, modelID, streamFn) {
  const meshes = new Map();
  const total = newBox();
  streamFn((mesh) => {
    const id = mesh.expressID;
    const cls = api.GetNameFromTypeCode(api.GetLineType(modelID, id));
    const info = meshes.get(id) ?? { cls, geometries: 0, verts: 0, tris: 0, volume: 0, colours: new Set(), box: newBox() };
    const n = mesh.geometries.size();
    for (let i = 0; i < n; i++) {
      const pg = mesh.geometries.get(i);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const m = toArray(pg.flatTransformation);
      info.matrix ??= m;
      const tv = new Float64Array((v.length / 6) * 3);
      for (let k = 0, j = 0; k < v.length; k += 6, j += 3) {
        const x = v[k];
        const y = v[k + 1];
        const z = v[k + 2];
        // column-major 4x4
        tv[j] = m[0] * x + m[4] * y + m[8] * z + m[12];
        tv[j + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        tv[j + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        grow(info.box, tv[j], tv[j + 1], tv[j + 2]);
        grow(total, tv[j], tv[j + 1], tv[j + 2]);
      }
      let vol = 0;
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3;
        const b = idx[t + 1] * 3;
        const c = idx[t + 2] * 3;
        const [ax, ay, az, bx, by, bz, cx, cy, cz] = [tv[a], tv[a + 1], tv[a + 2], tv[b], tv[b + 1], tv[b + 2], tv[c], tv[c + 1], tv[c + 2]];
        vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      }
      info.volume += vol / 6;
      info.geometries++;
      info.verts += v.length / 6;
      info.tris += idx.length / 3;
      const col = pg.color;
      info.colours.add(`rgba(${col.x.toFixed(2)},${col.y.toFixed(2)},${col.z.toFixed(2)},${col.w.toFixed(2)})`);
      geom.delete?.();
    }
    meshes.set(id, info);
  });
  return { meshes, total };
}

function checkModel(api, file, entities) {
  const name = path.basename(file);
  console.log('\n[web-ifc]');
  const data = new Uint8Array(fs.readFileSync(file));

  // capture whatever web-ifc logs while loading / meshing
  const logged = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...a) => logged.push(a.join(' '));
  console.warn = capture;
  console.error = capture;

  const t0 = performance.now();
  const modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: false });
  if (modelID < 0) {
    Object.assign(console, orig);
    fail('OpenModel returned -1');
    return;
  }
  const { meshes, total } = collectMeshes(api, modelID, (cb) => api.StreamAllMeshes(modelID, cb));
  const t1 = performance.now();
  const withTypes = collectMeshes(api, modelID, (cb) =>
    api.StreamAllMeshesWithTypes(modelID, [WebIFC.IFCSPACE, WebIFC.IFCOPENINGELEMENT], cb),
  );
  Object.assign(console, orig);

  const line = (id) => api.GetLine(modelID, id);
  const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
  const typeIds = (name) => ids(api.GetLineIDsWithType(modelID, WebIFC[name.toUpperCase()]));

  console.log(`  schema: ${api.GetModelSchema(modelID)}   (opened + streamed in ${(t1 - t0).toFixed(0)} ms)`);
  if (logged.length) {
    fail(`web-ifc logged ${logged.length} warning(s)/error(s):`);
    for (const l of logged.slice(0, 10)) console.log(`         ${l}`);
  } else ok('web-ifc logged no warnings or errors');

  // --- meshes per class ---
  const perClass = new Map();
  for (const m of meshes.values()) {
    const c = perClass.get(m.cls) ?? { n: 0, verts: 0, tris: 0, colours: new Set() };
    c.n++;
    c.verts += m.verts;
    c.tris += m.tris;
    m.colours.forEach((x) => c.colours.add(x));
    perClass.set(m.cls, c);
  }
  console.log(`  StreamAllMeshes: ${meshes.size} meshes`);
  for (const [cls, c] of [...perClass].sort((a, b) => b[1].n - a[1].n))
    console.log(`    ${cls.padEnd(24)} ${String(c.n).padStart(4)} meshes  ${String(c.tris).padStart(6)} tris   colours ${[...c.colours].join(' ')}`);

  // --- coverage: every element of the relevant classes has a non-empty mesh ---
  console.log('  geometry coverage:');
  for (const cls of ELEMENT_CLASSES) {
    const all = typeIds(cls);
    if (!all.length) continue;
    const withMesh = all.filter((id) => (meshes.get(id)?.tris ?? 0) > 0 || (withTypes.meshes.get(id)?.tris ?? 0) > 0);
    const missing = all.filter((id) => !withMesh.includes(id));
    const msg = `${cls.padEnd(24)} ${withMesh.length}/${all.length} with geometry`;
    if (missing.length) fail(`${msg} – missing: ${missing.map((id) => `#${id} ${val(line(id).Name)}`).join(', ')}`);
    else ok(msg);
  }
  for (const cls of CONTAINER_CLASSES) {
    const all = typeIds(cls);
    if (all.length) console.log(`  info ${cls} x${all.length}: container without own representation (geometry via aggregated parts)`);
  }

  // --- spaces / openings ---
  const countCls = (map, cls) => [...map.values()].filter((m) => m.cls.toUpperCase() === cls.toUpperCase()).length;
  const spacesDefault = countCls(meshes, 'IfcSpace');
  const openingsDefault = countCls(meshes, 'IfcOpeningElement');
  const spacesTyped = countCls(withTypes.meshes, 'IfcSpace');
  const openingsTyped = countCls(withTypes.meshes, 'IfcOpeningElement');
  console.log(
    `  IfcSpace:          ${typeIds('IfcSpace').length} in file, ${spacesDefault} via StreamAllMeshes, ${spacesTyped} via StreamAllMeshesWithTypes`,
  );
  console.log(
    `  IfcOpeningElement: ${typeIds('IfcOpeningElement').length} in file, ${openingsDefault} via StreamAllMeshes, ${openingsTyped} via StreamAllMeshesWithTypes`,
  );
  for (const cls of ['IfcSpace', 'IfcOpeningElement']) {
    const typed = [...withTypes.meshes.values()].filter((m) => m.cls.toUpperCase() === cls.toUpperCase());
    if (typed.length)
      console.log(`    ${cls} meshes on request: ${typed.reduce((a, m) => a + m.tris, 0)} tris, colours ${[...new Set(typed.flatMap((m) => [...m.colours]))].join(' ')}`);
  }

  // --- bounding box / units / up axis ---
  const s = size(total);
  console.log(`  bounding box (output units): ${fmtBox(total)}`);
  console.log(`  extents: ${s.map((v) => v.toFixed(3)).join(' x ')}`);
  const lengthUnits = typeIds('IfcSIUnit')
    .map(line)
    .filter((u) => val(u.UnitType) === 'LENGTHUNIT')
    .map((u) => `${val(u.Prefix) ?? ''}${val(u.Name)}`);
  const maxExtent = Math.max(...s);
  const unitGuess = maxExtent < 1000 ? 'metres (mm -> m scaling applied by web-ifc)' : 'file units (NO scaling applied)';
  console.log(`  IFC length unit: ${lengthUnits.join(', ')}; largest extent ${maxExtent.toFixed(3)} -> output is in ${unitGuess}`);
  const upIsY = s[1] < s[2] && s[1] < s[0];
  console.log(`  up axis: ${upIsY ? 'Y (IFC Z is mapped to output Y, Y-up like three.js)' : 'Z (no Y-up conversion)'}`);
  console.log(`  coordination matrix: [${toArray(api.GetCoordinationMatrix(modelID)).map((v) => +v.toFixed(4)).join(', ')}]`);

  // probe element with known IFC coordinates -> derive the exact axis mapping
  const probe = name.includes('Architektur') ? 'ST-EG-A1' : 'TW-EG-Hauptleitung';
  const probeId = [...meshes.keys()].find((id) => val(line(id).Name) === probe);
  if (probeId) {
    const b = meshes.get(probeId).box;
    console.log(`  flatTransformation of ${probe}: [${meshes.get(probeId).matrix.map((v) => +v.toFixed(4)).join(', ')}]`);
    const expected =
      probe === 'ST-EG-A1'
        ? 'IFC mm: x 4850..5150, y 3850..4150, z 0..2950'
        : 'IFC mm: x 600..15500, y 6861.95..6938.05, z 2481.95..2558.05';
    console.log(`  probe ${probe} (${expected})`);
    console.log(`        output: x ${b[0].toFixed(3)}..${b[3].toFixed(3)}, y ${b[1].toFixed(3)}..${b[4].toFixed(3)}, z ${b[2].toFixed(3)}..${b[5].toFixed(3)}`);
  }

  // --- openings cut walls: mesh volume vs. Qto NetVolume and vs. gross box volume ---
  const voided = new Map();
  for (const id of typeIds('IfcRelVoidsElement')) {
    const r = line(id);
    const host = val(r.RelatingBuildingElement);
    voided.set(host, (voided.get(host) ?? 0) + 1);
  }
  const netVolume = new Map();
  for (const id of typeIds('IfcRelDefinesByProperties')) {
    const r = line(id);
    const def = line(val(r.RelatingPropertyDefinition));
    if (val(def.Name) !== 'Qto_WallBaseQuantities') continue;
    for (const q of def.Quantities.map((x) => line(val(x))))
      if (val(q.Name) === 'NetVolume') for (const o of r.RelatedObjects) netVolume.set(val(o), val(q.VolumeValue));
  }
  const walls = typeIds('IfcWall');
  if (walls.length) {
    let cut = 0;
    let volOk = 0;
    let worst = 0;
    let wallsWithVoids = 0;
    for (const id of walls) {
      const m = meshes.get(id);
      if (!m) continue;
      const gross = size(m.box).reduce((a, b) => a * b, 1);
      const qto = netVolume.get(id);
      const err = qto ? Math.abs(Math.abs(m.volume) - qto) / qto : 1;
      worst = Math.max(worst, err);
      if (err < 0.005) volOk++;
      if (voided.has(id)) {
        wallsWithVoids++;
        if (Math.abs(m.volume) < gross * 0.999) cut++;
      }
    }
    const msg = `walls: ${wallsWithVoids} with IfcRelVoidsElement, ${cut} of them have mesh volume < gross box volume (openings cut)`;
    if (cut === wallsWithVoids) ok(msg);
    else fail(msg);
    const msg2 = `wall mesh volume (m³) matches Qto_WallBaseQuantities.NetVolume for ${volOk}/${walls.length} walls (max rel. error ${(worst * 100).toFixed(3)} %)`;
    if (volOk === walls.length) ok(msg2);
    else fail(msg2);
    const sample = walls.map((id) => ({ id, m: meshes.get(id) })).find((w) => voided.get(w.id) >= 5);
    if (sample) {
      const gross = size(sample.m.box).reduce((a, b) => a * b, 1);
      console.log(
        `  e.g. ${val(line(sample.id).Name)}: ${voided.get(sample.id)} openings, ${sample.m.verts} vertices, mesh ${Math.abs(sample.m.volume).toFixed(3)} m³ / gross ${gross.toFixed(3)} m³ / Qto NetVolume ${netVolume.get(sample.id).toFixed(3)} m³`,
      );
    }
  }

  // --- umlauts / string decoding ---
  const decoded = [];
  const pushNames = (cls, max, attrs = ['Name', 'LongName']) => {
    for (const id of typeIds(cls).slice(0, max)) {
      const l = line(id);
      decoded.push(`${cls.slice(3)} #${id}: ${attrs.map((a) => `${a}="${val(l[a]) ?? ''}"`).join(' ')}`);
    }
  };
  pushNames('IfcProject', 1);
  pushNames('IfcSite', 1);
  pushNames('IfcBuilding', 1);
  pushNames('IfcBuildingStorey', 4);
  pushNames('IfcSpace', 2);
  pushNames('IfcDistributionSystem', 1);
  const umlautWall = walls.find((id) => val(line(id).Name).includes('ü'));
  if (umlautWall) decoded.push(`Wall #${umlautWall}: Name="${val(line(umlautWall).Name)}"`);
  console.log('  strings read back via api.GetLine:');
  for (const d of decoded) console.log(`    ${d}`);
  const undecoded = decoded.filter((d) => d.includes('\\X2\\') || d.includes('\\X0\\'));
  const expectedSite = typeIds('IfcSite').map((id) => val(line(id).Name));
  if (undecoded.length) fail(`undecoded \\X2\\ sequences: ${undecoded.join(' | ')}`);
  else if (!expectedSite.includes('Grundstück')) fail(`site name decoded as ${JSON.stringify(expectedSite)}`);
  else ok('\\X2\\ encoded umlauts decode correctly (e.g. "Grundstück")');

  api.CloseModel(modelID);
  return { meshes: meshes.size };
}

// ---------------------------------------------------------------------------

const api = new WebIFC.IfcAPI();
await api.Init();
console.log(`web-ifc ${api.GetVersion()}`);
const schema = loadIfc4Schema();

for (const file of files) {
  console.log(`\n=== ${path.relative(ROOT, file)} ===`);
  if (!fs.existsSync(file)) {
    fail(`missing file ${file} – run "node scripts/generate-demo-ifc.mjs" first`);
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  const entities = textChecks(file, text, schema);
  checkModel(api, file, entities);
}

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
