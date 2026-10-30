#!/usr/bin/env node
/**
 * Generates two deterministic IFC4 demo models (plain STEP text) for the viewer:
 *
 *   public/demo/Demo_Architektur.ifc  – small 3-storey office building (20 m x 12 m)
 *   public/demo/Demo_HLS.ifc          – MEP model aligned with the same building
 *
 * The HLS model deliberately clashes with the architecture (ducts/pipes through
 * beams and walls, a cable tray through a column) and contains two near misses.
 * A summary of all clashes – computed from the axis-aligned boxes of both
 * models – is printed at the end of the run.
 *
 * Usage: node scripts/generate-demo-ifc.mjs
 * No dependencies besides Node built-ins. Output is byte-for-byte deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'demo');

// Fixed timestamps keep the output deterministic.
const TIMESTAMP_ISO = '2026-01-15T09:00:00';
const TIMESTAMP_UNIX = 1768467600; // 2026-01-15T09:00:00Z

// ---------------------------------------------------------------------------
// Deterministic GlobalIds
// ---------------------------------------------------------------------------

const IFC_B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function b64(value, digits) {
  let s = '';
  for (let i = digits - 1; i >= 0; i--) s += IFC_B64[(value >>> (6 * i)) & 63];
  return s;
}

/** Returns a function producing unique 22-char IFC GlobalIds (compressed UUID v4) from a seeded PRNG. */
function guidFactory(seed) {
  const rnd = mulberry32(seed);
  const used = new Set();
  return () => {
    for (;;) {
      const b = new Array(16);
      for (let i = 0; i < 16; i++) b[i] = Math.floor(rnd() * 256);
      b[6] = (b[6] & 0x0f) | 0x40; // UUID version 4
      b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
      let s = b64(b[0], 2);
      for (let i = 1; i < 16; i += 3) s += b64((b[i] << 16) | (b[i + 1] << 8) | b[i + 2], 4);
      if (!used.has(s)) {
        used.add(s);
        return s;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// STEP (ISO 10303-21) encoding
// ---------------------------------------------------------------------------

class Ref {
  constructor(id) {
    this.id = id;
  }
}
const raw = (s) => ({ raw: s });
const STAR = raw('*');
const enumv = (v) => raw(`.${v}.`);
const int = (n) => {
  if (!Number.isInteger(n)) throw new Error(`Not an integer: ${n}`);
  return raw(String(n));
};
const typed = (type, v) => raw(`${type}(${fmt(v)})`);

function round6(x) {
  const v = Math.round(x * 1e6) / 1e6;
  return Object.is(v, -0) ? 0 : v;
}

function fmtReal(x) {
  if (!Number.isFinite(x)) throw new Error(`Invalid REAL: ${x}`);
  let s = String(round6(x));
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    s = `${m.includes('.') ? m : `${m}.`}E${e}`;
  } else if (!s.includes('.')) {
    s += '.';
  }
  return s;
}

/** Encodes a JS string as STEP string literal: '' for apostrophes, \\ for backslashes, \X2\....\X0\ for non-ASCII. */
function fmtString(s) {
  const chars = [...s];
  let out = '';
  const printable = (c) => {
    const cp = c.codePointAt(0);
    return cp >= 0x20 && cp <= 0x7e;
  };
  for (let k = 0; k < chars.length; ) {
    const c = chars[k];
    if (printable(c)) {
      out += c === "'" ? "''" : c === '\\' ? '\\\\' : c;
      k++;
      continue;
    }
    let hex = '';
    while (k < chars.length && !printable(chars[k])) {
      const cp = chars[k].codePointAt(0);
      if (cp > 0xffff) throw new Error(`Character outside BMP not supported: ${chars[k]}`);
      hex += cp.toString(16).toUpperCase().padStart(4, '0');
      k++;
    }
    out += `\\X2\\${hex}\\X0\\`;
  }
  return `'${out}'`;
}

function fmt(v) {
  if (v === null || v === undefined) return '$';
  if (v instanceof Ref) return `#${v.id}`;
  if (typeof v === 'number') return fmtReal(v);
  if (typeof v === 'boolean') return v ? '.T.' : '.F.';
  if (typeof v === 'string') return fmtString(v);
  if (Array.isArray(v)) return `(${v.map(fmt).join(',')})`;
  if (typeof v === 'object' && 'raw' in v) return v.raw;
  throw new Error(`Cannot encode value: ${JSON.stringify(v)}`);
}

class StepFile {
  constructor() {
    this.lines = [];
    this.next = 1;
    this.cache = new Map();
    this.typeCounts = new Map();
  }

  add(type, ...args) {
    const id = this.next++;
    this.lines.push(`#${id}=${type}(${args.map(fmt).join(',')});`);
    this.typeCounts.set(type, (this.typeCounts.get(type) ?? 0) + 1);
    return new Ref(id);
  }

  cached(key, create) {
    if (!this.cache.has(key)) this.cache.set(key, create());
    return this.cache.get(key);
  }

  serialize({ fileName, description }) {
    const header = [
      'ISO-10303-21;',
      'HEADER;',
      `FILE_DESCRIPTION((${fmtString('ViewDefinition [ReferenceView_V1.2]')}),'2;1');`,
      `FILE_NAME(${fmtString(fileName)},${fmtString(TIMESTAMP_ISO)},(${fmtString('OpenZoom Demo')}),(${fmtString(
        'OpenZoom',
      )}),${fmtString('generate-demo-ifc.mjs')},${fmtString('OpenZoom Demo-IFC-Generator 1.0')},${fmtString(description)});`,
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
    ];
    return [...header, ...this.lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
  }
}

// Typed property values
const V = {
  label: (s) => typed('IFCLABEL', s),
  id: (s) => typed('IFCIDENTIFIER', s),
  text: (s) => typed('IFCTEXT', s),
  bool: (b) => typed('IFCBOOLEAN', !!b),
  real: (x) => typed('IFCREAL', x),
  len: (x) => typed('IFCLENGTHMEASURE', x),
  plen: (x) => typed('IFCPOSITIVELENGTHMEASURE', x),
  area: (x) => typed('IFCAREAMEASURE', x),
  uval: (x) => typed('IFCTHERMALTRANSMITTANCEMEASURE', x),
  ratio: (x) => typed('IFCPOSITIVERATIOMEASURE', x),
  count: (n) => typed('IFCCOUNTMEASURE', int(n)),
  pressure: (x) => typed('IFCPRESSUREMEASURE', x),
};

const money = (x) => Math.round(x * 100) / 100;
const asArray = (x) => (Array.isArray(x) ? x : [x]);

// ---------------------------------------------------------------------------
// IFC model builder (shared by both models)
// ---------------------------------------------------------------------------

class IfcBuilder {
  constructor({ seed }) {
    this.f = new StepFile();
    this.guid = guidFactory(seed);
    this.relMaps = {
      contained: new Map(),
      type: new Map(),
      material: new Map(),
      classification: new Map(),
    };
    this.types = [];
    this.tagCounter = 0;
  }

  // -- geometry resources ---------------------------------------------------
  pt(...c) {
    const r = c.map(round6);
    return this.f.cached(`P${r.join(',')}`, () => this.f.add('IFCCARTESIANPOINT', r));
  }

  dir(...c) {
    const r = c.map(round6);
    return this.f.cached(`D${r.join(',')}`, () => this.f.add('IFCDIRECTION', r));
  }

  /** IfcAxis2Placement3D; Axis and RefDirection are either both given or both omitted (IFC4 rule). */
  ax3(loc = [0, 0, 0], zAxis = null, xAxis = null) {
    if (xAxis && !zAxis) zAxis = [0, 0, 1];
    if (zAxis && !xAxis) throw new Error('ax3: RefDirection required when Axis is given');
    const key = `A3${loc.map(round6).join(',')}|${zAxis ?? ''}|${xAxis ?? ''}`;
    return this.f.cached(key, () =>
      this.f.add('IFCAXIS2PLACEMENT3D', this.pt(...loc), zAxis ? this.dir(...zAxis) : null, xAxis ? this.dir(...xAxis) : null),
    );
  }

  ax2(loc = [0, 0]) {
    return this.f.cached(`A2${loc.map(round6).join(',')}`, () => this.f.add('IFCAXIS2PLACEMENT2D', this.pt(...loc), null));
  }

  placement(relTo, loc = [0, 0, 0], xAxis = null) {
    return this.f.add('IFCLOCALPLACEMENT', relTo, this.ax3(loc, null, xAxis));
  }

  rectProfile(xDim, yDim, cx = 0, cy = 0) {
    const key = `RP${[xDim, yDim, cx, cy].map(round6).join(',')}`;
    return this.f.cached(key, () => this.f.add('IFCRECTANGLEPROFILEDEF', enumv('AREA'), null, this.ax2([cx, cy]), xDim, yDim));
  }

  circleProfile(radius) {
    return this.f.cached(`CP${round6(radius)}`, () => this.f.add('IFCCIRCLEPROFILEDEF', enumv('AREA'), null, this.ax2([0, 0]), radius));
  }

  polyline(points2d) {
    const pts = ccw(points2d).map(([x, y]) => this.pt(x, y));
    return this.f.add('IFCPOLYLINE', [...pts, pts[0]]);
  }

  polyProfile(points2d) {
    return this.f.add('IFCARBITRARYCLOSEDPROFILEDEF', enumv('AREA'), null, this.polyline(points2d));
  }

  polyProfileWithVoids(outer, holes) {
    return this.f.add(
      'IFCARBITRARYPROFILEDEFWITHVOIDS',
      enumv('AREA'),
      null,
      this.polyline(outer),
      holes.map((h) => this.polyline(h)),
    );
  }

  extrude(profile, position, depth, direction = [0, 0, 1]) {
    return this.f.add('IFCEXTRUDEDAREASOLID', profile, position, this.dir(...direction), depth);
  }

  /** Vertical extrusion of an axis-aligned box given in coordinates relative to the element placement. */
  boxSolid(x0, x1, y0, y1, z0, z1) {
    const prof = this.rectProfile(x1 - x0, y1 - y0, (x0 + x1) / 2, (y0 + y1) / 2);
    return this.extrude(prof, this.ax3([0, 0, z0]), z1 - z0);
  }

  // -- presentation ---------------------------------------------------------
  surfaceStyle(name, [r, g, b], transparency = 0) {
    return this.f.cached(`STYLE${name}`, () => {
      const colour = this.f.add('IFCCOLOURRGB', null, r, g, b);
      const rendering = this.f.add(
        'IFCSURFACESTYLERENDERING',
        colour,
        transparency,
        null,
        null,
        null,
        null,
        null,
        null,
        enumv('NOTDEFINED'),
      );
      return this.f.add('IFCSURFACESTYLE', name, enumv('BOTH'), [rendering]);
    });
  }

  /** Body representation; items is an array of solids or [solid, style] pairs. */
  body(items, style = null) {
    const solids = [];
    for (const it of items) {
      const [solid, st] = Array.isArray(it) ? it : [it, style];
      if (st) this.f.add('IFCSTYLEDITEM', solid, [st], null);
      solids.push(solid);
    }
    const rep = this.f.add('IFCSHAPEREPRESENTATION', this.bodyCtx, 'Body', 'SweptSolid', solids);
    return this.f.add('IFCPRODUCTDEFINITIONSHAPE', null, null, [rep]);
  }

  // -- objects ----------------------------------------------------------------
  /** Any IfcElement subtype: GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, Tag, ...extra */
  element(type, { name, description = null, objectType = null, placement, shape = null, tag = undefined, extra = [] }) {
    const t = tag === undefined ? `E${String(++this.tagCounter).padStart(4, '0')}` : tag;
    return this.f.add(type, this.guid(), this.oh, name, description, objectType, placement, shape, t, ...extra);
  }

  /** Type object: GlobalId, OwnerHistory, Name, Description, ApplicableOccurrence, HasPropertySets, RepresentationMaps, Tag, ElementType, PredefinedType, ...extra */
  typeObject(type, name, predefined, { description = null, psets = [], extra = [] } = {}) {
    const ref = this.f.add(
      type,
      this.guid(),
      this.oh,
      name,
      description,
      null,
      psets.length ? psets : null,
      null,
      null,
      name,
      enumv(predefined),
      ...extra,
    );
    this.types.push(ref);
    return ref;
  }

  propertySet(name, props) {
    const refs = props
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([n, v]) => this.f.add('IFCPROPERTYSINGLEVALUE', n, null, v, null));
    return this.f.add('IFCPROPERTYSET', this.guid(), this.oh, name, null, refs);
  }

  pset(objects, name, props) {
    const ps = this.propertySet(name, props);
    this.f.add('IFCRELDEFINESBYPROPERTIES', this.guid(), this.oh, null, null, asArray(objects), ps);
    return ps;
  }

  /** quantities: [name, 'L'|'A'|'V', value] – lengths in mm, areas in m², volumes in m³ */
  qto(objects, name, quantities) {
    const kinds = { L: 'IFCQUANTITYLENGTH', A: 'IFCQUANTITYAREA', V: 'IFCQUANTITYVOLUME' };
    const refs = quantities.map(([n, k, v]) => this.f.add(kinds[k], n, null, null, v, null));
    const eq = this.f.add('IFCELEMENTQUANTITY', this.guid(), this.oh, name, null, null, refs);
    this.f.add('IFCRELDEFINESBYPROPERTIES', this.guid(), this.oh, null, null, asArray(objects), eq);
    return eq;
  }

  projectData(el, centreX, gewerk, kosten) {
    this.pset(el, 'Demo_Projektdaten', [
      ['Bauabschnitt', V.label(centreX < 10000 ? 'BA1' : 'BA2')],
      ['Gewerk', V.label(gewerk)],
      ['Kosten', V.real(money(kosten))],
    ]);
  }

  // -- batched relationships ----------------------------------------------------
  collect(mapName, key, item) {
    const m = this.relMaps[mapName];
    if (!m.has(key.id)) m.set(key.id, { key, items: [] });
    m.get(key.id).items.push(item);
  }
  contain(storey, el) {
    this.collect('contained', storey, el);
  }
  setType(type, el) {
    this.collect('type', type, el);
  }
  setMaterial(mat, el) {
    this.collect('material', mat, el);
  }
  classify(ref, el) {
    this.collect('classification', ref, el);
  }

  aggregate(whole, parts) {
    this.f.add('IFCRELAGGREGATES', this.guid(), this.oh, null, null, whole, asArray(parts));
  }

  material(name, category) {
    return this.f.cached(`MAT${name}`, () => this.f.add('IFCMATERIAL', name, null, category));
  }

  classificationRef(code, name) {
    return this.f.cached(`CLS${code}`, () => this.f.add('IFCCLASSIFICATIONREFERENCE', null, code, name, this.din276, null, null));
  }

  flushRelations() {
    const f = this.f;
    for (const { key, items } of this.relMaps.contained.values())
      f.add('IFCRELCONTAINEDINSPATIALSTRUCTURE', this.guid(), this.oh, null, null, items, key);
    for (const { key, items } of this.relMaps.type.values()) f.add('IFCRELDEFINESBYTYPE', this.guid(), this.oh, null, null, items, key);
    for (const { key, items } of this.relMaps.material.values())
      f.add('IFCRELASSOCIATESMATERIAL', this.guid(), this.oh, null, null, items, key);
    for (const { key, items } of this.relMaps.classification.values())
      f.add('IFCRELASSOCIATESCLASSIFICATION', this.guid(), this.oh, null, null, items, key);
    if (this.types.length) f.add('IFCRELDECLARES', this.guid(), this.oh, null, null, this.project, this.types);
  }

  // -- project / spatial structure ---------------------------------------------
  setupProject({ description, storeys }) {
    const f = this.f;
    const person = f.add('IFCPERSON', null, 'Demo', 'OpenZoom', null, null, null, null, null);
    const org = f.add('IFCORGANIZATION', null, 'OpenZoom Demo', null, null, null);
    const pao = f.add('IFCPERSONANDORGANIZATION', person, org, null);
    const app = f.add('IFCAPPLICATION', org, '1.0', 'OpenZoom Demo-IFC-Generator', 'OpenZoomDemoGen');
    this.oh = f.add('IFCOWNERHISTORY', pao, app, null, enumv('NOCHANGE'), null, null, null, int(TIMESTAMP_UNIX));

    // Length in MILLIMETRE on purpose (tests unit scaling); area m², volume m³, angle radian.
    const units = f.add('IFCUNITASSIGNMENT', [
      f.add('IFCSIUNIT', STAR, enumv('LENGTHUNIT'), enumv('MILLI'), enumv('METRE')),
      f.add('IFCSIUNIT', STAR, enumv('AREAUNIT'), null, enumv('SQUARE_METRE')),
      f.add('IFCSIUNIT', STAR, enumv('VOLUMEUNIT'), null, enumv('CUBIC_METRE')),
      f.add('IFCSIUNIT', STAR, enumv('PLANEANGLEUNIT'), null, enumv('RADIAN')),
    ]);

    this.ctx = f.add('IFCGEOMETRICREPRESENTATIONCONTEXT', null, 'Model', int(3), 1e-5, this.ax3(), this.dir(0, 1));
    this.bodyCtx = f.add(
      'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
      'Body',
      'Model',
      STAR,
      STAR,
      STAR,
      STAR,
      this.ctx,
      null,
      enumv('MODEL_VIEW'),
      null,
    );

    this.project = f.add(
      'IFCPROJECT',
      this.guid(),
      this.oh,
      'Demo Projekt',
      description,
      null,
      'Demo Projekt Bürogebäude',
      'Entwurf',
      [this.ctx],
      units,
    );

    this.din276 = f.add('IFCCLASSIFICATION', 'DIN', '2018-12', null, 'DIN 276', 'Kosten im Bauwesen', null, null);

    const sitePl = this.placement(null);
    this.site = f.add(
      'IFCSITE',
      this.guid(),
      this.oh,
      'Grundstück',
      'Demo-Grundstück',
      null,
      sitePl,
      null,
      'Grundstück Musterstraße 1',
      enumv('ELEMENT'),
      [int(48), int(8), int(13), int(0)],
      [int(11), int(34), int(30), int(0)],
      432500,
      null,
      null,
    );
    const buildingPl = this.placement(sitePl);
    this.building = f.add(
      'IFCBUILDING',
      this.guid(),
      this.oh,
      'Bürogebäude',
      'Dreigeschossiges Bürogebäude',
      null,
      buildingPl,
      null,
      'Bürogebäude Demo',
      enumv('ELEMENT'),
      null,
      null,
      null,
    );
    this.storeys = storeys.map((s) => {
      const placement = this.placement(buildingPl, [0, 0, s.elev]);
      const ref = f.add(
        'IFCBUILDINGSTOREY',
        this.guid(),
        this.oh,
        s.key,
        null,
        null,
        placement,
        null,
        s.long,
        enumv('ELEMENT'),
        s.elev,
      );
      return { ...s, ref, placement };
    });
    this.aggregate(this.project, this.site);
    this.aggregate(this.site, this.building);
    this.aggregate(
      this.building,
      this.storeys.map((s) => s.ref),
    );
  }
}

function ccw(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    a += x0 * y1 - x1 * y0;
  }
  return a < 0 ? [...points].reverse() : points;
}

// ---------------------------------------------------------------------------
// Shared layout (storey-local millimetres; storey origin = building origin + elevation)
// ---------------------------------------------------------------------------

const STOREYS = [
  { key: 'EG', long: 'Erdgeschoss', elev: 0, idx: 0 },
  { key: '1.OG', long: '1. Obergeschoss', elev: 3200, idx: 1 },
  { key: '2.OG', long: '2. Obergeschoss', elev: 6400, idx: 2 },
  { key: 'Dach', long: 'Dachebene', elev: 9600, idx: 3 },
];
const FLOORS = STOREYS.slice(0, 3);

const SLAB_T = 250; // floor slab below storey elevation: z -250..0
const WALL_H = 2950; // walls up to the underside of the slab above (3200 - 250)
const BEAM_H = 500;
const BEAM_BOTTOM = WALL_H - BEAM_H; // 2450 = storey elevation + 3200 - 250 - 500
const CEILING_Z = [2300, 2320]; // suspended ceiling in the corridor (1.OG, 2.OG)

const WALLS = [
  { key: 'AW-S', name: 'Süd', ext: true, dir: 'x', sx: 0, sy: 150, len: 20000 },
  { key: 'AW-N', name: 'Nord', ext: true, dir: 'x', sx: 0, sy: 11850, len: 20000 },
  { key: 'AW-W', name: 'West', ext: true, dir: 'y', sx: 150, sy: 300, len: 11400 },
  { key: 'AW-O', name: 'Ost', ext: true, dir: 'y', sx: 19850, sy: 300, len: 11400 },
  { key: 'IW1', name: 'Flur Süd', ext: false, dir: 'x', sx: 300, sy: 4800, len: 19400 },
  { key: 'IW2', name: 'Flur Nord', ext: false, dir: 'x', sx: 300, sy: 7200, len: 19400 },
  { key: 'IW3', name: 'Trennwand Süd', ext: false, dir: 'y', sx: 7500, sy: 300, len: 4440 },
  { key: 'IW4', name: 'Trennwand Nord', ext: false, dir: 'y', sx: 12500, sy: 7260, len: 4440 },
];
// window centres as world coordinate along the wall axis
const WINDOWS = {
  'AW-S': [2500, 5500, 9500, 13000, 16500],
  'AW-N': [2500, 6000, 9500, 15000, 18000],
  'AW-W': [2500, 9500],
  'AW-O': [2500, 9500],
};
const WIN = { w: 1500, h: 1500, sill: 900 };
const DOORS = [
  { wall: 'IW1', at: 6500, room: '01' },
  { wall: 'IW1', at: 15000, room: '02' },
  { wall: 'IW2', at: 5800, room: '04' },
  { wall: 'IW2', at: 15000, room: '05' },
];
const DOOR = { w: 1010, h: 2135 };
const ENTRANCE = { wall: 'AW-W', at: 6000, w: 1260, h: 2260 };

const COLUMNS = [
  { id: 'A1', x: 5000, y: 4000 },
  { id: 'A2', x: 10000, y: 4000 },
  { id: 'A3', x: 15000, y: 4000 },
  { id: 'B1', x: 5000, y: 8000 },
  { id: 'B2', x: 10000, y: 8000 },
  { id: 'B3', x: 15000, y: 8000 },
];
const BEAMS = [
  { id: 'A2-A3', from: 10150, to: 14850, y: 4000 },
  { id: 'B1-B2', from: 5150, to: 9850, y: 8000 },
  { id: 'B3-Ost', from: 15150, to: 19700, y: 8000 },
];
const SPACES = [
  { n: '01', long: 'Büro', x: [300, 7440], y: [300, 4740] },
  { n: '02', long: 'Großraumbüro', x: [7560, 19700], y: [300, 4740] },
  { n: '03', long: 'Flur', x: [300, 19700], y: [4860, 7140] },
  { n: '04', long: 'Büro', x: [300, 12440], y: [7260, 11700] },
  { n: '05', long: 'Besprechung', x: [12560, 19700], y: [7260, 11700] },
];
// Stair (EG -> 1.OG) at the east end of the corridor, half-turn with landing
const STAIR = {
  risers: 9,
  riser: 1600 / 9,
  tread: 280,
  x0: 16000,
  x1: 16000 + 9 * 280, // 18520
  flight1Y: [4880, 5950],
  flight2Y: [6050, 7120],
  landing: { x: [18520, 19700], y: [4880, 7120], z: [1400, 1600] },
  railingY: [5980, 6020],
  hole: { x: [16000, 18520], y: [4860, 7140] }, // opening in the 1.OG slab
};

// --- HLS layout --------------------------------------------------------------
const OPENING_MARGIN = 60; // provided wall openings (Durchbrüche) are 60 mm larger than the penetrating element
const D = { HZ_MAIN: 88.9, TW_MAIN: 76.1, BRANCH: 60.3, FIT_EXTRA: 16, FIT_LEN: 80 };
const Z = { PIPE: 2520, DUCT: 2720, TRAY: 2420 }; // duct main 2570..2870 (80 mm below the slab)
const Y = { HZ: 5100, TW: 6900, DUCT: 6000, TRAY: 5450 };
const DN = { 88.9: 'DN80', 76.1: 'DN65', 60.3: 'DN50' };

/**
 * Every HLS element is an axis-aligned run: axis 'x' | 'y' | 'z', from/to along the axis,
 * c = centre in the two other axes (x-runs: [y, z], y-runs: [x, z], z-runs: [x, y]).
 * noSleeve: the architecture gets NO opening for this run (intended wall clash).
 */
function hlsLayout() {
  const runs = [];
  for (const st of FLOORS) {
    const p = st.key;
    const xEnd = st.idx === 0 ? 15500 : 18500; // EG: stop before the stair
    const add = (r) => runs.push({ storey: st.idx, ...r });

    // --- Lüftung (Zuluft) ---
    add({ sys: 'ZUL', cls: 'IFCDUCTSEGMENT', name: `ZUL-${p}-Hauptkanal`, axis: 'x', from: 600, to: xEnd, c: [Y.DUCT, Z.DUCT], w: 600, h: 300, typeKey: 'duct600' });
    const ductBranch = (label, x, dirSign, opts = {}) => {
      const yFace = dirSign < 0 ? Y.DUCT - 300 : Y.DUCT + 300;
      const yFit = yFace + dirSign * 200;
      const yEnd = dirSign < 0 ? 2000 : 10000;
      add({ sys: 'ZUL', cls: 'IFCDUCTFITTING', name: `ZUL-${p}-${label} T-Stück`, axis: 'y', from: Math.min(yFace, yFit), to: Math.max(yFace, yFit), c: [x, Z.DUCT], w: 450, h: 250, predefined: 'JUNCTION', nenn: '400x200' });
      add({ sys: 'ZUL', cls: 'IFCDUCTSEGMENT', name: `ZUL-${p}-${label}`, axis: 'y', from: Math.min(yFit, yEnd), to: Math.max(yFit, yEnd), c: [x, Z.DUCT], w: 400, h: 200, typeKey: 'duct400', ...opts });
      add({ sys: 'ZUL', cls: 'IFCAIRTERMINAL', name: `ZUL-${p}-Auslass ${label.replace('Abzweig ', '')}`, axis: 'z', from: Z.DUCT - 100 - 80, to: Z.DUCT - 100, c: [x, yEnd - dirSign * 300], w: 600, h: 600, predefined: 'DIFFUSER', nenn: '600x600' });
    };
    ductBranch('Abzweig Süd 1', 3500, -1);
    ductBranch('Abzweig Nord 1', 3500, +1);

    // --- Heizung Vorlauf / Trinkwasser ---
    add({ sys: 'HZ', cls: 'IFCPIPESEGMENT', name: `HZ-VL-${p}-Hauptleitung`, axis: 'x', from: 600, to: xEnd, c: [Y.HZ, Z.PIPE], d: D.HZ_MAIN, typeKey: 'pipe80' });
    add({ sys: 'TW', cls: 'IFCPIPESEGMENT', name: `TW-${p}-Hauptleitung`, axis: 'x', from: 600, to: xEnd, c: [Y.TW, Z.PIPE], d: D.TW_MAIN, typeKey: 'pipe65' });
    const prefix = (sys) => (sys === 'HZ' ? `HZ-VL-${p}` : `TW-${p}`);
    const mainOf = (sys) => (sys === 'HZ' ? { y: Y.HZ, r: D.HZ_MAIN / 2 } : { y: Y.TW, r: D.TW_MAIN / 2 });
    const pipeBranch = (sys, label, x, dirSign, opts = {}) => {
      const m = mainOf(sys);
      const yFace = m.y + dirSign * m.r;
      const yFit = yFace + dirSign * D.FIT_LEN;
      const yEnd = dirSign < 0 ? 2500 : 10500;
      add({ sys, cls: 'IFCPIPEFITTING', name: `${prefix(sys)}-${label} T-Stück`, axis: 'y', from: Math.min(yFace, yFit), to: Math.max(yFace, yFit), c: [x, Z.PIPE], d: D.BRANCH + D.FIT_EXTRA, predefined: 'JUNCTION', nenn: 'DN50' });
      add({ sys, cls: 'IFCPIPESEGMENT', name: `${prefix(sys)}-${label}`, axis: 'y', from: Math.min(yFit, yEnd), to: Math.max(yFit, yEnd), c: [x, Z.PIPE], d: D.BRANCH, typeKey: 'pipe50', ...opts });
    };
    /** Branch that drops below the main and passes under a beam with the given clearance. */
    const pipeBranchLow = (sys, label, x, dirSign, clearance, opts = {}) => {
      const m = mainOf(sys);
      const r = D.BRANCH / 2;
      const zc = BEAM_BOTTOM - clearance - r;
      const yEnd = dirSign < 0 ? 2500 : 10500;
      add({ sys, cls: 'IFCPIPEFITTING', name: `${prefix(sys)}-${label} Bogen`, axis: 'z', from: zc - r, to: Z.PIPE - m.r, c: [x, m.y], d: D.BRANCH, predefined: 'BEND', nenn: 'DN50' });
      const yStart = m.y + dirSign * r;
      add({ sys, cls: 'IFCPIPESEGMENT', name: `${prefix(sys)}-${label}`, axis: 'y', from: Math.min(yStart, yEnd), to: Math.max(yStart, yEnd), c: [x, zc], d: D.BRANCH, typeKey: 'pipe50', ...opts });
    };
    pipeBranch('HZ', 'Anbindung Süd 1', 2500, -1);
    pipeBranch('TW', 'Anbindung Nord 1', 2500, +1);

    // --- Elektro ---
    add({ sys: 'EL', cls: 'IFCCABLECARRIERSEGMENT', name: `EL-${p}-Kabeltrasse`, axis: 'x', from: 600, to: xEnd, c: [Y.TRAY, Z.TRAY], w: 300, h: 60, typeKey: 'tray300' });

    // --- storey specific runs incl. the deliberate clashes ---
    if (st.idx === 0) {
      ductBranch('Abzweig Süd 2', 12500, -1, { intent: 'B-1' });
      pipeBranch('HZ', 'Anbindung Süd 2', 9000, -1, { intent: 'W-1', noSleeve: true });
      pipeBranchLow('HZ', 'Anbindung Süd 3 (tief)', 13500, -1, 30, { intent: 'N-2' });
      pipeBranchLow('TW', 'Anbindung Nord 2 (tief)', 8500, +1, 30, { intent: 'N-1' });
    }
    if (st.idx === 1) {
      ductBranch('Abzweig Nord 2', 7500, +1, { intent: 'B-2' });
      pipeBranch('HZ', 'Anbindung Süd 2', 11000, -1, { intent: 'B-4' });
      pipeBranch('TW', 'Anbindung Nord 2', 13500, +1, { intent: 'W-2', noSleeve: true });
      add({ sys: 'HZ', cls: 'IFCPIPESEGMENT', name: `HZ-VL-${p}-Heizkörperanbindung Nord`, axis: 'x', from: 9000, to: 16000, c: [11000, 400], d: D.BRANCH, typeKey: 'pipe50', intent: 'W-4', noSleeve: true });
      add({ sys: 'EL', cls: 'IFCCABLECARRIERSEGMENT', name: `EL-${p}-Kabeltrasse Abzweig Süd`, axis: 'y', from: 1500, to: Y.TRAY - 150, c: [5000, Z.TRAY], w: 300, h: 60, typeKey: 'tray300', intent: 'C-1' });
    }
    if (st.idx === 2) {
      pipeBranch('TW', 'Anbindung Nord 2', 17500, +1, { intent: 'B-3' });
      add({ sys: 'HZ', cls: 'IFCPIPESEGMENT', name: `HZ-VL-${p}-Heizkörperanbindung Süd`, axis: 'x', from: 4000, to: 11000, c: [1500, 400], d: D.BRANCH, typeKey: 'pipe50', intent: 'W-3', noSleeve: true });
    }
  }
  for (const r of runs) {
    if (r.d) r.w = r.h = r.d;
    r.box = runBox(r);
  }
  return runs;
}

const INTENTS = {
  'B-1': 'Lüftungskanal durch Unterzug (EG)',
  'B-2': 'Lüftungskanal durch Unterzug (1.OG)',
  'B-3': 'Trinkwasserleitung durch Unterzug (2.OG)',
  'B-4': 'Heizungsleitung durch Unterzug (1.OG)',
  'W-1': 'Heizungsleitung durch Flurwand ohne Durchbruch (EG)',
  'W-2': 'Trinkwasserleitung durch Flurwand ohne Durchbruch (1.OG)',
  'W-3': 'Heizkörperanbindung durch Trennwand ohne Durchbruch (2.OG)',
  'W-4': 'Heizkörperanbindung durch Trennwand ohne Durchbruch (1.OG)',
  'C-1': 'Kabeltrasse gegen Stütze (1.OG)',
  'N-1': 'Beinahe-Kollision: Trinkwasser 30 mm unter Unterzug (EG)',
  'N-2': 'Beinahe-Kollision: Heizung 30 mm unter Unterzug (EG)',
};

/** storey-local AABB [x0,y0,z0,x1,y1,z1] of a run */
function runBox(r) {
  const [c0, c1] = r.c;
  const hw = r.w / 2;
  const hh = r.h / 2;
  if (r.axis === 'x') return [r.from, c0 - hw, c1 - hh, r.to, c0 + hw, c1 + hh];
  if (r.axis === 'y') return [c0 - hw, r.from, c1 - hh, c0 + hw, r.to, c1 + hh];
  return [c0 - hw, c1 - hh, r.from, c0 + hw, c1 + hh, r.to];
}

/** Placement location + extruded solid for a run (profile swept along the run axis). */
function runGeometry(b, r) {
  const prof = r.d ? b.circleProfile(r.d / 2) : b.rectProfile(r.w, r.h);
  const depth = r.to - r.from;
  const [c0, c1] = r.c;
  if (r.axis === 'x') return { loc: [r.from, c0, c1], solid: b.extrude(prof, b.ax3([0, 0, 0], [1, 0, 0], [0, 1, 0]), depth) };
  if (r.axis === 'y') return { loc: [c0, r.from, c1], solid: b.extrude(prof, b.ax3([0, 0, 0], [0, 1, 0], [-1, 0, 0]), depth) };
  return { loc: [c0, c1, r.from], solid: b.extrude(prof, b.ax3(), depth) };
}

// ---------------------------------------------------------------------------
// Box helpers (used for openings and the clash summary)
// ---------------------------------------------------------------------------

const EPS = 0.5;
function intersectBox(a, b) {
  const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]), Math.min(a[3], b[3]), Math.min(a[4], b[4]), Math.min(a[5], b[5])];
  return r[3] - r[0] > EPS && r[4] - r[1] > EPS && r[5] - r[2] > EPS ? r : null;
}
function containsBox(outer, inner) {
  return inner[0] >= outer[0] - EPS && inner[1] >= outer[1] - EPS && inner[2] >= outer[2] - EPS && inner[3] <= outer[3] + EPS && inner[4] <= outer[4] + EPS && inner[5] <= outer[5] + EPS;
}
function boxDistance(a, b) {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const g = Math.max(0, a[i] - b[i + 3], b[i] - a[i + 3]);
    s += g * g;
  }
  return Math.sqrt(s);
}
const offsetZ = (box, dz) => [box[0], box[1], box[2] + dz, box[3], box[4], box[5] + dz];

