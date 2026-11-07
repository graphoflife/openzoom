import { CATEGORIES } from './ifc-classes.js';

const isOpening = (el) => el.supers.includes('IfcOpeningElement');

/**
 * Element visibility / transparency / color with undo-redo history,
 * "My View" and the selection. All element references are global ids (gid).
 */
export class ElementState extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.undoStack = [];
    this.redoStack = [];
    this.myView = new Set();
    this.selection = new Set();
    this.hoverGid = -1;
    this.legend = null; // smart view legend [{color, label, count}]
    // global view settings like Zoom's Alt+S / Alt+O: spaces and openings only show when switched on
    this.showSpaces = false;
    this.showOpenings = false;
    this.skipChild = (el) => (!this.showSpaces && el.cls === 'IfcSpace') || (!this.showOpenings && isOpening(el));
  }

  get models() { return this.app.models.models; }

  // --- history -------------------------------------------------------------
  snapshot() {
    return this.models.map((m) => ({ m, flags: m.flags.slice(), colors: m.colors.slice(), legend: this.legend }));
  }

  /** Call before every user-visible change of visibility/colour. */
  record() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  restore(snap) {
    for (const s of snap) {
      if (!this.models.includes(s.m)) continue;
      // keep selection/hover channels
      const f = s.m.flags;
      for (let i = 0; i < f.length; i += 4) { f[i] = s.flags[i]; f[i + 1] = s.flags[i + 1]; }
      s.m.colors.set(s.colors);
      s.m.touch();
      this.legend = s.legend;
    }
    this.changed();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  changed() {
    for (const m of this.models) m.touch();
    this.dispatchEvent(new Event('change'));
    this.app.viewer.requestRender();
  }

  // --- low level -------------------------------------------------------------
  each(gids, fn) {
    for (const gid of this.app.models.expand(gids)) {
      const m = this.app.models.modelOf(gid);
      if (m) fn(m, gid - m.base);
    }
  }

  setVisible(gids, v) { this.each(gids, (m, i) => { m.flags[i * 4] = v ? 255 : 0; }); }
  setGhost(gids, v) { this.each(gids, (m, i) => { m.flags[i * 4 + 1] = v ? 255 : 0; }); }
  setColor(gids, rgb) {
    this.each(gids, (m, i) => {
      const c = m.colors;
      if (rgb) { c[i * 4] = rgb[0]; c[i * 4 + 1] = rgb[1]; c[i * 4 + 2] = rgb[2]; c[i * 4 + 3] = 255; }
      else c[i * 4 + 3] = 0;
    });
  }

  isVisible(gid) {
    const m = this.app.models.modelOf(gid);
    return m ? m.isVisible(gid - m.base) : false;
  }

  // --- commands --------------------------------------------------------------
  hide(gids) { this.record(); this.setVisible(gids, false); this.changed(); }
  show(gids) { this.record(); this.setVisible(gids, true); this.changed(); }

  /** Spacebar: toggle visibility of the selected elements. */
  toggle(gids) {
    const list = [...gids];
    if (!list.length) return;
    const anyVisible = list.some((g) => this.isVisible(g));
    this.record();
    this.setVisible(list, !anyVisible);
    this.changed();
  }

  isolate(gids) {
    const keep = this.app.models.expand(gids);
    if (!keep.size) return;
    this.record();
    for (const m of this.models) for (let i = 0; i < m.count; i++) if (!keep.has(m.base + i)) m.flags[i * 4] = 0;
    this.setVisible([...keep], true);
    this.changed();
  }

  /** Ctrl+T: toggle transparency of the given elements. */
  toggleTransparent(gids) {
    const list = [...gids];
    if (!list.length) return;
    let anyOpaque = false;
    this.each(list, (m, i) => { if (!m.flags[i * 4 + 1]) anyOpaque = true; });
    this.record();
    this.setGhost(list, anyOpaque);
    this.changed();
  }

  ghostOthers(gids) {
    const keep = this.app.models.expand(gids);
    this.record();
    for (const m of this.models) for (let i = 0; i < m.count; i++) m.flags[i * 4 + 1] = keep.has(m.base + i) ? 0 : 255;
    this.changed();
  }

  colorize(gids, rgb) { this.record(); this.setColor(gids, rgb); this.changed(); }

  showAll() {
    this.record();
    for (const m of this.models) for (let i = 0; i < m.count; i++) {
      if (!this.skipChild(m.elements[i])) m.flags[i * 4] = 255;
    }
    this.changed();
  }

  hideAll() {
    this.record();
    for (const m of this.models) for (let i = 0; i < m.count; i++) m.flags[i * 4] = 0;
    this.changed();
  }

  /** Ctrl+R: back to the initial view state (default visibility, no colours). */
  restoreView() {
    this.record();
    for (const m of this.models) m.resetState();
    this.showSpaces = false;
    this.showOpenings = false;
    this.legend = null;
    this.changed();
  }

  /** Alt+<key>: toggle a component category. */
  toggleCategory(key) {
    const cat = CATEGORIES.find((c) => c.key === key);
    if (!cat) return;
    const gids = [];
    let anyVisible = false;
    for (const m of this.models) for (let i = 0; i < m.count; i++) {
      if (m.elements[i].category !== key || !m.hasGeom[i]) continue;
      gids.push(m.base + i);
      if (m.isVisible(i)) anyVisible = true;
    }
    if (!gids.length) return false;
    if (key === 'spaces') this.showSpaces = !anyVisible;
    if (key === 'openings') this.showOpenings = !anyVisible;
    this.record();
    for (const gid of gids) {
      const m = this.app.models.modelOf(gid);
      m.flags[(gid - m.base) * 4] = anyVisible ? 0 : 255;
    }
    this.changed();
    return !anyVisible;
  }

  categoryVisible(key) {
    for (const m of this.models) for (let i = 0; i < m.count; i++) {
      if (m.elements[i].category === key && m.hasGeom[i] && m.isVisible(i)) return true;
    }
    return false;
  }

  visibleGids() {
    const out = [];
    for (const m of this.models) for (let i = 0; i < m.count; i++) if (m.hasGeom[i] && m.isVisible(i)) out.push(m.base + i);
    return out;
  }

  // --- My View -----------------------------------------------------------------
  setMyView(gids) { this.myView = new Set(this.app.models.expand(gids.length ? gids : this.visibleGids())); this.emitMyView(); }
  addToMyView(gids) { for (const g of this.app.models.expand(gids)) this.myView.add(g); this.emitMyView(); }
  removeFromMyView(gids) { for (const g of this.app.models.expand(gids)) this.myView.delete(g); this.emitMyView(); }
  clearMyView() { this.myView.clear(); this.emitMyView(); }
  showMyView() {
    if (!this.myView.size) return false;
    this.record();
    for (const m of this.models) for (let i = 0; i < m.count; i++) m.flags[i * 4] = this.myView.has(m.base + i) ? 255 : 0;
    this.changed();
    return true;
  }
  emitMyView() { this.dispatchEvent(new Event('myview')); }

  // --- Selection ---------------------------------------------------------------
  /** mode: 'replace' | 'add' | 'toggle' | 'remove' */
  select(gids, mode = 'replace') {
    const list = [...gids];
    if (mode === 'replace') this.selection = new Set(list);
    else if (mode === 'add') for (const g of list) this.selection.add(g);
    else if (mode === 'remove') for (const g of list) this.selection.delete(g);
    else if (mode === 'toggle') for (const g of list) this.selection.has(g) ? this.selection.delete(g) : this.selection.add(g);
    this.syncSelection();
  }

  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.syncSelection();
  }

  syncSelection() {
    for (const m of this.models) for (let i = 0; i < m.count; i++) m.flags[i * 4 + 2] = 0;
    this.each([...this.selection], (m, i) => { m.flags[i * 4 + 2] = 255; });
    for (const m of this.models) m.touch();
    this.dispatchEvent(new Event('selection'));
    this.app.viewer.requestRender();
  }

  /** Selected gids including descendants that have geometry. */
  selectedGeometry() {
    const out = [];
    for (const gid of this.app.models.expand([...this.selection])) {
      const m = this.app.models.modelOf(gid);
      if (m && m.hasGeom[gid - m.base]) out.push(gid);
    }
    return out;
  }

  setHover(gid) {
    if (gid === this.hoverGid) return;
    const prev = this.app.models.modelOf(this.hoverGid);
    if (prev) { prev.flags[(this.hoverGid - prev.base) * 4 + 3] = 0; prev.flagTex.needsUpdate = true; }
    this.hoverGid = gid;
    const m = this.app.models.modelOf(gid);
    if (m) { m.flags[(gid - m.base) * 4 + 3] = 255; m.flagTex.needsUpdate = true; }
    this.app.viewer.requestRender();
  }
}
