import { classToZoomType } from './ifc-classes.js';

// Property access shared by the properties panel, smart views, lists and search.
// Property "types" follow the BIMcollab .bcsv vocabulary:
// Summary | Location | Material | File | Project | PropertySet.

// Names of our own fixed properties and their aliases are matched loosely ...
const norm = (s) => (s || '').toLowerCase().replace(/[\s_-]+/g, '');
// ... property set and property names from the model only ignore case: exporters use
// names that differ by a space or hyphen alone ("Rahmen Breite" vs "Rahmen-Breite").
const nameKey = (s) => (s || '').toLowerCase();

/** World height of a storey: its placement, or Elevation when an exporter puts every storey at Z = 0. */
export function storeyZ(el) {
  const pz = el.placementZ, ev = el.elevation;
  if (pz === undefined || pz === null) return ev ?? 0;
  if (Math.abs(pz) < 1e-9 && ev) return ev;
  return pz;
}

function siblingName(model, idx) {
  return idx === undefined || idx < 0 ? undefined : model.elements[idx].name || model.elements[idx].longName;
}

const storeyOf = (model, el) => (el.storey >= 0 ? model.elements[el.storey] : null);
const bboxAt = (model, i, k) => model.bboxes[i * 6 + k];
const offsetY = (model) => model.offset?.[1] || 0;

/*
 * Fixed properties, one table per bcsv property type. Each entry is the single
 * definition used for display, smart view / list lookup, the property catalog and
 * the German label:
 *   name     bcsv name          aliases  extra names accepted in rules (normalized)
 *   get      raw value          digits   rounding, applied to display AND lookup
 *   unit     display unit       geom     only elements with geometry have it
 *   optional row left out when there is no value
 */
const FIXED = {
  Summary: [
    { name: 'Name', get: (m, i, el) => el.name },
    { name: 'Long Name', de: 'Langname', optional: true, get: (m, i, el) => el.longName },
    { name: 'Description', de: 'Beschreibung', get: (m, i, el) => el.desc },
    { name: 'GUID', aliases: ['globalid'], get: (m, i, el) => el.guid },
    { name: 'IfcType', de: 'Elementtyp', aliases: ['elementtype'], get: (m, i, el) => classToZoomType(el.cls) },
    { name: 'IfcEntity', de: 'IFC-Klasse', aliases: ['entity', 'class'], get: (m, i, el) => el.cls },
    { name: 'Type', de: 'Typ', aliases: ['typename'], get: (m, i, el) => el.typeName },
    { name: 'Object Type', de: 'Objekttyp', get: (m, i, el) => el.objType },
    { name: 'Predefined Type', de: 'Vordefinierter Typ', get: (m, i, el) => el.predef },
    { name: 'Tag', de: 'Kennung (Tag)', get: (m, i, el) => el.tag },
    { name: 'Model', de: 'Modell', aliases: ['modelname'], get: (m) => m.name },
    { name: 'Classification', de: 'Klassifikation', get: (m, i, el) => classificationText(m, el) },
    { name: 'System', get: (m, i, el) => systems(m, el) },
    { name: 'Volume', de: 'Volumen', unit: 'm³', digits: 4, geom: true, optional: true, get: (m, i, el) => el.volume },
    { name: 'Area', de: 'Oberfläche', unit: 'm²', digits: 3, geom: true, optional: true, get: (m, i, el) => el.area },
    { name: 'Height', de: 'Höhe', unit: 'm', digits: 3, geom: true, optional: true, get: (m, i) => bboxAt(m, i, 4) - bboxAt(m, i, 1) },
    { name: 'Bottom Elevation', de: 'UK (absolut)', unit: 'm', digits: 3, geom: true, optional: true, get: (m, i) => bboxAt(m, i, 1) + offsetY(m) },
    { name: 'Top Elevation', de: 'OK (absolut)', unit: 'm', digits: 3, geom: true, optional: true, get: (m, i) => bboxAt(m, i, 4) + offsetY(m) },
    { name: 'Elevation', de: 'Höhe (Elevation)', unit: 'm', digits: 3, optional: true, get: (m, i, el) => el.elevation },
  ],
  Location: [
    { name: 'Site', de: 'Grundstück', get: (m, i, el) => siblingName(m, el.site) },
    { name: 'Building', de: 'Gebäude', get: (m, i, el) => siblingName(m, el.building) },
    { name: 'Building Storey', de: 'Geschoss', aliases: ['buildingstory', 'storey', 'story', 'level', 'geschoss'], get: (m, i, el) => storeyOf(m, el)?.name },
    { name: 'Storey Elevation', de: 'Geschosshöhe', unit: 'm', digits: 3, get: (m, i, el) => storeyOf(m, el)?.elevation },
    { name: 'Space', de: 'Raum', aliases: ['room'], get: (m, i, el) => (el.space !== undefined ? `${m.elements[el.space].name} ${m.elements[el.space].longName || ''}`.trim() : undefined) },
  ],
  Material: [
    { name: 'Material', get: (m, i, el) => materialNames(m, el) },
    { name: 'Material Layer Set', de: 'Schichtaufbau', aliases: ['layerset'], optional: true, get: (m, i, el) => (el.mat >= 0 ? m.materials[el.mat].set : undefined) },
  ],
  File: [
    { name: 'File Name', de: 'Dateiname', aliases: ['name'], get: (m) => m.name },
    { name: 'Schema', get: (m) => m.schema },
    { name: 'Application', de: 'Anwendung', get: (m) => m.header?.application },
    { name: 'Author', de: 'Autor', get: (m) => m.header?.author },
    { name: 'Organization', de: 'Organisation', get: (m) => m.header?.organization },
  ],
  Project: [
    { name: 'Name', get: (m) => m.project?.name },
    { name: 'Long Name', de: 'Langname', get: (m) => m.project?.longName },
    { name: 'Phase', get: (m) => m.project?.phase },
    { name: 'Description', de: 'Beschreibung', get: (m) => m.project?.desc },
  ],
};