// Wall-local (u along axis, v across, z) <-> storey coordinates
function wallBox(w) {
  const t = w.ext ? 300 : 120;
  return w.dir === 'x' ? [w.sx, w.sy - t / 2, 0, w.sx + w.len, w.sy + t / 2, WALL_H] : [w.sx - t / 2, w.sy, 0, w.sx + t / 2, w.sy + w.len, WALL_H];
}
function wallLocalToBox(w, u0, u1, v0, v1, z0, z1) {
  return w.dir === 'x' ? [w.sx + u0, w.sy + v0, z0, w.sx + u1, w.sy + v1, z1] : [w.sx - v1, w.sy + u0, z0, w.sx - v0, w.sy + u1, z1];
}
const wallU = (w, worldCoord) => worldCoord - (w.dir === 'x' ? w.sx : w.sy);

// ---------------------------------------------------------------------------
// Demo_Architektur.ifc
// ---------------------------------------------------------------------------

function buildArchitecture(hlsRuns) {
  const b = new IfcBuilder({ seed: 0xa2c417ec });
  const f = b.f;
  b.setupProject({ description: 'Demo-Modell Architektur', storeys: STOREYS });
  const archBoxes = []; // absolute AABBs for the clash summary

  const S = {
    concrete: b.surfaceStyle('Beton hellgrau', [0.75, 0.75, 0.73]),
    drywall: b.surfaceStyle('Gipskarton weiss', [0.95, 0.94, 0.9]),
    glass: b.surfaceStyle('Glas', [0.62, 0.8, 0.95], 0.6),
    frame: b.surfaceStyle('Fensterrahmen', [0.3, 0.32, 0.35]),
    wood: b.surfaceStyle('Holz braun', [0.55, 0.35, 0.2]),
    space: b.surfaceStyle('Raum', [0.6, 0.9, 0.6], 0.7),
    roof: b.surfaceStyle('Dach dunkelgrau', [0.35, 0.35, 0.37]),
    steel: b.surfaceStyle('Stahl dunkel', [0.15, 0.15, 0.17]),
    ceiling: b.surfaceStyle('Akustikdecke', [0.98, 0.98, 0.96]),
  };

  const M = {
    concrete: b.material('Stahlbeton C30/37', 'Beton'),
    gk: b.material('Gipskarton', 'Gips'),
    glass: b.material('Glas', 'Glas'),
    wood: b.material('Holz', 'Holz'),
    steel: b.material('Stahl', 'Stahl'),
  };
  const layerSet = (name, mat, t, layerName) =>
    f.add('IFCMATERIALLAYERSET', [f.add('IFCMATERIALLAYER', mat, t, false, layerName, null, null, null)], name, null);
  const lsExt = layerSet('AW 300 Beton', M.concrete, 300, 'Tragschicht Stahlbeton');
  const lsInt = layerSet('IW 120 Trockenbau', M.gk, 120, 'Ständerwand Gipskarton');
  const usageExt = f.add('IFCMATERIALLAYERSETUSAGE', lsExt, enumv('AXIS2'), enumv('POSITIVE'), -150, null);
  const usageInt = f.add('IFCMATERIALLAYERSETUSAGE', lsInt, enumv('AXIS2'), enumv('POSITIVE'), -60, null);

  const C = {
    extWall: b.classificationRef('331', 'Tragende Außenwände'),
    column: b.classificationRef('343', 'Innenstützen'),
    intWall: b.classificationRef('342', 'Nichttragende Innenwände'),
    extOpen: b.classificationRef('334', 'Außentüren und -fenster'),
    intOpen: b.classificationRef('344', 'Innentüren und -fenster'),
    slab: b.classificationRef('351', 'Deckenkonstruktionen'),
    ceiling: b.classificationRef('354', 'Deckenbekleidungen'),
    slabOther: b.classificationRef('359', 'Sonstiges zur KG 350'),
    roof: b.classificationRef('361', 'Dachkonstruktionen'),
  };

  const T = {
    wallExt: b.typeObject('IFCWALLTYPE', 'AW 300 Beton', 'STANDARD', {
      description: 'Außenwand Stahlbeton 300 mm',
      psets: [
        b.propertySet('Pset_WallCommon', [
          ['Reference', V.id('AW 300')],
          ['IsExternal', V.bool(true)],
          ['LoadBearing', V.bool(true)],
          ['FireRating', V.label('REI 90')],
          ['ThermalTransmittance', V.uval(0.28)],
        ]),
      ],
    }),
    wallInt: b.typeObject('IFCWALLTYPE', 'IW 120 Trockenbau', 'PARTITIONING', {
      description: 'Innenwand Metallständer, beidseitig doppelt beplankt',
      psets: [
        b.propertySet('Pset_WallCommon', [
          ['Reference', V.id('IW 120')],
          ['AcousticRating', V.label('Rw 47 dB')],
          ['IsExternal', V.bool(false)],
          ['LoadBearing', V.bool(false)],
          ['FireRating', V.label('EI 30')],
        ]),
      ],
    }),
    slab: b.typeObject('IFCSLABTYPE', 'DE 250 Stahlbeton', 'FLOOR', {
      psets: [b.propertySet('Pset_SlabCommon', [['Reference', V.id('DE 250')], ['LoadBearing', V.bool(true)], ['FireRating', V.label('REI 90')]])],
    }),
    roofSlab: b.typeObject('IFCSLABTYPE', 'Dach 250 Stahlbeton', 'ROOF', {
      psets: [b.propertySet('Pset_SlabCommon', [['Reference', V.id('DA 250')], ['IsExternal', V.bool(true)], ['LoadBearing', V.bool(true)]])],
    }),
    column: b.typeObject('IFCCOLUMNTYPE', 'ST 300x300 Stahlbeton', 'COLUMN', {
      psets: [b.propertySet('Pset_ColumnCommon', [['Reference', V.id('ST 30/30')], ['LoadBearing', V.bool(true)], ['FireRating', V.label('R 90')]])],
    }),
    beam: b.typeObject('IFCBEAMTYPE', 'UZ 300x500 Stahlbeton', 'BEAM', {
      psets: [b.propertySet('Pset_BeamCommon', [['Reference', V.id('UZ 30/50')], ['LoadBearing', V.bool(true)], ['FireRating', V.label('R 90')]])],
    }),
    window: b.typeObject('IFCWINDOWTYPE', 'FE 1500x1500', 'WINDOW', {
      psets: [b.propertySet('Pset_WindowCommon', [['Reference', V.id('FE 150/150')], ['ThermalTransmittance', V.uval(1.1)], ['GlazingAreaFraction', V.ratio(0.74)]])],
      extra: [enumv('SINGLE_PANEL'), false, null],
    }),
    door: b.typeObject('IFCDOORTYPE', 'T 1010x2135 Holz', 'DOOR', {
      psets: [b.propertySet('Pset_DoorCommon', [['Reference', V.id('T 101/213')], ['FireRating', V.label('EI 30')], ['HandicapAccessible', V.bool(true)]])],
      extra: [enumv('SINGLE_SWING_LEFT'), false, null],
    }),
    entrance: b.typeObject('IFCDOORTYPE', 'Haustür 1260x2260', 'DOOR', {
      psets: [b.propertySet('Pset_DoorCommon', [['Reference', V.id('HT 126/226')], ['IsExternal', V.bool(true)], ['ThermalTransmittance', V.uval(1.3)]])],
      extra: [enumv('SINGLE_SWING_RIGHT'), false, null],
    }),
  };

  const record = (name, cls, st, box, openings = []) =>
    archBoxes.push({ name, cls, storey: st.key, box: offsetZ(box, st.elev), openings: openings.map((o) => offsetZ(o, st.elev)) });

  for (const st of b.storeys.slice(0, 3)) {
    const p = st.key;
    const sIdx = st.idx;
    const runsHere = hlsRuns.filter((r) => r.storey === sIdx);

    // ---------------- walls with openings ----------------
    for (const w of WALLS) {
      const t = w.ext ? 300 : 120;
      const wb = wallBox(w);
      const openings = [];
      if (w.ext) {
        for (const at of WINDOWS[w.key]) openings.push({ kind: 'window', uc: wallU(w, at), w: WIN.w, h: WIN.h, sill: WIN.sill });
        if (sIdx === 0 && w.key === ENTRANCE.wall)
          openings.push({ kind: 'entrance', uc: wallU(w, ENTRANCE.at), w: ENTRANCE.w, h: ENTRANCE.h, sill: 0 });
      }
      for (const d of DOORS.filter((d) => d.wall === w.key))
        openings.push({ kind: 'door', uc: wallU(w, d.at), w: DOOR.w, h: DOOR.h, sill: 0, room: d.room });
      for (const r of runsHere) {
        if (r.noSleeve) continue;
        const I = intersectBox(r.box, wb);
        if (!I) continue;
        const [a0, a1] = w.dir === 'x' ? [I[0], I[3]] : [I[1], I[4]];
        const u0 = wallU(w, a0) - OPENING_MARGIN;
        const u1 = wallU(w, a1) + OPENING_MARGIN;
        const z0 = I[2] - OPENING_MARGIN;
        const z1 = I[5] + OPENING_MARGIN;
        if (z0 < 1 || z1 > WALL_H - 1) throw new Error(`Opening for ${r.name} touches wall boundary`);
        openings.push({ kind: 'sleeve', uc: (u0 + u1) / 2, w: u1 - u0, h: z1 - z0, sill: z0, run: r });
      }

      const grossArea = w.len * WALL_H;
      const openArea = openings.reduce((s, o) => s + o.w * o.h, 0);
      const netSideArea = (grossArea - openArea) / 1e6;
      const netVolume = (netSideArea * t) / 1000;
      const name = `${w.ext ? 'AW' : 'IW'}-${p}-${w.name}`;
      const pl = b.placement(st.placement, [w.sx, w.sy, 0], w.dir === 'y' ? [0, 1, 0] : null);
      const solid = b.extrude(b.rectProfile(w.len, t, w.len / 2, 0), b.ax3(), WALL_H);
      const wall = b.element('IFCWALL', {
        name,
        description: w.ext ? 'Außenwand Stahlbeton' : 'Innenwand Trockenbau',
        objectType: w.ext ? 'AW 300 Beton' : 'IW 120 Trockenbau',
        placement: pl,
        shape: b.body([solid], w.ext ? S.concrete : S.drywall),
        extra: [enumv(w.ext ? 'STANDARD' : 'PARTITIONING')],
      });
      b.pset(wall, 'Pset_WallCommon', [
        ['Reference', V.id(w.ext ? 'AW 300' : 'IW 120')],
        ['IsExternal', V.bool(w.ext)],
        ['LoadBearing', V.bool(w.ext)],
        ['FireRating', V.label(w.ext ? 'REI 90' : 'EI 30')],
      ]);
      b.qto(wall, 'Qto_WallBaseQuantities', [
        ['Length', 'L', w.len],
        ['Width', 'L', t],
        ['Height', 'L', WALL_H],
        ['GrossSideArea', 'A', grossArea / 1e6],
        ['NetSideArea', 'A', netSideArea],
        ['GrossVolume', 'V', (grossArea * t) / 1e9],
        ['NetVolume', 'V', netVolume],
      ]);
      const cx = w.dir === 'x' ? w.sx + w.len / 2 : w.sx;
      b.projectData(wall, cx, w.ext ? 'Rohbau' : 'Ausbau', w.ext ? netVolume * 480 : netSideArea * 65);
      b.setType(w.ext ? T.wallExt : T.wallInt, wall);
      b.setMaterial(w.ext ? usageExt : usageInt, wall);
      b.classify(w.ext ? C.extWall : C.intWall, wall);
      b.contain(st.ref, wall);

      const openingBoxes = [];
      for (const o of openings) {
        const opPl = b.placement(pl, [o.uc, 0, o.sill]);
        const below = o.sill <= 0 ? 20 : 0; // door openings extend below the wall to avoid coplanar faces
        const opSolid = b.extrude(b.rectProfile(o.w, t + 40), b.ax3([0, 0, -below]), o.h + below);
        const opName =
          o.kind === 'sleeve' ? `Durchbruch ${o.run.name}` : o.kind === 'window' ? `Öffnung Fenster ${name}` : `Öffnung Tür ${name}`;
        const opening = b.element('IFCOPENINGELEMENT', {
          name: opName,
          description: o.kind === 'sleeve' ? 'Durchbruch HLS (Rohbauöffnung)' : null,
          placement: opPl,
          shape: b.body([opSolid]),
          extra: [enumv('OPENING')],
        });
        f.add('IFCRELVOIDSELEMENT', b.guid(), b.oh, null, null, wall, opening);
        const oBox = wallLocalToBox(w, o.uc - o.w / 2, o.uc + o.w / 2, -t / 2 - 20, t / 2 + 20, o.sill - below, o.sill + o.h);
        openingBoxes.push(oBox);

        if (o.kind === 'sleeve') continue;
        const fillPl = b.placement(opPl);
        let filling;
        if (o.kind === 'window') {
          const fw = o.w;
          const fh = o.h;
          // frame (profile with void) + glass pane, both in the wall plane, extruded across the wall
          const framePos = b.ax3([0, 40, 0], [0, -1, 0], [1, 0, 0]);
          const frameProf = b.polyProfileWithVoids(
            [[-fw / 2, 0], [fw / 2, 0], [fw / 2, fh], [-fw / 2, fh]],
            [[[-fw / 2 + 70, 70], [fw / 2 - 70, 70], [fw / 2 - 70, fh - 70], [-fw / 2 + 70, fh - 70]]],
          );
          const frame = b.extrude(frameProf, framePos, 80);
          const glass = b.extrude(b.rectProfile(fw - 140, 24, 0, 0), b.ax3([0, 0, 70]), fh - 140);
          const winName = `FE-${p}-${w.name}-${openings.filter((x) => x.kind === 'window').indexOf(o) + 1}`;
          filling = b.element('IFCWINDOW', {
            name: winName,
            objectType: 'FE 1500x1500',
            placement: fillPl,
            shape: b.body([[frame, S.frame], [glass, S.glass]]),
            extra: [fh, fw, enumv('WINDOW'), enumv('SINGLE_PANEL'), null],
          });
          b.pset(filling, 'Pset_WindowCommon', [
            ['Reference', V.id('FE 150/150')],
            ['IsExternal', V.bool(true)],
            ['ThermalTransmittance', V.uval(1.1)],
            ['GlazingAreaFraction', V.ratio(0.74)],
          ]);
          b.projectData(filling, wallLocalToBox(w, o.uc, o.uc, 0, 0, 0, 0)[0], 'Fassade', 1450);
          b.setType(T.window, filling);
          b.setMaterial(M.glass, filling);
          b.classify(C.extOpen, filling);
          record(winName, 'IfcWindow', st, wallLocalToBox(w, o.uc - fw / 2, o.uc + fw / 2, -40, 40, o.sill, o.sill + fh));
        } else {
          const isEntrance = o.kind === 'entrance';
          const leaf = b.extrude(b.rectProfile(o.w - 20, 50, 0, 0), b.ax3(), o.h - 10);
          const doorName = isEntrance ? `TU-${p}-Haupteingang` : `TU-${p}-${p === 'EG' ? '0' : p[0]}.${o.room}`;
          filling = b.element('IFCDOOR', {
            name: doorName,
            objectType: isEntrance ? 'Haustür 1260x2260' : 'T 1010x2135 Holz',
            placement: fillPl,
            shape: b.body([leaf], S.wood),
            extra: [o.h, o.w, enumv('DOOR'), enumv(isEntrance ? 'SINGLE_SWING_RIGHT' : 'SINGLE_SWING_LEFT'), null],
          });
          b.pset(filling, 'Pset_DoorCommon', [
            ['Reference', V.id(isEntrance ? 'HT 126/226' : 'T 101/213')],
            ['IsExternal', V.bool(isEntrance)],
            ['FireRating', V.label(isEntrance ? 'RC2' : 'EI 30')],
          ]);
          b.projectData(filling, wallLocalToBox(w, o.uc, o.uc, 0, 0, 0, 0)[0], 'Ausbau', isEntrance ? 3800 : 950);
          b.setType(isEntrance ? T.entrance : T.door, filling);
          b.setMaterial(M.wood, filling);
          b.classify(isEntrance ? C.extOpen : C.intOpen, filling);
          record(doorName, 'IfcDoor', st, wallLocalToBox(w, o.uc - o.w / 2, o.uc + o.w / 2, -25, 25, 0, o.h));
        }
        f.add('IFCRELFILLSELEMENT', b.guid(), b.oh, null, null, opening, filling);
        b.contain(st.ref, filling);
      }
      record(name, 'IfcWall', st, wb, openingBoxes);
    }

    // ---------------- floor slab ----------------
    {
      const name = `DE-${p}`;
      const pl = b.placement(st.placement);
      const slab = b.element('IFCSLAB', {
        name,
        description: sIdx === 0 ? 'Bodenplatte' : `Geschossdecke über ${FLOORS[sIdx - 1].key}`,
        objectType: 'DE 250 Stahlbeton',
        placement: pl,
        shape: b.body([b.boxSolid(0, 20000, 0, 12000, -SLAB_T, 0)], S.concrete),
        extra: [enumv('FLOOR')],
      });
      let holeArea = 0;
      if (sIdx === 1) {
        const h = STAIR.hole;
        holeArea = ((h.x[1] - h.x[0]) * (h.y[1] - h.y[0])) / 1e6;
        const opening = b.element('IFCOPENINGELEMENT', {
          name: `Treppenauge ${name}`,
          placement: b.placement(pl),
          shape: b.body([b.boxSolid(h.x[0], h.x[1], h.y[0], h.y[1], -SLAB_T - 20, 20)]),
          extra: [enumv('OPENING')],
        });
        f.add('IFCRELVOIDSELEMENT', b.guid(), b.oh, null, null, slab, opening);
      }
      const area = 240 - holeArea;
      b.pset(slab, 'Pset_SlabCommon', [
        ['Reference', V.id('DE 250')],
        ['IsExternal', V.bool(false)],
        ['LoadBearing', V.bool(true)],
        ['FireRating', V.label('REI 90')],
      ]);
      b.qto(slab, 'Qto_SlabBaseQuantities', [
        ['Width', 'L', SLAB_T],
        ['Perimeter', 'L', 64000],
        ['GrossArea', 'A', 240],
        ['NetArea', 'A', area],
        ['GrossVolume', 'V', 240 * 0.25],
        ['NetVolume', 'V', area * 0.25],
      ]);
      b.projectData(slab, 10000, 'Rohbau', area * 0.25 * 420);
      b.setType(T.slab, slab);
      b.setMaterial(M.concrete, slab);
      b.classify(C.slab, slab);
      b.contain(st.ref, slab);
      record(name, 'IfcSlab', st, [0, 0, -SLAB_T, 20000, 12000, 0]);
    }

    // ---------------- columns ----------------
    for (const c of COLUMNS) {
      const name = `ST-${p}-${c.id}`;
      const col = b.element('IFCCOLUMN', {
        name,
        objectType: 'ST 300x300 Stahlbeton',
        placement: b.placement(st.placement, [c.x, c.y, 0]),
        shape: b.body([b.extrude(b.rectProfile(300, 300), b.ax3(), WALL_H)], S.concrete),
        extra: [enumv('COLUMN')],
      });
      const vol = 0.3 * 0.3 * (WALL_H / 1000);
      b.pset(col, 'Pset_ColumnCommon', [
        ['Reference', V.id('ST 30/30')],
        ['IsExternal', V.bool(false)],
        ['LoadBearing', V.bool(true)],
        ['FireRating', V.label('R 90')],
      ]);
      b.qto(col, 'Qto_ColumnBaseQuantities', [
        ['Length', 'L', WALL_H],
        ['CrossSectionArea', 'A', 0.09],
        ['NetVolume', 'V', vol],
      ]);
      b.projectData(col, c.x, 'Rohbau', vol * 900);
      b.setType(T.column, col);
      b.setMaterial(M.concrete, col);
      b.classify(C.column, col);
      b.contain(st.ref, col);
      record(name, 'IfcColumn', st, [c.x - 150, c.y - 150, 0, c.x + 150, c.y + 150, WALL_H]);
    }

    // ---------------- beams (under the slab above) ----------------
    for (const bm of BEAMS) {
      const name = `UZ-${p}-${bm.id}`;
      const run = { axis: 'x', from: bm.from, to: bm.to, c: [bm.y, BEAM_BOTTOM + BEAM_H / 2], w: 300, h: BEAM_H };
      const g = runGeometry(b, run);
      const beam = b.element('IFCBEAM', {
        name,
        objectType: 'UZ 300x500 Stahlbeton',
        placement: b.placement(st.placement, g.loc),
        shape: b.body([g.solid], S.concrete),
        extra: [enumv('BEAM')],
      });
      const span = bm.to - bm.from;
      const vol = 0.3 * 0.5 * (span / 1000);
      b.pset(beam, 'Pset_BeamCommon', [
        ['Reference', V.id('UZ 30/50')],
        ['Span', V.plen(span)],
        ['IsExternal', V.bool(false)],
        ['LoadBearing', V.bool(true)],
        ['FireRating', V.label('R 90')],
      ]);
      b.qto(beam, 'Qto_BeamBaseQuantities', [
        ['Length', 'L', span],
        ['CrossSectionArea', 'A', 0.15],
        ['NetVolume', 'V', vol],
      ]);
      b.projectData(beam, (bm.from + bm.to) / 2, 'Rohbau', vol * 850);
      b.setType(T.beam, beam);
      b.setMaterial(M.concrete, beam);
      b.classify(C.slab, beam);
      b.contain(st.ref, beam);
      record(name, 'IfcBeam', st, runBox(run));
    }

    // ---------------- spaces ----------------
    const spaces = [];
    for (const sp of SPACES) {
      const name = `${sIdx}.${sp.n}`;
      const [x0, x1] = sp.x;
      const [y0, y1] = sp.y;
      const area = ((x1 - x0) * (y1 - y0)) / 1e6;
      const space = f.add(
        'IFCSPACE',
        b.guid(),
        b.oh,
        name,
        null,
        null,
        b.placement(st.placement, [x0, y0, 0]),
        b.body([b.boxSolid(0, x1 - x0, 0, y1 - y0, 0, WALL_H)], S.space),
        sp.long,
        enumv('ELEMENT'),
        enumv('INTERNAL'),
        0,
      );
      b.pset(space, 'Pset_SpaceCommon', [
        ['Reference', V.id(sp.long)],
        ['IsExternal', V.bool(false)],
        ['NetPlannedArea', V.area(area)],
        ['PubliclyAccessible', V.bool(sp.n === '03')],
      ]);
      b.qto(space, 'Qto_SpaceBaseQuantities', [
        ['Height', 'L', WALL_H],
        ['GrossFloorArea', 'A', area],
        ['NetFloorArea', 'A', area],
        ['NetVolume', 'V', area * (WALL_H / 1000)],
      ]);
      spaces.push({ ref: space, sp });
    }
    b.aggregate(
      st.ref,
      spaces.map((s) => s.ref),
    );

    // ---------------- suspended ceiling (1.OG, 2.OG) ----------------
    if (sIdx >= 1) {
      const corridor = SPACES.find((s) => s.n === '03');
      const name = `AD-${p}-Flur`;
      const box = [corridor.x[0], corridor.y[0], CEILING_Z[0], corridor.x[1], corridor.y[1], CEILING_Z[1]];
      const cov = b.element('IFCCOVERING', {
        name,
        description: 'Abgehängte Decke Flur',
        objectType: 'Gipskarton-Akustikdecke 20 mm',
        placement: b.placement(st.placement),
        shape: b.body([b.boxSolid(box[0], box[3], box[1], box[4], box[2], box[5])], S.ceiling),
        extra: [enumv('CEILING')],
      });
      const area = ((box[3] - box[0]) * (box[4] - box[1])) / 1e6;
      b.pset(cov, 'Pset_CoveringCommon', [
        ['Reference', V.id('AD 20')],
        ['IsExternal', V.bool(false)],
        ['FireRating', V.label('EI 30')],
      ]);
      b.qto(cov, 'Qto_CoveringBaseQuantities', [
        ['Width', 'L', 20],
        ['GrossArea', 'A', area],
        ['NetArea', 'A', area],
      ]);
      b.projectData(cov, 10000, 'Ausbau', area * 55);
      b.setMaterial(M.gk, cov);
      b.classify(C.ceiling, cov);
      b.contain(st.ref, cov);
      f.add('IFCRELCOVERSSPACES', b.guid(), b.oh, null, null, spaces.find((s) => s.sp.n === '03').ref, [cov]);
      record(name, 'IfcCovering', st, box);
    }

    // ---------------- stair + railing (EG) ----------------
    if (sIdx === 0) {
      const stairPl = b.placement(st.placement);
      const stair = b.element('IFCSTAIR', {
        name: 'Treppe',
        description: 'Zweiläufige Podesttreppe EG - 1.OG',
        objectType: 'Stahlbetontreppe',
        placement: stairPl,
        extra: [enumv('HALF_TURN_STAIR')],
      });
      const { risers: n, riser: r, tread: t, x0, x1 } = STAIR;
      // stepped profile in the x/z plane, origin at the flight start (u along run, v up)
      const steps = [[0, 0]];
      for (let i = 0; i < n; i++) steps.push([i * t, (i + 1) * r], [(i + 1) * t, (i + 1) * r]);
      steps.push([n * t, n * r - 250], [300, 0]);
      const flightAt = (yRange, map) => b.extrude(b.polyProfile(steps.map(map)), b.ax3([0, yRange[1], 0], [0, -1, 0], [1, 0, 0]), yRange[1] - yRange[0]);
      const flights = [
        { name: 'Treppenlauf 1', solid: flightAt(STAIR.flight1Y, ([u, v]) => [x0 + u, v]), box: [x0, STAIR.flight1Y[0], 0, x1, STAIR.flight1Y[1], 1600] },
        { name: 'Treppenlauf 2', solid: flightAt(STAIR.flight2Y, ([u, v]) => [x1 - u, 1600 + v]), box: [x0, STAIR.flight2Y[0], 1600, x1, STAIR.flight2Y[1], 3200] },
      ];
      const parts = [];
      for (const fl of flights) {
        const flight = b.element('IFCSTAIRFLIGHT', {
          name: fl.name,
          objectType: 'Stahlbeton-Treppenlauf',
          placement: b.placement(stairPl),
          shape: b.body([fl.solid], S.concrete),
          extra: [int(n), int(n - 1), r, t, enumv('STRAIGHT')],
        });
        b.pset(flight, 'Pset_StairFlightCommon', [
          ['Reference', V.id('TL 9x177.8/280')],
          ['NumberOfRiser', V.count(n)],
          ['NumberOfTreads', V.count(n - 1)],
          ['RiserHeight', V.plen(r)],
          ['TreadLength', V.plen(t)],
        ]);
        b.projectData(flight, 17000, 'Rohbau', 6200);
        b.setMaterial(M.concrete, flight);
        b.classify(C.slab, flight);
        parts.push(flight);
        record(fl.name, 'IfcStairFlight', st, fl.box);
      }
      const L = STAIR.landing;
      const landing = b.element('IFCSLAB', {
        name: 'Treppenpodest',
        objectType: 'Podest Stahlbeton 200 mm',
        placement: b.placement(stairPl),
        shape: b.body([b.boxSolid(L.x[0], L.x[1], L.y[0], L.y[1], L.z[0], L.z[1])], S.concrete),
        extra: [enumv('LANDING')],
      });
      b.pset(landing, 'Pset_SlabCommon', [['Reference', V.id('Podest')], ['IsExternal', V.bool(false)], ['LoadBearing', V.bool(true)]]);
      b.projectData(landing, 19000, 'Rohbau', 2100);
      b.setMaterial(M.concrete, landing);
      b.classify(C.slab, landing);
      parts.push(landing);
      record('Treppenpodest', 'IfcSlab', st, [L.x[0], L.y[0], L.z[0], L.x[1], L.y[1], L.z[1]]);
      b.aggregate(stair, parts);
      b.pset(stair, 'Pset_StairCommon', [
        ['Reference', V.id('Treppe 1')],
        ['NumberOfRiser', V.count(2 * n)],
        ['NumberOfTreads', V.count(2 * (n - 1))],
        ['RiserHeight', V.plen(r)],
        ['TreadLength', V.plen(t)],
        ['IsExternal', V.bool(false)],
      ]);
      b.projectData(stair, 17000, 'Rohbau', 18500);
      b.classify(C.slab, stair);
      b.contain(st.ref, stair);

      const ry = STAIR.railingY;
      const railing = b.element('IFCRAILING', {
        name: 'Geländer',
        description: 'Treppengeländer zwischen den Läufen',
        objectType: 'Stahlgeländer 900 mm',
        placement: b.placement(st.placement),
        shape: b.body(
          [b.extrude(b.polyProfile([[x0, 200], [x1, 1800], [x1, 2700], [x0, 1100]]), b.ax3([0, ry[1], 0], [0, -1, 0], [1, 0, 0]), ry[1] - ry[0])],
          S.steel,
        ),
        extra: [enumv('BALUSTRADE')],
      });
      b.pset(railing, 'Pset_RailingCommon', [['Reference', V.id('GL 900')], ['Height', V.plen(900)], ['IsExternal', V.bool(false)]]);
      b.projectData(railing, 17000, 'Ausbau', 3200);
      b.setMaterial(M.steel, railing);
      b.classify(C.slabOther, railing);
      b.contain(st.ref, railing);
      record('Geländer', 'IfcRailing', st, [x0, ry[0], 200, x1, ry[1], 2700]);
    }
  }

  // ---------------- roof (storey "Dach") ----------------
  {
    const st = b.storeys[3];
    const roofPl = b.placement(st.placement);
    const roof = b.element('IFCROOF', { name: 'Dach', description: 'Flachdach', objectType: 'Flachdach', placement: roofPl, extra: [enumv('FLAT_ROOF')] });
    const box = [-300, -300, -SLAB_T, 20300, 12300, 0];
    const roofSlab = b.element('IFCSLAB', {
      name: 'Dachdecke',
      description: 'Flachdach Stahlbeton mit Abdichtung',
      objectType: 'Dach 250 Stahlbeton',
      placement: b.placement(roofPl),
      shape: b.body([b.boxSolid(box[0], box[3], box[1], box[4], box[2], box[5])], S.roof),
      extra: [enumv('ROOF')],
    });
    const area = (20600 * 12600) / 1e6;
    b.aggregate(roof, roofSlab);
    b.pset(roof, 'Pset_RoofCommon', [['Reference', V.id('Flachdach')], ['IsExternal', V.bool(true)]]);
    b.pset(roofSlab, 'Pset_SlabCommon', [['Reference', V.id('DA 250')], ['IsExternal', V.bool(true)], ['LoadBearing', V.bool(true)], ['FireRating', V.label('REI 90')]]);
    b.qto(roofSlab, 'Qto_SlabBaseQuantities', [
      ['Width', 'L', SLAB_T],
      ['GrossArea', 'A', area],
      ['NetArea', 'A', area],
      ['NetVolume', 'V', area * 0.25],
    ]);
    b.projectData(roof, 10000, 'Rohbau', area * 180);
    b.projectData(roofSlab, 10000, 'Rohbau', area * 0.25 * 420);
    b.setType(T.roofSlab, roofSlab);
    b.setMaterial(M.concrete, roofSlab);
    b.classify(C.roof, roofSlab);
    b.contain(st.ref, roof);
    record('Dachdecke', 'IfcSlab', st, box);
  }

  b.flushRelations();
  return { text: f.serialize({ fileName: 'Demo_Architektur.ifc', description: 'Demo-Modell Architektur' }), archBoxes, counts: f.typeCounts };
}

