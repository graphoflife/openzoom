import { t } from '../i18n.js';
import { CATEGORIES } from '../core/ifc-classes.js';
import { toast, download, stamp, dataUrlToBlob } from './dom.js';
import { openSearch, openSettings, openShortcuts, openAbout } from './dialogs.js';

/**
 * Every command: menus, toolbar, context menus, shortcuts and the F1 list come from here.
 * A command with `enabled` is greyed out in menus while disabled. Several commands may share
 * a key: an enabled one with `enabled` wins over one without (Delete removes the selected
 * dimension, markup or plane, else hides the selected elements).
 */
export function registerCommands(app) {
  const C = app.cmd.bind(app);
  const sel = () => app.state.selection;
  const S = { needsSelection: true };
  // File
  C('open', 'cmd.open', 'Ctrl+O', () => app.openDialog(true), { icon: 'open' });
  C('add', 'cmd.add', 'Ctrl+M', () => app.openDialog(false), { icon: 'add' });
  C('demo', 'cmd.demo', '', () => app.loadDemo(), { icon: 'model' });
  C('save', 'cmd.save', 'Ctrl+S', () => app.saveProject(), { icon: 'save', needsModel: true });
  C('closeAll', 'cmd.closeAll', '', () => app.closeAll());
  C('screenshot', 'cmd.screenshot', '', () => download(`OpenZoom_${stamp()}.png`, dataUrlToBlob(app.issues.snapshot())), { icon: 'camera' });
  C('exportBcf', 'cmd.exportBcf', '', () => app.exportBcf('2.1'), { icon: 'export' });
  C('importBcf', 'cmd.importBcf', '', () => app.importBcf(), { icon: 'import' });
  // View
  C('restore', 'cmd.restore', 'Ctrl+R', () => { app.state.restoreView(); app.smartViews.activeGuid = null; app.smartViewsPanel.render(); }, { icon: 'restore' });
  C('floorplans', 'cmd.floorplans', 'Alt+F', () => app.toggleFloorPlan(), { icon: 'floor', checked: () => !!app.sections.floorPlan, needsModel: true });
  for (const c of CATEGORIES) {
    C(`cat.${c.key}`, `cat.${c.key}`, `Alt+${c.accel}`, () => app.state.toggleCategory(c.key), { checked: () => app.state.categoryVisible(c.key), icon: c.key === 'spaces' ? 'space' : c.key === 'openings' ? 'opening' : undefined });
  }
  C('showAll', 'cmd.showAll', 'Alt+A', () => app.state.showAll(), { icon: 'eye' });
  C('hideAll', 'cmd.hideAll', 'Alt+H', () => app.state.hideAll(), { icon: 'eyeOff' });
  C('toggleSel', 'cmd.toggleSel', 'Space', () => app.state.toggle(sel()), { icon: 'eyeOff', ...S });
  C('hideSel', 'cmd.hideSel', 'Delete', () => app.state.hide(sel()), { icon: 'eyeOff', ...S });
  C('transparent', 'cmd.transparent', 'Ctrl+T,Shift+T', () => app.state.toggleTransparent(sel()), { icon: 'ghost', ...S });
  C('isolate', 'cmd.isolate', 'Shift+I', () => app.state.isolate(sel()), { icon: 'isolate', ...S });
  C('ghostOthers', 'cmd.ghostOthers', 'Shift+G', () => app.state.ghostOthers(sel()), { icon: 'ghost', ...S });
  C('undo', 'cmd.undo', 'Ctrl+Z', () => app.state.undo(), { icon: 'undo', enabled: () => app.state.undoStack.length > 0 });
  C('redo', 'cmd.redo', 'Ctrl+Y,Ctrl+Shift+Z', () => app.state.redo(), { icon: 'redo', enabled: () => app.state.redoStack.length > 0 });
  C('edges', 'cmd.edges', '', () => { app.settings.set('edges', !app.settings.get('edges')); app.applySettings(); }, { icon: 'edges', checked: () => app.settings.get('edges') !== false });
  C('legend', 'cmd.legend', '', () => { app.settings.set('legend', !app.settings.get('legend')); app.legend.render(); }, { icon: 'legend', checked: () => app.settings.get('legend') !== false });
  C('selectAll', 'cmd.selectAll', 'Ctrl+A', () => app.state.select(app.state.visibleGids()));
  C('deselect', 'cmd.deselect', 'Escape', () => app.state.clearSelection());
  C('selectSameType', 'cmd.selectSameType', '', () => app.selectSame('typeName'), S);
  C('selectSameClass', 'cmd.selectSameClass', '', () => app.selectSame('cls'), S);
  C('copyGuid', 'cmd.copyGuid', 'Ctrl+C', () => app.copyText([...sel()].map((g) => app.models.element(g)?.guid).filter(Boolean).join('\n')), { icon: 'copy', ...S });
  C('properties', 'cmd.properties', '', () => app.showTab('navigation'), { icon: 'info' });
  // Navigate
  C('orbit', 'cmd.orbit', '', () => app.controls.setMode('orbit'), { icon: 'orbit', checked: () => app.controls.mode === 'orbit' });
  C('fly', 'cmd.fly', '', () => app.controls.setMode('fly'), { icon: 'fly', checked: () => app.controls.mode === 'fly' });
  C('fit', 'cmd.fit', 'Home', () => app.zoomToFit(), { icon: 'fit' });
  C('zoomSel', 'cmd.zoomSel', 'End', () => app.zoomToSelection(), { icon: 'zoomSel', ...S });
  C('perpendicular', 'cmd.perpendicular', 'Ctrl+=', () => app.lookPerpendicular());
  const views = [['front', '2'], ['back', '8'], ['left', '4'], ['right', '6'], ['top', '5'], ['bottom', '0'], ['iso', '1'], ['isoSE', '3'], ['isoNW', '7'], ['isoNE', '9']];
  for (const [v, k] of views) C(v, `cmd.${v}`, `Ctrl+${k}`, () => app.setView(v), { icon: v.startsWith('iso') ? 'iso' : 'cube', needsModel: true });
  C('perspective', 'cmd.perspective', '', () => app.controls.setProjection('perspective'), { icon: 'persp', checked: () => !app.controls.isOrtho });
  C('orthographic', 'cmd.orthographic', '', () => app.controls.setProjection('orthographic'), { icon: 'ortho', checked: () => app.controls.isOrtho });
  C('level', 'cmd.level', 'Ctrl+L', () => app.controls.levelCamera());
  // My view
  C('showMyView', 'cmd.showMyView', 'Alt+V', () => { if (!app.state.showMyView()) toast(t('msg.myViewEmpty')); }, { icon: 'myview' });
  C('setMyView', 'cmd.setMyView', 'Alt+=', () => app.state.setMyView([...sel()]));
  C('addMyView', 'cmd.addMyView', 'Alt++', () => app.state.addToMyView(sel()), S);
  C('removeMyView', 'cmd.removeMyView', 'Alt+-', () => app.state.removeFromMyView(sel()), S);
  C('clearMyView', 'cmd.clearMyView', 'Alt+*', () => app.state.clearMyView());
  // Validate / measure
  C('clashes', 'cmd.clashes', '', () => app.showTab('clashes'), { icon: 'clash' });
  C('newClash', 'cmd.newClash', '', () => { app.showTab('clashes'); app.clashesPanel.newTest(); }, { icon: 'plus' });
  // tool commands toggle their tool and are checked while it is active
  const T = (id, key, make, icon) => C(id, `cmd.${id}`, key, () => app.toggleTool(make()), { icon, needsModel: true, checked: () => app.tool?.id === make().id });
  const measure = [['dimension', 'Ctrl+Alt+M', 'ruler'], ['distance', '', 'distance'], ['angle', '', 'angle'], ['area', '', 'area'], ['elevation', 'Ctrl+Alt+H', 'elevation'], ['mindist', '', 'mindist']];
  for (const [mode, key, icon] of measure) T(mode, key, () => app.measure.tool(mode), icon);
  C('clearDims', 'cmd.clearDims', '', () => app.measure.clear(), { icon: 'trash' });
  // Sectioning
  T('sectionPlane', 'Ctrl+Alt+P', () => app.sections.planeTool, 'plane');
  C('sectionX', 'cmd.sectionX', '', () => app.sections.addAxisPlane('x'), { needsModel: true });
  C('sectionY', 'cmd.sectionY', '', () => app.sections.addAxisPlane('y'), { needsModel: true });
  C('sectionZ', 'cmd.sectionZ', '', () => app.sections.addAxisPlane('z'), { needsModel: true });
  C('sectionBox', 'cmd.sectionBox', 'Ctrl+B', () => app.createSectionBox(), { icon: 'box', needsModel: true, checked: () => !!app.sections.box });
  C('sectionBoxSel', 'cmd.sectionBoxSel', '', () => app.createSectionBox(true), { icon: 'box', ...S });
  C('deletePlane', 'cmd.deletePlane', 'Delete,Backspace', () => app.sections.deleteSelected(), { enabled: () => !!app.sections.selected });
  C('deleteSections', 'cmd.deleteSections', 'Ctrl+Delete', () => app.sections.deleteAll(), { icon: 'trash' });
  C('suspend', 'cmd.suspend', 'Ctrl+P', () => app.sections.toggleSuspend(), { icon: 'pause', checked: () => app.sections.suspended });
  C('showPlanes', 'cmd.showPlanes', 'Alt+P', () => app.sections.toggleHelpers(), { checked: () => app.sections.helpersVisible });
  C('flipPlane', 'cmd.flipPlane', '', () => app.sections.flipSelected(), { icon: 'flip', enabled: () => !!app.sections.selected });
  // Extra
  C('search', 'cmd.search', 'Ctrl+F', () => openSearch(app), { icon: 'search' });
  C('issue', 'cmd.issue', 'Ctrl+I', () => app.createIssue(), { icon: 'issue' });
  const ann = [['annLine', 'line', 'L'], ['annArrow', 'arrow', 'A'], ['annEllipse', 'ellipse', 'E'], ['annCloud', 'cloud', 'C'], ['annRect', 'rect', 'R'], ['annText', 'text', 'T']];
  for (const [id, kind, k] of ann) T(id, `Ctrl+Alt+${k}`, () => app.annotations.tool(kind), 'annotate');
  C('annClear', 'cmd.annClear', '', () => app.annotations.clear(), { icon: 'trash' });
  // Keys whose meaning depends on what is active or selected
  C('endTool', 'cmd.endTool', 'Escape', () => app.setTool(null), { enabled: () => !!app.tool });
  C('endFly', 'cmd.endFly', 'Escape', () => app.controls.setMode('orbit'), { enabled: () => app.controls.mode === 'fly' });
  C('togglePlane', 'cmd.togglePlane', 'Space', () => app.sections.toggleSelectedHelper(), { enabled: () => !!app.sections.selected });
  C('deleteDim', 'cmd.deleteDim', 'Delete,Backspace', () => app.measure.deleteSelected(), { enabled: () => !!app.measure.selected });
  C('deleteMarkup', 'cmd.deleteMarkup', 'Delete,Backspace', () => app.annotations.deleteSelected(), { enabled: () => !!app.annotations.selected });
  C('copyValue', 'cmd.copyValue', 'Ctrl+C', () => app.properties.copySelected(), { enabled: () => !!app.properties.selectedRow });
  C('nextPset', 'cmd.nextPset', 'Tab', () => app.properties.cycle(1));
  C('prevPset', 'cmd.prevPset', 'Shift+Tab', () => app.properties.cycle(-1));
  C('pasteSearch', 'cmd.pasteSearch', 'Ctrl+V', () => navigator.clipboard?.readText().then((txt) => openSearch(app, txt)).catch(() => openSearch(app)));
  C('settings', 'cmd.settings', '', () => openSettings(app), { icon: 'gear' });
  C('shortcuts', 'cmd.shortcuts', 'F1', () => openShortcuts(app));
  C('about', 'cmd.about', '', () => openAbout(app), { icon: 'info' });
}
