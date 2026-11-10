import { CATEGORIES, isGated, isAuxiliary } from './ifc-classes.js';
import { packRgb } from './models.js';

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * A complete element view for `ElementState.applyView`: per model visibility,
 * transparency and packed colour (-1 = none). Smart views, BCF viewpoints and
 * the clash focus produce one instead of writing element state themselves.
 */
export function blankView(models) {
  return models.map((model) => ({ model, vis: new Uint8Array(model.count), ghost: new Uint8Array(model.count), color: new Int32Array(model.count).fill(-1) }));
}

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
    this.legend = null; // {title, entries: [{color, label, count, gids, takeoff?}]}
    // gated categories switched on with their Alt toggle (Alt+S spaces, Alt+O openings)
    this.revealed = new Set();
    this.skipChild = (el) => isGated(el) && !this.revealed.has(el.category);
  }

  get models() { return this.app.models.models; }

  // --- history -------------------------------------------------------------
  snapshot() {
    return { legend: this.legend, revealed: [...this.revealed], models: this.models.map((m) => ({ m, ...m.packState() })) };
  }

  /** Call before every user-visible change of visibility/colour. */
  record() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  restore(snap) {
    // selection/hover channels stay as they are
    for (const s of snap.models) if (this.models.includes(s.m)) s.m.unpackState(s);
    this.legend = snap.legend;
    this.revealed = new Set(snap.revealed);
    this.changed();
  }

  /** Drop every reference to a removed model (history, My View). Legend gids of it simply match nothing. */
  forgetModel(model) {
    for (const stack of [this.undoStack, this.redoStack]) for (const s of stack) s.models = s.models.filter((x) => x.m !== model);
    for (const gid of [...this.myView]) if (gid >= model.base && gid < model.base + model.count) this.myView.delete(gid);
  }

  /** Visibility, transparency and colours of a model for the project file. */
  serializeModel(m) {
    const { bits, colors } = m.packState();
    return { count: m.count, bits: toB64(bits), colors: colors ? toB64(colors) : null };
  }

  restoreModel(m, data) {
    if (!data || data.count !== m.count) return; // file changed since the project was saved
    m.unpackState({ bits: fromB64(data.bits), colors: data.colors ? fromB64(data.colors) : null });
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

  /** The current element state as a view (see blankView). */
  currentView() {
    return this.models.map((m) => {
      const v = { model: m, vis: new Uint8Array(m.count), ghost: new Uint8Array(m.count), color: new Int32Array(m.count) };
      for (let i = 0; i < m.count; i++) { v.vis[i] = m.isVisible(i) ? 1 : 0; v.ghost[i] = m.isGhost(i) ? 1 : 0; v.color[i] = m.colorOf(i); }
      return v;
    });
  }

  /**
   * Replace everything a snapshot holds in one undoable step: the element view,
   * its legend and (optionally) the revealed categories.
   */
  applyView(view, { legend = null, revealed = this.revealed } = {}) {
    this.record();
    for (const { model: m, vis, ghost, color } of view) {
      if (!this.models.includes(m)) continue;
      for (let i = 0; i < m.count; i++) { m.setVisible(i, vis[i]); m.setGhost(i, ghost[i]); m.setColor(i, color[i]); }
    }
    this.legend = legend;
    this.revealed = new Set(revealed);
    this.changed();
  }

  // --- low level -------------------------------------------------------------
  each(gids, fn) {
    for (const gid of this.app.models.expand(gids)) {
      const m = this.app.models.modelOf(gid);
      if (m) fn(m, gid - m.base);
    }
  }

  setVisible(gids, v) { this.each(gids, (m, i) => m.setVisible(i, v)); }
  setGhost(gids, v) { this.each(gids, (m, i) => m.setGhost(i, v)); }
  setColor(gids, rgb) {
    const p = rgb ? packRgb(rgb) : -1;
    this.each(gids, (m, i) => m.setColor(i, p));
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
    for (const m of this.models) for (let i = 0; i < m.count; i++) m.setVisible(i, keep.has(m.base + i));
    this.changed();
  }

  /** Ctrl+T: toggle transparency of the given elements. */
  toggleTransparent(gids) {
    const list = [...gids];
    if (!list.length) return;
    let anyOpaque = false;
    this.each(list, (m, i) => { if (!m.isGhost(i)) anyOpaque = true; });
    this.record();
    this.setGhost(list, anyOpaque);
    this.changed();
  }

  ghostOthers(gids) {
    const keep = this.app.models.expand(gids);
    this.record();
    for (const m of this.models) for (let i = 0; i < m.count; i++) m.setGhost(i, !keep.has(m.base + i));
    this.changed();
  }

  colorize(gids, rgb) { this.record(); this.setColor(gids, rgb); this.changed(); }

  showAll() {
    this.record();
    for (const m of this.models) for (let i = 0; i < m.count; i++) {
      const el = m.elements[i];
      if (!this.skipChild(el) && !isAuxiliary(el)) m.setVisible(i, true);
    }
    this.changed();
  }

  hideAll() {
    this.record();
    for (const m of this.models) for (let i = 0; i < m.count; i++) m.setVisible(i, false);
    this.changed();
  }

  /** Ctrl+R: back to the initial view state (default visibility, no colours). */
  restoreView() {
    this.record();
    for (const m of this.models) m.resetState();
    this.revealed.clear();
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
    this.record();
    if (cat.gated) { if (anyVisible) this.revealed.delete(key); else this.revealed.add(key); }
    for (const gid of gids) {
      const m = this.app.models.modelOf(gid);
      m.setVisible(gid - m.base, !anyVisible);
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
    for (const m of this.models) for (let i = 0; i < m.count; i++) m.setVisible(i, this.myView.has(m.base + i));
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
    for (const m of this.models) for (let i = 0; i < m.count; i++) m.setSelected(i, false);
    this.each([...this.selection], (m, i) => m.setSelected(i, true));
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
    if (prev) prev.setHover(this.hoverGid - prev.base, false);
    this.hoverGid = gid;
    const m = this.app.models.modelOf(gid);
    if (m) m.setHover(gid - m.base, true);
    this.app.viewer.requestRender();
  }
}
