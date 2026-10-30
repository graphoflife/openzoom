import { h, showMenu, clear, dialog, promptDialog, confirmDialog, download, pickFiles, toast, hexToRgb, rgbToHex } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';
import { ZOOM_TYPES } from '../core/ifc-classes.js';
import { ACTIONS, CONDITIONS, PROPERTY_TYPES, NO_VALUE_CONDITIONS, exportBcsv, importBcsv, rule, uuid, evaluate, applyResult } from '../core/smartviews.js';
import { collectPropertyCatalog } from '../core/props.js';

const SUMMARY_NAMES = ['Name', 'Description', 'GUID', 'IfcType', 'IfcEntity', 'Type', 'Object Type', 'Predefined Type', 'Tag', 'Model', 'Classification', 'System', 'Long Name', 'Volume', 'Area', 'Height', 'Bottom Elevation', 'Top Elevation'];
const LOCATION_NAMES = ['Site', 'Building', 'Building Storey', 'Storey Elevation', 'Space'];
const FILE_NAMES = ['File Name', 'Schema', 'Application', 'Author', 'Organization'];
const PROJECT_NAMES = ['Name', 'Long Name', 'Phase', 'Description'];

/** Smart view sets tree with apply-on-click, editor, .bcsv import/export. */
export class SmartViewsPanel {
  constructor(app, host) {
    this.app = app;
    this.lib = app.smartViews;
    this.collapsed = new Set(JSON.parse(localStorage.getItem('oz.svCollapsed') || '[]'));
    this.selectedSet = null;
    this.selectedView = null;
    const tb = (ic, title, fn) => h('button.icon-btn', { title, html: icon(ic, 16), on: { click: fn } });
    this.toolbar = h('div.panel-head',
      tb('play', t('sv.apply'), () => this.selectedView && this.apply(this.selectedView)),
      tb('plus', t('sv.new'), () => this.newView()),
      tb('folder', t('sv.newSet'), () => this.newSet()),
      tb('edit', t('sv.edit'), () => this.edit()),
      tb('copy', t('sv.copy'), () => this.copy()),
      tb('minus', t('sv.delete'), () => this.remove()),
      h('span.flex'),
      h('button.icon-btn', { title: '…', html: icon('menu', 16), on: { pointerdown: (e) => { e.stopPropagation(); this.menu(e); } } }));
    this.list = h('div.sv-list');
    host.append(this.toolbar, this.list);
    this.lib.addEventListener('change', () => this.render());
    this.render();
  }

