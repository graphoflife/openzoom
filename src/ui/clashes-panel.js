import * as THREE from 'three';
import { h, clear, dialog, showMenu, download, toast, confirmDialog } from './dom.js';
import { icon } from './icons.js';
import { t, getLanguage } from '../i18n.js';
import { classLabel } from '../core/ifc-classes.js';
import { packRgb } from '../core/models.js';

const COLOR_A = [230, 40, 40], COLOR_B = [40, 170, 60];
const STATUSES = ['new', 'active', 'resolved', 'ignored', 'approved'];
const ABSTRACT = ['IfcBuildingElement', 'IfcBuiltElement', 'IfcDistributionElement', 'IfcDistributionFlowElement', 'IfcFlowSegment', 'IfcFlowFitting', 'IfcFlowTerminal', 'IfcElement'];

/** Clash tests, running them and browsing the results. */
export class ClashesPanel {
  constructor(app, host) {
    this.app = app;
    this.mgr = app.clashes;
    this.selected = null;
    this.statusFilter = 'open';
    const tb = (ic, title, fn) => h('button.icon-btn', { title, html: icon(ic, 16), on: { click: fn } });
    this.runBtn = tb('play', t('clash.run'), () => this.run(this.selected));
    host.append(
      h('div.panel-head',
        tb('plus', t('clash.new'), () => this.newTest()), this.runBtn, tb('edit', t('clash.edit'), () => this.selected && this.editTest(this.selected)),
        tb('minus', t('clash.delete'), () => this.deleteTest()), h('span.flex'),
        tb('issue', t('clash.toIssues'), () => this.allToIssues()), tb('export', t('clash.export'), () => this.exportCsv())),
      this.testsEl = h('div.clash-tests'),
      this.progressEl = h('div.inline-progress', h('div.progress-bar', h('div.progress-fill')), h('span.lbl'), h('button.btn.small', { on: { click: () => this.mgr.cancel() } }, t('clash.cancel'))),
      h('div.panel-head.sub',
        h('span.panel-title.inline', t('clash.results')),
        h('span.flex'),
        this.filterSel = h('select.input.small', { on: { change: (e) => { this.statusFilter = e.target.value; this.renderResults(); } } },
          h('option', { value: 'open' }, `${t('clash.status.new')} + ${t('clash.status.active')}`),
          h('option', { value: 'all' }, t('clash.allStatus')),
          ...STATUSES.map((s) => h('option', { value: s }, t(`clash.status.${s}`))))),
      this.resultsEl = h('div.clash-results'));
    this.mgr.addEventListener('change', () => this.render());
    this.render();
  }

  render() {
    clear(this.testsEl);
    if (!this.mgr.tests.includes(this.selected)) this.selected = this.mgr.tests[0] || null;
    if (!this.mgr.tests.length) {
      this.testsEl.appendChild(h('div.empty', h('p', t('clash.notRun')), h('button.btn', { on: { click: () => this.newTest() } }, `+ ${t('clash.new')}`)));
    }
    for (const test of this.mgr.tests) {
      const counts = {};
      for (const r of test.results) counts[r.status] = (counts[r.status] || 0) + 1;
      const card = h('div.clash-test', { class: `clash-test${test === this.selected ? ' selected' : ''}` },
        h('div.ct-name', test.name),
        h('div.ct-sub', `${this.setLabel(test.setA)}  ×  ${this.setLabel(test.setB)} · ${test.mode === 'hard' ? `${t('clash.hard')} ${Math.round(test.tolerance * 1000)} mm` : `${t('clash.clearance')} ${Math.round(test.clearance * 1000)} mm`}`),
        h('div.ct-counts', test.lastRun ? STATUSES.filter((s) => counts[s]).map((s) => h('span.badge', { class: `badge st-${s}` }, `${counts[s]} ${t(`clash.status.${s}`)}`)) : h('span.muted', t('clash.notRun'))));
      card.addEventListener('click', () => { this.selected = test; this.render(); });
      card.addEventListener('dblclick', () => this.editTest(test));
      this.testsEl.appendChild(card);
    }
    this.renderResults();
  }