// ---------------------------------------------------------------------------
// Demo_HLS.ifc
// ---------------------------------------------------------------------------

const SYSTEMS = {
  ZUL: { name: 'Zuluft', type: 'VENTILATION', medium: 'Luft', gewerk: 'Lüftung', din: ['431', 'Lüftungsanlagen'], colour: [0.6, 0.8, 1.0], mat: 'Stahlblech verzinkt' },
  HZ: { name: 'Heizung Vorlauf', type: 'HEATING', medium: 'Heizwasser', gewerk: 'Heizung', din: ['422', 'Wärmeverteilnetze'], colour: [0.92, 0.36, 0.12], mat: 'Stahl' },
  TW: { name: 'Trinkwasser', type: 'DOMESTICCOLDWATER', medium: 'Trinkwasser kalt', gewerk: 'Sanitär', din: ['412', 'Wasseranlagen'], colour: [0.2, 0.7, 0.3], mat: 'Edelstahl' },
  EL: { name: 'Elektro', type: 'ELECTRICAL', medium: 'Elektrische Energie', gewerk: 'Elektro', din: ['444', 'Niederspannungsinstallationsanlagen'], colour: [0.95, 0.85, 0.1], mat: 'Stahl verzinkt' },
};

function buildHLS(runs) {
  const b = new IfcBuilder({ seed: 0x5eed4115 });
  const f = b.f;
  b.setupProject({ description: 'Demo-Modell HLS (Heizung, Lüftung, Sanitär, Elektro)', storeys: STOREYS });
  const hlsBoxes = [];

  const terminalStyle = b.surfaceStyle('Luftauslass', [0.88, 0.92, 0.96]);
  const sys = {};
  for (const [key, s] of Object.entries(SYSTEMS)) {
    const ref = f.add('IFCDISTRIBUTIONSYSTEM', b.guid(), b.oh, s.name, `System ${s.name}`, null, s.name, enumv(s.type));
    f.add('IFCRELSERVICESBUILDINGS', b.guid(), b.oh, null, null, ref, [b.building]);
    sys[key] = {
      ...s,
      ref,
      members: [],
      style: b.surfaceStyle(`System ${s.name}`, s.colour),
      material: b.material(s.mat, key === 'EL' ? 'Stahl' : 'Metall'),
      cls: b.classificationRef(...s.din),
    };
  }

  const pipeType = (name, dn, od, wall) =>
    b.typeObject('IFCPIPESEGMENTTYPE', name, 'RIGIDSEGMENT', {
      psets: [
        b.propertySet('Pset_PipeSegmentTypeCommon', [
          ['Reference', V.id(dn)],
          ['WorkingPressure', V.pressure(600000)],
          ['NominalDiameter', V.plen(Number(dn.slice(2)))],
          ['InnerDiameter', V.plen(round6(od - 2 * wall))],
          ['OuterDiameter', V.plen(od)],
        ]),
      ],
    });
  const ductType = (name, w, h) =>
    b.typeObject('IFCDUCTSEGMENTTYPE', name, 'RIGIDSEGMENT', {
      psets: [
        b.propertySet('Pset_DuctSegmentTypeCommon', [
          ['Reference', V.id(`${w}x${h}`)],
          ['WorkingPressure', V.pressure(500)],
          ['NominalDiameterOrWidth', V.plen(w)],
          ['NominalHeight', V.plen(h)],
        ]),
      ],
    });
  const T = {
    duct600: ductType('Rechteckkanal 600x300', 600, 300),
    duct400: ductType('Rechteckkanal 400x200', 400, 200),
    pipe80: pipeType('Stahlrohr DN80', 'DN80', 88.9, 3.2),
    pipe65: pipeType('Edelstahlrohr DN65', 'DN65', 76.1, 2.0),
    pipe50: pipeType('Rohr DN50', 'DN50', 60.3, 2.9),
    tray300: b.typeObject('IFCCABLECARRIERSEGMENTTYPE', 'Kabelrinne 300x60', 'CABLETRAYSEGMENT', {
      psets: [b.propertySet('Pset_CableCarrierSegmentTypeCommon', [['Reference', V.id('KR 300/60')], ['NominalWidth', V.plen(300)], ['NominalHeight', V.plen(60)]])],
    }),
  };
  const DEFAULT_PREDEFINED = { IFCDUCTSEGMENT: 'RIGIDSEGMENT', IFCPIPESEGMENT: 'RIGIDSEGMENT', IFCCABLECARRIERSEGMENT: 'CABLETRAYSEGMENT' };

  for (const r of runs) {
    const st = b.storeys[r.storey];
    const s = sys[r.sys];
    const g = runGeometry(b, r);
    const style = r.cls === 'IFCAIRTERMINAL' ? terminalStyle : s.style;
    const nenn = r.nenn ?? (r.d ? DN[r.d] : `${r.w}x${r.h}`);
    const el = b.element(r.cls, {
      name: r.name,
      objectType: r.typeKey ? undefined : nenn,
      placement: b.placement(st.placement, g.loc),
      shape: b.body([g.solid], style),
      extra: [enumv(r.predefined ?? DEFAULT_PREDEFINED[r.cls])],
    });
    const len = r.to - r.from;
    b.pset(el, 'Demo_HLS', [
      ['System', V.label(s.name)],
      ['Medium', V.label(s.medium)],
      ['Nennweite', V.label(nenn)],
    ]);
    const centreX = r.axis === 'x' ? (r.from + r.to) / 2 : r.c[0];
    const unitPrice = { ZUL: 180, HZ: 95, TW: 110, EL: 60 }[r.sys];
    b.projectData(el, centreX, s.gewerk, r.cls.endsWith('SEGMENT') ? (len / 1000) * unitPrice : r.cls === 'IFCAIRTERMINAL' ? 240 : 85);
    if (r.typeKey) b.setType(T[r.typeKey], el);
    b.setMaterial(s.material, el);
    b.classify(s.cls, el);
    b.contain(st.ref, el);
    s.members.push(el);
    hlsBoxes.push({ ...r, storeyKey: st.key, absBox: offsetZ(r.box, st.elev) });
  }
  for (const s of Object.values(sys)) f.add('IFCRELASSIGNSTOGROUP', b.guid(), b.oh, null, null, s.members, null, s.ref);

  b.flushRelations();
  return { text: f.serialize({ fileName: 'Demo_HLS.ifc', description: 'Demo-Modell HLS' }), hlsBoxes, counts: f.typeCounts };
}