  render() {
    clear(this.list);
    const groups = [[t('sv.builtin'), this.lib.builtin], [t('sv.local'), this.lib.local]];
    for (const [label, sets] of groups) {
      this.list.appendChild(h('div.sv-group', label));
      if (!sets.length) this.list.appendChild(h('div.empty.small', t('sv.none')));
      for (const set of sets) {
        const open = !this.collapsed.has(set.guid);
        const row = h('div.sv-set', { class: `sv-set${this.selectedSet === set && !this.selectedView ? ' selected' : ''}` },
          h('span.tw', open ? '▾' : '▸'), h('span.sv-folder', { html: icon('folder', 15) }), h('span.lbl', set.title), h('span.sub', String(set.views.length)));
        row.addEventListener('click', () => {
          if (open) this.collapsed.add(set.guid); else this.collapsed.delete(set.guid);
          localStorage.setItem('oz.svCollapsed', JSON.stringify([...this.collapsed]));
          this.selectedSet = set; this.selectedView = null;
          this.render();
        });
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.selectedSet = set; this.selectedView = null; this.menu(e); });
        this.list.appendChild(row);
        if (!open) continue;
        for (const v of set.views) {
          const active = this.lib.activeGuid === v.guid;
          const vr = h('div.sv-view', { class: `sv-view${this.selectedView === v ? ' selected' : ''}${active ? ' active' : ''}`, title: v.description || v.title },
            h('span.sv-ico', { html: icon('smart', 15) }), h('span.lbl', v.title));
          vr.addEventListener('click', () => { this.selectedSet = set; this.selectedView = v; this.apply(v); });
          vr.addEventListener('dblclick', () => { this.selectedSet = set; this.selectedView = v; this.edit(); });
          vr.addEventListener('contextmenu', (e) => { e.preventDefault(); this.selectedSet = set; this.selectedView = v; this.render(); this.menu(e); });
          this.list.appendChild(vr);
        }
      }
    }
  }

  apply(v) {
    if (!this.app.models.models.length) { toast(t('err.noModels')); return; }
    this.app.applySmartView(v);
    this.render();
  }

  menu(e) {
    const s = this.selectedSet, v = this.selectedView;
    showMenu([
      v && { label: t('sv.apply'), icon: 'play', run: () => this.apply(v) },
      v && { label: t('sv.edit'), icon: 'edit', run: () => this.edit() },
      { label: t('sv.new'), icon: 'plus', run: () => this.newView() },
      { label: t('sv.newSet'), icon: 'folder', run: () => this.newSet() },
      s && !s.builtin && { label: t('sv.rename'), run: () => this.rename() },
      (s || v) && { label: t('sv.copy'), icon: 'copy', run: () => this.copy() },
      (s || v) && { label: t('sv.delete'), icon: 'minus', disabled: s?.builtin, run: () => this.remove() },
      '-',
      { label: t('sv.import'), icon: 'import', run: () => this.importDialog() },
      { label: t('sv.export'), icon: 'export', run: () => this.exportSets(this.lib.local.length ? this.lib.local : this.lib.sets) },
      s && { label: t('sv.exportSet'), icon: 'export', run: () => this.exportSets([s]) },
    ], e.clientX, e.clientY);
  }

  async newSet() {
    const name = await promptDialog(t('sv.newSet'), t('sv.setName'), 'Neues Set');
    if (!name) return;
    this.selectedSet = this.lib.addSet(name);
    this.selectedView = null;
    this.render();
  }

  async rename() {
    const s = this.selectedSet;
    if (!s || s.builtin) return;
    const name = await promptDialog(t('sv.rename'), t('sv.setName'), s.title);
    if (name) { s.title = name; this.lib.save(); }
  }

  async newView() {
    let set = this.selectedSet;
    if (!set || set.builtin) set = this.lib.local[0] || this.lib.addSet('Meine Smart Views');
    const name = await promptDialog(t('sv.new'), t('sv.viewName'), 'Neue Smart View');
    if (!name) return;
    const v = this.lib.newView(set, name);
    this.selectedSet = set;
    this.selectedView = v;
    this.collapsed.delete(set.guid);
    this.edit();
  }

  copy() {
    const s = this.selectedSet, v = this.selectedView;
    if (v) {
      let target = s.builtin ? this.lib.local[0] || this.lib.addSet('Meine Smart Views') : s;
      const c = JSON.parse(JSON.stringify(v));
      c.guid = uuid();
      c.title = `${v.title} (Kopie)`;
      target.views.push(c);
      this.lib.save();
      this.selectedSet = target; this.selectedView = c;
    } else if (s) {
      this.selectedSet = this.lib.copySet(s);
    }
    this.render();
  }

  async remove() {
    const s = this.selectedSet, v = this.selectedView;
    if (!s || s.builtin) { toast(t('sv.readonly')); return; }
    if (v) {
      if (!(await confirmDialog(t('sv.delete'), `„${v.title}“?`))) return;
      s.views = s.views.filter((x) => x !== v);
      this.selectedView = null;
      this.lib.save();
    } else {
      if (!(await confirmDialog(t('sv.delete'), `„${s.title}“ (${s.views.length})?`))) return;
      this.lib.removeSet(s);
      this.selectedSet = null;
    }
  }

  async importDialog() {
    const files = await pickFiles('.bcsv,.xml', true);
    for (const f of files) await this.importFile(f);
  }

  async importFile(f) {
    try {
      const sets = importBcsv(await f.text());
      this.lib.importSets(sets);
      toast(t('sv.imported', { n: sets.length }));
      this.app.showTab('smartviews');
    } catch (err) {
      toast(`${f.name}: ${err.message}`, 5000);
    }
  }

  exportSets(sets) {
    const name = sets.length === 1 ? sets[0].title : 'SmartViews';
    download(`${name.replace(/[^\w\-äöüÄÖÜß ]+/g, '_')}.bcsv`, exportBcsv(sets), 'application/xml');
  }

  // --- editor ---------------------------------------------------------------------------
  edit() {
    const v = this.selectedView;
    const set = this.selectedSet;
    if (!v) return;
    const readonly = !!set?.builtin;
    const draft = JSON.parse(JSON.stringify(v));
    const catalog = collectPropertyCatalog(this.app.models.models);
    const psetNames = [...catalog.keys()].sort();
    const allProps = [...new Set([...catalog.values()].flatMap((s) => [...s]))].sort();
    const dl = (id, items) => h('datalist', { id }, ...items.map((x) => h('option', { value: x })));
    const nameInput = h('input.input', { value: draft.title });
    const descInput = h('textarea.input', { rows: 2 }, draft.description || '');
    const tbody = h('tbody');
    const renderRules = () => {
      clear(tbody);
      draft.rules.forEach((r, k) => tbody.appendChild(this.ruleRow(draft, r, k, renderRules, psetNames)));
    };
    renderRules();
    const take = draft.takeoff || { psetName: 'None', propName: 'None', op: 0 };
    const tkPset = h('input.input.small', { value: take.psetName === 'None' ? '' : take.psetName, list: 'sv-psets', placeholder: 'Property Set' });
    const tkProp = h('input.input.small', { value: take.propName === 'None' ? '' : take.propName, list: 'sv-props', placeholder: t('sv.property') });
    const tkOp = h('select.input.small', ...['Σ', 'Ø', 'Min', 'Max'].map((x, i) => h('option', { value: i, selected: Number(take.op) === i }, x)));
    const collect = () => {
      draft.title = nameInput.value || draft.title;
      draft.description = descInput.value;
      draft.takeoff = { psetName: tkPset.value || 'None', propName: tkProp.value || 'None', op: Number(tkOp.value) };
      return draft;
    };
    const body = h('div.sv-editor',
      dl('sv-psets', psetNames), dl('sv-props', allProps), dl('sv-summary', SUMMARY_NAMES), dl('sv-location', LOCATION_NAMES),
      dl('sv-file', FILE_NAMES), dl('sv-project', PROJECT_NAMES),
      readonly ? h('div.notice', t('sv.readonly')) : null,
      h('div.form-row', h('label', t('sv.name'), nameInput)),
      h('div.rules-wrap', h('table.rules',
        h('thead', h('tr', ...[t('sv.elementType'), t('sv.property'), '', t('sv.operator'), t('sv.value'), t('sv.action'), t('sv.color'), ''].map((x) => h('th', x)))),
        tbody)),
      h('div.form-row.row', h('button.btn', { on: { click: () => { draft.rules.push(rule('Any', ['Summary', 'Summary', 'Model'], ['StringIsDefined'], ['Add'])); renderRules(); } } }, `+ ${t('sv.addRule')}`)),
      h('div.form-row.two',
        h('label', t('sv.description'), descInput),
        h('label', t('sv.takeoff'), h('div.row', tkPset, tkProp, tkOp))));
    const buttons = [
      { label: t('sv.preview'), run: () => { applyResult(this.app, evaluate(collect(), this.app.models.models)); this.app.legendTitle = draft.title; this.app.renderLegend(); return false; } },
    ];
    if (!readonly) {
      buttons.push({
        label: t('ui.save'), primary: true,
        run: () => {
          Object.assign(v, collect(), { modified: new Date().toISOString().slice(0, 19), modifier: this.app.settings.get('author') || 'OpenZoom' });
          this.lib.save();
          this.apply(v);
        },
      });
    }
    buttons.push({ label: t('ui.cancel') });
    dialog({ title: `${t('sv.editTitle')} – ${v.title}`, body, buttons, width: 1100, className: 'wide' });
  }

  ruleRow(draft, r, k, rerender, psetNames) {
    const p = r.property || (r.property = { type: 'Summary', psetName: 'Summary', name: 'Model', valueType: 'StringValue', unit: 'None' });
    const c = r.condition || (r.condition = { type: 'StringIsDefined', value: '' });
    const a = r.action || (r.action = { type: 'Add' });
    const sel = (options, value, onChange, labelFn = (x) => x) => {
      const s = h('select.input.small', ...options.map((o) => h('option', { value: o, selected: o === value }, labelFn(o))));
      s.addEventListener('change', () => onChange(s.value));
      return s;
    };
    const typeSel = sel(ZOOM_TYPES.includes(r.ifcType) ? ZOOM_TYPES : [r.ifcType, ...ZOOM_TYPES], r.ifcType || 'Any', (x) => { r.ifcType = x; });
    const listFor = { Summary: 'sv-summary', Location: 'sv-location', File: 'sv-file', Project: 'sv-project', PropertySet: 'sv-props', Material: '' }[p.type] || 'sv-props';
    const ptype = sel(PROPERTY_TYPES, p.type || 'PropertySet', (x) => {
      p.type = x;
      p.psetName = x === 'PropertySet' ? '' : x;
      p.name = { Summary: 'Name', Location: 'Building Storey', Material: 'Material', File: 'File Name', Project: 'Name', PropertySet: '' }[x];
      rerender();
    }, (x) => t(`ptype.${x}`));
    const pset = h('input.input.small', { value: p.psetName || '', list: 'sv-psets', placeholder: t('sv.psetHint'), style: { display: p.type === 'PropertySet' ? '' : 'none' } });
    pset.addEventListener('input', () => { p.psetName = pset.value; });
    const pname = h('input.input.small', { value: p.name || '', list: listFor, placeholder: t('sv.property') });
    pname.addEventListener('input', () => { p.name = pname.value; });
    const vtype = sel(Object.keys(CONDITIONS), p.valueType || 'StringValue', (x) => {
      p.valueType = x;
      if (!CONDITIONS[x].includes(c.type)) c.type = CONDITIONS[x][0];
      rerender();
    }, (x) => t(`vtype.${x}`));
    const conds = CONDITIONS[p.valueType || 'StringValue'];
    const cond = sel(conds.includes(c.type) ? conds : [c.type, ...conds], c.type, (x) => { c.type = x; rerender(); }, (x) => t(`cond.${x}`));
    const value = h('input.input.small', { value: c.value || '', disabled: NO_VALUE_CONDITIONS.has(c.type) });
    value.addEventListener('input', () => { c.value = value.value; });
    const act = sel(ACTIONS, a.type, (x) => { a.type = x; if (['SetColored', 'AddSetColored'].includes(x) && a.r === undefined) Object.assign(a, { r: 220, g: 40, b: 40 }); rerender(); }, (x) => t(`act.${x}`));
    const hasColor = ['SetColored', 'AddSetColored'].includes(a.type);
    const color = h('input', { type: 'color', value: rgbToHex([a.r ?? 220, a.g ?? 40, a.b ?? 40]), style: { visibility: hasColor ? 'visible' : 'hidden' } });
    color.addEventListener('input', () => { const [rr, gg, bb] = hexToRgb(color.value); Object.assign(a, { r: rr, g: gg, b: bb }); });
    const move = (d) => {
      const j = k + d;
      if (j < 0 || j >= draft.rules.length) return;
      [draft.rules[k], draft.rules[j]] = [draft.rules[j], draft.rules[k]];
      rerender();
    };
    const tools = h('td.rule-tools',
      h('button.icon-btn', { title: '↑', html: icon('arrowUp', 14), on: { click: () => move(-1) } }),
      h('button.icon-btn', { title: '↓', html: icon('arrowDown', 14), on: { click: () => move(1) } }),
      h('button.icon-btn', { title: t('ui.delete'), html: icon('close', 14), on: { click: () => { draft.rules.splice(k, 1); rerender(); } } }));
    return h('tr', h('td', typeSel), h('td', h('div.row', ptype, pset, pname)), h('td', vtype), h('td', cond), h('td', value), h('td', act), h('td', color), tools);
  }
}
