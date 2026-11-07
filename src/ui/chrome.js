import { h, showMenu, closeMenus } from './dom.js';
import { icon } from './icons.js';
import { t, setLanguage } from '../i18n.js';
import { CATEGORIES } from '../core/ifc-classes.js';
import { openSearch } from './dialogs.js';

function menus(app) {
  const c = (id, extra) => app.menuItem(id, extra);
  const views = ['perpendicular', '-', 'front', 'back', 'left', 'right', 'top', 'bottom', '-', 'iso', 'isoSE', 'isoNW', 'isoNE'];
  return [
    ['menu.file', () => [
      c('open'), c('add'), c('demo'),
      { label: t('cmd.remove'), shortcut: 'Ctrl+Delete', disabled: !app.models.models.length, submenu: app.models.models.map((m) => ({ label: m.name, run: () => app.removeModel(m) })) },
      '-', c('save'), c('closeAll'), '-', c('importBcf'), c('exportBcf'), c('screenshot'),
    ]],
    ['menu.view', () => [
      c('restore'), c('floorplans'), '-',
      { label: t('cmd.components'), submenu: [...CATEGORIES.map((k) => c(`cat.${k.key}`)), '-', c('showAll'), c('hideAll')] },
      c('toggleSel'), c('transparent'), c('isolate'), c('ghostOthers'), '-',
      c('undo'), c('redo'), '-', c('selectAll'), c('deselect'), '-',
      c('edges'), c('legend'),
      { label: t('cmd.background'), submenu: ['zoom', 'light', 'dark', 'white'].map((b) => ({ label: t(`bg.${b}`), checked: app.settings.get('background') === b, run: () => { app.settings.set('background', b); app.applySettings(); } })) },
    ]],
    ['menu.navigate', () => [
      c('orbit'), c('fly'), '-', c('fit'), c('zoomSel'), '-',
      ...views.map((v) => (v === '-' ? '-' : c(v))), '-', c('perspective'), c('orthographic'), c('level'),
    ]],
    ['menu.myview', () => [c('showAll'), c('showMyView'), c('setMyView'), c('addMyView'), c('removeMyView'), c('clearMyView')]],
    ['menu.validate', () => [
      c('clashes'), c('newClash'), '-',
      c('dimension'), c('distance'), c('angle'), c('area'), c('elevation'), c('mindist'), c('clearDims'),
    ]],
    ['menu.sectioning', () => [
      c('sectionPlane'), c('sectionX'), c('sectionY'), c('sectionZ'), c('sectionBox'), c('sectionBoxSel'), '-',
      c('flipPlane'), c('deletePlane'), c('deleteSections'), '-', c('suspend'), c('showPlanes'),
    ]],
    ['menu.extra', () => [
      c('search'), c('issue'),
      { label: t('cmd.annotations'), icon: 'annotate', submenu: [c('annLine'), c('annArrow'), c('annEllipse'), c('annCloud'), c('annRect'), c('annText'), '-', c('annClear')] },
      '-',
      { label: t('cmd.language'), submenu: [['de', 'Deutsch'], ['en', 'English']].map(([l, n]) => ({ label: n, checked: app.settings.get('lang') === l, run: () => { app.settings.set('lang', l); setLanguage(l); location.reload(); } })) },
      c('settings'),
    ]],
    ['menu.help', () => [c('shortcuts'), c('about')]],
  ];
}

export function buildMenubar(app, el) {
  const logo = h('div.brand', h('span.logo-mark'), 'OpenZoom');
  // small screens: the side panel overlays the 3D view and can be toggled
  const panelToggle = h('button.menu-btn.panel-toggle', { title: t('tab.navigation'), html: icon('menu', 16), on: { click: () => app.root.classList.toggle('panel-open') } });
  el.append(panelToggle, logo);
  let openKey = null;
  const entries = menus(app).map(([key, items]) => {
    const btn = h('button.menu-btn', t(key));
    const open = () => {
      closeMenus();
      btn.classList.add('open');
      openKey = key;
      const r = btn.getBoundingClientRect();
      showMenu(items(), r.left, r.bottom, { minWidth: 220 });
      btn.classList.add('open');
    };
    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (btn.classList.contains('open')) { closeMenus(); openKey = null; } else open();
    });
    btn.addEventListener('mouseenter', () => { if (document.querySelector('.menubar .open') && openKey !== key) open(); });
    el.appendChild(btn);
    return btn;
  });
  return entries;
}

