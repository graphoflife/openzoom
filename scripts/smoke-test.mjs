import * as WebIFC from 'web-ifc';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseIfc } from '../src/core/ifc-parse.js';

// Smoke test: parse IFC files in Node with the app's parser and print a summary.
// Usage: node scripts/smoke-test.mjs [file.ifc ...]   (default: the demo models)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2);
if (!files.length) files.push(...['Demo_Architektur.ifc', 'Demo_HLS.ifc'].map((f) => path.join(root, 'public/demo', f)));

const api = new WebIFC.IfcAPI();
await api.Init();
let offset = null;
for (const file of files) {
  const buf = fs.readFileSync(file);
  const t0 = Date.now();
  const r = parseIfc(api, WebIFC, { buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), fileName: path.basename(file), offset, edges: true });
  offset = r.offset;
  console.log(`${path.basename(file)}: ${Date.now() - t0} ms, ${r.schema}, units ${JSON.stringify(r.units)}, offset ${r.offset}`);
  console.log(` chunks ${JSON.stringify(r.chunks.map((c) => [c.position.length / 3, c.index.length / 3]))}`);
  console.log(` elements ${r.elements.length}, psets ${r.psets.length}, materials ${r.materials.length}, classifications ${r.classes.length}, groups ${r.groups.length}`);
  const by = {};
  r.elements.forEach((e) => { by[e.cls] = (by[e.cls] || 0) + 1; });
  console.log(` classes ${JSON.stringify(by)}`);
  const hasKids = new Set(r.elements.map((e) => e.parent));
  const bare = {};
  r.elements.forEach((e, i) => { if (!r.ranges[i] && !hasKids.has(i)) bare[e.cls] = (bare[e.cls] || 0) + 1; });
  console.log(` without geometry and children ${JSON.stringify(bare)}`);
  console.log(` storeys ${JSON.stringify(r.elements.filter((e) => e.cls === 'IfcBuildingStorey').map((e) => [e.name, e.elevation, e.placementZ]))}`);
  console.log(` roots ${JSON.stringify(r.elements.filter((e) => e.parent < 0).map((e) => e.cls))}`);
  const w = r.elements.find((e) => e.supers.includes('IfcWall'));
  if (w) {
    console.log(` wall ${JSON.stringify({ name: w.name, type: w.typeName, parent: r.elements[w.parent]?.cls, psets: w.psets.map((k) => r.psets[k].n), typePsets: w.typePsets.map((k) => r.psets[k].n), mat: r.materials[w.mat], classes: w.classes.map((c) => r.classes[c]) })}`);
  }
  const bb = r.bboxes;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < r.elements.length; i++) {
    if (Number.isNaN(bb[i * 6])) continue;
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], bb[i * 6 + k]); mx[k] = Math.max(mx[k], bb[i * 6 + 3 + k]); }
  }
  console.log(` bbox ${mn.map((v) => v.toFixed(2))} .. ${mx.map((v) => v.toFixed(2))}`);
}
