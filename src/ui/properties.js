import { h, showMenu, clear } from './dom.js';
import { t, getLanguage } from '../i18n.js';
import { classLabel } from '../core/ifc-classes.js';
import { propertyGroups, getValue, valueText } from '../core/props.js';
import { rule, uuid } from '../core/smartviews.js';

const MULTI_LIMIT = 400;

/** Properties of the selection, one property set at a time (Tab / Shift+Tab cycles). */
export class PropertiesPanel {
  constructor(app, host) {
    this.app = app;
    this.groupKey = localStorage.getItem('oz.propGroup') || '*';
    this.selectedRow = null;
    this.head = h('div.props-head');
    this.chips = h('div.props-chips');
    this.body = h('div.props-body');
    host.append(h('div.panel-title', t('props.title')), this.head, this.chips, this.body);
    app.state.addEventListener('selection', () => this.render());
    app.models.addEventListener('changed', () => this.render());
    this.render();
  }

  /** Property groups for the current selection; with several elements values are merged. */
  collect() {
    const M = this.app.models;
    const gids = [...this.app.state.selection].slice(0, MULTI_LIMIT);
    if (!gids.length) return null;
    const merged = new Map(); // key -> {key, type, rows: Map(name -> {value, unit, varies})}
    let n = 0;
    for (const gid of gids) {
      const m = M.modelOf(gid);
      if (!m) continue;
      n++;
      for (const g of propertyGroups(m, gid - m.base)) {
        const key = g.fromType ? `${g.key} (${t('props.type')})` : g.key;
        let mg = merged.get(key);
        if (!mg) merged.set(key, (mg = { key, type: g.type, baseKey: g.key, fromType: g.fromType, quantity: g.quantity, rows: new Map(), count: 0 }));
        mg.count++;
        for (const [name, value, unit] of g.props) {
          const r = mg.rows.get(name);
          if (!r) mg.rows.set(name, { value, unit, varies: n > 1 });
          else if (valueText(r.value) !== valueText(value)) r.varies = true;
        }
      }
    }
    if (n > 1) for (const mg of merged.values()) for (const r of mg.rows.values()) if (mg.count < n) r.varies = true;
    return { n, groups: [...merged.values()] };
  }