const FIXED_INDEX = Object.fromEntries(Object.entries(FIXED).map(([type, defs]) => {
  const index = new Map();
  for (const d of defs) for (const n of [d.name, ...(d.aliases || [])]) index.set(norm(n), d);
  return [type, index];
}));

/** Definition of a fixed property by type and name (or alias), else null. */
export function fixedProperty(type, name) {
  return FIXED_INDEX[type]?.get(norm(name)) || null;
}

/** The fixed property a rule refers to: a Material rule with another (or no) name tests the material itself. */
function ruleFixedProperty(type, name) {
  return fixedProperty(type, name) || (type === 'Material' ? fixedProperty('Material', 'Material') : null);
}

/** Value of a fixed property: undefined when missing, rounded to its digits. */
function read(d, model, i) {
  if (d.geom && !model.hasGeom[i]) return undefined;
  const v = d.get(model, i, model.elements[i]);
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return undefined;
  if (typeof v !== 'number' || d.digits === undefined) return v;
  if (!Number.isFinite(v)) return undefined;
  const f = 10 ** d.digits;
  return Math.round(v * f) / f;
}

/** Display rows [name, value, unit] of a fixed property type; i < 0 for per-file types. */
function fixedRows(type, model, i) {
  const rows = [];
  for (const d of FIXED[type]) {
    const v = read(d, model, i);
    if (v === undefined && d.optional) continue;
    rows.push([d.name, v ?? '', d.unit || '']);
  }
  return rows;
}

export const summaryProps = (model, i) => fixedRows('Summary', model, i);
export const locationProps = (model, i) => fixedRows('Location', model, i);
export const fileProps = (model) => fixedRows('File', model, -1);
export const projectProps = (model) => fixedRows('Project', model, -1);

export function materialNames(model, el) {
  return el.mat >= 0 ? model.materials[el.mat].names : [];
}

