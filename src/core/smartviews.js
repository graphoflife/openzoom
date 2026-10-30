import { zoomTypeToClasses } from './ifc-classes.js';
import { getValue, valueText } from './props.js';
import { t } from '../i18n.js';

// Smart views: ordered rule lists that build up the visible set, colours and
// transparency. Format and semantics follow the BIMcollab Zoom .bcsv spec v5.

export const ACTIONS = ['Add', 'Remove', 'RemoveOthers', 'SetColored', 'SetTransparent', 'SetOpaque', 'SetAutoColored', 'AddSetColored', 'AddSetTransparent', 'And'];
export const COLOR_ACTIONS = new Set(['SetColored', 'AddSetColored']);
export const CONDITIONS = {
  StringValue: ['Is', 'IsNot', 'Contains', 'DoesNotContain', 'StartsWith', 'EndsWith', 'Or', 'Nor', 'StringIsDefined', 'StringIsNotDefined'],
  DoubleValue: ['Equals', 'NotEquals', 'Less', 'Greater', 'LessEqual', 'GreaterEqual', 'NumericIsDefined', 'NumericIsNotDefined'],
  BoolValue: ['BooleanTrue', 'BooleanFalse', 'BooleanIsDefined', 'BooleanIsNotDefined'],
  LogicalValue: ['LogicalTrue', 'LogicalFalse', 'LogicalUnknown', 'LogicalIsDefined', 'LogicalIsNotDefined'],
};
export const PROPERTY_TYPES = ['Summary', 'Location', 'Material', 'File', 'Project', 'PropertySet'];
export const NO_VALUE_CONDITIONS = new Set(['StringIsDefined', 'StringIsNotDefined', 'NumericIsDefined', 'NumericIsNotDefined', 'BooleanTrue', 'BooleanFalse', 'BooleanIsDefined', 'BooleanIsNotDefined', 'LogicalTrue', 'LogicalFalse', 'LogicalUnknown', 'LogicalIsDefined', 'LogicalIsNotDefined']);

export const PALETTE = [
  [230, 25, 75], [60, 180, 75], [255, 225, 25], [0, 130, 200], [245, 130, 48], [145, 30, 180], [70, 240, 240], [240, 50, 230],
  [210, 245, 60], [250, 190, 212], [0, 128, 128], [220, 190, 255], [170, 110, 40], [255, 250, 200], [128, 0, 0], [170, 255, 195],
  [128, 128, 0], [255, 215, 180], [0, 0, 128], [128, 128, 128], [255, 160, 0], [100, 149, 237], [178, 34, 34], [46, 139, 87],
];

export function paletteColor(k) {
  if (k < PALETTE.length) return PALETTE[k];
  const h = (k * 137.508) % 360;
  return hslToRgb(h / 360, 0.65, 0.55);
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const now = () => new Date().toISOString().slice(0, 19);

// --- condition evaluation ------------------------------------------------------
const toNum = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : NaN);
const lower = (v) => valueText(v).toLowerCase();

