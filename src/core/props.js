import { classToZoomType } from './ifc-classes.js';

// Property access shared by the properties panel, smart views, lists and search.
// Property "types" follow the BIMcollab .bcsv vocabulary:
// Summary | Location | Material | File | Project | PropertySet.

const norm = (s) => (s || '').toLowerCase().replace(/[\s_-]+/g, '');

function siblingName(model, idx) {
  return idx === undefined || idx < 0 ? '' : model.elements[idx].name || model.elements[idx].longName || '';
}

/** Summary values of an element as [key, value, unit] (keys are bcsv names). */
export function summaryProps(model, i) {
  const el = model.elements[i];
  const rows = [
    ['Name', el.name],
    ['Description', el.desc],
    ['GUID', el.guid],
    ['IfcType', classToZoomType(el.cls)],
    ['IfcEntity', el.cls],
    ['Type', el.typeName],
    ['Object Type', el.objType],
    ['Predefined Type', el.predef],
    ['Tag', el.tag],
    ['Model', model.name],
    ['Classification', classificationText(model, el)[0] || ''],
    ['System', systems(model, el)[0] || ''],
  ];
  if (el.longName) rows.splice(1, 0, ['Long Name', el.longName]);
  if (model.hasGeom[i]) {
    rows.push(['Volume', round(el.volume, 4), 'm³']);
    rows.push(['Area', round(el.area, 3), 'm²']);
    const b = model.bboxes;
    rows.push(['Height', round(b[i * 6 + 4] - b[i * 6 + 1], 3), 'm']);
    rows.push(['Bottom Elevation', round(b[i * 6 + 1] + (model.offset?.[1] || 0), 3), 'm']);
    rows.push(['Top Elevation', round(b[i * 6 + 4] + (model.offset?.[1] || 0), 3), 'm']);
  }
  if (el.elevation !== null && el.elevation !== undefined) rows.push(['Elevation', round(el.elevation, 3), 'm']);
  return rows.map(([k, v, u]) => [k, v === undefined ? '' : v, u || '']);
}

