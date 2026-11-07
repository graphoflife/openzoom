import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { createMeshMaterial, createEdgeMaterial } from './materials.js';
import { HIDDEN_BY_DEFAULT, SPATIAL, categoryOf } from './ifc-classes.js';

const TEX_W = 1024;
let nextModelId = 1;
let nextBase = 0;

/** One loaded IFC file. Element state lives in two RGBA8 textures read by the shaders. */
export class Model {
  constructor(data, sourceBytes) {
    Object.assign(this, data);
    this.id = nextModelId++;
    this.name = data.fileName;
    this.source = sourceBytes; // original IFC bytes (for project save)
    this.count = this.elements.length;
    this.base = nextBase;
    nextBase += this.count;
    this.texW = TEX_W;
    this.texH = Math.max(1, Math.ceil(this.count / TEX_W));
    this.flags = new Uint8Array(this.texW * this.texH * 4); // r visible, g ghost, b selected, a hover
    this.colors = new Uint8Array(this.texW * this.texH * 4); // rgb override, a = override on
    this.flagTex = makeTex(this.flags, this.texW, this.texH);
    this.colorTex = makeTex(this.colors, this.texW, this.texH);
    this.visible = true;
    this.group = new THREE.Group();
    this.group.name = this.name;
    this.meshes = [];
    this.edgeLines = [];

    this.children = Array.from({ length: this.count }, () => []);
    this.roots = [];
    this.elements.forEach((el, i) => {
      if (el.parent >= 0) this.children[el.parent].push(i);
      else this.roots.push(i);
    });
    // Elements with geometry but without spatial parent hang below the project.
    const project = this.elements.findIndex((e) => e.cls === 'IfcProject');
    if (project >= 0) {
      this.roots = this.roots.filter((i) => {
        if (i === project) return true;
        this.elements[i].parent = project;
        this.children[project].push(i);
        return false;
      });
    }
    this.hasGeom = new Uint8Array(this.count);
    this.ranges.forEach((r, i) => { if (r) this.hasGeom[i] = 1; });
    this.computeDerived();
    this.resetState();
  }

  computeDerived() {
    const els = this.elements;
    for (let i = 0; i < this.count; i++) {
      const el = els[i];
      let p = el.parent;
      const aggregates = [];
      while (p >= 0) {
        const pe = els[p];
        if (pe.cls === 'IfcBuildingStorey' && el.storey === undefined) el.storey = p;
        if (pe.cls === 'IfcBuilding' && el.building === undefined) el.building = p;
        if (pe.cls === 'IfcSite' && el.site === undefined) el.site = p;
        if (pe.cls === 'IfcSpace' && el.space === undefined) el.space = p;
        if (!SPATIAL.has(pe.cls) && pe.cls !== 'IfcSpace') aggregates.unshift(pe);
        p = pe.parent;
      }
      el.category = categoryOf(el, aggregates);
    }
  }

  resetState() {
    const f = this.flags;
    for (let i = 0; i < this.count; i++) {
      const el = this.elements[i];
      f[i * 4] = HIDDEN_BY_DEFAULT.has(el.cls) || el.supers.includes('IfcOpeningElement') ? 0 : 255;
      f[i * 4 + 1] = 0;
    }
    this.colors.fill(0);
    this.touch();
  }

  touch() {
    this.flagTex.needsUpdate = true;
    this.colorTex.needsUpdate = true;
  }

  isVisible(i) { return this.flags[i * 4] > 0; }
  isGhost(i) { return this.flags[i * 4 + 1] > 0; }

  buildMeshes() {
    this.chunks.forEach((c, ci) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(c.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(c.normal, 3, true));
      g.setAttribute('rgba', new THREE.BufferAttribute(c.color, 4, true));
      g.setAttribute('eid', new THREE.BufferAttribute(c.eid, 1));
      g.setIndex(new THREE.BufferAttribute(c.index, 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      // indirect: keep the index buffer untouched, element ranges index into it
      g.boundsTree = new MeshBVH(g, { targetLeafSize: 16, indirect: true });
      const opaque = new THREE.Mesh(g, createMeshMaterial(this, 0));
      const transp = new THREE.Mesh(g, createMeshMaterial(this, 1));
      transp.renderOrder = 2;
      opaque.userData = { model: this, chunk: ci, pickable: true };
      transp.userData = { model: this, chunk: ci };
      transp.raycast = () => {};
      opaque.raycast = () => {};
      this.group.add(opaque, transp);
      this.meshes.push(opaque);
      if (c.edgePos && c.edgePos.length) {
        const eg = new THREE.BufferGeometry();
        eg.setAttribute('position', new THREE.BufferAttribute(c.edgePos, 3));
        eg.setAttribute('eid', new THREE.BufferAttribute(c.edgeEid, 1));
        const lines = new THREE.LineSegments(eg, createEdgeMaterial(this));
        lines.renderOrder = 1;
        lines.raycast = () => {};
        this.group.add(lines);
        this.edgeLines.push(lines);
      }
    });
  }

  setEdgesVisible(v) { for (const l of this.edgeLines) l.visible = v; }

  /** Bounding box of an element (local index) or null. */
  bbox(i, target = new THREE.Box3()) {
    const b = this.bboxes;
    if (Number.isNaN(b[i * 6])) return null;
    target.min.set(b[i * 6], b[i * 6 + 1], b[i * 6 + 2]);
    target.max.set(b[i * 6 + 3], b[i * 6 + 4], b[i * 6 + 5]);
    return target;
  }

  /** Local indices of i and all descendants; `skip(el)` prunes children (never i itself). */
  descendants(i, out = [], skip = null) {
    const stack = [i];
    while (stack.length) {
      const j = stack.pop();
      out.push(j);
      for (const c of this.children[j]) if (!skip || !skip(this.elements[c])) stack.push(c);
    }
    return out;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) { o.geometry.boundsTree = null; o.geometry.dispose(); }
      if (o.material) o.material.dispose();
    });
    this.flagTex.dispose();
    this.colorTex.dispose();
  }
}

