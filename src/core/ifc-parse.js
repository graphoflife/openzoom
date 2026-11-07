// IFC parsing: geometry merging and metadata extraction with web-ifc.

// ---------------------------------------------------------------------------
// Proper-case IFC class names ("IFCWALL" -> "IfcWall") and inheritance.

const properNames = new Map();
function initNames() {
  for (const ns of ['IFC2X3', 'IFC4', 'IFC4X3']) {
    for (const k of Object.keys(WebIFC[ns] || {})) {
      if (k.startsWith('Ifc')) properNames.set(k.toUpperCase(), k);
    }
  }
}
const superCache = new Map();

function schemaIndex(schema) {
  const s = (schema || '').toUpperCase();
  for (let i = 1; i < WebIFC.SchemaNames.length; i++) {
    if (WebIFC.SchemaNames[i] && WebIFC.SchemaNames[i].includes(s)) return i;
  }
  return 2;
}

function supersFor(idx) {
  if (superCache.has(idx)) return superCache.get(idx);
  const map = new Map();
  const defs = WebIFC.InheritanceDef[idx] || {};
  for (const key of Object.keys(defs)) {
    const parent = Number(key);
    for (const sub of defs[key]) {
      let arr = map.get(sub);
      if (!arr) map.set(sub, (arr = []));
      arr.push(parent);
    }
  }
  superCache.set(idx, map);
  return map;
}

function className(code) {
  const name = api.GetNameFromTypeCode(code) || 'IfcProduct';
  return properNames.get(name.toUpperCase()) || name;
}

const upperName = (code) => (api.GetNameFromTypeCode(code) || '').toUpperCase();

// ---------------------------------------------------------------------------
// Geometry

const MAX_CHUNK_VERTS = 1_500_000;

class Grow {
  constructor(Type, cap = 1 << 16) { this.Type = Type; this.a = new Type(cap); this.n = 0; }
  reserve(extra) {
    if (this.n + extra <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + extra) cap *= 2;
    const b = new this.Type(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  out() { return this.a.slice(0, this.n); }
}

class GeometryBuilder {
  constructor(offset, withEdges) {
    this.offset = offset;
    this.withEdges = withEdges;
    this.chunks = [];
    this.cache = new Map();
    this.ranges = new Map(); // expressID -> [{chunk, vStart, vCount, iStart, iCount}]
    this.newChunk();
  }

  newChunk() {
    if (this.cur && this.cur.pos.n === 0) return;
    this.cur = {
      pos: new Grow(Float32Array), nrm: new Grow(Int8Array), col: new Grow(Uint8Array),
      eid: new Grow(Float32Array), idx: new Grow(Uint32Array),
      ePos: new Grow(Float32Array), eEid: new Grow(Float32Array),
    };
    this.chunks.push(this.cur);
  }

  localGeometry(modelID, geomID) {
    let g = this.cache.get(geomID);
    if (g) return g;
    const geom = api.GetGeometry(modelID, geomID);
    const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize()).slice();
    const index = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize()).slice();
    geom.delete();
    g = { verts, index };
    this.cache.set(geomID, g);
    return g;
  }

