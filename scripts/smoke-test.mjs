import * as WebIFC from 'web-ifc';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseIfc } from '../src/core/ifc-parse.js';

// Smoke test: parse the demo models in Node and print a summary.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = new WebIFC.IfcAPI();
await api.Init();
let offset = null;
for (const f of ['Demo_Architektur.ifc', 'Demo_HLS.ifc']) {
  const buf = fs.readFileSync(root + '/public/demo/' + f);
  const t0 = Date.now();
  const r = parseIfc(api, WebIFC, { buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), fileName: f, offset, edges: true });
  offset = r.offset;
  console.log(f, 'ms', Date.now() - t0, 'schema', r.schema, 'units', JSON.stringify(r.units), 'offset', r.offset);
  console.log(' chunks', r.chunks.map(c => [c.position.length / 3, c.index.length / 3, c.edgePos.length / 6]));
  console.log(' elements', r.elements.length, 'psets', r.psets.length, 'materials', r.materials.length, 'classes', r.classes.length, 'groups', r.groups.length);
  const byCls = {};
  r.elements.forEach((e, i) => { byCls[e.cls] = (byCls[e.cls] || 0) + 1; });
  console.log(' classes', JSON.stringify(byCls));
  const storeys = r.elements.filter(e => e.cls === 'IfcBuildingStorey').map(e => [e.name, e.elevation, e.placementZ]);
  console.log(' storeys', JSON.stringify(storeys));
  const wall = r.elements.findIndex(e => e.cls === 'IfcWall');
  const w = r.elements[wall];
  if (w) console.log(' wall', JSON.stringify({ ...w, psets: w.psets.map(k => r.psets[k]), typePsets: w.typePsets.map(k => r.psets[k]), mat: r.materials[w.mat], classes: w.classes.map(c => r.classes[c]) }).slice(0, 1500));
  if (w) console.log(' bbox wall', Array.from(r.bboxes.slice(wall * 6, wall * 6 + 6)).map(v => v.toFixed(3)), 'vol', w.volume.toFixed(3));
  const pipe = r.elements.find(e => e.cls === 'IfcPipeSegment');
  if (pipe) console.log(' pipe', JSON.stringify({ name: pipe.name, groups: pipe.groups.map(g => r.groups[g]), supers: pipe.supers }));
  console.log(' header', JSON.stringify(r.header), JSON.stringify(r.project));
  const noParent = r.elements.filter(e => e.parent < 0).map(e => e.cls);
  console.log(' roots', noParent);
}
