import { zoomTypeToClasses, isGated, namesGatedType } from './ifc-classes.js';
import { getValue, valueText, roundNumber } from './props.js';
import { packRgb } from './models.js';
import { t } from '../i18n.js';
import { uuid } from './util.js';
import { E, render, parseXml, elems, child, text, descendants } from './xml.js';

// Smart views: ordered rule lists that build up the visible set, colours and
// transparency. Format and semantics follow the BIMcollab Zoom .bcsv spec v5.

export const PROPERTY_TYPES = ['Summary', 'Location', 'Material', 'File', 'Project', 'PropertySet'];

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

const now = () => new Date().toISOString().slice(0, 19);

// --- conditions -------------------------------------------------------------------
const toNum = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : NaN);
const lower = (v) => valueText(v).toLowerCase();
const defined = (v) => v !== undefined && v !== null && v !== '';
const splitList = (s) => s.split(/[;|]/).map((x) => x.trim()).filter(Boolean);
const isTrue = (v) => v === true || lower(v) === 'true' || lower(v) === 't';
const isFalse = (v) => v === false || lower(v) === 'false' || lower(v) === 'f';
// case-insensitive test of a defined value's text
const byText = (f) => (v, want) => defined(v) && f(lower(v), want.toLowerCase());
// compare at the precision values are shown with (valueText); false unless both sides are numbers
const byNumber = (f) => (v, want) => {
  const a = roundNumber(toNum(v)), b = roundNumber(toNum(want));
  return Number.isFinite(a) && Number.isFinite(b) && f(a, b, 1e-12 * Math.max(1, Math.abs(a), Math.abs(b)));
};

/**
 * Every condition, in UI order: the value type it belongs to, whether it takes no value, and
 * either `test(v, want)` for one property value or `not`, the condition it negates. A list value
 * meets a condition when any entry does, and a negation when no entry meets the negated condition.
 */
const CONDITION_DEFS = {
  Is: { valueType: 'StringValue', test: byText((s, w) => s === w) },
  IsNot: { valueType: 'StringValue', not: 'Is' },
  Contains: { valueType: 'StringValue', test: byText((s, w) => s.includes(w)) },
  DoesNotContain: { valueType: 'StringValue', not: 'Contains' },
  StartsWith: { valueType: 'StringValue', test: byText((s, w) => s.startsWith(w)) },
  EndsWith: { valueType: 'StringValue', test: byText((s, w) => s.endsWith(w)) },
  Or: { valueType: 'StringValue', test: byText((s, w) => splitList(w).includes(s)) },
  Nor: { valueType: 'StringValue', not: 'Or' },
  StringIsDefined: { valueType: 'StringValue', noValue: true, test: defined },
  StringIsNotDefined: { valueType: 'StringValue', noValue: true, not: 'StringIsDefined' },
  Equals: { valueType: 'DoubleValue', test: byNumber((a, b, eps) => Math.abs(a - b) <= eps) },
  NotEquals: { valueType: 'DoubleValue', not: 'Equals' },
  Less: { valueType: 'DoubleValue', test: byNumber((a, b, eps) => a < b - eps) },
  Greater: { valueType: 'DoubleValue', test: byNumber((a, b, eps) => a > b + eps) },
  LessEqual: { valueType: 'DoubleValue', test: byNumber((a, b, eps) => a <= b + eps) },
  GreaterEqual: { valueType: 'DoubleValue', test: byNumber((a, b, eps) => a >= b - eps) },
  NumericIsDefined: { valueType: 'DoubleValue', noValue: true, test: (v) => defined(v) && Number.isFinite(toNum(v)) },
  NumericIsNotDefined: { valueType: 'DoubleValue', noValue: true, not: 'NumericIsDefined' },
  BooleanTrue: { valueType: 'BoolValue', noValue: true, test: isTrue },
  BooleanFalse: { valueType: 'BoolValue', noValue: true, test: isFalse },
  BooleanIsDefined: { valueType: 'BoolValue', noValue: true, test: defined },
  BooleanIsNotDefined: { valueType: 'BoolValue', noValue: true, not: 'BooleanIsDefined' },
  LogicalTrue: { valueType: 'LogicalValue', noValue: true, test: isTrue },
  LogicalFalse: { valueType: 'LogicalValue', noValue: true, test: isFalse },
  LogicalUnknown: { valueType: 'LogicalValue', noValue: true, test: (v) => lower(v) === 'unknown' || lower(v) === 'u' },
  LogicalIsDefined: { valueType: 'LogicalValue', noValue: true, test: defined },
  LogicalIsNotDefined: { valueType: 'LogicalValue', noValue: true, not: 'LogicalIsDefined' },
};

