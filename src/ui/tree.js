import { h, showMenu } from './dom.js';
import { icon } from './icons.js';
import { t, getLanguage } from '../i18n.js';
import { classLabel, SPATIAL, CATEGORY_COLORS } from '../core/ifc-classes.js';
import { materialNames, storeyZ } from '../core/props.js';

const ROW_H = 22;

/** Virtualised model tree (building structure or grouped by class/type/material/storey). */
export class TreePanel {
  constructor(app, host) {
    this.app = app;
    this.mode = localStorage.getItem('oz.treeMode') || 'spatial';
    this.expanded = new Set();
    this.selectedKeys = new Set();
    this.selectedModel = null;
    this.filter = '';
    this.rows = [];
    this.lastClicked = -1;

    const modeSel = h('select.input.small', { on: { change: (e) => { this.mode = e.target.value; localStorage.setItem('oz.treeMode', this.mode); this.rebuild(); } } },
      ...['spatial', 'class', 'type', 'material', 'storey'].map((m) => h('option', { value: m, selected: m === this.mode }, t(`tree.${m === 'class' ? 'class' : m}`))));
    const filter = h('input.input.small', { type: 'search', placeholder: t('tree.filter'), on: { input: (e) => { this.filterRaw = e.target.value.trim(); this.filter = this.filterRaw.toLowerCase(); this.flatten(); } } });
    const collapse = h('button.icon-btn', { title: '−', html: icon('minus', 14), on: { click: () => { this.expanded.clear(); this.flatten(); } } });
    this.scroll = h('div.tree-scroll', { tabindex: 0 });
    this.spacer = h('div.tree-spacer');
    this.scroll.appendChild(this.spacer);
    host.append(h('div.panel-head', modeSel, filter, collapse), this.scroll);
    this.scroll.addEventListener('scroll', () => this.renderRows());
    this.scroll.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.renderRows()).observe(this.scroll);