  addMesh(modelID, flat, eidOf) {
    const expressID = flat.expressID;
    const geoms = flat.geometries;
    const n = geoms.size();
    const parts = [];
    let totalVerts = 0;
    for (let i = 0; i < n; i++) {
      const pg = geoms.get(i);
      const g = this.localGeometry(modelID, pg.geometryExpressID);
      if (!g.index.length) continue;
      parts.push({ g, m: pg.flatTransformation, c: pg.color });
      totalVerts += g.verts.length / 6;
    }
    if (!parts.length) return;
    if (this.cur.pos.n / 3 + totalVerts > MAX_CHUNK_VERTS) this.newChunk();
    const ch = this.cur;
    const eid = eidOf(expressID);
    const vStart = ch.pos.n / 3;
    const iStart = ch.idx.n;
    ch.pos.reserve(totalVerts * 3); ch.nrm.reserve(totalVerts * 3);
    ch.col.reserve(totalVerts * 4); ch.eid.reserve(totalVerts);

    for (const { g, m, c } of parts) {
      if (!this.offset) {
        const x = g.verts[0], y = g.verts[1], z = g.verts[2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        this.offset = Math.abs(wx) > 1000 || Math.abs(wz) > 1000 ? [Math.round(wx), 0, Math.round(wz)] : [0, 0, 0];
      }
      const [ox, oy, oz] = this.offset;
      const base = ch.pos.n / 3;
      const v = g.verts;
      const P = ch.pos.a, N = ch.nrm.a, C = ch.col.a, E = ch.eid.a;
      const r = Math.round(c.x * 255), gg = Math.round(c.y * 255), b = Math.round(c.z * 255), a = Math.round(c.w * 255);
      let p = ch.pos.n, q = ch.col.n, k = ch.eid.n;
      for (let j = 0; j < v.length; j += 6) {
        const x = v[j], y = v[j + 1], z = v[j + 2];
        P[p] = m[0] * x + m[4] * y + m[8] * z + m[12] - ox;
        P[p + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] - oy;
        P[p + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] - oz;
        const nx = v[j + 3], ny = v[j + 4], nz = v[j + 5];
        let tx = m[0] * nx + m[4] * ny + m[8] * nz;
        let ty = m[1] * nx + m[5] * ny + m[9] * nz;
        let tz = m[2] * nx + m[6] * ny + m[10] * nz;
        const len = Math.hypot(tx, ty, tz) || 1;
        N[p] = Math.round((tx / len) * 127); N[p + 1] = Math.round((ty / len) * 127); N[p + 2] = Math.round((tz / len) * 127);
        C[q] = r; C[q + 1] = gg; C[q + 2] = b; C[q + 3] = a;
        E[k] = eid;
        p += 3; q += 4; k++;
      }
      ch.pos.n = p; ch.nrm.n = p; ch.col.n = q; ch.eid.n = k;
      // Mirrored placements flip the triangle winding.
      const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
      const idx = g.index;
      ch.idx.reserve(idx.length);
      const I = ch.idx.a;
      let t = ch.idx.n;
      if (det < 0) {
        for (let j = 0; j < idx.length; j += 3) { I[t++] = idx[j] + base; I[t++] = idx[j + 2] + base; I[t++] = idx[j + 1] + base; }
      } else {
        for (let j = 0; j < idx.length; j++) I[t++] = idx[j] + base;
      }
      ch.idx.n = t;
    }
    const range = { chunk: this.chunks.length - 1, vStart, vCount: ch.pos.n / 3 - vStart, iStart, iCount: ch.idx.n - iStart };
    let list = this.ranges.get(expressID);
    if (!list) this.ranges.set(expressID, (list = []));
    list.push(range);
    if (this.withEdges) computeEdges(ch, iStart, range.iCount, eid);
  }

  finish() {
    return this.chunks.filter((c) => c.pos.n > 0).map((c) => ({
      position: c.pos.out(), normal: c.nrm.out(), color: c.col.out(), eid: c.eid.out(), index: c.idx.out(),
      edgePos: this.withEdges ? c.ePos.out() : null, edgeEid: this.withEdges ? c.eEid.out() : null,
    }));
  }
}

// Feature edges (like THREE.EdgesGeometry) for one element range.
const COS_EDGE = Math.cos((32 * Math.PI) / 180);
function computeEdges(ch, iStart, iCount, eid) {
  const P = ch.pos.a, I = ch.idx.a;
  const weld = new Map();
  const wid = (vi) => {
    const key = `${Math.round(P[vi * 3] * 2000)},${Math.round(P[vi * 3 + 1] * 2000)},${Math.round(P[vi * 3 + 2] * 2000)}`;
    let w = weld.get(key);
    if (w === undefined) { w = weld.size; weld.set(key, w); }
    return w;
  };
  const edges = new Map();
  const out = [];
  for (let t = iStart; t < iStart + iCount; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len; ny /= len; nz /= len;
    const tri = [a, b, c];
    const w = [wid(a), wid(b), wid(c)];
    for (let k = 0; k < 3; k++) {
      const w0 = w[k], w1 = w[(k + 1) % 3];
      if (w0 === w1) continue;
      const key = w0 < w1 ? w0 * 4194304 + w1 : w1 * 4194304 + w0;
      const prev = edges.get(key);
      if (prev) {
        if (prev.n0 * nx + prev.n1 * ny + prev.n2 * nz <= COS_EDGE) out.push(prev.v0, prev.v1);
        edges.delete(key);
      } else {
        edges.set(key, { v0: tri[k], v1: tri[(k + 1) % 3], n0: nx, n1: ny, n2: nz });
      }
    }
  }
  for (const e of edges.values()) out.push(e.v0, e.v1);
  ch.ePos.reserve(out.length * 3);
  ch.eEid.reserve(out.length);
  for (const vi of out) {
    const p = ch.ePos.n;
    ch.ePos.a[p] = P[vi * 3]; ch.ePos.a[p + 1] = P[vi * 3 + 1]; ch.ePos.a[p + 2] = P[vi * 3 + 2];
    ch.ePos.n += 3;
    ch.eEid.a[ch.eEid.n++] = eid;
  }
}

// ---------------------------------------------------------------------------
// Metadata helpers

const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const refId = (x) => (x && typeof x === 'object' ? x.value : x);
const str = (x) => {
  const v = val(x);
  return v === null || v === undefined ? '' : String(v);
};

function ids(modelID, type) {
  const v = api.GetLineIDsWithType(modelID, type, false);
  const a = new Array(v.size());
  for (let i = 0; i < a.length; i++) a[i] = v.get(i);
  return a;
}

function safeLine(modelID, id) {
  try { return api.GetLine(modelID, id, false); } catch { return null; }
}

const PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 0.001, MICRO: 1e-6, NANO: 1e-9 };
const PREFIX_SYM = { KILO: 'k', HECTO: 'h', DECI: 'd', CENTI: 'c', MILLI: 'm', MICRO: 'µ' };
const SI_SYM = { METRE: 'm', SQUARE_METRE: 'm²', CUBIC_METRE: 'm³', GRAM: 'g', SECOND: 's', RADIAN: 'rad', DEGREE_CELSIUS: '°C', KELVIN: 'K', WATT: 'W', PASCAL: 'Pa', NEWTON: 'N', JOULE: 'J', VOLT: 'V', AMPERE: 'A', HERTZ: 'Hz', LUMEN: 'lm', LUX: 'lx' };