/** Condition types per property value type, in UI order. */
export const CONDITIONS = {};
for (const [type, d] of Object.entries(CONDITION_DEFS)) (CONDITIONS[d.valueType] ||= []).push(type);
export const NO_VALUE_CONDITIONS = new Set(Object.keys(CONDITION_DEFS).filter((c) => CONDITION_DEFS[c].noValue));

const anyValue = (test, v, want) => (!Array.isArray(v) ? test(v, want) : v.length ? v.some((x) => test(x, want)) : test(undefined, want));

/** Whether a property value meets a condition ({type, value}); unknown condition types never match. */
export function testCondition(cond, v) {
  const def = Object.hasOwn(CONDITION_DEFS, cond.type) ? CONDITION_DEFS[cond.type] : null;
  if (!def) return false;
  const want = (cond.value ?? '').toString();
  return def.not ? !anyValue(CONDITION_DEFS[def.not].test, v, want) : anyValue(def.test, v, want);
}

function makePredicate(rule) {
  const classes = zoomTypeToClasses(rule.ifcType);
  const prop = rule.property;
  const noProp = !prop.name && prop.type !== 'Material';
  const pred = (model, i, el) => {
    if (classes && !classes.some((c) => el.supers.includes(c))) return false;
    if (noProp) return true;
    return testCondition(rule.condition, getValue(model, i, prop));
  };
  // spaces and openings only match a rule that names their type (unless their Alt toggle is on)
  pred.explicit = (el) => namesGatedType(el, classes);
  return pred;
}

// --- actions ----------------------------------------------------------------------
/**
 * Every action, in UI order: `set(w, i, hit, packed)` applies it to element i of a model's view w
 * (hit: the rule matched it), `legend(rule, shown, view)` colours and lists the elements with
 * geometry it left visible ([w, i] pairs). And combines a rule with the next one.
 */
const ACTION_DEFS = {
  Add: { set: (w, i, h) => { if (h) w.vis[i] = 1; } },
  Remove: { set: (w, i, h) => { if (h) w.vis[i] = 0; } },
  RemoveOthers: { set: (w, i, h) => { if (!h) w.vis[i] = 0; } },
  SetColored: { set: (w, i, h, c) => { if (h && w.vis[i]) w.color[i] = c; }, legend: colorLegend },
  SetTransparent: { set: (w, i, h) => { if (h && w.vis[i]) w.ghost[i] = 1; } },
  SetOpaque: { set: (w, i, h) => { if (h && w.vis[i]) w.ghost[i] = 0; } },
  SetAutoColored: { legend: autoColor },
  AddSetColored: { set: (w, i, h, c) => { if (h) { w.vis[i] = 1; w.color[i] = c; } }, legend: colorLegend },
  AddSetTransparent: { set: (w, i, h) => { if (h) { w.vis[i] = 1; w.ghost[i] = 1; } } },
  And: {},
};
export const ACTIONS = Object.keys(ACTION_DEFS);
/** Actions that paint the rule's own colour. */
export const COLOR_ACTIONS = new Set(ACTIONS.filter((a) => ACTION_DEFS[a].legend === colorLegend));

const ruleColor = (a) => [a.r ?? 255, a.g ?? 0, a.b ?? 0];
const gidsOf = (items) => items.map(([w, i]) => w.model.base + i);

function colorLegend(rule, shown) {
  return [{ color: ruleColor(rule.action), label: ruleLabel(rule), count: shown.length, gids: gidsOf(shown) }];
}

/** One palette colour and legend entry per distinct value of the rule's property. */
function autoColor(rule, shown, view) {
  const groups = new Map();
  for (const [w, i] of shown) {
    const key = valueText(getValue(w.model, i, rule.property)) || '(nicht definiert)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([w, i]);
  }
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return keys.map((key, k) => {
    const color = paletteColor(k);
    const items = groups.get(key);
    const p = packRgb(color);
    for (const [w, i] of items) w.color[i] = p;
    return { color, label: key, count: items.length, gids: gidsOf(items), takeoff: takeoff(view, items) };
  });
}

