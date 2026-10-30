import { h, clear, download } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';
import { getValue, valueText, collectPropertyCatalog } from '../core/props.js';
import { toCsv } from './clashes-panel.js';

const SUMMARY = ['IfcType', 'Type', 'Name', 'Object Type', 'Predefined Type', 'Model', 'Classification', 'System', 'Volume', 'Area', 'Height'];
const LOCATION = ['Building Storey', 'Building', 'Space'];
const FLAT_LIMIT = 3000;

/** Quantity lists ("Lists" tab): group elements by a property and sum numeric values. */
export class ListsPanel {
  constructor(app, host) {
    this.app = app;
    const saved = JSON.parse(localStorage.getItem('oz.lists') || '{}');
    this.source = saved.source || 'visible';
    this.mode = saved.mode || 'group';
    this.groupBy = saved.groupBy || { type: 'Summary', psetName: 'Summary', name: 'IfcType' };
    this.columns = saved.columns || [{ type: 'Summary', psetName: 'Summary', name: 'Volume' }];
    this.isVisible = false;
    const sel = (opts, value, fn) => {
      const s = h('select.input.small', ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
      s.addEventListener('change', () => { fn(s.value); this.save(); this.refresh(); });
      return s;
    };
    this.head = h('div.panel-head',
      sel([['visible', t('list.src.visible')], ['selection', t('list.src.selection')], ['all', t('list.src.all')]], this.source, (v) => { this.source = v; }),
      sel([['group', t('list.mode.group')], ['flat', t('list.mode.flat')]], this.mode, (v) => { this.mode = v; }),
      h('span.flex'),
      h('button.icon-btn', { title: t('list.refresh'), html: icon('restore', 16), on: { click: () => this.refresh() } }),
      h('button.icon-btn', { title: t('list.export'), html: icon('export', 16), on: { click: () => this.exportCsv() } }));
    this.config = h('div.list-config');
    this.table = h('div.list-table');
    host.append(this.head, this.config, this.table);
    let timer = 0;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => this.isVisible && this.refresh(), 150); };
    app.state.addEventListener('change', later);
    app.state.addEventListener('selection', () => this.source === 'selection' && later());
    app.models.addEventListener('changed', () => { this.catalog = null; later(); });
  }

  save() {
    localStorage.setItem('oz.lists', JSON.stringify({ source: this.source, mode: this.mode, groupBy: this.groupBy, columns: this.columns }));
  }

  visible(v) {
    this.isVisible = v;
    if (v) this.refresh();
  }

  propOptions() {
    if (!this.catalog) this.catalog = collectPropertyCatalog(this.app.models.models);
    const opts = [];
    for (const n of SUMMARY) opts.push([{ type: 'Summary', psetName: 'Summary', name: n }, `${t('ptype.Summary')} · ${n}`]);
    for (const n of LOCATION) opts.push([{ type: 'Location', psetName: 'Location', name: n }, `${t('ptype.Location')} · ${n}`]);
    opts.push([{ type: 'Material', psetName: 'Material', name: 'Material' }, t('ptype.Material')]);
    for (const [ps, props] of [...this.catalog].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const p of [...props].sort()) opts.push([{ type: 'PropertySet', psetName: ps, name: p }, `${ps} · ${p}`]);
    }
    return opts;
  }

  propSelect(value, onChange, includeEmpty = false) {
    const key = (p) => `${p.type}|${p.psetName}|${p.name}`;
    const opts = this.propOptions();
    const s = h('select.input.small.grow',
      includeEmpty ? h('option', { value: '' }, `+ ${t('list.addColumn')}`) : null,
      ...opts.map(([p, l]) => h('option', { value: key(p), selected: value && key(p) === key(value) }, l)));
    s.addEventListener('change', () => {
      if (!s.value) return;
      const [type, psetName, ...rest] = s.value.split('|');
      onChange({ type, psetName, name: rest.join('|') });
      this.save();
      this.refresh();
    });
    return s;
  }

  renderConfig() {
    clear(this.config);
    this.config.append(
      h('div.row', h('span.form-label', t('list.groupBy')), this.propSelect(this.groupBy, (p) => { this.groupBy = p; })),
      h('div.row.wrap', h('span.form-label', t('list.columns')),
        ...this.columns.map((c, k) => h('span.chip.removable', `${c.name}`, h('span.x', { on: { click: () => { this.columns.splice(k, 1); this.save(); this.refresh(); } } }, '×'))),
        this.propSelect(null, (p) => { this.columns.push(p); }, true)));
  }

  elements() {
    const st = this.app.state;
    const M = this.app.models;
    if (this.source === 'selection') return st.selectedGeometry();
    if (this.source === 'visible') return st.visibleGids();
    return M.allGids((m, i, el) => m.hasGeom[i] && el.cls !== 'IfcOpeningElement');
  }

  compute() {
    const M = this.app.models;
    const gids = this.elements();
    const val = (gid, p) => { const m = M.modelOf(gid); return getValue(m, gid - m.base, p); };
    if (this.mode === 'flat') {
      return {
        header: ['Name', 'IFC', this.groupBy.name, ...this.columns.map((c) => c.name)],
        rows: gids.map((gid) => {
          const el = M.element(gid);
          return { gids: [gid], cells: [el.name, el.cls, valueText(val(gid, this.groupBy)), ...this.columns.map((c) => num(val(gid, c)))] };
        }),
      };
    }
    const groups = new Map();
    for (const gid of gids) {
      const k = valueText(val(gid, this.groupBy)) || '–';
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { gids: [], sums: this.columns.map(() => 0) }));
      g.gids.push(gid);
      this.columns.forEach((c, i) => { const v = num(val(gid, c)); if (v !== '') g.sums[i] += v; });
    }
    const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const rows = keys.map((k) => ({ gids: groups.get(k).gids, cells: [k, groups.get(k).gids.length, ...groups.get(k).sums] }));
    const total = { total: true, gids, cells: [t('list.total'), gids.length, ...this.columns.map((_, i) => rows.reduce((s, r) => s + r.cells[2 + i], 0))] };
    return { header: [this.groupBy.name, t('list.count'), ...this.columns.map((c) => `Σ ${c.name}`)], rows: [...rows, total] };
  }

  refresh() {
    this.renderConfig();
    clear(this.table);
    if (!this.app.models.models.length) { this.table.appendChild(h('div.empty', t('tree.empty'))); return; }
    const data = this.compute();
    this.data = data;
    const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : this.app.fmtNum(v, 3)) : v ?? '');
    const table = h('table.grid',
      h('thead', h('tr', ...data.header.map((x) => h('th', x)))),
      h('tbody', ...data.rows.slice(0, FLAT_LIMIT).map((r) => {
        const tr = h('tr', { class: r.total ? 'total' : '' }, ...r.cells.map((c) => h('td', { class: typeof c === 'number' ? 'num' : '' }, fmt(c))));
        tr.addEventListener('click', (e) => this.app.state.select(r.gids, e.ctrlKey ? 'add' : 'replace'));
        return tr;
      })));
    this.table.appendChild(table);
    if (data.rows.length > FLAT_LIMIT) this.table.appendChild(h('div.muted', `… ${data.rows.length - FLAT_LIMIT} (CSV)`));
  }

  exportCsv() {
    const data = this.data || this.compute();
    const rows = [data.header, ...data.rows.map((r) => r.cells.map((c) => (typeof c === 'number' ? String(c).replace('.', this.app.decimalSep) : c)))];
    download(`Liste_${this.groupBy.name}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  }
}

function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return '';
}