  setLabel(set) {
    const v = set.value;
    switch (set.kind) {
      case 'types': return (v || []).map((c) => classLabel(c, getLanguage())).join(', ') || '–';
      case 'model': return (v || []).join(', ') || '–';
      case 'smartview': return this.app.smartViews.findView(v)?.view.title || '–';
      case 'guids': return `${t('clash.kind.guids')} (${(v || []).length})`;
      default: return t(`clash.kind.${set.kind}`);
    }
  }

  renderResults() {
    clear(this.resultsEl);
    const test = this.selected;
    if (!test) return;
    if (!test.lastRun) { this.resultsEl.appendChild(h('div.empty', t('clash.notRun'))); return; }
    const list = test.results.filter((r) => this.statusFilter === 'all' || (this.statusFilter === 'open' ? r.status === 'new' || r.status === 'active' : r.status === this.statusFilter));
    if (!list.length) { this.resultsEl.appendChild(h('div.empty', t('clash.none'))); return; }
    const table = h('table.grid');
    table.appendChild(h('thead', h('tr', h('th', '#'), h('th', t('issue.status')), h('th', 'A'), h('th', 'B'), h('th', test.mode === 'hard' ? t('clash.depth') : t('clash.dist')))));
    const tb = h('tbody');
    list.forEach((r, k) => {
      const tr = h('tr', { class: r === this.focused ? 'sel' : '' },
        h('td', String(test.results.indexOf(r) + 1)),
        h('td', h('span.badge', { class: `badge st-${r.status}` }, t(`clash.status.${r.status}`))),
        h('td', { title: `${r.nameA} · ${r.clsA} · ${r.modelA}` }, r.nameA),
        h('td', { title: `${r.nameB} · ${r.clsB} · ${r.modelB}` }, r.nameB),
        h('td.num', test.mode === 'hard' ? `${Math.round(r.depth * 1000)} mm` : `${Math.round(r.distance * 1000)} mm`));
      tr.addEventListener('click', () => { this.focus(r); this.renderResults(); });
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu([
          ...STATUSES.map((s) => ({ label: t(`clash.status.${s}`), checked: r.status === s, run: () => { r.status = s; this.mgr.changed(); } })),
          '-', { label: t('clash.toIssue'), icon: 'issue', run: () => this.toIssue(r) },
        ], e.clientX, e.clientY);
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    this.resultsEl.appendChild(table);
  }

  newTest() {
    const test = this.mgr.newTest(`${t('cmd.clashes')} ${this.mgr.tests.length + 1}`);
    this.selected = test;
    this.render();
    this.editTest(test);
  }

  async deleteTest() {
    if (!this.selected) return;
    if (await confirmDialog(t('clash.delete'), `„${this.selected.name}“?`)) this.mgr.removeTest(this.selected);
  }

  editTest(test) {
    const app = this.app;
    const classes = new Set(ABSTRACT);
    for (const m of app.models.models) for (let i = 0; i < m.count; i++) if (m.hasGeom[i]) classes.add(m.elements[i].cls);
    const allClasses = [...classes].sort();
    const name = h('input.input', { value: test.name });
    const mode = h('select.input', h('option', { value: 'hard', selected: test.mode === 'hard' }, t('clash.hard')), h('option', { value: 'clearance', selected: test.mode === 'clearance' }, t('clash.clearance')));
    const tol = h('input.input', { type: 'number', step: 1, min: 0, value: Math.round(test.tolerance * 1000) });
    const clr = h('input.input', { type: 'number', step: 5, min: 1, value: Math.round(test.clearance * 1000) });
    const same = h('input', { type: 'checkbox', checked: test.ignoreSameModel });
    const editors = [test.setA, test.setB].map((set) => this.setEditor(set, allClasses));
    const body = h('div.form',
      h('label', t('clash.name'), name),
      h('div.form-row.two', h('label', t('clash.mode'), mode), h('div.row', h('label', t('clash.tolerance'), tol), h('label', t('clash.clearanceVal'), clr))),
      h('label.check', same, t('clash.sameModel')),
      h('div.form-row.two', h('div', h('div.form-label', t('clash.setA')), editors[0].el), h('div', h('div.form-label', t('clash.setB')), editors[1].el)));
    dialog({
      title: t('clash.edit'), body, width: 760,
      buttons: [
        {
          label: t('clash.run'), primary: true,
          run: () => { save(); this.run(test); },
        },
        { label: t('ui.save'), run: () => save() },
        { label: t('ui.cancel') },
      ],
    });
    const save = () => {
      test.name = name.value || test.name;
      test.mode = mode.value;
      test.tolerance = Math.max(0, Number(tol.value) || 0) / 1000;
      test.clearance = Math.max(1, Number(clr.value) || 50) / 1000;
      test.ignoreSameModel = same.checked;
      test.setA = editors[0].value();
      test.setB = editors[1].value();
      this.mgr.changed();
    };
  }

  setEditor(set, allClasses) {
    const app = this.app;
    const kinds = ['types', 'model', 'smartview', 'all', 'visible', 'guids'];
    const kind = h('select.input', ...kinds.map((k) => h('option', { value: k, selected: set.kind === k }, t(`clash.kind.${k}`))));
    const valueHost = h('div.set-value');
    let current = set.kind === 'guids' ? set.value : null;
    const draw = () => {
      clear(valueHost);
      const k = kind.value;
      if (k === 'types' || k === 'model') {
        const opts = k === 'types' ? allClasses : app.models.models.map((m) => m.name);
        const chosen = new Set(set.kind === k ? set.value || [] : []);
        valueHost.appendChild(h('div.checklist', ...opts.map((o) => h('label.check', h('input', { type: 'checkbox', value: o, checked: chosen.has(o) }), k === 'types' ? `${classLabel(o, getLanguage())} (${o})` : o))));
      } else if (k === 'smartview') {
        valueHost.appendChild(h('select.input.sv-pick', ...app.smartViews.sets.flatMap((s) => s.views.map((v) => h('option', { value: v.guid, selected: set.value === v.guid }, `${s.title} / ${v.title}`)))));
      } else if (k === 'guids') {
        if (!current) current = [...app.state.selection].map((g) => app.models.element(g)?.guid).filter(Boolean);
        valueHost.appendChild(h('div.muted', `${current.length} ${t('status.selected', { n: '' }).trim()}`),
          h('button.btn.small', { on: { click: () => { current = [...app.state.selection].map((g) => app.models.element(g)?.guid).filter(Boolean); draw(); } } }, '↻'));
      }
    };
    kind.addEventListener('change', draw);
    draw();
    return {
      el: h('div', kind, valueHost),
      value: () => {
        const k = kind.value;
        if (k === 'types' || k === 'model') return { kind: k, value: [...valueHost.querySelectorAll('input:checked')].map((i) => i.value) };
        if (k === 'smartview') return { kind: k, value: valueHost.querySelector('select')?.value };
        if (k === 'guids') return { kind: k, value: current || [] };
        return { kind: k };
      },
    };
  }

  async run(test) {
    if (!test) return;
    if (!this.app.models.models.length) { toast(t('err.noModels')); return; }
    this.selected = test;
    this.progressEl.classList.add('show');
    const fill = this.progressEl.querySelector('.progress-fill');
    const lbl = this.progressEl.querySelector('.lbl');
    const res = await this.mgr.run(test, (p, n) => {
      fill.style.width = `${Math.round(p * 100)}%`;
      lbl.textContent = t('clash.progress', { p: Math.round(p * 100), n });
    });
    this.progressEl.classList.remove('show');
    toast(`${test.name}: ${t('clash.count', { n: res.results.filter((r) => r.status !== 'resolved').length })}`);
    this.render();
  }

  /** Show a clash: both elements opaque and coloured, everything else transparent. */
  focus(r, animate = true) {
    const app = this.app;
    const M = app.models;
    // gids are exact within a session; GUIDs survive reloading the models
    const resolve = (guid, gid) => {
      const el = M.element(gid);
      if (el && (!guid || el.guid === guid)) return gid;
      return guid ? M.findByGuid(guid) : -1;
    };
    const ga = resolve(r.guidA, r.a), gb = resolve(r.guidB, r.b);
    if (ga < 0 || gb < 0) return;
    this.focused = r;
    // everything else stays as visible as it is, but transparent and uncoloured
    const focusView = app.state.currentView();
    for (const v of focusView) { v.ghost.fill(1); v.color.fill(-1); }
    const mark = (gid, rgb) => {
      for (const g of M.expand([gid])) {
        const v = focusView.find((x) => x.model === M.modelOf(g));
        const i = g - v.model.base;
        v.vis[i] = 1; v.ghost[i] = 0; v.color[i] = packRgb(rgb);
      }
    };
    mark(ga, COLOR_A);
    mark(gb, COLOR_B);
    app.state.applyView(focusView, {
      legend: {
        title: this.selected?.name,
        entries: [
          { color: COLOR_A, label: `A: ${r.nameA}`, count: 1, gids: [ga] },
          { color: COLOR_B, label: `B: ${r.nameB}`, count: 1, gids: [gb] },
        ],
      },
    });
    const point = new THREE.Vector3().fromArray(r.point);
    const box = M.boxOf([ga, gb]);
    const clamp = new THREE.Box3().setFromCenterAndSize(point, new THREE.Vector3(5, 5, 5));
    const view = box.clone().intersect(clamp);
    view.expandByPoint(point);
    if (view.isEmpty()) view.setFromCenterAndSize(point, new THREE.Vector3(2, 2, 2));
    app.controls.fitBox(view.expandByScalar(0.3), null, animate);
    app.status(`${r.nameA} (${r.clsA}) × ${r.nameB} (${r.clsB})`);
  }

  toIssue(r, animate = true) {
    this.focus(r, animate);
    return new Promise((resolve) => setTimeout(() => {
      const issue = this.app.createIssue({
        title: `Kollision: ${r.nameA} × ${r.nameB}`, type: 'Clash',
        description: `${this.selected?.name || ''}\nA: ${r.nameA} (${r.clsA}, ${r.modelA}, ${r.guidA})\nB: ${r.nameB} (${r.clsB}, ${r.modelB}, ${r.guidB})\n${this.selected?.mode === 'hard' ? `${t('clash.depth')}: ${Math.round(r.depth * 1000)} mm` : `${t('clash.dist')}: ${Math.round(r.distance * 1000)} mm`}`,
        labels: ['Clash'],
      });
      if (issue) {
        const vp = issue.viewpoints[0];
        vp.components.selection = [r.guidA, r.guidB];
      }
      r.status = r.status === 'new' ? 'active' : r.status;
      this.mgr.changed();
      resolve(issue);
    }, animate ? 520 : 30));
  }

  async allToIssues() {
    const test = this.selected;
    if (!test) return;
    const list = test.results.filter((r) => r.status === 'new' || r.status === 'active');
    for (const r of list) await this.toIssue(r, false);
    toast(t('issue.imported', { n: list.length }));
  }

  exportCsv() {
    const test = this.selected;
    if (!test || !test.results.length) return;
    const rows = [['Nr', 'Status', 'Element A', 'Klasse A', 'Modell A', 'GUID A', 'Element B', 'Klasse B', 'Modell B', 'GUID B', 'Tiefe/Abstand [mm]', 'X', 'Y', 'Z']];
    test.results.forEach((r, k) => {
      const p = this.app.models.toIfc(new THREE.Vector3().fromArray(r.point));
      rows.push([k + 1, t(`clash.status.${r.status}`), r.nameA, r.clsA, r.modelA, r.guidA, r.nameB, r.clsB, r.modelB, r.guidB, Math.round((test.mode === 'hard' ? r.depth : r.distance) * 1000), ...p.map((v) => v.toFixed(3))]);
    });
    download(`${test.name}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  }
}

export function toCsv(rows) {
  const sep = ';';
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${rows.map((r) => r.map(esc).join(sep)).join('\r\n')}`;
}