function round(v, d) {
  if (!Number.isFinite(v)) return '';
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export function locationProps(model, i) {
  const el = model.elements[i];
  const storey = el.storey >= 0 && el.storey !== undefined ? model.elements[el.storey] : null;
  return [
    ['Site', siblingName(model, el.site), ''],
    ['Building', siblingName(model, el.building), ''],
    ['Building Storey', storey ? storey.name : '', ''],
    ['Storey Elevation', storey && storey.elevation !== null ? round(storey.elevation, 3) : '', storey ? 'm' : ''],
    ['Space', el.space !== undefined ? `${model.elements[el.space].name} ${model.elements[el.space].longName || ''}`.trim() : '', ''],
  ];
}

export function materialNames(model, el) {
  return el.mat >= 0 ? model.materials[el.mat].names : [];
}

export function materialProps(model, i) {
  const el = model.elements[i];
  if (el.mat < 0) return [['Material', '', '']];
  const info = model.materials[el.mat];
  const rows = [['Material', info.names.join(', '), '']];
  if (info.set) rows.push(['Material Layer Set', info.set, '']);
  info.layers.forEach((l, k) => rows.push([`Schicht ${k + 1}`, `${l.name} (${l.thickness})`, model.units.length]));
  return rows;
}

export function classificationText(model, el) {
  return el.classes.map((c) => {
    const x = model.classes[c];
    return [x.code, x.name !== x.code ? x.name : ''].filter(Boolean).join(' ');
  });
}

export function systems(model, el) {
  return el.groups.map((g) => model.groups[g]).filter((g) => /System|Circuit/i.test(g.cls)).map((g) => g.name);
}

export function fileProps(model) {
  return [
    ['File Name', model.name, ''],
    ['Schema', model.schema, ''],
    ['Application', model.header?.application || '', ''],
    ['Author', model.header?.author || '', ''],
    ['Organization', model.header?.organization || '', ''],
  ];
}

export function projectProps(model) {
  const p = model.project || {};
  return [['Name', p.name || '', ''], ['Long Name', p.longName || '', ''], ['Phase', p.phase || '', ''], ['Description', p.desc || '', '']];
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
  if (el.classes.length) {
    groups.push({ key: 'Classification', type: 'PropertySet', props: el.classes.map((c) => [model.classes[c].system || 'Klassifikation', `${model.classes[c].code} ${model.classes[c].name}`.trim(), '']) });
  }
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

const SUMMARY_ALIASES = {
  ifctype: 'IfcType', ifcentity: 'IfcEntity', entity: 'IfcEntity', elementtype: 'IfcType', class: 'IfcEntity',
  name: 'Name', description: 'Description', guid: 'GUID', globalid: 'GUID', type: 'Type', typename: 'Type',
  objecttype: 'Object Type', predefinedtype: 'Predefined Type', tag: 'Tag', model: 'Model', modelname: 'Model',
  classification: 'Classification', system: 'System', volume: 'Volume', area: 'Area', height: 'Height', longname: 'Long Name',
  bottomelevation: 'Bottom Elevation', topelevation: 'Top Elevation', elevation: 'Elevation',
};
const LOCATION_ALIASES = {
  site: 'Site', building: 'Building', buildingstorey: 'Building Storey', buildingstory: 'Building Storey', storey: 'Building Storey',
  story: 'Building Storey', level: 'Building Storey', geschoss: 'Building Storey', storeyelevation: 'Storey Elevation', space: 'Space', room: 'Space',
};

function summaryValue(model, i, el, key) {
  const b = model.bboxes;
  const oy = model.offset?.[1] || 0;
  switch (key) {
    case 'Name': return el.name;
    case 'Long Name': return el.longName;
    case 'Description': return el.desc;
    case 'GUID': return el.guid;
    case 'IfcType': return classToZoomType(el.cls);
    case 'IfcEntity': return el.cls;
    case 'Type': return el.typeName;
    case 'Object Type': return el.objType;
    case 'Predefined Type': return el.predef;
    case 'Tag': return el.tag;
    case 'Model': return model.name;
    case 'Classification': return classificationText(model, el);
    case 'System': return systems(model, el);
    case 'Volume': return model.hasGeom[i] ? el.volume : undefined;
    case 'Area': return model.hasGeom[i] ? el.area : undefined;
    case 'Height': return model.hasGeom[i] ? b[i * 6 + 4] - b[i * 6 + 1] : undefined;
    case 'Bottom Elevation': return model.hasGeom[i] ? b[i * 6 + 1] + oy : undefined;
    case 'Top Elevation': return model.hasGeom[i] ? b[i * 6 + 4] + oy : undefined;
    case 'Elevation': return el.elevation ?? undefined;
    default: return undefined;
  }
}

/**
 * Value of a property reference {type, psetName, name} for an element.
 * Returns undefined when the property does not exist, arrays for multi-valued ones.
 */
export function getValue(model, i, prop) {
  const type = prop.type || 'PropertySet';
  const name = norm(prop.name);
  const el = model.elements[i];
  if (type === 'Summary') {
    const v = summaryValue(model, i, el, SUMMARY_ALIASES[name]);
    return v === '' || v === null || (Array.isArray(v) && !v.length) ? undefined : v;
  }
  if (type === 'Location') {
    const key = LOCATION_ALIASES[name] || prop.name;
    const row = locationProps(model, i).find((r) => r[0] === key);
    return row && row[1] !== '' ? row[1] : undefined;
  }
  if (type === 'Material') {
    if (name.includes('layerset')) return el.mat >= 0 && model.materials[el.mat].set ? model.materials[el.mat].set : undefined;
    const m = materialNames(model, el);
    return m.length ? m : undefined;
  }
  if (type === 'File') {
    const row = fileProps(model).find((r) => norm(r[0]) === name || (name === 'name' && r[0] === 'File Name'));
    return row && row[1] !== '' ? row[1] : undefined;
  }
  if (type === 'Project') {
    const row = projectProps(model).find((r) => norm(r[0]) === name);
    return row && row[1] !== '' ? row[1] : undefined;
  }
  // PropertySet (and "None"): match set name (empty or * = any set), then property name.
  const psetName = norm(prop.psetName);
  const anySet = !psetName || psetName === '*' || type === 'None';
  if (!anySet && psetName === 'classification') {
    const hit = el.classes.map((c) => model.classes[c]).find((c) => norm(c.system) === name || name === '*' || !name);
    return hit ? `${hit.code} ${hit.name}`.trim() : undefined;
  }
  for (const ps of psetsOf(model, i)) {
    if (!anySet && norm(ps.n) !== psetName) continue;
    for (const p of ps.p) if (norm(p[0]) === name) return p[1] === null ? undefined : p[1];
  }
  return undefined;
}

/** Text form of a value for display / grouping. */
export function valueText(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return String(v);
}

/** Collect available property names (for editor dropdowns). */
export function collectPropertyCatalog(models, limitPerModel = 20000) {
  const sets = new Map(); // psetName -> Set(propName)
  for (const m of models) {
    let n = 0;
    for (let i = 0; i < m.count && n < limitPerModel; i++, n++) {
      for (const ps of psetsOf(m, i)) {
        let s = sets.get(ps.n);
        if (!s) sets.set(ps.n, (s = new Set()));
        for (const p of ps.p) s.add(p[0]);
      }
    }
  }
  return sets;
}