export function buildToolbar(app, el) {
  const buttons = [];
  const btn = (id, opts = {}) => {
    const c = app.commands.get(id);
    const b = h('button.tb', { title: `${t(c.label)}${c.shortcut ? ` (${c.shortcut.split(',')[0]})` : ''}`, html: icon(opts.icon || c.icon || 'info', 20) });
    b.addEventListener('click', () => app.run(id));
    // keep keyboard focus in the 3D view so Space etc. don't re-click the button
    b.addEventListener('mousedown', (e) => e.preventDefault());
    buttons.push({ b, c });
    return b;
  };
  const drop = (iconName, title, items, opts = {}) => {
    const b = h('button.tb.drop', { title, html: `${icon(iconName, 20)}<span class="caret">▾</span>` });
    b.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const r = b.getBoundingClientRect();
      showMenu(items(), r.left, r.bottom + 2, { minWidth: 200 });
    });
    if (opts.active) buttons.push({ b, active: opts.active });
    return b;
  };
  const c = (id) => app.menuItem(id);
  const sep = () => h('span.tb-sep');
  el.append(
    btn('open'), btn('add'), btn('save'), sep(),
    btn('undo'), btn('redo'), sep(),
    btn('orbit'), btn('fly'), sep(),
    btn('fit'), btn('zoomSel'),
    drop('cube', t('menu.navigate'), () => ['front', 'back', 'left', 'right', 'top', 'bottom', '-', 'iso', 'isoSE', 'isoNW', 'isoNE', '-', 'perpendicular'].map((v) => (v === '-' ? '-' : c(v)))),
    btn('iso'),
    btn('perspective'), btn('orthographic'), sep(),
    btn('showAll'), btn('toggleSel'), btn('isolate'), btn('transparent'), btn('restore'), sep(),
    btn('sectionPlane'), btn('sectionBox'), btn('suspend'),
    drop('floor', t('cmd.floorplans'), () => {
      const st = app.storeys();
      const items = st.map(({ m, el: s }) => ({ label: `${s.name}${app.models.models.length > 1 ? ` · ${m.name}` : ''}`, checked: app.floorPlanStorey === s, run: () => app.enterFloorPlan(s) }));
      if (app.floorPlanStorey) items.unshift({ label: `✕ ${t('cmd.floorplans')}`, run: () => app.toggleFloorPlan() }, '-');
      return items.length ? items : [{ label: t('floor.none'), disabled: true }];
    }, { active: () => !!app.floorPlanStorey }), sep(),
    btn('dimension'),
    drop('distance', t('cmd.measure'), () => [c('dimension'), c('distance'), c('angle'), c('area'), c('elevation'), c('mindist'), '-', c('clearDims')], { active: () => ['distance', 'angle', 'area', 'mindist'].includes(app.measure.mode) }),
    btn('elevation'), sep(),
    btn('cat.spaces', { icon: 'space' }), btn('cat.openings', { icon: 'opening' }), btn('edges'), sep(),
    drop('annotate', t('cmd.annotations'), () => [c('annLine'), c('annArrow'), c('annEllipse'), c('annCloud'), c('annRect'), c('annText'), '-', c('annClear')], { active: () => !!app.annotations.tool }),
    btn('issue'), btn('screenshot'),
    h('span.flex'),
    h('div.tb-search', { html: icon('search', 16) }, h('input.input', {
      type: 'search', placeholder: t('cmd.search').replace('…', ''),
      on: { keydown: (e) => { if (e.key === 'Enter') openSearch(app, e.target.value); } },
    })),
    btn('settings'),
  );
  app.toolbar = {
    refresh() {
      for (const { b, c: cmd, active } of buttons) {
        if (active) { b.classList.toggle('active', active()); continue; }
        b.classList.toggle('active', !!(cmd.checked && cmd.checked()));
        b.disabled = cmd.enabled ? !cmd.enabled() : false;
      }
    },
  };
  app.state.addEventListener('change', () => app.toolbar.refresh());
  app.sections.addEventListener('change', () => app.toolbar.refresh());
  app.measure.addEventListener('mode', () => app.toolbar.refresh());
  app.controls.addEventListener('projection', () => app.toolbar.refresh());
  app.models.addEventListener('changed', () => app.toolbar.refresh());
  app.toolbar.refresh();
}
