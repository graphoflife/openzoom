import { CATEGORIES } from './ifc-classes.js';

const isOpening = (el) => el.supers.includes('IfcOpeningElement');

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
  /**
   * Compact snapshot: one byte per element (bit 0 visible, bit 1 transparent) and
   * the colour overrides only for models that have any.
   */
  snapshot() {
    return {
      legend: this.legend, showSpaces: this.showSpaces, showOpenings: this.showOpenings,
      models: this.models.map((m) => {
        const f = m.flags, c = m.colors;
        const bits = new Uint8Array(m.count);
        let colored = false;
        for (let i = 0; i < m.count; i++) {
          bits[i] = (f[i * 4] ? 1 : 0) | (f[i * 4 + 1] ? 2 : 0);
          if (c[i * 4 + 3]) colored = true;
        }
        return { m, bits, colors: colored ? c.slice(0, m.count * 4) : null };
      }),
    };
  }

  /** Call before every user-visible change of visibility/colour. */
  record() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  restore(snap) {
    for (const s of snap.models) {
      if (!this.models.includes(s.m)) continue;
      // selection/hover channels stay as they are
      const f = s.m.flags;
      for (let i = 0; i < s.m.count; i++) { f[i * 4] = s.bits[i] & 1 ? 255 : 0; f[i * 4 + 1] = s.bits[i] & 2 ? 255 : 0; }
      if (s.colors) s.m.colors.set(s.colors); else s.m.colors.fill(0);
    }
    this.legend = snap.legend;
    this.showSpaces = snap.showSpaces;
    this.showOpenings = snap.showOpenings;
    this.changed();
  }

  /** Drop every reference to a removed model (history, legend, My View). */
  forgetModel(model) {
    for (const stack of [this.undoStack, this.redoStack]) for (const s of stack) s.models = s.models.filter((x) => x.m !== model);
    const uses = (legend) => legend?.some((e) => e.items?.some(([w]) => w.model === model));
    if (uses(this.legend)) this.legend = null;
    for (const stack of [this.undoStack, this.redoStack]) for (const s of stack) if (uses(s.legend)) s.legend = null;
    for (const gid of [...this.myView]) if (gid >= model.base && gid < model.base + model.count) this.myView.delete(gid);
  }

  /** Visibility, transparency and colours of a model for the project file. */
  serializeModel(m) {
    const bits = new Uint8Array(m.count);
    for (let i = 0; i < m.count; i++) bits[i] = (m.flags[i * 4] ? 1 : 0) | (m.flags[i * 4 + 1] ? 2 : 0);
    let colored = false;
    for (let i = 0; i < m.count && !colored; i++) if (m.colors[i * 4 + 3]) colored = true;
    return { count: m.count, bits: toB64(bits), colors: colored ? toB64(m.colors.subarray(0, m.count * 4)) : null };
  }

  restoreModel(m, data) {
    if (!data || data.count !== m.count) return; // file changed since the project was saved
    const bits = fromB64(data.bits);
    for (let i = 0; i < m.count; i++) { m.flags[i * 4] = bits[i] & 1 ? 255 : 0; m.flags[i * 4 + 1] = bits[i] & 2 ? 255 : 0; }
    if (data.colors) m.colors.set(fromB64(data.colors));
    m.touch();
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
    for (const m of this.models) for (let i = 0; i < m.count; i++) m.flags[i * 4] = keep.has(m.base + i) ? 255 : 0;
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
    this.record();
    if (key === 'spaces') this.showSpaces = !anyVisible;
    if (key === 'openings') this.showOpenings = !anyVisible;
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
