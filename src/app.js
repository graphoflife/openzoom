import * as THREE from 'three';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { t, setLanguage, getLanguage } from './i18n.js';
import { Viewer } from './core/viewer.js';
import { ModelManager } from './core/models.js';
import { ElementState } from './core/state.js';
import { Controls } from './core/controls.js';
import { Sections } from './core/sections.js';
import { Measure } from './core/measure.js';
import { ClashManager } from './core/clash.js';
import { SmartViewLibrary, evaluate, applyResult } from './core/smartviews.js';
import { IssueManager } from './core/issues.js';
import { Annotations } from './core/annotations.js';
import { sharedUniforms } from './core/materials.js';
import { CATEGORIES } from './core/ifc-classes.js';
import { buildPropertyCatalog } from './core/props.js';
import { h, toast, download, pickFiles, confirmDialog, showMenu } from './ui/dom.js';
import { buildMenubar, buildToolbar } from './ui/chrome.js';
import { TreePanel } from './ui/tree.js';
import { PropertiesPanel } from './ui/properties.js';
import { SmartViewsPanel } from './ui/smartviews-panel.js';
import { ClashesPanel } from './ui/clashes-panel.js';
import { ListsPanel } from './ui/lists-panel.js';
import { IssuesPanel } from './ui/issues-panel.js';
import { openSearch, openSettings, openShortcuts, openAbout, chooseStorey } from './ui/dialogs.js';

const DEFAULTS = {
  lang: (navigator.language || 'de').startsWith('de') ? 'de' : 'en', unit: 'm', decimals: 3, background: 'zoom', edges: true,
  ghost: 18, elevationRef: 'project', elevationZero: 0, author: '', cutHeight: 1.2, legend: true, selColor: '#ffc400',
};

class Settings {
  constructor() {
    this.values = { ...DEFAULTS };
    try { Object.assign(this.values, JSON.parse(localStorage.getItem('oz.settings') || '{}')); } catch { /* ignore */ }
  }
  get(k) { return this.values[k]; }
  set(k, v) {
    this.values[k] = v;
    try { localStorage.setItem('oz.settings', JSON.stringify(this.values)); } catch { /* ignore */ }
  }
}

export class App {
  constructor(root) {
    this.root = root;
    this.settings = new Settings();
    setLanguage(this.settings.get('lang'));
    this.t = t;
    this.buildLayout();
    this.viewer = new Viewer(this.viewport);
    this.models = new ModelManager(this);
    this.state = new ElementState(this);
    this.controls = new Controls(this);
    this.sections = new Sections(this);
    this.measure = new Measure(this);
    this.annotations = new Annotations(this);
    this.smartViews = new SmartViewLibrary();
    this.clashes = new ClashManager(this);
    this.issues = new IssueManager(this);
    this.floorPlanStorey = null;
    this.applySettings();
    this.registerCommands();
    this.buildUi();
    this.bindEvents();
    this.updateWelcome();
    this.status('');
    const params = new URLSearchParams(location.search);
    if (params.has('demo')) this.loadDemo();
  }

  // --- formatting -------------------------------------------------------------------
  get decimalSep() { return getLanguage() === 'de' ? ',' : '.'; }