/**
 * Evaluate a smart view against all models. Matches propagate to contained and
 * aggregated elements; `skipChild(el)` excludes children (default: spaces, openings).
 * @returns {{perModel: Array<{model, vis, ghost, color}>, legend: {title, entries} | null}}
 *   perModel is a view for ElementState.applyView, legend entries list gids.
 */
export function evaluate(view, models, skipChild = isGated) {
  const W = models.map((m) => ({ model: m, vis: new Uint8Array(m.count), ghost: new Uint8Array(m.count), color: new Int32Array(m.count).fill(-1) }));
  const legend = [];
  let chain = [];
  for (const rule of view.rules) {
    const pred = makePredicate(rule);
    const { type } = rule.action;
    if (type === 'And') { chain.push(pred); continue; }
    const preds = [...chain, pred];
    chain = [];
    const { set = () => {}, legend: toLegend } = Object.hasOwn(ACTION_DEFS, type) ? ACTION_DEFS[type] : {};
    const packed = packRgb(ruleColor(rule.action));
    const shown = toLegend ? [] : null;
    for (const w of W) {
      const m = w.model;
      const hit = new Uint8Array(m.count);
      for (let i = 0; i < m.count; i++) {
        if (hit[i]) continue;
        const el = m.elements[i];
        // spaces/openings need a rule that names their type unless their toggle is on
        if (skipChild(el) && !preds.some((p) => p.explicit(el))) continue;
        if (preds.every((p) => p(m, i, el))) for (const d of m.descendants(i, [], skipChild)) hit[d] = 1;
      }
      for (let i = 0; i < m.count; i++) {
        set(w, i, hit[i], packed);
        if (shown && hit[i] && w.vis[i] && m.hasGeom[i]) shown.push([w, i]);
      }
    }
    if (toLegend) legend.push(...toLegend(rule, shown, view));
  }
  return { perModel: W, legend: legend.length ? { title: view.title, entries: legend } : null };
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
  const { property: p, condition: c } = rule;
  const parts = [rule.ifcType !== 'Any' ? rule.ifcType : ''];
  const all = p.type === 'Summary' && p.name === 'Model' && c.type === 'StringIsDefined';
  if (p.name && !all) parts.push(p.name);
  if (!all) parts.push(t(`cond.${c.type}`));
  if (c.value && !NO_VALUE_CONDITIONS.has(c.type)) parts.push(c.value);
  return parts.filter(Boolean).join(' ') || 'Regel';
}

// --- rules ------------------------------------------------------------------------
/** A rule with every field present (bcsv defaults filled in); applied wherever rules enter. */
export function normalizeRule(src) {
  const p = src.property || {}, c = src.condition || {}, a = src.action || {};
  const type = p.type || 'PropertySet';
  return {
    ifcType: src.ifcType || 'Any',
    property: { type, psetName: p.psetName ?? (type === 'PropertySet' ? '' : type), name: p.name ?? '', valueType: p.valueType || 'StringValue', unit: p.unit || 'None' },
    condition: { type: c.type || 'StringIsDefined', value: c.value ?? '', ...(c.state && { state: c.state }) },
    action: { type: a.type || 'Add', r: a.r, g: a.g, b: a.b },
  };
}

/** Normalize the rules of all views of the given sets in place. */
function normalizeSets(sets) {
  for (const s of sets) {
    s.views ||= [];
    for (const v of s.views) v.rules = (v.rules || []).map(normalizeRule);
  }
  return sets;
}

