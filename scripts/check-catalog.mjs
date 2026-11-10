import * as WebIFC from 'web-ifc';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseIfc } from '../src/core/ifc-parse.js';
import { Model } from '../src/core/models.js';
import { buildPropertyCatalog, getValue } from '../src/core/props.js';
import { testCondition } from '../src/core/smartviews.js';

// Every value the smart view value picker offers must find exactly the elements
// it was counted for: the catalog and getValue have to read properties the same way.
// Usage: node scripts/check-catalog.mjs [file.ifc ...]   (default: the demo models)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2);
if (!files.length) files.push(...['Demo_Architektur.ifc', 'Demo_HLS.ifc'].map((f) => path.join(root, 'public/demo', f)));

const api = new WebIFC.IfcAPI();
await api.Init();
const models = [];
let offset = null;
for (const file of files) {
  const buf = fs.readFileSync(file);
  const r = parseIfc(api, WebIFC, { buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), fileName: path.basename(file), offset, edges: false });
  offset = r.offset;
  models.push(new Model(r, null));
}

const CONDITION = { StringValue: 'Is', DoubleValue: 'Equals', BoolValue: 'Is', LogicalValue: 'Is' };
let checked = 0;
const failures = [];
for (const g of buildPropertyCatalog(models).groups) {
  for (const p of g.props) {
    if (p.more) continue; // capped value list: counts are incomplete
    const ref = { type: g.type, psetName: g.psetName, name: p.name };
    // File/Project values are counted for every element of the model, the others skip the project
    const perModel = g.type === 'File' || g.type === 'Project';
    for (const [value, count] of p.values) {
      let matched = 0;
      for (const m of models) {
        for (let i = 0; i < m.count; i++) {
          if (!perModel && m.elements[i].cls === 'IfcProject') continue;
          const v = getValue(m, i, ref);
          if (v !== undefined && testCondition({ type: CONDITION[p.valueType], value }, v)) matched++;
        }
      }
      checked++;
      if (matched !== count) failures.push(`${g.type} › ${g.psetName || '*'} › ${p.name} = "${value}": offered for ${count}, matches ${matched}`);
    }
  }
}
for (const f of failures.slice(0, 40)) console.log(`  FAIL ${f}`);
if (failures.length) {
  console.log(`catalog round trip: ${failures.length} of ${checked} values do not match`);
  process.exit(1);
}
console.log(`  ok   ${checked} catalog values find exactly their elements`);