function readUnits(modelID) {
  const units = { length: 'm', area: 'm²', volume: 'm³', angle: 'rad', mass: 'kg', lengthScale: 1 };
  try {
    const proj = ids(modelID, WebIFC.IFCPROJECT)[0];
    const p = api.GetLine(modelID, proj, false);
    const ua = api.GetLine(modelID, refId(p.UnitsInContext), false);
    for (const u of ua.Units || []) {
      const unit = safeLine(modelID, refId(u));
      if (!unit) continue;
      const type = str(unit.UnitType);
      const kind = upperName(api.GetLineType(modelID, refId(u)));
      let sym = '', scale = 1;
      if (kind === 'IFCSIUNIT') {
        const pre = unit.Prefix ? str(unit.Prefix) : '';
        const name = str(unit.Name);
        const base = SI_SYM[name] || name.toLowerCase();
        if (name === 'SQUARE_METRE') sym = `${PREFIX_SYM[pre] || ''}m²`;
        else if (name === 'CUBIC_METRE') sym = `${PREFIX_SYM[pre] || ''}m³`;
        else sym = `${PREFIX_SYM[pre] || ''}${base}`;
        scale = PREFIX[pre] || 1;
      } else if (kind === 'IFCCONVERSIONBASEDUNIT' && unit.ConversionFactor) {
        sym = str(unit.Name).toLowerCase();
        const mwu = safeLine(modelID, refId(unit.ConversionFactor));
        if (mwu) {
          scale = Number(val(mwu.ValueComponent)) || 1;
          // e.g. foot = 304.8 MILLIMETRE: apply the prefix of the base unit
          const base = mwu.UnitComponent ? safeLine(modelID, refId(mwu.UnitComponent)) : null;
          if (base && base.Prefix) scale *= PREFIX[str(base.Prefix)] || 1;
        }
        if (sym === 'foot') sym = 'ft';
        if (sym === 'inch') sym = 'in';
        if (sym === 'degree') sym = '°';
      }
      if (type === 'LENGTHUNIT') { units.length = sym; units.lengthScale = scale; }
      else if (type === 'AREAUNIT') units.area = sym;
      else if (type === 'VOLUMEUNIT') units.volume = sym;
      else if (type === 'PLANEANGLEUNIT') units.angle = sym;
      else if (type === 'MASSUNIT') units.mass = sym;
    }
  } catch { /* keep defaults */ }
  return units;
}