function testOne(cond, v) {
  const want = (cond.value ?? '').toString();
  const wl = want.toLowerCase();
  const defined = v !== undefined && v !== null && v !== '';
  switch (cond.type) {
    case 'Is': return defined && lower(v) === wl;
    case 'IsNot': return !defined || lower(v) !== wl;
    case 'Contains': return defined && lower(v).includes(wl);
    case 'DoesNotContain': return !defined || !lower(v).includes(wl);
    case 'StartsWith': return defined && lower(v).startsWith(wl);
    case 'EndsWith': return defined && lower(v).endsWith(wl);
    case 'Or': return defined && splitList(wl).includes(lower(v));
    case 'Nor': return !defined || !splitList(wl).includes(lower(v));
    case 'StringIsDefined': return defined;
    case 'StringIsNotDefined': return !defined;
    case 'NumericIsDefined': return defined && Number.isFinite(toNum(v));
    case 'NumericIsNotDefined': return !defined || !Number.isFinite(toNum(v));
    case 'BooleanIsDefined': case 'LogicalIsDefined': return defined;
    case 'BooleanIsNotDefined': case 'LogicalIsNotDefined': return !defined;
    case 'BooleanTrue': case 'LogicalTrue': return v === true || lower(v) === 'true' || lower(v) === 't';
    case 'BooleanFalse': case 'LogicalFalse': return v === false || lower(v) === 'false' || lower(v) === 'f';
    case 'LogicalUnknown': return lower(v) === 'unknown' || lower(v) === 'u';
    default: break;
  }
  const a = toNum(v), b = toNum(want);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return cond.type === 'NotEquals';
  const eps = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  switch (cond.type) {
    case 'Equals': return Math.abs(a - b) <= eps;
    case 'NotEquals': return Math.abs(a - b) > eps;
    case 'Less': return a < b - eps;
    case 'Greater': return a > b + eps;
    case 'LessEqual': return a <= b + eps;
    case 'GreaterEqual': return a >= b - eps;
    default: return false;
  }
}

function splitList(s) {
  return s.split(/[;|]/).map((x) => x.trim()).filter(Boolean);
}

const NEGATIVE = new Set(['IsNot', 'DoesNotContain', 'Nor', 'StringIsNotDefined', 'NumericIsNotDefined', 'NotEquals', 'BooleanIsNotDefined', 'LogicalIsNotDefined']);

export function testCondition(cond, v) {
  if (Array.isArray(v)) {
    if (!v.length) return testOne(cond, undefined);
    return NEGATIVE.has(cond.type) ? v.every((x) => testOne(cond, x)) : v.some((x) => testOne(cond, x));
  }
  return testOne(cond, v);
}

function makePredicate(rule) {
  const classes = zoomTypeToClasses(rule.ifcType);
  const prop = rule.property || {};
  const noProp = !prop.name && prop.type !== 'Material';
  return (model, i, el) => {
    if (classes && !classes.some((c) => el.supers.includes(c))) return false;
    if (noProp) return true;
    return testCondition(rule.condition || {}, getValue(model, i, prop));
  };
}

/**
 * Evaluate a smart view against all models.
 * @returns {{perModel: Array<{model, vis, ghost, color}>, legend: Array}}
 */