/** Material rows plus the layers of a layer set (layers are display only). */
export function materialProps(model, i) {
  const el = model.elements[i];
  const rows = fixedRows('Material', model, i);
  if (el.mat >= 0) model.materials[el.mat].layers.forEach((l, k) => rows.push([`Schicht ${k + 1}`, `${l.name} (${l.thickness})`, model.units.length]));
  return rows;
}

export function classificationText(model, el) {
  return el.classes.map((c) => {
    const x = model.classes[c];
    return [x.code, x.name !== x.code ? x.name : ''].filter(Boolean).join(' ');
  });
}

/** Classifications as a property set "Classification": one row per classification system. */
function classificationRows(model, el) {
  return el.classes.map((c) => {
    const x = model.classes[c];
    return [x.system || 'Klassifikation', `${x.code} ${x.name}`.trim(), ''];
  });
}

export function systems(model, el) {
  return el.groups.map((g) => model.groups[g]).filter((g) => /System|Circuit/i.test(g.cls)).map((g) => g.name);
}

/** Property sets of an element (instance first, then type sets). */
export function psetsOf(model, i) {
  const el = model.elements[i];
  const out = el.psets.map((k) => model.psets[k]);
  for (const k of el.typePsets) out.push(model.psets[k]);
  return out;
}

/** Every property group shown in the properties panel. */
export function propertyGroups(model, i) {
  const el = model.elements[i];
  const groups = [
    { key: 'Summary', type: 'Summary', props: summaryProps(model, i) },
    { key: 'Location', type: 'Location', props: locationProps(model, i) },
    { key: 'Material', type: 'Material', props: materialProps(model, i) },
  ];
  if (el.classes.length) groups.push({ key: 'Classification', type: 'PropertySet', props: classificationRows(model, el) });
  if (el.groups.length) {
    groups.push({ key: 'Groups', type: 'PropertySet', props: el.groups.map((g) => [model.groups[g].cls.replace(/^Ifc/, ''), model.groups[g].name, '']) });
  }
  for (const ps of psetsOf(model, i)) {
    groups.push({ key: ps.n, type: 'PropertySet', props: ps.p, fromType: !!ps.t, quantity: !!ps.q });
  }
  groups.push({ key: 'File', type: 'File', props: fileProps(model) });
  groups.push({ key: 'Project', type: 'Project', props: projectProps(model) });
  return groups;
}

/**
 * Value of a property reference {type, psetName, name} for an element.
 * Returns undefined when the property does not exist, arrays for multi-valued ones.
 */
export function getValue(model, i, prop) {
  const type = prop.type || 'PropertySet';
  if (FIXED[type]) {
    const d = ruleFixedProperty(type, prop.name);
    return d ? read(d, model, i) : undefined;
  }
  // PropertySet (and "None"): match set name (empty or * = any set), then property name.
  const name = nameKey(prop.name);
  const psetName = nameKey(prop.psetName);
  const anySet = !psetName || psetName === '*' || type === 'None';
  if (!anySet && psetName === 'classification') {
    const rows = classificationRows(model, model.elements[i]);
    const row = !name || name === '*' ? rows[0] : rows.find((r) => nameKey(r[0]) === name);
    return row ? row[1] : undefined;
  }
  for (const ps of psetsOf(model, i)) {
    if (!anySet && nameKey(ps.n) !== psetName) continue;
    for (const p of ps.p) if (nameKey(p[0]) === name) return p[1] === null ? undefined : p[1];
  }
  return undefined;
}

/** Precision of numbers in value texts; smart view comparisons use the same, so a shown value matches. */
export const roundNumber = (v) => Math.round(v * 1e6) / 1e6;

/** Text form of a value for display / grouping. */
export function valueText(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(roundNumber(v));
  return String(v);
}

const MAX_VALUES = 500;

/**
 * Union of every property found on any element of any model, grouped like the
 * smart view property types. Each property records how many elements carry it,
 * its inferred bcsv value type and the distinct values (capped) with counts.
 * @returns {{groups: Array<{type, psetName, props: Array<{name, count, valueType, unit, values: Array<[string, number]>, more: boolean}>}>}}
 */
