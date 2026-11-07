import { h, clear } from './dom.js';
import { t } from '../i18n.js';
import { displayName } from './properties.js';
import { catalogEntry } from '../core/props.js';

// Searchable popovers for choosing a property (union over all loaded elements)
// and one of its existing values. Used by the smart view editor and the lists.

let current = null;

export function closePicker() {
  if (!current) return;
  current.el.remove();
  document.removeEventListener('pointerdown', current.outside, true);
  window.removeEventListener('keydown', current.keys, true);
  current = null;
}

function popover(anchor, width = 400) {
  closePicker();
  const el = h('div.picker', { style: { width: `${width}px` } });
  document.body.appendChild(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const height = Math.min(460, Math.max(below, r.top) - 12);
    el.style.maxHeight = `${height}px`;
    el.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - width - 4))}px`;
    el.style.top = below >= height || below > r.top ? `${r.bottom + 2}px` : `${r.top - height - 2}px`;
  };
  place();
  const outside = (e) => { if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closePicker(); };
  document.addEventListener('pointerdown', outside, true);
  return { el, outside };
}

/** Rows of a filterable list with keyboard navigation. */
function listUi(el, search, render) {
  const list = h('div.picker-list');
  el.append(h('div.picker-search', search), list);
  let active = -1;
  let rows = [];
  const highlight = () => rows.forEach((r, k) => r.classList.toggle('active', k === active));
  const refresh = () => {
    clear(list);
    rows = render(list, search.value.trim().toLowerCase());
    active = rows.length ? 0 : -1;
    highlight();
  };
  const keys = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closePicker(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      highlight();
      rows[active].scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter' && rows[active]) { e.preventDefault(); e.stopPropagation(); rows[active].click(); }
  };
  search.addEventListener('input', refresh);
  refresh();
  setTimeout(() => search.focus(), 0);
  return keys;
}

const TYPE_BADGE = { StringValue: 'Aa', DoubleValue: '123', BoolValue: '✓✗', LogicalValue: '✓?' };

function groupLabel(g) {
  if (g.type !== 'PropertySet') return t(`ptype.${g.type}`);
  if (g.psetName === '') return t('pick.anySet');
  if (g.psetName === 'Classification') return t('grp.Classification');
  return g.psetName;
}

/**
 * Open the property picker.
 * @param {object} opts {current: {type, psetName, name}, onPick(prop), numericOnly}
 */
export function openPropertyPicker(app, anchor, { current: cur, onPick, numericOnly = false }) {
  const catalog = app.propertyCatalog();
  const { el, outside } = popover(anchor, 420);
  const expanded = new Set(['Summary|Summary']);
  if (cur) expanded.add(`${cur.type}|${cur.type === 'PropertySet' ? cur.psetName || '' : cur.type}`);
  const pick = (g, p) => {
    onPick({ type: g.type, psetName: g.type === 'PropertySet' ? g.psetName : g.type, name: p.name, valueType: p.valueType, unit: 'None' });
    closePicker();
  };
  const search = h('input.input', { type: 'search', placeholder: t('pick.search') });
  const keys = listUi(el, search, (list, q) => {
    const rows = [];
    if (q && !numericOnly) {
      const raw = search.value.trim();
      const row = h('div.picker-row.custom', h('span.lbl', t('pick.custom', { name: raw })));
      row.addEventListener('click', () => { onPick({ type: 'PropertySet', psetName: '', name: raw, valueType: 'StringValue', unit: 'None' }); closePicker(); });
      list.appendChild(row);
      rows.push(row);
    }
    for (const g of catalog.groups) {
      const props = g.props.filter((p) => (!numericOnly || p.valueType === 'DoubleValue')
        && (!q || p.name.toLowerCase().includes(q) || displayName(p.name, g.type).toLowerCase().includes(q) || groupLabel(g).toLowerCase().includes(q)));
      if (!props.length) continue;
      const key = `${g.type}|${g.psetName}`;
      const open = !!q || expanded.has(key);
      const head = h('div.picker-group', { class: `picker-group${g.psetName === '' && g.type === 'PropertySet' ? ' any' : ''}` },
        h('span.tw', open ? '▾' : '▸'), h('span.lbl', groupLabel(g)), h('span.sub', String(props.length)));
      head.addEventListener('click', () => {
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        search.dispatchEvent(new Event('input'));
      });
      list.appendChild(head);
      if (!open) continue;
      for (const p of props) {
        const isCur = cur && cur.type === g.type && cur.name === p.name && (g.type !== 'PropertySet' || (cur.psetName || '') === g.psetName);
        const row = h('div.picker-row', { class: `picker-row${isCur ? ' current' : ''}`, title: `${p.name} · ${p.count} ${t('pick.elements')}` },
          h('span.badge.vt', TYPE_BADGE[p.valueType]),
          h('span.lbl', displayName(p.name, g.type)),
          h('span.sub', `${p.count}`));
        row.addEventListener('click', () => pick(g, p));
        list.appendChild(row);
        rows.push(row);
      }
    }
    if (!rows.length) list.appendChild(h('div.empty.small', t('pick.none')));
    return rows;
  });
  current = { el, outside, keys };
  // window capture runs before the dialog's document-level Escape handler
  window.addEventListener('keydown', keys, true);
}

/** Open a list of the values a property actually has in the models. */
export function openValuePicker(app, anchor, prop, onPick) {
  const entry = catalogEntry(app.propertyCatalog(), prop);
  const { el, outside } = popover(anchor, 320);
  const search = h('input.input', { type: 'search', placeholder: t('pick.searchValue') });
  const keys = listUi(el, search, (list, q) => {
    const rows = [];
    const values = (entry?.values || []).filter(([v]) => !q || v.toLowerCase().includes(q));
    for (const [v, n] of values) {
      const row = h('div.picker-row', h('span.lbl', v), h('span.sub', String(n)));
      row.addEventListener('click', () => { onPick(v); closePicker(); });
      list.appendChild(row);
      rows.push(row);
    }
    if (entry?.more) list.appendChild(h('div.muted.small.pad', t('pick.more')));
    if (!rows.length) list.appendChild(h('div.empty.small', t('pick.noValues')));
    return rows;
  });
  current = { el, outside, keys };
  window.addEventListener('keydown', keys, true);
}

/** Short text for a property reference ("Pset_WallCommon › FireRating"). */
export function propertyText(prop) {
  if (!prop || !prop.name) return t('pick.choose');
  if (prop.type === 'PropertySet') return `${prop.psetName ? prop.psetName : t('pick.anySet')} › ${prop.name}`;
  return `${t(`ptype.${prop.type}`)} › ${displayName(prop.name, prop.type)}`;
}
