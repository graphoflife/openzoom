// Web worker: parses an IFC file with web-ifc, merges the geometry into a few
// large buffers (one vertex range per element) and extracts all metadata that
// the viewer needs (spatial tree, types, property sets, materials, ...).
import * as WebIFC from 'web-ifc';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';
import { parseIfc } from './ifc-parse.js';

const api = new WebIFC.IfcAPI();
let ready = null;

function init() {
  if (!ready) {
    const url = new URL(wasmUrl, self.location.href).href;
    ready = api.Init(() => url, true);
  }
  return ready;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.cmd !== 'load') return;
  try {
    await init();
    const result = parseIfc(api, WebIFC, msg, (phase, value) => progress(msg.id, phase, value));
    const transfer = [];
    for (const c of result.chunks) {
      transfer.push(c.position.buffer, c.normal.buffer, c.color.buffer, c.eid.buffer, c.index.buffer);
      if (c.edgePos) transfer.push(c.edgePos.buffer, c.edgeEid.buffer);
    }
    transfer.push(result.bboxes.buffer);
    self.postMessage({ type: 'result', id: msg.id, result }, transfer);
  } catch (err) {
    console.error(err);
    self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};

function progress(id, phase, value) {
  self.postMessage({ type: 'progress', id, phase, value });
}