export function buildPropertyCatalog(models) {
  const groups = new Map();
  // keyed like getValue matches names, so one entry is one property for the rules
  const add = (type, psetName, name, value, unit, n = 1) => {
    if (!name) return;
    const gk = `${type}|${nameKey(psetName)}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = { type, psetName, props: new Map() }));
    let p = g.props.get(nameKey(name));
    if (!p) g.props.set(nameKey(name), (p = { name, count: 0, kinds: new Set(), unit: unit || '', values: new Map(), more: false }));
    p.count += n;
    if (value === undefined || value === null || value === '') return;
    const vals = Array.isArray(value) ? value : [value];
    for (const v of vals) {
      p.kinds.add(v === 'UNKNOWN' ? 'logical' : typeof v);
      const key = valueText(v);
      if (p.values.has(key)) p.values.set(key, p.values.get(key) + n);
      else if (p.values.size < MAX_VALUES) p.values.set(key, n);
      else p.more = true;
    }
  };
  for (const m of models) {
    for (const [k, v, u] of fileProps(m)) add('File', 'File', k, v, u, m.count);
    for (const [k, v, u] of projectProps(m)) add('Project', 'Project', k, v, u, m.count);
    for (let i = 0; i < m.count; i++) {
      const el = m.elements[i];
      if (el.cls === 'IfcProject') continue;
      // same rows and rounding as the properties panel and getValue
      for (const type of ['Summary', 'Location', 'Material']) for (const [k, v, u] of fixedRows(type, m, i)) add(type, type, k, v, u);
      for (const [k, v, u] of classificationRows(m, el)) add('PropertySet', 'Classification', k, v, u);
      // a property present in both the instance and the type set counts once per element;
      // psetName '' collects every property regardless of its set ("any property set")
      const seen = new Set();
      const seenAny = new Set();
      for (const ps of psetsOf(m, i)) {
        for (const [name, value, unit] of ps.p) {
          const key = `${nameKey(ps.n)}\u0000${nameKey(name)}`;
          if (!seen.has(key)) { seen.add(key); add('PropertySet', ps.n, name, value, unit); }
          if (!seenAny.has(nameKey(name))) { seenAny.add(nameKey(name)); add('PropertySet', '', name, value, unit); }
        }
      }
    }
  }
  const order = { Summary: 0, Location: 1, Material: 2, PropertySet: 3, File: 4, Project: 5 };
  const out = [...groups.values()].map((g) => ({
    type: g.type,
    psetName: g.psetName,
    props: [...g.props.values()].map((p) => ({
      name: p.name, count: p.count, unit: p.unit, more: p.more, valueType: inferValueType(p.kinds),
      values: [...p.values].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })),
    })).sort((a, b) => (g.type === 'PropertySet' ? a.name.localeCompare(b.name, undefined, { numeric: true }) : 0)),
  }));
  out.sort((a, b) => order[a.type] - order[b.type] || a.psetName.localeCompare(b.psetName, undefined, { numeric: true }));
  return { groups: out };
}

function inferValueType(kinds) {
  if (!kinds.size) return 'StringValue';
  if ([...kinds].every((k) => k === 'boolean')) return 'BoolValue';
  if ([...kinds].every((k) => k === 'boolean' || k === 'logical')) return 'LogicalValue';
  if ([...kinds].every((k) => k === 'number')) return 'DoubleValue';
  return 'StringValue';
}

/** Find a property entry in a catalog (empty pset name = any property set). */
export function catalogEntry(catalog, prop) {
  if (!catalog || !prop) return null;
  const type = prop.type || 'PropertySet';
  const name = nameKey(FIXED[type] ? ruleFixedProperty(type, prop.name)?.name : prop.name);
  const anySet = !prop.psetName || prop.psetName === '*';
  for (const g of catalog.groups) {
    if (g.type !== type) continue;
    if (type === 'PropertySet' && (anySet ? g.psetName !== '' : nameKey(g.psetName) !== nameKey(prop.psetName))) continue;
    const p = g.props.find((x) => nameKey(x.name) === name);
    if (p) return p;
  }
  return null;
}