  fmtNum(v, d = this.settings.get('decimals')) {
    return Number(v).toLocaleString(getLanguage() === 'de' ? 'de-DE' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  fmtLen(m) {
    const u = this.settings.get('unit');
    const d = Number(this.settings.get('decimals'));
    if (u === 'mm') return `${this.fmtNum(m * 1000, Math.max(0, d - 3))} mm`;
    if (u === 'cm') return `${this.fmtNum(m * 100, Math.max(0, d - 2))} cm`;
    return `${this.fmtNum(m, d)} m`;
  }

  fmtArea(a) { return `${this.fmtNum(a, 2)} m²`; }

  status(msg) {
    this.statusMsg.textContent = msg || '';
  }

  // --- layout -----------------------------------------------------------------------
  buildLayout() {
    this.menubarEl = h('div.menubar');
    this.toolbarEl = h('div.toolbar');
    this.tabsEl = h('div.tabs');
    this.tabBody = h('div.tab-body');
    this.leftPanel = h('div.left-panel', this.tabsEl, this.tabBody);
    this.splitter = h('div.splitter');
    this.viewport = h('div.viewport');
    this.statusMsg = h('span.status-msg');
    this.statusSel = h('span.status-sel');
    this.statusInfo = h('span.status-info');
    this.statusbar = h('div.statusbar', this.statusMsg, h('span.flex'), this.statusInfo, this.statusSel);
    this.root.append(this.menubarEl, this.toolbarEl, h('div.main', this.leftPanel, this.splitter, this.viewport), this.statusbar);
    const w = Number(localStorage.getItem('oz.leftWidth')) || 380;
    this.leftPanel.style.width = `${w}px`;
    this.splitter.addEventListener('pointerdown', (e) => {
      this.splitter.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const nw = Math.max(240, Math.min(window.innerWidth - 300, ev.clientX));
        this.leftPanel.style.width = `${nw}px`;
      };
      const up = () => {
        this.splitter.removeEventListener('pointermove', move);
        localStorage.setItem('oz.leftWidth', parseInt(this.leftPanel.style.width, 10));
      };
      this.splitter.addEventListener('pointermove', move);
      this.splitter.addEventListener('pointerup', up, { once: true });
    });
  }

  buildUi() {
    buildMenubar(this, this.menubarEl);
    buildToolbar(this, this.toolbarEl);
    this.panels = {
      navigation: { label: 'tab.navigation', el: h('div.tab-page.nav-page') },
      smartviews: { label: 'tab.smartviews', el: h('div.tab-page') },
      clashes: { label: 'tab.clashes', el: h('div.tab-page') },
      lists: { label: 'tab.lists', el: h('div.tab-page') },
      issues: { label: 'tab.issues', el: h('div.tab-page') },
    };
    for (const [key, p] of Object.entries(this.panels)) {
      p.tab = h('button.tab', { on: { click: () => this.showTab(key) } }, t(p.label));
      this.tabsEl.appendChild(p.tab);
      this.tabBody.appendChild(p.el);
    }
    const treeHost = h('div.nav-tree');
    const propHost = h('div.nav-props');
    const navSplit = h('div.hsplit');
    this.panels.navigation.el.append(treeHost, navSplit, propHost);
    const treeH = Number(localStorage.getItem('oz.treeHeight')) || 0;
    if (treeH) treeHost.style.flex = `0 0 ${treeH}px`;
    navSplit.addEventListener('pointerdown', (e) => {
      navSplit.setPointerCapture(e.pointerId);
      const top = treeHost.getBoundingClientRect().top;
      const move = (ev) => { treeHost.style.flex = `0 0 ${Math.max(80, ev.clientY - top)}px`; };
      navSplit.addEventListener('pointermove', move);
      navSplit.addEventListener('pointerup', () => {
        navSplit.removeEventListener('pointermove', move);
        localStorage.setItem('oz.treeHeight', parseInt(treeHost.style.flexBasis, 10));
      }, { once: true });
    });
    this.tree = new TreePanel(this, treeHost);
    this.properties = new PropertiesPanel(this, propHost);
    this.smartViewsPanel = new SmartViewsPanel(this, this.panels.smartviews.el);
    this.clashesPanel = new ClashesPanel(this, this.panels.clashes.el);
    this.listsPanel = new ListsPanel(this, this.panels.lists.el);
    this.issuesPanel = new IssuesPanel(this, this.panels.issues.el);
    this.showTab(localStorage.getItem('oz.tab') || 'navigation');

    // viewport overlays
    this.legendEl = h('div.legend');
    this.progressEl = h('div.progress', h('div.progress-label'), h('div.progress-bar', h('div.progress-fill')));
    this.dropEl = h('div.drop-hint', t('status.dropHint'));
    this.welcomeEl = h('div.welcome',
      h('div.welcome-card',
        h('div.welcome-logo', h('span.logo-mark'), 'OpenZoom'),
        h('h2', t('welcome.title')),
        h('p', t('welcome.text')),
        h('div.welcome-actions',
          h('button.btn.primary', { on: { click: () => this.run('open') } }, t('welcome.open')),
          h('button.btn', { on: { click: () => this.loadDemo() } }, t('welcome.demo'))),
        h('p.muted', t('welcome.drop'))));
    this.axesEl = h('canvas.axes', { width: 90, height: 90 });
    this.viewport.append(this.legendEl, this.progressEl, this.dropEl, this.welcomeEl, this.axesEl);
  }

  showTab(key) {
    if (!this.panels[key]) key = 'navigation';
    for (const [k, p] of Object.entries(this.panels)) {
      p.tab.classList.toggle('active', k === key);
      p.el.classList.toggle('active', k === key);
    }
    this.activeTab = key;
    localStorage.setItem('oz.tab', key);
    this.panels[key].onShow?.();
    this.listsPanel?.visible(key === 'lists');
  }

  applySettings() {
    const s = this.settings;
    this.viewer.setBackground(s.get('background'));
    sharedUniforms.uGhostAlpha.value = Number(s.get('ghost')) / 100;
    sharedUniforms.uSelColor.value.set(s.get('selColor') || '#ffc400');
    for (const m of this.models?.models || []) m.setEdgesVisible(s.get('edges') !== false);
    this.viewer.requestRender();
  }

  // --- events -----------------------------------------------------------------------
  bindEvents() {
    this.controls.addEventListener('click', (e) => this.onViewportClick(e.detail.event, e.detail.button));
    let hoverTimer = 0;
    this.controls.addEventListener('hover', (e) => {
      const ev = e.detail;
      if (this.measure.active) { this.measure.hover(ev); return; }
      if (performance.now() - hoverTimer < 40) return;
      hoverTimer = performance.now();
      const hit = this.viewer.pick(ev.clientX, ev.clientY, this.models.models);
      this.state.setHover(hit ? hit.gid : -1);
      this.statusInfo.textContent = hit ? this.hoverText(hit) : '';
    });
    this.viewer.canvas.addEventListener('pointerleave', () => { this.state.setHover(-1); this.statusInfo.textContent = ''; });
    this.state.addEventListener('selection', () => this.updateSelectionStatus());
    this.state.addEventListener('change', () => this.renderLegend());
    this.models.addEventListener('changed', () => { this.catalogCache = null; this.updateWelcome(); this.updateSceneBounds(); this.updateSelectionStatus(); });
    this.controls.addEventListener('mode', () => this.updateFlyStatus());
    this.controls.addEventListener('speed', () => this.updateFlyStatus());
    this.viewer.addEventListener('render', () => this.drawAxes());
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    // drag & drop
    let dragDepth = 0;
    this.root.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; this.dropEl.classList.add('show'); });
    this.root.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; this.dropEl.classList.remove('show'); } });
    this.root.addEventListener('dragover', (e) => e.preventDefault());
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      this.dropEl.classList.remove('show');
      const files = [...e.dataTransfer.files];
      if (files.length) this.openFiles(files, false);
    });
    window.addEventListener('beforeunload', (e) => { if (this.models.models.length && this.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  hoverText(hit) {
    const el = hit.model.elements[hit.index];
    const z = this.models.toIfc(hit.point)[2];
    return `${el.name || el.cls} · ${el.cls} · Z ${this.fmtNum(z, 3)} m`;
  }

  updateSelectionStatus() {
    const n = this.state.selection.size;
    let total = 0;
    for (const m of this.models.models) for (let i = 0; i < m.count; i++) if (m.hasGeom[i]) total++;
    this.statusSel.textContent = `${n ? `${t('status.selected', { n })} · ` : ''}${t('status.elements_count', { n: total })}`;
  }

  updateFlyStatus() {
    if (this.controls.mode === 'fly') this.status(t('status.fly', { s: this.fmtNum(this.controls.flySpeed, 1) }));
    else this.status('');
    this.toolbar?.refresh();
  }

  updateWelcome() {
    this.welcomeEl.style.display = this.models.models.length ? 'none' : '';
  }

  updateSceneBounds() {
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (const m of this.models.models) for (let i = 0; i < m.count; i++) if (m.bbox(i, tmp)) box.union(tmp);
    this.controls.sceneRadius = box.isEmpty() ? 50 : Math.max(5, box.getBoundingSphere(new THREE.Sphere()).radius);
    this.controls.updateClipRange();
  }

  /** Union of all properties of all loaded elements (cached until the models change). */
  propertyCatalog() {
    if (!this.catalogCache) this.catalogCache = buildPropertyCatalog(this.models.models);
    return this.catalogCache;
  }

  pickPoint(x, y) {
    const hit = this.viewer.pick(x, y, this.models.models);
    return hit ? hit.point : null;
  }

  onViewportClick(e, button) {
    this.viewer.canvas.focus({ preventScroll: true });
    if (button === 2) { this.openContextMenu(e); return; }
    if (button !== 0) return;
    if (this.annotations.active) return;
    if (this.measure.active) { this.measure.click(e); return; }
    const hit = this.viewer.pick(e.clientX, e.clientY, this.models.models);
    const mode = e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace';
    if (!hit) { if (mode === 'replace') this.state.clearSelection(); return; }
    this.state.select([hit.gid], mode);
    this.tree.reveal(hit.gid);
  }

  openContextMenu(e) {
    const hit = this.viewer.pick(e.clientX, e.clientY, this.models.models);
    if (hit && !this.state.selection.has(hit.gid)) this.state.select([hit.gid]);
    const c = (id) => this.menuItem(id);
    showMenu([
      c('toggleSel'), c('isolate'), c('transparent'), c('ghostOthers'), c('showAll'), '-',
      c('zoomSel'), c('sectionBoxSel'), '-',
      { label: t('cmd.colorSel'), icon: 'legend', submenu: [[230, 25, 75], [60, 180, 75], [0, 130, 200], [255, 225, 25], [245, 130, 48], [145, 30, 180]].map((rgb) => ({ label: `RGB ${rgb.join(',')}`, color: `rgb(${rgb})`, run: () => this.state.colorize(this.state.selection, rgb) })).concat([{ label: t('cmd.resetColor'), run: () => this.state.colorize(this.state.selection, null) }]) },
      c('selectSameType'), c('selectSameClass'), '-',
      c('addMyView'), c('removeMyView'), '-',
      c('copyGuid'), c('issue'), c('properties'),
    ], e.clientX, e.clientY);
  }

  // --- commands -----------------------------------------------------------------------
  cmd(id, label, shortcut, run, opts = {}) {
    this.commands.set(id, { id, label, shortcut, run, ...opts });
  }

  menuItem(id, extra = {}) {
    const c = this.commands.get(id);
    if (!c) return null;
    return {
      label: t(c.label), shortcut: c.shortcut ? c.shortcut.split(',')[0] : '', icon: c.icon,
      checked: c.checked ? c.checked() : false, disabled: c.enabled ? !c.enabled() : false, run: () => this.run(id), ...extra,
    };
  }

  run(id) {
    const c = this.commands.get(id);
    if (!c) return;
    if (c.needsModel && !this.models.models.length) { toast(t('err.noModels')); return; }
    if (c.needsSelection && !this.state.selection.size) { toast(t('msg.noSelection')); return; }
    c.run();
    this.toolbar?.refresh();
  }

  registerCommands() {
    this.commands = new Map();
    const C = this.cmd.bind(this);
    const sel = () => this.state.selection;
    const S = { needsSelection: true };
    // File
    C('open', 'cmd.open', 'Ctrl+O', () => this.openDialog(true), { icon: 'open' });
    C('add', 'cmd.add', 'Ctrl+M', () => this.openDialog(false), { icon: 'add' });
    C('demo', 'cmd.demo', '', () => this.loadDemo(), { icon: 'model' });
    C('save', 'cmd.save', 'Ctrl+S', () => this.saveProject(), { icon: 'save', needsModel: true });
    C('closeAll', 'cmd.closeAll', '', () => this.closeAll());
    C('screenshot', 'cmd.screenshot', '', () => download(`OpenZoom_${stamp()}.png`, dataUrlToBlob(this.issues.snapshot())), { icon: 'camera' });
    C('exportBcf', 'cmd.exportBcf', '', () => this.exportBcf('2.1'), { icon: 'export' });
    C('importBcf', 'cmd.importBcf', '', () => this.importBcf(), { icon: 'import' });
    // View
    C('restore', 'cmd.restore', 'Ctrl+R', () => { this.state.restoreView(); this.smartViews.activeGuid = null; this.smartViewsPanel.render(); }, { icon: 'restore' });
    C('floorplans', 'cmd.floorplans', 'Alt+F', () => this.toggleFloorPlan(), { icon: 'floor', checked: () => !!this.floorPlanStorey, needsModel: true });
    for (const c of CATEGORIES) {
      C(`cat.${c.key}`, `cat.${c.key}`, `Alt+${c.accel}`, () => this.state.toggleCategory(c.key), { checked: () => this.state.categoryVisible(c.key), icon: c.key === 'spaces' ? 'space' : c.key === 'openings' ? 'opening' : undefined });
    }
    C('showAll', 'cmd.showAll', 'Alt+A', () => this.state.showAll(), { icon: 'eye' });
    C('hideAll', 'cmd.hideAll', 'Alt+H', () => this.state.hideAll(), { icon: 'eyeOff' });
    C('toggleSel', 'cmd.toggleSel', 'Space', () => this.state.toggle(sel()), { icon: 'eyeOff', ...S });
    C('hideSel', 'cmd.hideSel', '', () => this.state.hide(sel()), { icon: 'eyeOff', ...S });
    C('transparent', 'cmd.transparent', 'Ctrl+T,Shift+T', () => this.state.toggleTransparent(sel()), { icon: 'ghost', ...S });
    C('isolate', 'cmd.isolate', 'Shift+I', () => this.state.isolate(sel()), { icon: 'isolate', ...S });
    C('ghostOthers', 'cmd.ghostOthers', 'Shift+G', () => this.state.ghostOthers(sel()), { icon: 'ghost', ...S });
    C('undo', 'cmd.undo', 'Ctrl+Z', () => this.state.undo(), { icon: 'undo', enabled: () => this.state.undoStack.length > 0 });
    C('redo', 'cmd.redo', 'Ctrl+Y,Ctrl+Shift+Z', () => this.state.redo(), { icon: 'redo', enabled: () => this.state.redoStack.length > 0 });
    C('edges', 'cmd.edges', '', () => { this.settings.set('edges', !this.settings.get('edges')); this.applySettings(); }, { icon: 'edges', checked: () => this.settings.get('edges') !== false });
    C('legend', 'cmd.legend', '', () => { this.settings.set('legend', !this.settings.get('legend')); this.renderLegend(); }, { icon: 'legend', checked: () => this.settings.get('legend') !== false });
    C('selectAll', 'cmd.selectAll', 'Ctrl+A', () => this.state.select(this.state.visibleGids()));
    C('deselect', 'cmd.deselect', 'Escape', () => this.state.clearSelection());
    C('selectSameType', 'cmd.selectSameType', '', () => this.selectSame('typeName'), S);
    C('selectSameClass', 'cmd.selectSameClass', '', () => this.selectSame('cls'), S);
    C('copyGuid', 'cmd.copyGuid', '', () => this.copyText([...sel()].map((g) => this.models.element(g)?.guid).filter(Boolean).join('\n')), { icon: 'copy', ...S });
    C('properties', 'cmd.properties', '', () => this.showTab('navigation'), { icon: 'info' });
    // Navigate
    C('orbit', 'cmd.orbit', '', () => this.controls.setMode('orbit'), { icon: 'orbit', checked: () => this.controls.mode === 'orbit' });
    C('fly', 'cmd.fly', '', () => this.controls.setMode('fly'), { icon: 'fly', checked: () => this.controls.mode === 'fly' });
    C('fit', 'cmd.fit', 'Home', () => this.zoomToFit(), { icon: 'fit' });
    C('zoomSel', 'cmd.zoomSel', 'End', () => this.zoomToSelection(), { icon: 'zoomSel', ...S });
    C('perpendicular', 'cmd.perpendicular', 'Ctrl+=', () => this.lookPerpendicular());
    const views = [['front', '2'], ['back', '8'], ['left', '4'], ['right', '6'], ['top', '5'], ['bottom', '0'], ['iso', '1'], ['isoSE', '3'], ['isoNW', '7'], ['isoNE', '9']];
    for (const [v, k] of views) C(v, `cmd.${v}`, `Ctrl+${k}`, () => this.setView(v), { icon: v.startsWith('iso') ? 'iso' : 'cube', needsModel: true });
    C('perspective', 'cmd.perspective', '', () => this.controls.setProjection('perspective'), { icon: 'persp', checked: () => !this.controls.isOrtho });
    C('orthographic', 'cmd.orthographic', '', () => this.controls.setProjection('orthographic'), { icon: 'ortho', checked: () => this.controls.isOrtho });
    C('level', 'cmd.level', 'Ctrl+L', () => this.controls.levelCamera());
    // My view
    C('showMyView', 'cmd.showMyView', 'Alt+V', () => { if (!this.state.showMyView()) toast(t('msg.myViewEmpty')); }, { icon: 'myview' });
    C('setMyView', 'cmd.setMyView', 'Alt+=', () => this.state.setMyView([...sel()]));
    C('addMyView', 'cmd.addMyView', 'Alt++', () => this.state.addToMyView(sel()), S);
    C('removeMyView', 'cmd.removeMyView', 'Alt+-', () => this.state.removeFromMyView(sel()), S);
    C('clearMyView', 'cmd.clearMyView', 'Alt+*', () => this.state.clearMyView());
    // Validate / measure
    C('clashes', 'cmd.clashes', '', () => this.showTab('clashes'), { icon: 'clash' });
    C('newClash', 'cmd.newClash', '', () => { this.showTab('clashes'); this.clashesPanel.newTest(); }, { icon: 'plus' });
    const mm = (mode) => () => this.measure.setMode(this.measure.mode === mode ? null : mode);
    C('dimension', 'cmd.dimension', 'Ctrl+Alt+M', mm('dimension'), { icon: 'ruler', checked: () => this.measure.mode === 'dimension', needsModel: true });
    C('distance', 'cmd.distance', '', mm('distance'), { icon: 'distance', checked: () => this.measure.mode === 'distance', needsModel: true });
    C('angle', 'cmd.angle', '', mm('angle'), { icon: 'angle', checked: () => this.measure.mode === 'angle', needsModel: true });
    C('area', 'cmd.area', '', mm('area'), { icon: 'area', checked: () => this.measure.mode === 'area', needsModel: true });
    C('elevation', 'cmd.elevation', 'Ctrl+Alt+H', mm('elevation'), { icon: 'elevation', checked: () => this.measure.mode === 'elevation', needsModel: true });
    C('mindist', 'cmd.mindist', '', mm('mindist'), { icon: 'mindist', checked: () => this.measure.mode === 'mindist', needsModel: true });
    C('clearDims', 'cmd.clearDims', '', () => this.measure.clear(), { icon: 'trash' });
    // Sectioning
    C('sectionPlane', 'cmd.sectionPlane', 'Ctrl+Alt+P', () => this.sections.startCreatePlane(), { icon: 'plane', needsModel: true });
    C('sectionX', 'cmd.sectionX', '', () => this.sections.addAxisPlane('x'), { needsModel: true });
    C('sectionY', 'cmd.sectionY', '', () => this.sections.addAxisPlane('y'), { needsModel: true });
    C('sectionZ', 'cmd.sectionZ', '', () => this.sections.addAxisPlane('z'), { needsModel: true });
    C('sectionBox', 'cmd.sectionBox', 'Ctrl+B', () => this.createSectionBox(), { icon: 'box', needsModel: true, checked: () => !!this.sections.box });
    C('sectionBoxSel', 'cmd.sectionBoxSel', '', () => this.createSectionBox(true), { icon: 'box', ...S });
    C('deletePlane', 'cmd.deletePlane', 'Delete', () => this.sections.deleteSelected());
    C('deleteSections', 'cmd.deleteSections', 'Ctrl+Delete', () => { this.sections.deleteAll(); this.floorPlanStorey = null; }, { icon: 'trash' });
    C('suspend', 'cmd.suspend', 'Ctrl+P', () => this.sections.toggleSuspend(), { icon: 'pause', checked: () => this.sections.suspended });
    C('showPlanes', 'cmd.showPlanes', 'Alt+P', () => this.sections.toggleHelpers(), { checked: () => this.sections.helpersVisible });
    C('flipPlane', 'cmd.flipPlane', '', () => this.sections.flipSelected(), { icon: 'flip', enabled: () => !!this.sections.selected });
    // Extra
    C('search', 'cmd.search', 'Ctrl+F', () => openSearch(this), { icon: 'search' });
    C('issue', 'cmd.issue', 'Ctrl+I', () => this.createIssue(), { icon: 'issue' });
    const ann = [['annLine', 'line', 'L'], ['annArrow', 'arrow', 'A'], ['annEllipse', 'ellipse', 'E'], ['annCloud', 'cloud', 'C'], ['annRect', 'rect', 'R'], ['annText', 'text', 'T']];
    for (const [id, tool, k] of ann) C(id, `cmd.${id}`, `Ctrl+Alt+${k}`, () => this.annotations.setTool(this.annotations.tool === tool ? null : tool), { icon: 'annotate', checked: () => this.annotations.tool === tool, needsModel: true });
    C('annClear', 'cmd.annClear', '', () => this.annotations.clear(), { icon: 'trash' });
    C('settings', 'cmd.settings', '', () => openSettings(this), { icon: 'gear' });
    C('shortcuts', 'cmd.shortcuts', 'F1', () => openShortcuts(this));
    C('about', 'cmd.about', '', () => openAbout(this), { icon: 'info' });
  }

  // --- keyboard -----------------------------------------------------------------------
  onKeyDown(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
    if (document.querySelector('.modal-back')) return;
    if (this.measure.keyDown(e) || this.annotations.keyDown(e)) { e.preventDefault(); return; }
    const combo = comboOf(e);
    // context dependent keys first
    if (combo === 'Escape') {
      if (this.sections.creating) { this.sections.creating = false; this.status(''); return; }
      if (this.measure.active) { this.measure.setMode(null); this.toolbar.refresh(); return; }
      if (this.controls.mode === 'fly') { this.controls.setMode('orbit'); return; }
    }
    if (combo === 'Space' && this.sections.toggleSelectedHelper()) { e.preventDefault(); return; }
    if (combo === 'Delete' || combo === 'Backspace') {
      if (this.measure.deleteSelected() || this.annotations.deleteSelected() || this.sections.deleteSelected()) { e.preventDefault(); return; }
      if (combo === 'Delete' && this.state.selection.size) { this.state.hide(this.state.selection); return; }
    }
    if (combo === 'Ctrl+A' && this.sections.selected) { e.preventDefault(); return; }
    if (combo === 'Tab' || combo === 'Shift+Tab') { e.preventDefault(); this.properties.cycle(combo === 'Tab' ? 1 : -1); return; }
    if (combo === 'Ctrl+C') { if (this.properties.copySelected()) { e.preventDefault(); } else if (this.state.selection.size) { e.preventDefault(); this.run('copyGuid'); } return; }
    if (combo === 'Ctrl+V') {
      e.preventDefault();
      navigator.clipboard?.readText().then((txt) => openSearch(this, txt)).catch(() => openSearch(this));
      return;
    }
    if (combo === 'Ctrl+Delete' && this.tree.selectedModel) {
      e.preventDefault();
      this.removeModel(this.tree.selectedModel);
      return;
    }
    for (const c of this.commands.values()) {
      if (!c.shortcut) continue;
      if (c.shortcut.split(',').some((s) => s === combo)) {
        e.preventDefault();
        e.stopPropagation();
        this.run(c.id);
        return;
      }
    }
    if (this.controls.keyDown(e)) e.preventDefault();
  }

  // --- files --------------------------------------------------------------------------
  async openDialog(replace) {
    const files = await pickFiles('.ifc,.ifczip,.ozp,.bcsv,.bcfzip,.bcf', true);
    if (files.length) this.openFiles(files, replace);
  }

  async openFiles(files, replace) {
    const ifcs = [];
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (n.endsWith('.ozp')) { await this.loadProject(f); return; }
      if (n.endsWith('.bcsv')) { this.smartViewsPanel.importFile(f); continue; }
      if (n.endsWith('.bcfzip') || n.endsWith('.bcf')) { await this.importBcfFile(f); continue; }
      if (n.endsWith('.ifczip')) {
        const z = unzipSync(new Uint8Array(await f.arrayBuffer()));
        for (const [name, data] of Object.entries(z)) if (name.toLowerCase().endsWith('.ifc')) ifcs.push(new File([data], name.split('/').pop()));
        continue;
      }
      ifcs.push(f);
    }
    if (!ifcs.length) return;
    if (replace && this.models.models.length) this.clearModels();
    const first = !this.models.models.length;
    for (const f of ifcs) await this.loadModel(f);
    if (first) this.setView('iso', false);
  }

  async loadModel(file) {
    const name = file.name;
    this.showProgress(t('status.loading', { name }), 0);
    try {
      const model = await this.models.load(file, (phase, v) => this.showProgress(`${t('status.loading', { name })} – ${t(`status.${phase}`)}`, v));
      this.viewer.applyClipping();
      this.dirty = true;
      return model;
    } catch (err) {
      console.error(err);
      toast(t('err.load', { name, msg: err.message }), 6000);
      return null;
    } finally {
      this.hideProgress();
    }
  }

  async loadDemo() {
    if (this.models.models.length) this.clearModels();
    const base = new URL('demo/', document.baseURI);
    for (const name of ['Demo_Architektur.ifc', 'Demo_HLS.ifc']) {
      this.showProgress(t('status.loading', { name }), 0);
      const res = await fetch(new URL(name, base));
      const buf = await res.arrayBuffer();
      await this.loadModel(new File([buf], name));
    }
    this.setView('iso', false);
    this.dirty = false;
  }

  showProgress(label, v) {
    this.progressEl.classList.add('show');
    this.progressEl.querySelector('.progress-label').textContent = label;
    this.progressEl.querySelector('.progress-fill').style.width = `${Math.round((v || 0) * 100)}%`;
  }

  hideProgress() { this.progressEl.classList.remove('show'); }

  clearModels() {
    for (const m of [...this.models.models]) this.models.remove(m);
    this.state.selection.clear();
    this.state.undoStack.length = 0;
    this.state.redoStack.length = 0;
    this.state.legend = null;
    this.sections.deleteAll();
    this.measure.clear();
    this.annotations.clear();
    this.floorPlanStorey = null;
    this.state.syncSelection();
    this.renderLegend();
  }

  async closeAll() {
    if (!this.models.models.length) return;
    if (await confirmDialog(t('cmd.closeAll'), t('msg.closeProject'))) this.clearModels();
  }

  async removeModel(model) {
    if (await confirmDialog(t('cmd.remove'), t('msg.removeModel', { name: model.name }))) {
      for (const gid of [...this.state.selection]) if (this.models.modelOf(gid) === model) this.state.selection.delete(gid);
      this.models.remove(model);
      this.state.syncSelection();
    }
  }

  /** Project file (.ozp): zip with the IFC files and project.json (views, issues, clashes, ...). */
  saveProject() {
    const M = this.models;
    const files = {};
    const guidsOf = (set) => [...set].map((g) => M.element(g)?.guid).filter(Boolean);
    const project = {
      format: 'openzoom-project', version: 1, saved: new Date().toISOString(),
      models: M.models.map((m) => ({ name: m.name, visible: m.visible })),
      smartViews: this.smartViews.local,
      clashTests: this.clashes.tests,
      issues: this.issues.issues,
      myView: guidsOf(this.state.myView),
      viewpoint: this.issues.captureViewpoint(),
    };
    project.viewpoint.snapshot = null;
    files['project.json'] = strToU8(JSON.stringify(project));
    for (const m of M.models) files[`models/${m.name}`] = [m.source, { level: 6 }];
    const zip = zipSync(files);
    const name = (M.models[0]?.project?.name || 'Projekt').replace(/[^\w\-äöüÄÖÜß ]+/g, '_');
    download(`${name}.ozp`, zip, 'application/zip');
    this.dirty = false;
    toast(t('msg.saved'));
  }

  async loadProject(file) {
    const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const project = JSON.parse(strFromU8(z['project.json']));
    this.clearModels();
    for (const m of project.models || []) {
      const data = z[`models/${m.name}`];
      if (!data) continue;
      const model = await this.loadModel(new File([data], m.name));
      if (model && m.visible === false) { model.visible = false; model.group.visible = false; }
    }
    if (project.smartViews) this.smartViews.importSets(project.smartViews);
    if (project.clashTests) { this.clashes.tests = project.clashTests; this.clashes.changed(); }
    if (project.issues) { this.issues.issues = project.issues; this.issues.changed(); }
    if (project.myView) {
      const s = new Set();
      for (const g of project.myView) { const gid = this.models.findByGuid(g); if (gid >= 0) s.add(gid); }
      this.state.myView = s;
    }
    if (project.viewpoint) this.issues.showViewpoint(project.viewpoint);
    this.dirty = false;
  }

  async exportBcf(version) {
    if (!this.issues.issues.length) { toast(t('issue.none')); return; }
    download(`Issues_${stamp()}.bcf`, this.issues.exportBcf(version), 'application/zip');
  }

  async importBcf() {
    const files = await pickFiles('.bcf,.bcfzip', true);
    for (const f of files) await this.importBcfFile(f);
  }

  async importBcfFile(f) {
    try {
      const n = await this.issues.importBcf(f);
      toast(t('issue.imported', { n }));
      this.showTab('issues');
    } catch (err) {
      toast(`BCF: ${err.message}`, 5000);
    }
  }

  createIssue(fields) {
    if (!this.models.models.length) { toast(t('err.noModels')); return null; }
    const issue = this.issues.create(fields);
    this.showTab('issues');
    this.issuesPanel.select(issue, false);
    return issue;
  }

  // --- views --------------------------------------------------------------------------
  zoomToFit(animate = true) {
    const box = this.models.visibleBox();
    if (box.isEmpty()) return;
    this.controls.fitBox(box, null, animate);
  }

  zoomToSelection() {
    const gids = this.state.selectedGeometry();
    const box = this.models.boxOf(gids);
    if (box.isEmpty()) return;
    this.controls.fitBox(box, null, true);
  }

  setView(name, animate = true) {
    const dirs = {
      front: [0, 0, -1], back: [0, 0, 1], left: [1, 0, 0], right: [-1, 0, 0], top: [0, -1, 0], bottom: [0, 1, 0],
      iso: [1, -1, -1], isoSE: [-1, -1, -1], isoNW: [1, -1, 1], isoNE: [-1, -1, 1],
    };
    const d = new THREE.Vector3(...dirs[name]).normalize();
    if (name.startsWith('iso')) this.controls.setProjection('orthographic');
    const box = this.state.selection.size ? this.models.boxOf(this.state.selectedGeometry()) : this.models.visibleBox();
    const up = name === 'top' ? new THREE.Vector3(0, 0, -1) : name === 'bottom' ? new THREE.Vector3(0, 0, 1) : undefined;
    this.controls.fitBox(box.isEmpty() ? this.models.visibleBox() : box, d, animate, up);
  }

  lookPerpendicular() {
    const c = this.controls;
    const target = c.target.clone();
    let dir;
    if (this.sections.selected) dir = this.sections.selected.plane.normal.clone();
    else {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.viewer.camera.quaternion);
      const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((a) => new THREE.Vector3(...a));
      dir = axes.reduce((best, a) => (a.dot(fwd) > best.dot(fwd) ? a : best));
    }
    const dist = this.viewer.camera.position.distanceTo(target);
    const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : undefined;
    c.flyTo(target.clone().addScaledVector(dir, -dist), target, true, up);
  }

  createSectionBox(fromSelection) {
    if (this.sections.box && !fromSelection) { this.sections.removeBox(); return; }
    const gids = this.state.selectedGeometry();
    const box = gids.length ? this.models.boxOf(gids) : this.models.visibleBox();
    this.sections.createBox(box);
  }

  /** Alt+F: floor plan of a storey = horizontal cut + top orthographic view. */
  async toggleFloorPlan() {
    if (this.floorPlanStorey) {
      this.sections.clearFloorPlan();
      this.floorPlanStorey = null;
      this.toolbar.refresh();
      return;
    }
    let storey = null;
    for (const gid of this.state.selection) {
      const m = this.models.modelOf(gid);
      const el = m?.elements[gid - m.base];
      if (el?.cls === 'IfcBuildingStorey') storey = { m, el };
      else if (el && el.storey !== undefined) storey = { m, el: m.elements[el.storey] };
      if (storey) break;
    }
    if (!storey) storey = await chooseStorey(this);
    if (!storey) return;
    this.enterFloorPlan(storey.el);
  }

  enterFloorPlan(storeyEl) {
    const z = storeyEl.placementZ ?? storeyEl.elevation ?? 0;
    const y = z - (this.models.offset?.[1] || 0) + Number(this.settings.get('cutHeight') || 1.2);
    this.sections.setFloorPlan(y);
    this.floorPlanStorey = storeyEl;
    this.controls.setProjection('orthographic');
    this.controls.fitBox(this.models.visibleBox(), new THREE.Vector3(0, -1, 0), true, new THREE.Vector3(0, 0, -1));
    this.status(`${t('cmd.floorplans')}: ${storeyEl.name}`);
    this.toolbar.refresh();
  }

  storeys() {
    const out = [];
    for (const m of this.models.models) m.elements.forEach((el) => { if (el.cls === 'IfcBuildingStorey') out.push({ m, el }); });
    out.sort((a, b) => (a.el.placementZ ?? a.el.elevation ?? 0) - (b.el.placementZ ?? b.el.elevation ?? 0));
    return out;
  }

  selectSame(field) {
    const vals = new Set([...this.state.selection].map((g) => this.models.element(g)?.[field]).filter(Boolean));
    this.state.select(this.models.allGids((m, i, el) => m.hasGeom[i] && vals.has(el[field])));
  }

  copyText(text) {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => toast(t('msg.copied'))).catch(() => {});
  }

  /** Apply a smart view by guid (from the panel or a project). */
  applySmartView(view) {
    if (!this.models.models.length) return;
    const res = evaluate(view, this.models.models, this.state.skipChild);
    applyResult(this, res);
    this.smartViews.activeGuid = view.guid;
    this.legendTitle = view.title;
    this.renderLegend();
  }

  renderLegend() {
    const el = this.legendEl;
    el.innerHTML = '';
    const legend = this.state.legend;
    if (!legend || !legend.length || this.settings.get('legend') === false) { el.classList.remove('show'); return; }
    el.classList.add('show');
    el.appendChild(h('div.legend-title', this.legendTitle || t('sv.legend')));
    const list = h('div.legend-list');
    for (const entry of legend.slice(0, 60)) {
      const row = h('div.legend-row', { title: entry.label },
        h('span.swatch', { style: { background: `rgb(${entry.color.join(',')})` } }),
        h('span.legend-label', entry.label),
        h('span.legend-count', String(entry.count)),
        entry.takeoff !== null && entry.takeoff !== undefined ? h('span.legend-takeoff', this.fmtNum(entry.takeoff, 2)) : null);
      if (entry.items) row.addEventListener('click', (ev) => this.state.select(entry.items.map(([w, i]) => w.model.base + i), ev.ctrlKey ? 'add' : 'replace'));
      list.appendChild(row);
    }
    if (legend.length > 60) list.appendChild(h('div.muted', `… ${legend.length - 60}`));
    el.appendChild(list);
  }

  drawAxes() {
    const c = this.axesEl;
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const q = this.viewer.camera.quaternion.clone().invert();
    const axes = [['X', new THREE.Vector3(1, 0, 0), '#e04040'], ['Y', new THREE.Vector3(0, 0, -1), '#40b040'], ['Z', new THREE.Vector3(0, 1, 0), '#4070e0']];
    const cx = 45, cy = 45, r = 30;
    const items = axes.map(([n, v, col]) => ({ n, v: v.clone().applyQuaternion(q), col }));
    items.sort((a, b) => a.v.z - b.v.z);
    for (const { n, v, col } of items) {
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + v.x * r, cy - v.y * r); g.stroke();
      g.font = 'bold 12px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(n, cx + v.x * (r + 9), cy - v.y * (r + 9));
    }
  }
}

function comboOf(e) {
  let key;
  const c = e.code || '';
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^Numpad\d$/.test(c)) key = c.slice(6);
  else if (c === 'NumpadAdd') key = '+';
  else if (c === 'NumpadSubtract') key = '-';
  else if (c === 'NumpadMultiply') key = '*';
  else if (c === 'Space') key = 'Space';
  else if (['=', '+', '-', '*'].includes(e.key)) key = e.key;
  else if (c === 'Equal') key = '=';
  else if (c === 'Minus') key = '-';
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const symbol = ['=', '+', '-', '*'].includes(key);
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && !symbol) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export function dataUrlToBlob(url) {
  const [head, data] = url.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