export function rule(ifcType, [type, psetName, name, valueType], [ctype, value], [atype, r, g, b] = ['Add']) {
  return normalizeRule({ ifcType, property: { type, psetName, name, valueType }, condition: { type: ctype, value }, action: { type: atype, r, g, b } });
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
// text element, empty when the value is missing
const T = (name, v) => E(name, null, String(v ?? ''));

/** A .bcsv file (v5): the header and the SMARTVIEWSETS root element, CRLF line ends. */
export function exportBcsv(sets) {
  const ruleEl = ({ ifcType, property: p, condition: c, action: a }) => E('RULE', null,
    T('IFCTYPE', ifcType),
    E('PROPERTY', null, T('NAME', p.name), T('PROPERTYSETNAME', p.psetName), T('TYPE', p.type), T('VALUETYPE', p.valueType), T('UNIT', p.unit)),
    E('CONDITION', null, T('TYPE', c.type), c.value ? T('VALUE', c.value) : E('VALUE'), c.state ? T('STATE', c.state) : null),
    E('ACTION', null, T('TYPE', a.type),
      ['SetColored', 'AddSetColored', 'SetAutoColored'].includes(a.type) && a.r !== undefined ? [T('R', a.r | 0), T('G', a.g | 0), T('B', a.b | 0)] : null));
  const viewEl = (v) => {
    const tk = v.takeoff || {};
    return E('SMARTVIEW', null,
      T('TITLE', v.title), T('DESCRIPTION', v.description), T('CREATOR', v.creator), T('CREATIONDATE', v.created || now()),
      T('MODIFIER', v.modifier), T('MODIFICATIONDATE', v.modified || now()), T('GUID', v.guid),
      E('RULES', null, v.rules.map(ruleEl)),
      E('INFORMATIONTAKEOFF', null, T('PROPERTYSETNAME', tk.psetName || 'None'), T('PROPERTYNAME', tk.propName || 'None'), T('OPERATION', Number(tk.op) || 0)));
  };
  const setEl = (s) => E('SMARTVIEWSET', null,
    T('TITLE', s.title), T('DESCRIPTION', s.description), T('GUID', s.guid), T('MODIFICATIONDATE', s.modified || now()),
    E('SMARTVIEWS', null, s.views.map(viewEl)));
  const NL = '\r\n';
  return [
    '<?xml version="1.0"?>',
    render(E('bimcollabsmartviewfile', null, T('version', 5), T('applicationversion', 'OpenZoom 1.0')), '', NL),
    render(E('SMARTVIEWSETS', null, sets.map(setEl)), '', NL),
  ].join(NL);
}

/** Parse a .bcsv file (the format has two root elements, so it is wrapped first). */
export function importBcsv(bcsv) {
  const body = bcsv.replace(/^﻿/, '').replace(/<\?xml[^>]*\?>/i, '');
  const root = parseXml(`<root>${body}</root>`);
  if (!root) throw new Error('Ungültige .bcsv-Datei');
  const num = (x) => (x === '' ? undefined : Number(x));
  const ruleOf = (r) => {
    const p = child(r, 'PROPERTY'), c = child(r, 'CONDITION'), a = child(r, 'ACTION');
    return normalizeRule({
      ifcType: text(r, 'IFCTYPE'),
      property: p && { name: text(p, 'NAME'), psetName: text(p, 'PROPERTYSETNAME'), type: text(p, 'TYPE'), valueType: text(p, 'VALUETYPE'), unit: text(p, 'UNIT') },
      condition: c && { type: text(c, 'TYPE'), value: text(c, 'VALUE'), state: text(c, 'STATE') },
      action: a && { type: text(a, 'TYPE'), r: num(text(a, 'R')), g: num(text(a, 'G')), b: num(text(a, 'B')) },
    });
  };
  const viewOf = (v) => {
    const tk = child(v, 'INFORMATIONTAKEOFF');
    return {
      guid: text(v, 'GUID') || uuid(), title: text(v, 'TITLE'), description: text(v, 'DESCRIPTION'),
      creator: text(v, 'CREATOR'), created: text(v, 'CREATIONDATE'), modifier: text(v, 'MODIFIER'), modified: text(v, 'MODIFICATIONDATE'),
      rules: elems(child(v, 'RULES')).map(ruleOf),
      takeoff: tk ? { psetName: text(tk, 'PROPERTYSETNAME'), propName: text(tk, 'PROPERTYNAME'), op: Number(text(tk, 'OPERATION')) || 0 } : null,
    };
  };
  return descendants(root, 'SMARTVIEWSET').map((s) => ({
    guid: text(s, 'GUID') || uuid(), title: text(s, 'TITLE'), description: text(s, 'DESCRIPTION'), modified: text(s, 'MODIFICATIONDATE'),
    views: elems(child(s, 'SMARTVIEWS')).map(viewOf),
  }));
}

/** Smart view library: built-in sets + user sets persisted in localStorage. */
export class SmartViewLibrary extends EventTarget {
  constructor() {
    super();
    this.builtin = builtinSets();
    this.local = [];
    try { this.local = normalizeSets(JSON.parse(localStorage.getItem('oz.smartviews') || '[]')); } catch { this.local = []; }
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
    for (const s of normalizeSets(sets)) {
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