export function evaluate(view, models) {
  const W = models.map((m) => ({ model: m, vis: new Uint8Array(m.count), ghost: new Uint8Array(m.count), color: new Int32Array(m.count).fill(-1) }));
  const legend = [];
  let chain = [];
  for (const rule of view.rules) {
    const pred = makePredicate(rule);
    const type = rule.action?.type || 'Add';
    if (type === 'And') { chain.push(pred); continue; }
    const preds = [...chain, pred];
    chain = [];
    const rgb = [rule.action.r ?? 255, rule.action.g ?? 0, rule.action.b ?? 0];
    const packed = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    const auto = type === 'SetAutoColored' ? new Map() : null;
    let matchCount = 0;
    for (const w of W) {
      const m = w.model;
      const hit = new Uint8Array(m.count);
      for (let i = 0; i < m.count; i++) {
        if (hit[i]) continue;
        const el = m.elements[i];
        if (preds.every((p) => p(m, i, el))) for (const d of m.descendants(i)) hit[d] = 1;
      }
      for (let i = 0; i < m.count; i++) {
        const h = hit[i];
        switch (type) {
          case 'Add': if (h) w.vis[i] = 1; break;
          case 'Remove': if (h) w.vis[i] = 0; break;
          case 'RemoveOthers': if (!h) w.vis[i] = 0; break;
          case 'SetColored': if (h && w.vis[i]) w.color[i] = packed; break;
          case 'SetTransparent': if (h && w.vis[i]) w.ghost[i] = 1; break;
          case 'SetOpaque': if (h && w.vis[i]) w.ghost[i] = 0; break;
          case 'AddSetColored': if (h) { w.vis[i] = 1; w.color[i] = packed; } break;
          case 'AddSetTransparent': if (h) { w.vis[i] = 1; w.ghost[i] = 1; } break;
          case 'SetAutoColored':
            if (h && w.vis[i] && m.hasGeom[i]) {
              const key = valueText(getValue(m, i, rule.property || {})) || '(nicht definiert)';
              let entry = auto.get(key);
              if (!entry) auto.set(key, (entry = { label: key, items: [] }));
              entry.items.push([w, i]);
            }
            break;
          default: break;
        }
        if (h && m.hasGeom[i]) matchCount++;
      }
    }
    if (COLOR_ACTIONS.has(type)) {
      legend.push({ color: rgb, label: ruleLabel(rule), count: matchCount });
    }
    if (auto) {
      const keys = [...auto.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      keys.forEach((key, k) => {
        const c = paletteColor(k);
        const entry = auto.get(key);
        const p = (c[0] << 16) | (c[1] << 8) | c[2];
        for (const [w, i] of entry.items) w.color[i] = p;
        legend.push({ color: c, label: key, count: entry.items.length, items: entry.items, takeoff: takeoff(view, entry.items) });
      });
    }
  }
  return { perModel: W, legend };
}

function takeoff(view, items) {
  const t = view.takeoff;
  if (!t || !t.propName || t.propName === 'None') return null;
  const vals = [];
  for (const [w, i] of items) {
    const v = Number(getValue(w.model, i, { type: t.psetName === 'Summary' ? 'Summary' : 'PropertySet', psetName: t.psetName, name: t.propName }));
    if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return null;
  switch (Number(t.op)) {
    case 1: return vals.reduce((a, b) => a + b, 0) / vals.length;
    case 2: return Math.min(...vals);
    case 3: return Math.max(...vals);
    default: return vals.reduce((a, b) => a + b, 0);
  }
}

export function ruleLabel(rule) {
  const p = rule.property || {};
  const c = rule.condition || {};
  const parts = [rule.ifcType && rule.ifcType !== 'Any' ? rule.ifcType : ''];
  if (p.name) parts.push(p.name);
  if (c.type && !(p.type === 'Summary' && p.name === 'Model' && c.type === 'StringIsDefined')) parts.push(t(`cond.${c.type}`));
  if (c.value && !NO_VALUE_CONDITIONS.has(c.type)) parts.push(c.value);
  return parts.filter(Boolean).join(' ') || 'Regel';
}

/** Write an evaluation result into the element state (with undo). */
export function applyResult(app, result) {
  const st = app.state;
  st.record();
  for (const w of result.perModel) {
    const m = w.model;
    const f = m.flags, c = m.colors;
    for (let i = 0; i < m.count; i++) {
      f[i * 4] = w.vis[i] ? 255 : 0;
      f[i * 4 + 1] = w.ghost[i] ? 255 : 0;
      const col = w.color[i];
      if (col >= 0) { c[i * 4] = (col >> 16) & 255; c[i * 4 + 1] = (col >> 8) & 255; c[i * 4 + 2] = col & 255; c[i * 4 + 3] = 255; }
      else c[i * 4 + 3] = 0;
    }
  }
  st.legend = result.legend.length ? result.legend : null;
  st.changed();
}

// --- rule construction helpers ---------------------------------------------------
export function rule(ifcType, [ptype, psetName, name, valueType = 'StringValue'], [ctype, value = ''], [atype, r, g, b] = ['Add']) {
  return {
    ifcType,
    property: { type: ptype, psetName: psetName ?? (ptype === 'PropertySet' ? '' : ptype), name, valueType, unit: 'None' },
    condition: { type: ctype, value },
    action: { type: atype, r, g, b },
  };
}

const ALL = ['Summary', 'Summary', 'Model'];
const DEF = ['StringIsDefined'];

function view(title, description, rules, takeoff) {
  return { guid: uuid(), title, description, creator: 'OpenZoom', created: now(), modifier: 'OpenZoom', modified: now(), rules, takeoff: takeoff || { psetName: 'None', propName: 'None', op: 0 } };
}

/** Built-in, read-only smart view sets. */
export function builtinSets() {
  const red = [220, 40, 40];
  return [
    {
      guid: 'b1000000-0000-4000-8000-000000000001', title: 'Grundlagen', description: 'Einfache Ansichten', builtin: true, views: [
        view('Alle Elemente', 'Zeigt alle Elemente aller Modelle.', [rule('Any', ALL, DEF, ['Add'])]),
        view('Ohne Räume und Öffnungen', '', [rule('Any', ALL, DEF), rule('Space', ALL, DEF, ['Remove']), rule('Opening', ALL, DEF, ['Remove'])]),
        view('Rohbau', 'Wände, Decken, Stützen, Träger, Treppen, Dächer, Fundamente.', ['Wall', 'Slab', 'Column', 'Beam', 'Stair', 'Roof', 'Footing', 'Member', 'Pile'].map((t) => rule(t, ALL, DEF))),
        view('Tragende Bauteile', 'Tragende Bauteile rot, Rest transparent.', [
          rule('Any', ALL, DEF, ['AddSetTransparent']),
          rule('Any', ['PropertySet', '', 'LoadBearing', 'BoolValue'], ['BooleanTrue'], ['SetOpaque']),
          rule('Any', ['PropertySet', '', 'LoadBearing', 'BoolValue'], ['BooleanTrue'], ['SetColored', ...red]),
        ]),
        view('Außenbauteile', 'Bauteile mit IsExternal = Wahr.', [
          rule('Any', ALL, DEF, ['AddSetTransparent']),
          rule('Any', ['PropertySet', '', 'IsExternal', 'BoolValue'], ['BooleanTrue'], ['SetOpaque']),
          rule('Any', ['PropertySet', '', 'IsExternal', 'BoolValue'], ['BooleanTrue'], ['SetColored', 40, 120, 220]),
        ]),
        view('Nur Räume', 'Räume nach Name eingefärbt.', [rule('Space', ALL, DEF, ['Add']), rule('Space', ['Summary', 'Summary', 'Name'], DEF, ['SetAutoColored'])]),
        view('HLS / Haustechnik', 'Haustechnik farbig, Architektur transparent.', [
          rule('Any', ALL, DEF, ['AddSetTransparent']),
          rule('Distribution Element', ALL, DEF, ['SetOpaque']),
          rule('Space', ALL, DEF, ['Remove']),
        ]),
      ],
    },
    {
      guid: 'b1000000-0000-4000-8000-000000000002', title: 'Automatisch einfärben', description: 'Auto-Color nach Eigenschaften', builtin: true, views: [
        view('Nach Geschoss', '', [rule('Any', ALL, DEF), rule('Space', ALL, DEF, ['Remove']), rule('Any', ['Location', 'Location', 'Building Storey'], DEF, ['SetAutoColored'])]),
        view('Nach IFC-Typ', '', [rule('Any', ALL, DEF), rule('Any', ['Summary', 'Summary', 'IfcType'], DEF, ['SetAutoColored'])]),
        view('Nach Typ', '', [rule('Any', ALL, DEF), rule('Any', ['Summary', 'Summary', 'Type'], ['StringIsDefined'], ['SetAutoColored'])]),
        view('Nach Material', '', [rule('Any', ALL, DEF), rule('Any', ['Material', 'Material', 'Material'], DEF, ['SetAutoColored'])]),
        view('Nach Modell', '', [rule('Any', ALL, DEF), rule('Any', ALL, DEF, ['SetAutoColored'])]),
        view('Nach Klassifikation', '', [rule('Any', ALL, DEF), rule('Any', ['Summary', 'Summary', 'Classification'], DEF, ['SetAutoColored'])]),
        view('Nach Brandschutzklasse', 'FireRating aller Bauteile.', [
          rule('Any', ALL, DEF, ['AddSetTransparent']),
          rule('Any', ['PropertySet', '', 'FireRating'], DEF, ['SetOpaque']),
          rule('Any', ['PropertySet', '', 'FireRating'], DEF, ['SetAutoColored']),
        ]),
        view('Nach System (HLS)', '', [
          rule('Any', ALL, DEF, ['AddSetTransparent']),
          rule('Any', ['Summary', 'Summary', 'System'], DEF, ['SetOpaque']),
          rule('Any', ['Summary', 'Summary', 'System'], DEF, ['SetAutoColored']),
        ]),
        view('Räume nach Nutzung', '', [rule('Space', ALL, DEF), rule('Space', ['Summary', 'Summary', 'Long Name'], DEF, ['SetAutoColored'])]),
      ],
    },
    {
      guid: 'b1000000-0000-4000-8000-000000000003', title: 'Prüfungen', description: 'Datenqualität', builtin: true, views: [
        view('Bauteile ohne Material', '', [
          rule('Any', ALL, DEF, ['AddSetTransparent']),
          rule('Building Element', ['Material', 'Material', 'Material'], ['StringIsNotDefined'], ['SetOpaque']),
          rule('Building Element', ['Material', 'Material', 'Material'], ['StringIsNotDefined'], ['SetColored', ...red]),
        ]),
        view('Elemente ohne Geschoss', '', [
          rule('Any', ALL, DEF, ['AddSetTransparent']),
          rule('Element', ['Location', 'Location', 'Building Storey'], ['StringIsNotDefined'], ['SetOpaque']),
          rule('Element', ['Location', 'Location', 'Building Storey'], ['StringIsNotDefined'], ['SetColored', ...red]),
        ]),
        view('Elemente ohne Typ', '', [
          rule('Any', ALL, DEF, ['AddSetTransparent']),
          rule('Element', ['Summary', 'Summary', 'Type'], ['StringIsNotDefined'], ['SetOpaque']),
          rule('Element', ['Summary', 'Summary', 'Type'], ['StringIsNotDefined'], ['SetColored', ...red]),
          rule('Opening', ALL, DEF, ['Remove']),
        ]),
        view('Wände ohne Brandschutzklasse', '', [
          rule('Any', ALL, DEF, ['AddSetTransparent']),
          rule('Wall', ['PropertySet', '', 'FireRating'], ['StringIsNotDefined'], ['SetOpaque']),
          rule('Wall', ['PropertySet', '', 'FireRating'], ['StringIsNotDefined'], ['SetColored', ...red]),
        ]),
        view('Proxy-Elemente', 'IfcBuildingElementProxy sind oft falsch klassifiziert.', [
          rule('Any', ALL, DEF, ['AddSetTransparent']),
          rule('Building Element Proxy', ALL, DEF, ['SetOpaque']),
          rule('Building Element Proxy', ALL, DEF, ['SetColored', 255, 140, 0]),
        ]),
      ],
    },
  ];
}

// --- .bcsv import / export ------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function exportBcsv(sets) {
  const L = [];
  L.push('<?xml version="1.0"?>');
  L.push('<bimcollabsmartviewfile>');
  L.push('  <version>5</version>');
  L.push('  <applicationversion>OpenZoom 1.0</applicationversion>');
  L.push('</bimcollabsmartviewfile>');
  L.push('<SMARTVIEWSETS>');
  for (const s of sets) {
    L.push('  <SMARTVIEWSET>');
    L.push(`    <TITLE>${esc(s.title)}</TITLE>`);
    L.push(`    <DESCRIPTION>${esc(s.description)}</DESCRIPTION>`);
    L.push(`    <GUID>${esc(s.guid)}</GUID>`);
    L.push(`    <MODIFICATIONDATE>${esc(s.modified || now())}</MODIFICATIONDATE>`);
    L.push('    <SMARTVIEWS>');
    for (const v of s.views) {
      L.push('      <SMARTVIEW>');
      L.push(`        <TITLE>${esc(v.title)}</TITLE>`);
      L.push(`        <DESCRIPTION>${esc(v.description)}</DESCRIPTION>`);
      L.push(`        <CREATOR>${esc(v.creator)}</CREATOR>`);
      L.push(`        <CREATIONDATE>${esc(v.created || now())}</CREATIONDATE>`);
      L.push(`        <MODIFIER>${esc(v.modifier)}</MODIFIER>`);
      L.push(`        <MODIFICATIONDATE>${esc(v.modified || now())}</MODIFICATIONDATE>`);
      L.push(`        <GUID>${esc(v.guid)}</GUID>`);
      L.push('        <RULES>');
      for (const r of v.rules) {
        const p = r.property || {};
        const c = r.condition || {};
        const a = r.action || {};
        L.push('          <RULE>');
        L.push(`            <IFCTYPE>${esc(r.ifcType || 'Any')}</IFCTYPE>`);
        L.push('            <PROPERTY>');
        L.push(`              <NAME>${esc(p.name)}</NAME>`);
        L.push(`              <PROPERTYSETNAME>${esc(p.psetName ?? '')}</PROPERTYSETNAME>`);
        L.push(`              <TYPE>${esc(p.type || 'PropertySet')}</TYPE>`);
        L.push(`              <VALUETYPE>${esc(p.valueType || 'StringValue')}</VALUETYPE>`);
        L.push(`              <UNIT>${esc(p.unit || 'None')}</UNIT>`);
        L.push('            </PROPERTY>');
        L.push('            <CONDITION>');
        L.push(`              <TYPE>${esc(c.type || 'StringIsDefined')}</TYPE>`);
        L.push(c.value ? `              <VALUE>${esc(c.value)}</VALUE>` : '              <VALUE/>');
        if (c.state) L.push(`              <STATE>${esc(c.state)}</STATE>`);
        L.push('            </CONDITION>');
        L.push('            <ACTION>');
        L.push(`              <TYPE>${esc(a.type || 'Add')}</TYPE>`);
        if (['SetColored', 'AddSetColored', 'SetAutoColored'].includes(a.type) && a.r !== undefined) {
          L.push(`              <R>${a.r | 0}</R>`, `              <G>${a.g | 0}</G>`, `              <B>${a.b | 0}</B>`);
        }
        L.push('            </ACTION>');
        L.push('          </RULE>');
      }
      L.push('        </RULES>');
      const t = v.takeoff || {};
      L.push('        <INFORMATIONTAKEOFF>');
      L.push(`          <PROPERTYSETNAME>${esc(t.psetName || 'None')}</PROPERTYSETNAME>`);
      L.push(`          <PROPERTYNAME>${esc(t.propName || 'None')}</PROPERTYNAME>`);
      L.push(`          <OPERATION>${Number(t.op) || 0}</OPERATION>`);
      L.push('        </INFORMATIONTAKEOFF>');
      L.push('      </SMARTVIEW>');
    }
    L.push('    </SMARTVIEWS>');
    L.push('  </SMARTVIEWSET>');
  }
  L.push('</SMARTVIEWSETS>');
  return L.join('\r\n');
}

/** Parse a .bcsv file (the format has two root elements, so it is wrapped first). */
export function importBcsv(text) {
  const body = text.replace(/^﻿/, '').replace(/<\?xml[^>]*\?>/i, '');
  const doc = new DOMParser().parseFromString(`<root>${body}</root>`, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Ungültige .bcsv-Datei');
  const kid = (el, name) => [...el.children].find((c) => c.tagName.toUpperCase() === name);
  const txt = (el, name) => (kid(el, name)?.textContent ?? '').trim();
  const sets = [];
  for (const s of doc.getElementsByTagName('SMARTVIEWSET')) {
    const set = { guid: txt(s, 'GUID') || uuid(), title: txt(s, 'TITLE'), description: txt(s, 'DESCRIPTION'), modified: txt(s, 'MODIFICATIONDATE'), views: [] };
    const views = kid(s, 'SMARTVIEWS');
    for (const v of views ? [...views.children] : []) {
      const rules = [];
      const rr = kid(v, 'RULES');
      for (const r of rr ? [...rr.children] : []) {
        const p = kid(r, 'PROPERTY'), c = kid(r, 'CONDITION'), a = kid(r, 'ACTION');
        const num = (x) => (x === '' ? undefined : Number(x));
        rules.push({
          ifcType: txt(r, 'IFCTYPE') || 'Any',
          property: p ? { name: txt(p, 'NAME'), psetName: txt(p, 'PROPERTYSETNAME'), type: txt(p, 'TYPE') || 'PropertySet', valueType: txt(p, 'VALUETYPE') || 'StringValue', unit: txt(p, 'UNIT') || 'None' } : {},
          condition: c ? { type: txt(c, 'TYPE'), value: txt(c, 'VALUE'), state: txt(c, 'STATE') || undefined } : {},
          action: a ? { type: txt(a, 'TYPE') || 'Add', r: num(txt(a, 'R')), g: num(txt(a, 'G')), b: num(txt(a, 'B')) } : { type: 'Add' },
        });
      }
      const t = kid(v, 'INFORMATIONTAKEOFF');
      set.views.push({
        guid: txt(v, 'GUID') || uuid(), title: txt(v, 'TITLE'), description: txt(v, 'DESCRIPTION'),
        creator: txt(v, 'CREATOR'), created: txt(v, 'CREATIONDATE'), modifier: txt(v, 'MODIFIER'), modified: txt(v, 'MODIFICATIONDATE'),
        rules, takeoff: t ? { psetName: txt(t, 'PROPERTYSETNAME'), propName: txt(t, 'PROPERTYNAME'), op: Number(txt(t, 'OPERATION')) || 0 } : null,
      });
    }
    sets.push(set);
  }
  return sets;
}

/** Smart view library: built-in sets + user sets persisted in localStorage. */
export class SmartViewLibrary extends EventTarget {
  constructor() {
    super();
    this.builtin = builtinSets();
    this.local = [];
    try { this.local = JSON.parse(localStorage.getItem('oz.smartviews') || '[]'); } catch { this.local = []; }
    this.activeGuid = null;
  }

  get sets() { return [...this.builtin, ...this.local]; }

  save() {
    try { localStorage.setItem('oz.smartviews', JSON.stringify(this.local)); } catch { /* quota */ }
    this.dispatchEvent(new Event('change'));
  }

  findView(guid) {
    for (const s of this.sets) for (const v of s.views) if (v.guid === guid) return { set: s, view: v };
    return null;
  }

  addSet(title) {
    const s = { guid: uuid(), title, description: '', modified: now(), views: [] };
    this.local.push(s);
    this.save();
    return s;
  }

  importSets(sets) {
    for (const s of sets) {
      const existing = this.local.find((x) => x.guid === s.guid);
      if (existing) Object.assign(existing, s);
      else this.local.push(s);
    }
    this.save();
  }

  copySet(set) {
    const c = JSON.parse(JSON.stringify(set));
    c.guid = uuid();
    c.title = `${set.title} (Kopie)`;
    delete c.builtin;
    c.views.forEach((v) => { v.guid = uuid(); });
    this.local.push(c);
    this.save();
    return c;
  }

  removeSet(set) {
    this.local = this.local.filter((s) => s !== set);
    this.save();
  }

  newView(set, title) {
    const v = view(title, '', [rule('Any', ALL, DEF, ['Add'])]);
    set.views.push(v);
    this.save();
    return v;
  }
}