// ---------------------------------------------------------------------------
// Clash summary (axis-aligned boxes; all clash-relevant geometry is axis-aligned)
// ---------------------------------------------------------------------------

function computeClashes(archBoxes, hlsBoxes, clearance = 50) {
  const hard = [];
  const near = [];
  for (const h of hlsBoxes) {
    for (const a of archBoxes) {
      const I = intersectBox(h.absBox, a.box);
      if (I) {
        if (a.openings.some((o) => containsBox(o, I))) continue; // passes through a provided opening
        hard.push({ h, a, size: [I[3] - I[0], I[4] - I[1], I[5] - I[2]] });
        continue;
      }
      const d = boxDistance(h.absBox, a.box);
      if (d > EPS && d <= clearance) near.push({ h, a, d });
    }
  }
  return { hard, near };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const runs = hlsLayout();
  const arch = buildArchitecture(runs);
  const hls = buildHLS(runs);

  const outputs = [
    ['Demo_Architektur.ifc', arch],
    ['Demo_HLS.ifc', hls],
  ];
  for (const [file, res] of outputs) {
    const p = path.join(OUT_DIR, file);
    fs.writeFileSync(p, res.text, 'utf8');
    const lines = res.text.split('\n').filter((l) => l.startsWith('#')).length;
    const kb = (Buffer.byteLength(res.text) / 1024).toFixed(1);
    console.log(`wrote ${path.relative(ROOT, p)}  (${kb} KiB, ${lines} entities)`);
    const pick = [
      'IFCWALL', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCWINDOW', 'IFCDOOR', 'IFCOPENINGELEMENT', 'IFCSPACE', 'IFCCOVERING', 'IFCSTAIRFLIGHT',
      'IFCRAILING', 'IFCDUCTSEGMENT', 'IFCDUCTFITTING', 'IFCAIRTERMINAL', 'IFCPIPESEGMENT', 'IFCPIPEFITTING', 'IFCCABLECARRIERSEGMENT',
    ];
    const summary = pick.filter((t) => res.counts.get(t)).map((t) => `${t.slice(3).toLowerCase()}=${res.counts.get(t)}`);
    console.log(`  ${summary.join(', ')}`);
  }

  // ---- clash summary ----
  const { hard, near } = computeClashes(arch.archBoxes, hls.hlsBoxes);
  console.log('\nBeabsichtigte Kollisionen HLS × Architektur (aus achsparallelen Boxen berechnet):');
  const fmtMm = (v) => `${Math.round(v)}`;
  for (const c of hard) {
    const tag = c.h.intent ? `[${c.h.intent}]` : '[UNERWARTET]';
    console.log(`  ${tag.padEnd(13)} ${c.h.name} (${c.h.cls.slice(3)}) × ${c.a.name} (${c.a.cls})  Überlappung ${c.size.map(fmtMm).join(' x ')} mm`);
  }
  console.log('Beinahe-Kollisionen (Abstand ≤ 50 mm, keine Durchdringung):');
  for (const c of near) {
    const tag = c.h.intent ? `[${c.h.intent}]` : '[UNERWARTET]';
    console.log(`  ${tag.padEnd(13)} ${c.h.name} ↔ ${c.a.name} (${c.a.cls})  Abstand ${c.d.toFixed(1)} mm`);
  }
  const found = new Set([...hard, ...near].map((c) => c.h.intent).filter(Boolean));
  const missing = Object.keys(INTENTS).filter((k) => !found.has(k));
  const unexpected = [...hard, ...near].filter((c) => !c.h.intent);
  console.log('\nLegende:');
  for (const [k, v] of Object.entries(INTENTS)) console.log(`  ${k.padEnd(4)} ${v}${found.has(k) ? '' : '  <-- NICHT GEFUNDEN'}`);
  console.log(`\n${hard.length} harte Kollisionen, ${near.length} Beinahe-Kollisionen, ${unexpected.length} unerwartet, ${missing.length} fehlend.`);
  if (missing.length || unexpected.length) process.exitCode = 1;
}

main();