function measureUnit(units, typeName) {
  const n = (typeName || '').toUpperCase();
  if (n.includes('LENGTHMEASURE')) return units.length;
  if (n.includes('AREAMEASURE')) return units.area;
  if (n.includes('VOLUMEMEASURE')) return units.volume;
  if (n.includes('PLANEANGLEMEASURE')) return units.angle;
  if (n.includes('MASSMEASURE')) return units.mass;
  if (n.includes('THERMALTRANSMITTANCE')) return 'W/(m²K)';
  if (n.includes('THERMODYNAMICTEMPERATURE')) return '°C';
  if (n.includes('POWERMEASURE')) return 'W';
  return '';
}

function plainValue(v) {
  if (v === null || v === undefined) return null;
  const raw = val(v);
  const name = (v && v.name) || '';
  if (name === 'IFCBOOLEAN' || typeof raw === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).toUpperCase();
    return s === 'T' || s === 'TRUE' || s === '.T.';
  }
  if (name === 'IFCLOGICAL') {
    const s = String(raw).toUpperCase();
    if (s === 'T' || s === 'TRUE') return true;
    if (s === 'F' || s === 'FALSE') return false;
    return 'UNKNOWN';
  }
  if (typeof raw === 'number') return raw;
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((x) => val(x)).join(', ');
  return String(raw);
}

// ---------------------------------------------------------------------------

let api = null;
let WebIFC = null;
let progress = () => {};

/** Parse an IFC file: merged geometry chunks + metadata (runs in the worker, testable in Node). */
export function parseIfc(ifcApi, webIfc, { buffer, fileName, offset, edges }, onProgress) {
  api = ifcApi;
  WebIFC = webIfc;
  progress = (id, phase, value) => onProgress?.(phase, value);
  const id = 0;
  if (!properNames.size) initNames();
  progress(id, 'parse', 0);
  const data = new Uint8Array(buffer);
  const modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: false, CIRCLE_SEGMENTS: 16 });
  if (modelID < 0) throw new Error('IFC-Datei konnte nicht geöffnet werden');
  try {
    return parseModel(modelID, fileName, offset, edges, id);
  } finally {
    // also after an error, so a failed file does not stay in the wasm heap
    api.CloseModel(modelID);
  }
}