    const M = app.models;
    M.addEventListener('changed', () => this.rebuild());
    M.addEventListener('added', (e) => this.expanded.add(`m${e.detail.id}`));
    app.state.addEventListener('change', () => this.renderRows());
    app.state.addEventListener('selection', () => {
      // a selection made elsewhere (3D view, search) ends the model-row selection used by Ctrl+Delete
      if (!this.ownSelect) { this.selectedModel = null; this.selectedKeys.clear(); }
      this.renderRows();
    });
    this.rebuild();
  }

  // --- node construction -------------------------------------------------------------
  elNode(model, i, withChildren = true) {
    const el = model.elements[i];
    const kids = withChildren ? model.children[i] : [];
    return {
      key: `e${model.id}:${i}`, kind: 'el', model, index: i, gid: model.base + i,
      label: el.name || el.longName || classLabel(el.cls, getLanguage()),
      sub: el.cls === 'IfcSpace' && el.longName ? el.longName : classLabel(el.cls, getLanguage()),
      category: el.category, cls: el.cls,
      hasChildren: kids.length > 0,
      children: () => this.sortEls(model, kids).map((j) => this.elNode(model, j)),
    };
  }

  sortEls(model, list) {
    const els = model.elements;
    const rank = (el) => (SPATIAL.has(el.cls) ? 0 : el.cls === 'IfcSpace' ? 2 : 1);
    return [...list].sort((a, b) => {
      const A = els[a], B = els[b];
      if (rank(A) !== rank(B)) return rank(A) - rank(B);
      if (A.cls === 'IfcBuildingStorey' && B.cls === 'IfcBuildingStorey') return storeyZ(A) - storeyZ(B);
      if (A.cls !== B.cls) return A.cls.localeCompare(B.cls);
      return (A.name || '').localeCompare(B.name || '', undefined, { numeric: true });
    });
  }

  rebuild() {
    const M = this.app.models;
    if (this.mode === 'spatial') {
      this.roots = M.models.map((m) => ({
        key: `m${m.id}`, kind: 'model', model: m, label: m.name, sub: m.schema, hasChildren: true,
        gids: () => [m.base + (m.roots[0] ?? 0)],
        children: () => {
          const r = this.sortEls(m, m.roots);
          // skip the IfcProject level: show its children directly
          if (r.length === 1 && m.elements[r[0]].cls === 'IfcProject') return this.sortEls(m, m.children[r[0]]).map((j) => this.elNode(m, j));
          return r.map((j) => this.elNode(m, j));
        },
      }));
    } else {
      const keyFns = {
        class: [(m, el) => [classLabel(el.cls, getLanguage())]],
        type: [(m, el) => [el.typeName || t('tree.noType')]],
        material: [(m, el) => { const n = materialNames(m, el); return n.length ? n : [t('tree.noMaterial')]; }],
        storey: [(m, el) => [el.storey !== undefined ? m.elements[el.storey].name : t('tree.noStorey')], (m, el) => [classLabel(el.cls, getLanguage())]],
      }[this.mode];
      const build = (members, level, prefix) => {
        const groups = new Map();
        for (const [m, i] of members) {
          for (const k of keyFns[level](m, m.elements[i])) {
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push([m, i]);
          }
        }
        const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return keys.map((k) => {
          const list = groups.get(k);
          const key = `${prefix}/${k}`;
          return {
            key, kind: 'group', label: k, sub: String(list.length), hasChildren: true,
            gids: () => list.map(([m, i]) => m.base + i),
            children: () => (level + 1 < keyFns.length ? build(list, level + 1, key) : list.map(([m, i]) => this.elNode(m, i, false))),
          };
        });
      };
      const members = [];
      for (const m of M.models) {
        for (let i = 0; i < m.count; i++) {
          const el = m.elements[i];
          if (SPATIAL.has(el.cls) || el.supers.includes('IfcOpeningElement')) continue;
          if (!m.hasGeom[i] && !m.children[i].length) continue;
          members.push([m, i]);
        }
      }
      this.roots = build(members, 0, this.mode);
    }
    this.flatten();
  }

  flatten() {
    const rows = [];
    if (this.filter) {
      const f = this.filter;
      outer: for (const m of this.app.models.models) {
        for (let i = 0; i < m.count; i++) {
          const el = m.elements[i];
          if ((el.name || '').toLowerCase().includes(f) || el.cls.toLowerCase().includes(f) || el.guid === this.filterRaw || (el.typeName || '').toLowerCase().includes(f) || (el.longName || '').toLowerCase().includes(f)) {
            rows.push({ node: this.elNode(m, i, false), depth: 0 });
            if (rows.length > 5000) break outer;
          }
        }
      }
    } else {
      const walk = (nodes, depth) => {
        for (const n of nodes) {
          rows.push({ node: n, depth });
          if (n.hasChildren && this.expanded.has(n.key)) {
            if (!n._kids) n._kids = n.children();
            walk(n._kids, depth + 1);
          }
        }
      };
      walk(this.roots || [], 0);
    }
    this.rows = rows;
    this.spacer.style.height = `${rows.length * ROW_H}px`;
    this.renderRows();
  }

  // --- visibility state of a node ----------------------------------------------------------
  nodeGids(node) {
    if (node.kind === 'el') return [node.gid];
    return node.gids();
  }

  visState(node) {
    const M = this.app.models;
    let on = 0, off = 0;
    const check = (m, i) => { if (!m.hasGeom[i]) return; if (m.isVisible(i)) on++; else off++; };
    if (node.kind === 'model') {
      const m = node.model;
      if (!m.visible) return 'off';
      for (let i = 0; i < m.count; i++) check(m, i);
    } else {
      for (const gid of this.nodeGids(node)) {
        const m = M.modelOf(gid);
        if (!m) continue;
        for (const i of m.descendants(gid - m.base, [], this.app.state.skipChild)) { check(m, i); if (on && off) return 'mixed'; }
      }
    }
    if (on && off) return 'mixed';
    if (on) return 'on';
    return off ? 'off' : 'none';
  }

  isSelected(node) {
    if (node.kind === 'el') return this.app.state.selection.has(node.gid);
    return this.selectedKeys.has(node.key);
  }

  renderRows() {
    const sc = this.scroll;
    const top = sc.scrollTop;
    const height = sc.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5);
    const last = Math.min(this.rows.length, Math.ceil((top + height) / ROW_H) + 5);
    for (const el of [...sc.querySelectorAll('.tree-row')]) el.remove();
    if (!this.rows.length) {
      if (!sc.querySelector('.empty')) sc.appendChild(h('div.empty', t('tree.empty')));
      return;
    }
    sc.querySelector('.empty')?.remove();
    const frag = document.createDocumentFragment();
    for (let r = first; r < last; r++) {
      const { node, depth } = this.rows[r];
      const vis = this.visState(node);
      const toggle = h('span.tw', node.hasChildren && !this.filter ? (this.expanded.has(node.key) ? '▾' : '▸') : '');
      const cb = h('span.cb', { class: `cb ${vis}` });
      const color = node.kind === 'model' ? '#3d7bd9' : node.kind === 'group' ? '#8a8f98' : CATEGORY_COLORS[node.category] || '#b0b4ba';
      const ico = h('span.node-ico', { style: { background: color } });
      const row = h('div.tree-row', {
        class: `tree-row${this.isSelected(node) ? ' selected' : ''}${vis === 'off' ? ' hidden-el' : ''}`,
        style: { top: `${r * ROW_H}px`, paddingLeft: `${4 + depth * 14}px` },
        title: node.kind === 'el' ? `${node.label} · ${node.cls}` : node.label,
      }, toggle, cb, ico, h('span.lbl', node.label), h('span.sub', node.sub || ''));
      toggle.addEventListener('click', (e) => { e.stopPropagation(); this.toggleExpand(node, e.altKey); });
      toggle.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.toggleExpand(node, true); });
      cb.addEventListener('click', (e) => { e.stopPropagation(); this.toggleVisibility(node, vis); });
      row.addEventListener('click', (e) => this.onRowClick(r, node, e));
      row.addEventListener('dblclick', () => { this.app.zoomToSelection(); });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onRowContext(r, node, e); });
      frag.appendChild(row);
    }
    sc.appendChild(frag);
  }

  toggleExpand(node, deep = false) {
    if (!node.hasChildren) return;
    const open = !this.expanded.has(node.key);
    const apply = (n, d) => {
      if (open) this.expanded.add(n.key); else this.expanded.delete(n.key);
      if (deep && d < 8 && n.hasChildren) {
        if (!n._kids) n._kids = n.children();
        for (const c of n._kids) if (c.hasChildren) apply(c, d + 1);
      }
    };
    apply(node, 0);
    this.flatten();
  }

  toggleVisibility(node, vis) {
    if (node.kind === 'model' && !node.model.visible) {
      node.model.visible = true;
      node.model.group.visible = true;
      this.app.state.changed();
      return;
    }
    const gids = node.kind === 'model' ? [node.model.base + (node.model.roots[0] ?? 0)] : this.nodeGids(node);
    if (vis === 'on' || vis === 'mixed') this.app.state.hide(gids);
    else this.app.state.show(gids);
  }

  onRowClick(r, node, e) {
    const st = this.app.state;
    this.ownSelect = true;
    this.selectedModel = node.kind === 'model' ? node.model : null;
    let gids = this.nodeGids(node);
    if (e.shiftKey && this.lastClicked >= 0) {
      const [a, b] = [Math.min(this.lastClicked, r), Math.max(this.lastClicked, r)];
      gids = [];
      for (let k = a; k <= b; k++) gids.push(...this.nodeGids(this.rows[k].node));
      st.select(gids, 'add');
    } else if (e.ctrlKey || e.metaKey) {
      if (node.kind !== 'el') this.selectedKeys.has(node.key) ? this.selectedKeys.delete(node.key) : this.selectedKeys.add(node.key);
      st.select(gids, 'toggle');
    } else {
      this.selectedKeys = new Set(node.kind !== 'el' ? [node.key] : []);
      st.select(gids, 'replace');
    }
    this.ownSelect = false;
    this.lastClicked = r;
    this.scroll.focus({ preventScroll: true });
  }

  onRowContext(r, node, e) {
    if (!this.isSelected(node)) this.onRowClick(r, node, { shiftKey: false, ctrlKey: false });
    const app = this.app;
    const c = (id) => app.menuItem(id);
    const items = [c('toggleSel'), c('isolate'), c('transparent'), c('ghostOthers'), c('showAll'), '-', c('zoomSel'), c('sectionBoxSel'), '-', c('addMyView'), c('removeMyView')];
    if (node.kind === 'model') {
      items.push('-',
        { label: node.model.visible ? t('ui.hide') : t('ui.show'), icon: node.model.visible ? 'eyeOff' : 'eye', run: () => { node.model.visible = !node.model.visible; node.model.group.visible = node.model.visible; app.state.changed(); } },
        { label: t('cmd.remove'), icon: 'trash', shortcut: 'Ctrl+Delete', run: () => app.removeModel(node.model) });
    }
    showMenu(items, e.clientX, e.clientY);
  }

  onKey(e) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    let r = this.lastClicked;
    if (r < 0) r = 0;
    const node = this.rows[r]?.node;
    if (!node) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const open = this.expanded.has(node.key);
      if ((e.key === 'ArrowRight') !== open) this.toggleExpand(node, e.altKey);
      return;
    }
    if (e.key === 'Enter') { this.app.zoomToSelection(); return; }
    const next = Math.max(0, Math.min(this.rows.length - 1, r + (e.key === 'ArrowDown' ? 1 : -1)));
    this.onRowClick(next, this.rows[next].node, { shiftKey: e.shiftKey, ctrlKey: false });
    const y = next * ROW_H;
    if (y < this.scroll.scrollTop) this.scroll.scrollTop = y;
    if (y + ROW_H > this.scroll.scrollTop + this.scroll.clientHeight) this.scroll.scrollTop = y + ROW_H - this.scroll.clientHeight;
  }

  /** Expand the ancestors of an element and scroll it into view (building structure only). */
  reveal(gid) {
    if (this.mode !== 'spatial' || this.filter) return;
    const m = this.app.models.modelOf(gid);
    if (!m) return;
    this.expanded.add(`m${m.id}`);
    let p = m.elements[gid - m.base].parent;
    while (p >= 0) { this.expanded.add(`e${m.id}:${p}`); p = m.elements[p].parent; }
    // cached child lists stay valid; only expansion changed
    this.flatten();
    const key = `e${m.id}:${gid - m.base}`;
    const r = this.rows.findIndex((x) => x.node.key === key);
    if (r >= 0) {
      this.lastClicked = r;
      const y = r * ROW_H;
      if (y < this.scroll.scrollTop || y > this.scroll.scrollTop + this.scroll.clientHeight - ROW_H) this.scroll.scrollTop = Math.max(0, y - this.scroll.clientHeight / 2);
    }
  }
}
