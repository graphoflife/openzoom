import { h, clear, dialog } from './dom.js';
import { t, getLanguage } from '../i18n.js';
import { classLabel } from '../core/ifc-classes.js';
import { psetsOf, valueText, storeyZ, elementMatches } from '../core/props.js';

/** Ctrl+F: search names, GUIDs, types and (optionally) property values. */
export function openSearch(app, initial = '') {
  const input = h('input.input.search-input', { type: 'search', placeholder: t('search.placeholder'), value: initial });
  const inProps = h('input', { type: 'checkbox', checked: localStorage.getItem('oz.searchProps') === '1' });
  const info = h('div.muted');
  const results = h('div.search-results');
  let hits = [];
  const run = () => {
    const q = input.value.trim().toLowerCase();
    localStorage.setItem('oz.searchProps', inProps.checked ? '1' : '0');
    clear(results);
    hits = [];
    if (q.length < 1) { info.textContent = ''; return; }
    for (const m of app.models.models) {
      for (let i = 0; i < m.count; i++) {
        let match = elementMatches(m.elements[i], q);
        if (!match && inProps.checked) {
          outer: for (const ps of psetsOf(m, i)) for (const p of ps.p) if (valueText(p[1]).toLowerCase().includes(q)) { match = true; break outer; }
        }
        if (match) hits.push(m.base + i);
      }
    }
    info.textContent = t('search.results', { n: hits.length });
    for (const gid of hits.slice(0, 500)) {
      const el = app.models.element(gid);
      const row = h('div.search-row', h('span.lbl', el.name || el.longName || el.cls), h('span.sub', `${classLabel(el.cls, getLanguage())} · ${app.models.modelOf(gid).name}`));
      row.addEventListener('click', (e) => { app.state.select([gid], e.ctrlKey ? 'toggle' : 'replace'); app.tree.reveal(gid); });
      row.addEventListener('dblclick', () => { app.state.select([gid]); app.zoomToSelection(); });
      results.appendChild(row);
    }
  };
  let timer = 0;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  inProps.addEventListener('change', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { app.state.select(hits); } });
  dialog({
    title: t('search.title'), width: 560,
    body: h('div.form', input, h('label.check', inProps, t('search.inProps')), info, results),
    buttons: [
      { label: t('search.selectAll'), primary: true, run: () => { app.state.select(hits); return false; } },
      { label: t('search.isolate'), run: () => { app.state.select(hits); app.state.isolate(hits); app.zoomToSelection(); } },
      { label: t('ui.close') },
    ],
  });
  if (initial) run();
}

export function openSettings(app) {
  const s = app.settings;
  const sel = (key, opts) => h('select.input', { 'data-key': key }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(s.get(key)) === String(v) }, l)));
  const num = (key, attrs) => h('input.input', { type: 'number', 'data-key': key, value: s.get(key), ...attrs });
  const fields = [
    [t('settings.language'), sel('lang', [['de', 'Deutsch'], ['en', 'English']])],
    [t('settings.units'), sel('unit', [['m', 'm'], ['cm', 'cm'], ['mm', 'mm']])],
    [t('settings.decimals'), num('decimals', { min: 0, max: 6 })],
    [t('settings.background'), sel('background', ['zoom', 'light', 'dark', 'white'].map((b) => [b, t(`bg.${b}`)]))],
    [t('settings.ghost'), num('ghost', { min: 3, max: 90 })],
    [t('settings.selColor'), h('input.input', { type: 'color', 'data-key': 'selColor', value: s.get('selColor') })],
    [t('settings.elevRef'), sel('elevationRef', [['project', t('settings.elevProject')], ['storey', t('settings.elevStorey')]])],
    [t('settings.elevZero'), num('elevationZero', { step: 0.01 })],
    [t('settings.cutHeight'), num('cutHeight', { step: 0.1, min: 0.1 })],
    [t('settings.author'), h('input.input', { 'data-key': 'author', value: s.get('author') })],
  ];
  const edges = h('input', { type: 'checkbox', checked: s.get('edges') !== false });
  const body = h('div.form', ...fields.map(([l, el]) => h('label', l, el)), h('label.check', edges, t('settings.edges')));
  dialog({
    title: t('settings.title'), width: 460, body,
    buttons: [{
      label: t('ui.save'), primary: true,
      run: () => {
        const oldLang = s.get('lang');
        for (const el of body.querySelectorAll('[data-key]')) {
          const v = el.type === 'number' ? Number(el.value) : el.value;
          s.set(el.dataset.key, v);
        }
        s.set('edges', edges.checked);
        app.applySettings();
        app.measure.refreshElevations();
        if (s.get('lang') !== oldLang) location.reload();
      },
    }, { label: t('ui.cancel') }],
  });
}

export function openShortcuts(app) {
  const extra = [
    [t('cmd.orbit'), t('help.orbit')],
    [t('cmd.fly'), t('help.fly')],
    [t('menu.sectioning'), t('help.sections')],
    [t('cmd.dimension'), t('help.dims')],
    [t('help.mouse'), t('help.mouseText')],
  ];
  const rows = [...app.commands.values()].filter((c) => c.keys.length).map((c) => h('tr', h('td', t(c.label)), h('td', h('kbd', c.keys.join(' / ')))));
  dialog({
    title: t('cmd.shortcuts'), width: 720,
    body: h('div.shortcuts',
      h('table.grid', h('tbody', ...rows)),
      h('table.grid', h('tbody', ...extra.map(([l, d]) => h('tr', h('td', l), h('td', d))))),
      h('p.muted', t('help.browserNote'))),
    buttons: [{ label: t('ui.close') }],
  });
}

export function openAbout() {
  dialog({
    title: t('cmd.about'), width: 480,
    body: h('div.about',
      h('div.welcome-logo', h('span.logo-mark'), 'OpenZoom'),
      h('p', t('about.text')),
      h('p.muted', t('about.notAffiliated')),
      h('p.muted', 'MIT-Lizenz · three.js (MIT) · web-ifc (MPL-2.0) · three-mesh-bvh (MIT) · fflate (MIT)')),
    buttons: [{ label: t('ui.close') }],
  });
}

/** Ask the user for a storey (floor plans). */
export function chooseStorey(app) {
  return new Promise((resolve) => {
    const list = app.storeys();
    if (!list.length) { resolve(null); return; }
    let chosen = null;
    const d = dialog({
      title: t('floor.select'), width: 360,
      body: h('div.choice-list', ...list.map((s) => h('button.btn.block', {
        on: { click: () => { chosen = s; d.close(); } },
      }, `${s.el.name} (${app.fmtNum(storeyZ(s.el), 2)} m)${app.models.models.length > 1 ? ` · ${s.m.name}` : ''}`))),
      onClose: () => resolve(chosen),
    });
  });
}