function parseModel(modelID, fileName, offset, edges, id) {
  const schema = api.GetModelSchema(modelID);
  const units = readUnits(modelID);

  // Element index assignment: every element (with or without geometry) gets a
  // dense local index. Geometry elements are registered first while streaming.
  const eidMap = new Map();
  const order = [];
  const eidOf = (expressID) => {
    let e = eidMap.get(expressID);
    if (e === undefined) { e = order.length; eidMap.set(expressID, e); order.push(expressID); }
    return e;
  };

  const geo = new GeometryBuilder(offset || null, edges !== false);
  let lastP = 0;
  api.StreamAllMeshes(modelID, (mesh, index, total) => {
    geo.addMesh(modelID, mesh, eidOf);
    const p = total ? index / total : 0;
    if (p - lastP > 0.02) { lastP = p; progress(id, 'geometry', p); }
  });
  // Spaces and openings are hidden by default but must be available.
  const extraTypes = [WebIFC.IFCSPACE, WebIFC.IFCOPENINGELEMENT, WebIFC.IFCOPENINGSTANDARDCASE].filter(Boolean);
  api.StreamAllMeshesWithTypes(modelID, extraTypes, (mesh) => {
    if (!geo.ranges.has(mesh.expressID)) geo.addMesh(modelID, mesh, eidOf);
  });
  geo.cache.clear();
  progress(id, 'properties', 0);

  const meta = extractMeta(modelID, schema, units, eidOf, order, id);
  const chunks = geo.finish();

  // Per element: bounding box, ranges, volume.
  const count = order.length;
  const bboxes = new Float32Array(count * 6);
  bboxes.fill(NaN);
  const ranges = new Array(count).fill(null);
  for (const [expressID, list] of geo.ranges) {
    const e = eidMap.get(expressID);
    ranges[e] = list;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let vol = 0, area = 0;
    for (const r of list) {
      const c = chunks[r.chunk];
      const P = c.position, I = c.index;
      for (let v = r.vStart; v < r.vStart + r.vCount; v++) {
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
        if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
      }
      for (let t = r.iStart; t < r.iStart + r.iCount; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, cc = I[t + 2] * 3;
        const ax = P[a], ay = P[a + 1], az = P[a + 2];
        const bx = P[b], by = P[b + 1], bz = P[b + 2];
        const cx = P[cc], cy = P[cc + 1], cz = P[cc + 2];
        vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      }
    }
    bboxes.set([minX, minY, minZ, maxX, maxY, maxZ], e * 6);
    const el = meta.elements[e];
    el.volume = Math.abs(vol);
    el.area = area;
  }

  progress(id, 'done', 1);
  return {
    fileName, schema, units, offset: geo.offset || [0, 0, 0],
    chunks, bboxes, ranges, ...meta,
  };
}