  render() {
    const data = this.collect();
    clear(this.head); clear(this.chips); clear(this.body);
    this.selectedRow = null;
    this.data = data;
    if (!data) { this.body.appendChild(h('div.empty', t('props.none'))); return; }
    const M = this.app.models;
    if (data.n === 1) {
      const gid = [...this.app.state.selection][0];
      const m = M.modelOf(gid);
      const el = m.elements[gid - m.base];
      this.head.append(h('div.props-name', el.name || el.longName || classLabel(el.cls, getLanguage())), h('div.props-sub', `${el.cls}${el.predef ? `.${el.predef}` : ''} · ${m.name}`));
    } else {
      this.head.append(h('div.props-name', t('props.multi', { n: this.app.state.selection.size })));
    }
    const keys = ['*', ...data.groups.map((g) => g.key)];
    if (!keys.includes(this.groupKey)) this.groupKey = keys.includes('Summary') ? 'Summary' : '*';
    for (const k of keys) {
      const label = k === '*' ? t('props.all') : groupLabel(k);
      const chip = h('button.chip', { class: `chip${k === this.groupKey ? ' active' : ''}`, on: { click: () => this.setGroup(k) } }, label);
      this.chips.appendChild(chip);
    }
    const shown = this.groupKey === '*' ? data.groups : data.groups.filter((g) => g.key === this.groupKey);
    const table = h('table.props-table');
    for (const g of shown) {
      if (this.groupKey === '*') table.appendChild(h('tr.group-row', h('td', { colspan: 2 }, groupLabel(g.key))));
      for (const [name, r] of g.rows) {
        const val = r.varies ? t('props.varies') : formatValue(this.app, r.value, r.unit);
        const tr = h('tr.prop-row', h('td.pn', { title: name }, translateName(name, g.type)), h('td.pv', { title: val, class: `pv${r.varies ? ' varies' : ''}` }, val));
        tr.addEventListener('click', () => this.selectRow(tr, g, name, r));
        tr.addEventListener('contextmenu', (e) => { e.preventDefault(); this.selectRow(tr, g, name, r); this.rowMenu(e, g, name, r); });
        table.appendChild(tr);
      }
    }
    this.body.appendChild(table);
    this.chips.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  setGroup(k) {
    this.groupKey = k;
    localStorage.setItem('oz.propGroup', k);
    this.render();
  }

  cycle(dir) {
    if (!this.data) return;
    const keys = ['*', ...this.data.groups.map((g) => g.key)];
    const i = keys.indexOf(this.groupKey);
    this.setGroup(keys[(i + dir + keys.length) % keys.length]);
  }

  selectRow(tr, g, name, r) {
    this.body.querySelectorAll('.prop-row.sel').forEach((x) => x.classList.remove('sel'));
    tr.classList.add('sel');
    this.selectedRow = { g, name, r };
  }

  copySelected() {
    if (!this.selectedRow) return false;
    this.app.copyText(valueText(this.selectedRow.r.value));
    return true;
  }

  propRef(g, name) {
    if (g.type === 'PropertySet') return { type: 'PropertySet', psetName: g.baseKey === 'Classification' ? 'Classification' : g.baseKey, name };
    return { type: g.type, psetName: g.type, name };
  }

  matching(g, name, value) {
    const ref = this.propRef(g, name);
    const want = valueText(value);
    return this.app.models.allGids((m, i) => m.hasGeom[i] && valueText(getValue(m, i, ref)) === want);
  }

  rowMenu(e, g, name, r) {
    const app = this.app;
    const items = [
      { label: t('props.copy'), icon: 'copy', shortcut: 'Ctrl+C', run: () => app.copyText(valueText(r.value)) },
    ];
    if (!r.varies) {
      items.push(
        { label: t('props.selectSame'), icon: 'check', run: () => app.state.select(this.matching(g, name, r.value)) },
        { label: t('props.isolateSame'), icon: 'isolate', run: () => app.state.isolate(this.matching(g, name, r.value)) },
      );
    }
    items.push({
      label: t('props.autoColor'), icon: 'legend',
      run: () => {
        const ref = this.propRef(g, name);
        const view = {
          guid: uuid(), title: `${translateName(name, g.type)}`, description: '', rules: [
            rule('Any', ['Summary', 'Summary', 'Model'], ['StringIsDefined'], ['AddSetTransparent']),
            rule('Any', [ref.type, ref.psetName, name], ['StringIsDefined'], ['SetOpaque']),
            rule('Any', [ref.type, ref.psetName, name], ['StringIsDefined'], ['SetAutoColored']),
          ],
        };
        app.applySmartView(view);
      },
    });
    showMenu(items, e.clientX, e.clientY);
  }
}

const NAME_DE = {
  Name: 'Name', Description: 'Beschreibung', GUID: 'GUID', IfcType: 'Elementtyp', IfcEntity: 'IFC-Klasse', Type: 'Typ', 'Object Type': 'Objekttyp',
  'Predefined Type': 'Vordefinierter Typ', Tag: 'Kennung (Tag)', Model: 'Modell', Classification: 'Klassifikation', System: 'System', Volume: 'Volumen',
  Area: 'Oberfläche', Height: 'Höhe', 'Bottom Elevation': 'UK (absolut)', 'Top Elevation': 'OK (absolut)', Elevation: 'Höhe (Elevation)', 'Long Name': 'Langname',
  Site: 'Grundstück', Building: 'Gebäude', 'Building Storey': 'Geschoss', 'Storey Elevation': 'Geschosshöhe', Space: 'Raum', Material: 'Material',
  'Material Layer Set': 'Schichtaufbau', 'File Name': 'Dateiname', Schema: 'Schema', Application: 'Anwendung', Author: 'Autor', Organization: 'Organisation', Phase: 'Phase',
};

function translateName(name, type) {
  if (getLanguage() === 'de' && type !== 'PropertySet' && NAME_DE[name]) return NAME_DE[name];
  return name;
}

function groupLabel(k) {
  const base = k.replace(/ \(.*\)$/, '');
  const tr = t(`grp.${base}`);
  return tr === `grp.${base}` ? k : k.replace(base, tr);
}

function formatValue(app, v, unit) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? (getLanguage() === 'de' ? 'Wahr' : 'True') : (getLanguage() === 'de' ? 'Falsch' : 'False');
  if (typeof v === 'number') {
    const s = Number.isInteger(v) ? v.toLocaleString(getLanguage() === 'de' ? 'de-DE' : 'en-US') : app.fmtNum(v, Math.abs(v) < 10 ? 3 : 2);
    return unit ? `${s} ${unit}` : s;
  }
  if (Array.isArray(v)) return v.join(', ');
  return unit ? `${v} ${unit}` : String(v);
}