function makeTex(data, w, h) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** Loads IFC files through the worker and keeps the list of models + gid lookup. */
export class ModelManager extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.models = [];
    this.offset = null;
    this.reqId = 0;
    this.pending = new Map();
    this.worker = new Worker(new URL('./ifc-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') p.onProgress?.(msg.phase, msg.value);
    else if (msg.type === 'result') { this.pending.delete(msg.id); p.resolve(msg.result); }
    else if (msg.type === 'error') { this.pending.delete(msg.id); p.reject(new Error(msg.message)); }
  }

  async load(file, onProgress) {
    const buffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
    const source = new Uint8Array(buffer.slice(0));
    const id = ++this.reqId;
    const result = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({
        cmd: 'load', id, buffer, fileName: file.name || 'model.ifc', offset: this.offset,
        edges: this.app.settings.get('edges') !== false,
      }, [buffer]);
    });
    if (!this.offset) this.offset = result.offset;
    const model = new Model(result, source);
    model.buildMeshes();
    model.setEdgesVisible(this.app.settings.get('edges') !== false);
    this.models.push(model);
    this.app.viewer.scene.add(model.group);
    this.dispatchEvent(new CustomEvent('added', { detail: model }));
    this.changed();
    return model;
  }

  remove(model) {
    const i = this.models.indexOf(model);
    if (i < 0) return;
    this.models.splice(i, 1);
    this.app.viewer.scene.remove(model.group);
    model.dispose();
    if (!this.models.length) this.offset = null;
    this.dispatchEvent(new CustomEvent('removed', { detail: model }));
    this.changed();
  }

  changed() {
    this.dispatchEvent(new Event('changed'));
    this.app.viewer.requestRender();
  }

  // --- gid helpers -----------------------------------------------------------
  modelOf(gid) {
    for (const m of this.models) if (gid >= m.base && gid < m.base + m.count) return m;
    return null;
  }

  element(gid) {
    const m = this.modelOf(gid);
    return m ? m.elements[gid - m.base] : null;
  }

  /** Iterate over every element: fn(model, localIndex, element, gid). */
  forEach(fn) {
    for (const m of this.models) {
      const els = m.elements;
      for (let i = 0; i < m.count; i++) fn(m, i, els[i], m.base + i);
    }
  }

  allGids(filter) {
    const out = [];
    this.forEach((m, i, el, gid) => { if (!filter || filter(m, i, el)) out.push(gid); });
    return out;
  }

  /**
   * gids plus their descendants. Spaces and openings below a matched element are
   * skipped while their global toggle (Alt+S / Alt+O) is off, like in Zoom.
   */
  expand(gids, skip = this.app.state?.skipChild) {
    const out = new Set();
    for (const gid of gids) {
      const m = this.modelOf(gid);
      if (!m) continue;
      for (const i of m.descendants(gid - m.base, [], skip)) out.add(m.base + i);
    }
    return out;
  }

  findByGuid(guid) {
    for (const m of this.models) {
      if (!m.guidIndex) {
        m.guidIndex = new Map();
        m.elements.forEach((el, i) => el.guid && m.guidIndex.set(el.guid, i));
      }
      const i = m.guidIndex.get(guid);
      if (i !== undefined) return m.base + i;
    }
    return -1;
  }

  /** Bounding box of a set of gids (only elements with geometry). */
  boxOf(gids, onlyVisible = false) {
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (const gid of gids) {
      const m = this.modelOf(gid);
      if (!m || !m.visible) continue;
      const i = gid - m.base;
      if (onlyVisible && !m.isVisible(i)) continue;
      if (m.bbox(i, tmp)) box.union(tmp);
    }
    return box;
  }

  visibleBox() {
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (const m of this.models) {
      if (!m.visible) continue;
      for (let i = 0; i < m.count; i++) if (m.hasGeom[i] && m.isVisible(i) && m.bbox(i, tmp)) box.union(tmp);
    }
    if (box.isEmpty()) for (const m of this.models) for (let i = 0; i < m.count; i++) if (m.bbox(i, tmp)) box.union(tmp);
    return box;
  }

  /** Conversion between viewer (Y-up, offset) and IFC world (Z-up) coordinates. */
  toIfc(v) {
    const o = this.offset || [0, 0, 0];
    return [v.x + o[0], -(v.z + o[2]), v.y + o[1]];
  }

  fromIfc(a, target = new THREE.Vector3()) {
    const o = this.offset || [0, 0, 0];
    return target.set(a[0] - o[0], a[2] - o[1], -a[1] - o[2]);
  }

  dirToIfc(v) { return [v.x, -v.z, v.y]; }
  dirFromIfc(a, target = new THREE.Vector3()) { return target.set(a[0], a[2], -a[1]); }
}