function extractMeta(modelID, schema, units, eidOf, order, reqId) {
  const sIdx = schemaIndex(schema);
  const supersMap = supersFor(sIdx);
  const L = (id) => safeLine(modelID, id);
  const lscale = units.lengthScale || 1;

  const parent = new Map(); // child expressID -> parent expressID
  const typeOf = new Map(); // element -> type object id
  const psetsOf = new Map(); // element -> [pset index]
  const matsOf = new Map(); // element -> material info index
  const classOf = new Map(); // element -> [classification index]
  const groupsOf = new Map(); // element -> [group index]
  const push = (map, k, v) => { let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(v); };

  // Spatial structure / aggregation.
  for (const rid of ids(modelID, WebIFC.IFCRELAGGREGATES)) {
    const r = L(rid); if (!r) continue;
    const p = refId(r.RelatingObject);
    for (const c of r.RelatedObjects || []) parent.set(refId(c), p);
  }
  for (const rid of ids(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
    const r = L(rid); if (!r) continue;
    const p = refId(r.RelatingStructure);
    for (const c of r.RelatedElements || []) if (!parent.has(refId(c))) parent.set(refId(c), p);
  }
  const voidHost = new Map(); // opening -> host element
  for (const rid of ids(modelID, WebIFC.IFCRELVOIDSELEMENT)) {
    const r = L(rid); if (!r) continue;
    parent.set(refId(r.RelatedOpeningElement), refId(r.RelatingBuildingElement));
    voidHost.set(refId(r.RelatedOpeningElement), refId(r.RelatingBuildingElement));
  }
  const fillHost = new Map(); // door/window -> wall whose opening it fills
  for (const rid of ids(modelID, WebIFC.IFCRELFILLSELEMENT)) {
    const r = L(rid); if (!r) continue;
    const host = voidHost.get(refId(r.RelatingOpeningElement));
    if (host !== undefined) fillHost.set(refId(r.RelatedBuildingElement), host);
  }
  if (WebIFC.IFCRELNESTS) {
    for (const rid of ids(modelID, WebIFC.IFCRELNESTS)) {
      const r = L(rid); if (!r) continue;
      const p = refId(r.RelatingObject);
      for (const c of r.RelatedObjects || []) {
        const cid = refId(c);
        if (parent.has(cid)) continue;
        const code = api.GetLineType(modelID, cid);
        if (upperName(code).includes('PORT')) continue;
        parent.set(cid, p);
      }
    }
  }

  // Types
  const types = new Map(); // type id -> {name, cls, psets:[]}
  for (const rid of ids(modelID, WebIFC.IFCRELDEFINESBYTYPE)) {
    const r = L(rid); if (!r) continue;
    const t = refId(r.RelatingType);
    for (const c of r.RelatedObjects || []) typeOf.set(refId(c), t);
  }

  // Property sets
  const psets = [];
  const psetIndex = new Map();
  const readProps = (list, out, prefix = '') => {
    for (const pr of list || []) {
      const p = L(refId(pr)); if (!p) continue;
      const name = prefix + str(p.Name);
      if (p.NominalValue !== undefined) {
        out.push([name, plainValue(p.NominalValue), measureUnit(units, p.NominalValue && p.NominalValue.name)]);
      } else if (p.EnumerationValues !== undefined) {
        out.push([name, (p.EnumerationValues || []).map((x) => val(x)).join(', '), '']);
      } else if (p.ListValues !== undefined) {
        out.push([name, (p.ListValues || []).map((x) => val(x)).join(', '), '']);
      } else if (p.UpperBoundValue !== undefined || p.LowerBoundValue !== undefined) {
        const lo = plainValue(p.LowerBoundValue), hi = plainValue(p.UpperBoundValue);
        out.push([name, `${lo ?? ''} – ${hi ?? ''}`, measureUnit(units, (p.UpperBoundValue || p.LowerBoundValue || {}).name)]);
      } else if (p.HasProperties !== undefined) {
        readProps(p.HasProperties, out, `${name}.`);
      } else if (p.LengthValue !== undefined) {
        out.push([name, Number(val(p.LengthValue)), units.length]);
      } else if (p.AreaValue !== undefined) {
        out.push([name, Number(val(p.AreaValue)), units.area]);
      } else if (p.VolumeValue !== undefined) {
        out.push([name, Number(val(p.VolumeValue)), units.volume]);
      } else if (p.CountValue !== undefined) {
        out.push([name, Number(val(p.CountValue)), '']);
      } else if (p.WeightValue !== undefined) {
        out.push([name, Number(val(p.WeightValue)), units.mass]);
      } else if (p.TimeValue !== undefined) {
        out.push([name, Number(val(p.TimeValue)), 's']);
      } else if (p.HasQuantities !== undefined) {
        readProps(p.HasQuantities, out, `${name}.`);
      }
    }
  };
  const psetFor = (id, fromType) => {
    const key = `${id}:${fromType ? 1 : 0}`;
    if (psetIndex.has(key)) return psetIndex.get(key);
    const ps = L(id);
    let idx = -1;
    if (ps && (ps.HasProperties !== undefined || ps.Quantities !== undefined)) {
      const props = [];
      readProps(ps.HasProperties || ps.Quantities, props);
      idx = psets.length;
      psets.push({ n: str(ps.Name) || '(ohne Name)', p: props, q: ps.Quantities !== undefined ? 1 : 0, t: fromType ? 1 : 0 });
    }
    psetIndex.set(key, idx);
    return idx;
  };

  const relProps = ids(modelID, WebIFC.IFCRELDEFINESBYPROPERTIES);
  relProps.forEach((rid, i) => {
    if (i % 2000 === 0) progress(reqId, 'properties', relProps.length ? i / relProps.length : 1);
    const r = L(rid); if (!r) return;
    const defs = r.RelatingPropertyDefinition;
    const list = Array.isArray(defs) ? defs : [defs];
    for (const d of list) {
      const idx = psetFor(refId(d), false);
      if (idx < 0) continue;
      for (const c of r.RelatedObjects || []) push(psetsOf, refId(c), idx);
    }
  });

  const typeInfo = (tid) => {
    if (types.has(tid)) return types.get(tid);
    const t = L(tid);
    const info = { name: t ? str(t.Name) : '', cls: t ? className(api.GetLineType(modelID, tid)) : '', psets: [], predef: t ? str(t.PredefinedType) : '' };
    if (t && t.HasPropertySets) for (const p of t.HasPropertySets) { const i = psetFor(refId(p), true); if (i >= 0) info.psets.push(i); }
    types.set(tid, info);
    return info;
  };

  // Materials
  const materials = []; // [{names:[...], layers:[{name, thickness}]}]
  const matCache = new Map();
  const matName = (id) => { const m = L(id); return m ? str(m.Name) : ''; };
  const resolveMat = (id) => {
    if (matCache.has(id)) return matCache.get(id);
    const m = L(id);
    const info = { names: [], layers: [] };
    const cls = m ? upperName(api.GetLineType(modelID, id)) : '';
    const addLayerSet = (lsId) => {
      const ls = L(lsId); if (!ls) return;
      if (ls.LayerSetName) info.set = str(ls.LayerSetName);
      for (const lr of ls.MaterialLayers || []) {
        const layer = L(refId(lr)); if (!layer) continue;
        const nm = layer.Material ? matName(refId(layer.Material)) : str(layer.Name);
        info.layers.push({ name: nm, thickness: Number(val(layer.LayerThickness)) || 0 });
        info.names.push(nm);
      }
    };
    if (!m) { /* nothing */ } else if (cls === 'IFCMATERIAL') info.names.push(str(m.Name));
    else if (cls === 'IFCMATERIALLIST') for (const x of m.Materials || []) info.names.push(matName(refId(x)));
    else if (cls === 'IFCMATERIALLAYERSETUSAGE') addLayerSet(refId(m.ForLayerSet));
    else if (cls === 'IFCMATERIALLAYERSET') addLayerSet(id);
    else if (cls === 'IFCMATERIALLAYER') info.names.push(m.Material ? matName(refId(m.Material)) : str(m.Name));
    else if (cls === 'IFCMATERIALPROFILESETUSAGE') {
      const ps = L(refId(m.ForProfileSet));
      for (const pr of (ps && ps.MaterialProfiles) || []) { const p = L(refId(pr)); if (p && p.Material) info.names.push(matName(refId(p.Material))); }
    } else if (cls === 'IFCMATERIALPROFILESET') {
      for (const pr of m.MaterialProfiles || []) { const p = L(refId(pr)); if (p && p.Material) info.names.push(matName(refId(p.Material))); }
    } else if (cls === 'IFCMATERIALCONSTITUENTSET') {
      for (const cr of m.MaterialConstituents || []) { const c = L(refId(cr)); if (c && c.Material) info.names.push(matName(refId(c.Material))); }
    } else if (m.Name) info.names.push(str(m.Name));
    info.names = [...new Set(info.names.filter(Boolean))];
    const idx = materials.length;
    materials.push(info);
    matCache.set(id, idx);
    return idx;
  };
  for (const rid of ids(modelID, WebIFC.IFCRELASSOCIATESMATERIAL)) {
    const r = L(rid); if (!r) continue;
    const idx = resolveMat(refId(r.RelatingMaterial));
    for (const c of r.RelatedObjects || []) matsOf.set(refId(c), idx);
  }

  // Classifications
  const classes = [];
  for (const rid of ids(modelID, WebIFC.IFCRELASSOCIATESCLASSIFICATION)) {
    const r = L(rid); if (!r) continue;
    const ref = L(refId(r.RelatingClassification)); if (!ref) continue;
    let system = '';
    const src = ref.ReferencedSource ? L(refId(ref.ReferencedSource)) : null;
    if (src) system = str(src.Name);
    const code = str(ref.Identification !== undefined ? ref.Identification : ref.ItemReference);
    const idx = classes.length;
    classes.push({ system: system || str(ref.Name), code, name: str(ref.Name) });
    for (const c of r.RelatedObjects || []) push(classOf, refId(c), idx);
  }

  // Groups / systems / zones
  const groups = [];
  const groupIdx = new Map();
  for (const rid of ids(modelID, WebIFC.IFCRELASSIGNSTOGROUP)) {
    const r = L(rid); if (!r) continue;
    const gid = refId(r.RelatingGroup);
    if (!groupIdx.has(gid)) {
      const g = L(gid);
      groupIdx.set(gid, groups.length);
      groups.push({ name: g ? str(g.Name) : '', cls: className(api.GetLineType(modelID, gid)) });
    }
    for (const c of r.RelatedObjects || []) push(groupsOf, refId(c), groupIdx.get(gid));
  }

  // Register spatial nodes and all related objects so they get an index.
  const projectIds = ids(modelID, WebIFC.IFCPROJECT);
  for (const p of projectIds) eidOf(p);
  const spatialTypes = [WebIFC.IFCSITE, WebIFC.IFCBUILDING, WebIFC.IFCBUILDINGSTOREY, WebIFC.IFCSPACE];
  for (const t of spatialTypes) for (const i of ids(modelID, t)) eidOf(i);
  for (const [child, p] of parent) { eidOf(p); eidOf(child); }

  const project = projectIds.length ? L(projectIds[0]) : null;
  const elements = [];
  for (let e = 0; e < order.length; e++) {
    if (e % 5000 === 0) progress(reqId, 'elements', e / order.length);
    const id = order[e];
    const line = L(id);
    const code = api.GetLineType(modelID, id);
    const cls = className(code);
    const supers = [cls];
    const stack = [code];
    const seen = new Set();
    while (stack.length) {
      const c = stack.pop();
      for (const s of supersMap.get(c) || []) {
        if (seen.has(s)) continue;
        seen.add(s);
        supers.push(className(s));
        stack.push(s);
      }
    }
    const el = {
      id, cls, supers,
      guid: line ? str(line.GlobalId) : '',
      name: line ? str(line.Name) : '',
      desc: line ? str(line.Description) : '',
      objType: line ? str(line.ObjectType) : '',
      tag: line ? str(line.Tag) : '',
      longName: line ? str(line.LongName) : '',
      predef: line ? str(line.PredefinedType) : '',
      parent: parent.has(id) ? eidOf(parent.get(id)) : -1,
      psets: psetsOf.get(id) || [],
      typeName: '', typeCls: '', typePsets: [],
      mat: matsOf.has(id) ? matsOf.get(id) : -1,
      classes: classOf.get(id) || [],
      groups: groupsOf.get(id) || [],
      elevation: null,
      host: fillHost.has(id) ? eidOf(fillHost.get(id)) : -1,
    };
    if (cls === 'IfcBuildingStorey' && line) {
      const ev = Number(val(line.Elevation));
      el.elevation = Number.isFinite(ev) ? ev * lscale : null;
      try {
        if (line.ObjectPlacement) {
          const m = api.GetWorldTransformMatrix(modelID, refId(line.ObjectPlacement));
          if (m && m.length === 16) el.placementZ = m[14] * lscale;
        }
      } catch { /* optional */ }
    }
    if (typeOf.has(id)) {
      const t = typeInfo(typeOf.get(id));
      el.typeName = t.name;
      el.typeCls = t.cls;
      el.typePsets = t.psets;
      if (el.mat < 0 && matsOf.has(typeOf.get(id))) el.mat = matsOf.get(typeOf.get(id));
      // IFC2x3 MEP: IfcFlowSegment + IfcPipeSegmentType -> also an IfcPipeSegment.
      if (t.cls.endsWith('Type') && t.cls !== 'IfcTypeObject') {
        const occ = t.cls.slice(0, -4);
        if (!supers.includes(occ)) supers.push(occ);
      }
      if (!el.predef && t.predef) el.predef = t.predef;
    }
    if (el.predef === 'NOTDEFINED' || el.predef === 'USERDEFINED') el.predef = el.predef === 'USERDEFINED' && el.objType ? el.objType : '';
    elements.push(el);
  }

  // Elements created after the loop (parents referenced late) were appended to
  // order while iterating, so the loop above already covered them.
  const header = {};
  try {
    const fn = api.GetHeaderLine(modelID, WebIFC.FILE_NAME);
    if (fn && fn.arguments) {
      const a = fn.arguments;
      header.date = str(a[1]);
      header.author = Array.isArray(a[2]) ? a[2].map(str).join(', ') : str(a[2]);
      header.organization = Array.isArray(a[3]) ? a[3].map(str).join(', ') : str(a[3]);
      header.application = str(a[5]);
    }
  } catch { /* optional */ }

  return {
    elements, psets, materials, classes, groups, header,
    project: project ? { name: str(project.Name), longName: str(project.LongName), phase: str(project.Phase), desc: str(project.Description) } : {},
  };
}
