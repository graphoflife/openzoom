import * as THREE from 'three';
import { elementDistance } from './elementgeom.js';
import { storeyZ } from './props.js';

const LINE_COLOR = 0xffd400;
let nextId = 1;

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#ffd400';
  g.strokeStyle = '#000';
  g.lineWidth = 4;
  g.beginPath(); g.arc(16, 16, 11, 0, Math.PI * 2); g.fill(); g.stroke();
  return new THREE.CanvasTexture(c);
}

/**
 * Dimensions and markers:
 * dimension (Zoom style: click surface = perpendicular clear distance, Shift+click = point to point,
 * Ctrl+click = distance to section plane), distance, angle, area, elevation, mindist (object to object).
 */
export class Measure extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.viewer = app.viewer;
    this.mode = null;
    this.items = [];
    this.pending = [];
    this.pendingObjects = [];
    this.selected = null;
    this.dotTex = dotTexture();
    this.snap = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
      new THREE.PointsMaterial({ size: 14, sizeAttenuation: false, map: this.dotTex, transparent: true, depthTest: false }),
    );
    this.snap.visible = false;
    this.snap.renderOrder = 10;
    this.viewer.overlay.add(this.snap);
    this.rubber = this.makeLine([new THREE.Vector3(), new THREE.Vector3()], true);
    this.rubber.visible = false;
    this.viewer.overlay.add(this.rubber);
    this.snapLabel = document.createElement('div');
    this.snapLabel.className = 'snap-tip';
    this.snapItem = this.viewer.addLabel(this.snapLabel, new THREE.Vector3());
    this.snapItem.hidden = true;
  }

  get active() { return !!this.mode; }

  setMode(mode) {
    this.cancelPending();
    this.mode = mode;
    this.snap.visible = false;
    this.snapItem.hidden = true;
    this.dispatchEvent(new Event('mode'));
    const hints = {
      dimension: 'status.dimension', distance: 'status.distance', angle: 'status.angle', area: 'status.area',
      elevation: 'status.elevation', mindist: 'status.mindist',
    };
    this.app.status(mode ? this.app.t(hints[mode]) : '');
    this.viewer.requestRender();
  }

  cancelPending() {
    this.pending = [];
    for (const o of this.pendingObjects) { this.viewer.overlay.remove(o); o.geometry.dispose(); o.material.dispose(); }
    this.pendingObjects = [];
    this.rubber.visible = false;
    this.mindistA = null;
    this.viewer.requestRender();
  }

  // --- snapping -------------------------------------------------------------------
  /** Pick with vertex / edge / midpoint snapping. */
  snapPick(clientX, clientY) {
    const hit = this.viewer.pick(clientX, clientY, this.app.models.models);
    if (!hit) return null;
    const pos = hit.mesh.geometry.attributes.position;
    const verts = [hit.face.a, hit.face.b, hit.face.c].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
    const screen = (p) => {
      const v = p.clone().project(this.viewer.camera);
      const r = this.viewer.canvas.getBoundingClientRect();
      return new THREE.Vector2(((v.x + 1) / 2) * r.width + r.left, ((1 - v.y) / 2) * r.height + r.top);
    };
    const mouse = new THREE.Vector2(clientX, clientY);
    let best = null;
    for (const v of verts) {
      const d = screen(v).distanceTo(mouse);
      if (d < 12 && (!best || d < best.d)) best = { d, point: v, kind: 'vertex' };
    }
    if (!best) {
      for (let k = 0; k < 3; k++) {
        const a = verts[k], b = verts[(k + 1) % 3];
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const dm = screen(mid).distanceTo(mouse);
        if (dm < 10 && (!best || dm < best.d)) best = { d: dm, point: mid, kind: 'mid' };
        const line = new THREE.Line3(a, b);
        const p = line.closestPointToPoint(hit.point, true, new THREE.Vector3());
        const d = screen(p).distanceTo(mouse);
        if (d < 8 && (!best || d < best.d - 2)) best = { d, point: p, kind: 'edge' };
      }
    }
    return { ...hit, snapPoint: best ? best.point : hit.point.clone(), snapKind: best ? best.kind : 'face' };
  }

  hover(e) {
    if (!this.mode || this.mode === 'mindist') return;
    const s = this.snapPick(e.clientX, e.clientY);
    if (!s) {
      this.snap.visible = false;
      this.snapItem.hidden = true;
      this.viewer.requestRender();
      return;
    }
    this.snap.position.copy(s.snapPoint);
    this.snap.visible = true;
    this.snapItem.position.copy(s.snapPoint);
    this.snapItem.hidden = false;
    const kindText = { vertex: this.app.t('snap.vertex'), mid: this.app.t('snap.mid'), edge: this.app.t('snap.edge'), face: this.app.t('snap.face') }[s.snapKind];
    this.snapLabel.textContent = this.mode === 'elevation' ? `${kindText} · ${this.fmtElev(s.snapPoint, s)}` : kindText;
    if (this.pending.length) {
      const last = this.pending[this.pending.length - 1];
      this.setLine(this.rubber, [last, s.snapPoint]);
      this.rubber.visible = true;
    }
    this.viewer.requestRender();
  }

  // --- clicks ---------------------------------------------------------------------
  click(e) {
    const mode = this.mode;
    if (mode === 'mindist') return this.clickMinDist(e);
    const s = this.snapPick(e.clientX, e.clientY);
    if (mode === 'dimension') {
      if (e.ctrlKey || e.metaKey) return s && this.planeDistance(s);
      if (e.shiftKey || this.pending.length) return s && this.addPoint(s.snapPoint, 2, 'distance');
      return s && this.perpendicular(s);
    }
    if (!s) {
      if (mode === 'area' && this.pending.length >= 3 && e.detail >= 2) this.finishArea();
      return;
    }
    if (mode === 'distance') this.addPoint(s.snapPoint, 2, 'distance');
    else if (mode === 'angle') this.addPoint(s.snapPoint, 3, 'angle');
    else if (mode === 'elevation') this.createElevation(s.snapPoint, s);
    else if (mode === 'area') {
      if (this.pending.length >= 3 && (e.detail >= 2 || s.snapPoint.distanceTo(this.pending[0]) < this.app.controls.worldPerPixel(s.snapPoint) * 10)) {
        this.finishArea();
      } else this.addPoint(s.snapPoint, Infinity, 'area');
    }
  }

  keyDown(e) {
    if (!this.mode) return false;
    if (e.key === 'Enter' && this.mode === 'area' && this.pending.length >= 3) { this.finishArea(); return true; }
    if (e.key === 'Escape') {
      if (this.pending.length || this.mindistA) this.cancelPending();
      else this.setMode(null);
      return true;
    }
    return false;
  }

  addPoint(p, needed, type) {
    this.pending.push(p.clone());
    const dot = this.makeDots([p]);
    this.viewer.overlay.add(dot);
    this.pendingObjects.push(dot);
    if (this.pending.length >= needed) {
      const pts = this.pending;
      this.cancelPending();
      if (type === 'distance') this.createDistance(pts[0], pts[1]);
      if (type === 'angle') this.createAngle(pts);
    }
    this.viewer.requestRender();
  }

  perpendicular(s) {
    const origin = s.point.clone().addScaledVector(s.normal, 0.0005);
    const ray = new THREE.Ray(origin, s.normal.clone());
    let best = null;
    for (const m of this.app.models.models) {
      if (!m.visible) continue;
      for (const mesh of m.meshes) {
        for (const h of mesh.geometry.boundsTree.raycast(ray, THREE.DoubleSide)) {
          if (h.distance < 1e-4 || (best && h.distance >= best.distance)) continue;
          const eid = mesh.geometry.attributes.eid.array[h.face.a];
          if (!m.isVisible(eid) || this.viewer.isClipped(h.point)) continue;
          best = h;
        }
      }
    }
    if (!best) { this.app.status(this.app.t('status.noOpposite')); return; }
    this.createDistance(s.point.clone(), best.point.clone(), 'perpendicular');
  }

  planeDistance(s) {
    const planes = this.app.sections.allPlanes();
    if (!planes.length) { this.app.status(this.app.t('status.noPlane')); return; }
    let best = null;
    for (const p of planes) {
      const d = Math.abs(p.distanceToPoint(s.snapPoint));
      if (!best || d < best.d) best = { d, p };
    }
    const foot = best.p.projectPoint(s.snapPoint, new THREE.Vector3());
    this.createDistance(s.snapPoint.clone(), foot, 'plane');
  }

  clickMinDist(e) {
    const hit = this.viewer.pick(e.clientX, e.clientY, this.app.models.models);
    if (!hit) return;
    if (!this.mindistA) {
      this.mindistA = hit;
      this.app.state.select([hit.gid]);
      this.app.status(this.app.t('status.mindist2'));
      return;
    }
    const a = this.mindistA;
    this.mindistA = null;
    this.app.state.select([a.gid, hit.gid]);
    const res = elementDistance(a.model, a.index, hit.model, hit.index);
    if (!res) return;
    if (res.distance < 1e-6) { this.app.status(this.app.t('status.touching')); return; }
    this.createDistance(res.a, res.b, 'mindist');
    this.app.status(this.app.t('status.mindist'));
  }

  // --- item creation ------------------------------------------------------------------
  makeLine(points, dashed = false) {
    const g = new THREE.BufferGeometry().setFromPoints(points);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color: LINE_COLOR, dashSize: 0.1, gapSize: 0.06, depthTest: false, transparent: true })
      : new THREE.LineBasicMaterial({ color: LINE_COLOR, depthTest: false, transparent: true });
    const l = new THREE.Line(g, mat);
    l.renderOrder = 9;
    if (dashed) l.computeLineDistances();
    return l;
  }

  setLine(line, points) {
    line.geometry.setFromPoints(points);
    line.computeLineDistances?.();
    line.geometry.attributes.position.needsUpdate = true;
  }

  makeDots(points) {
    const p = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.PointsMaterial({ size: 10, sizeAttenuation: false, map: this.dotTex, transparent: true, depthTest: false }),
    );
    p.renderOrder = 10;
    return p;
  }

  label(html, pos, item) {
    const el = document.createElement('div');
    el.className = 'measure-label';
    el.innerHTML = html;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = this.app.t('measure.delete');
    x.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.remove(item); });
    el.appendChild(x);
    el.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.selectItem(item); });
    return this.viewer.addLabel(el, pos.clone());
  }

  register(item) {
    item.id = nextId++;
    for (const o of item.objects) this.viewer.overlay.add(o);
    this.items.push(item);
    this.viewer.requestRender();
    this.dispatchEvent(new Event('change'));
    return item;
  }

  createDistance(a, b, kind = 'distance') {
    const item = { type: 'distance', kind, points: [a.clone(), b.clone()], objects: [this.makeLine([a, b]), this.makeDots([a, b])], labels: [] };
    const d = a.distanceTo(b);
    const ia = this.app.models.toIfc(a), ib = this.app.models.toIfc(b);
    const f = (v) => this.app.fmtLen(Math.abs(v));
    const deltas = `ΔX ${f(ib[0] - ia[0])} · ΔY ${f(ib[1] - ia[1])} · ΔZ ${f(ib[2] - ia[2])}`;
    item.value = d;
    item.labels.push(this.label(`<b>${this.app.fmtLen(d)}</b><small>${deltas}</small>`, a.clone().add(b).multiplyScalar(0.5), item));
    // dashed component triangle helps reading 3D distances
    if (kind === 'distance' && Math.abs(ia[2] - ib[2]) > 1e-3 && Math.hypot(ib[0] - ia[0], ib[1] - ia[1]) > 1e-3) {
      const c = new THREE.Vector3(b.x, a.y, b.z);
      const tri = this.makeLine([a, c, b], true);
      tri.material.opacity = 0.6;
      item.objects.push(tri);
    }
    return this.register(item);
  }

  createAngle(pts) {
    const [a, v, b] = pts;
    const u = a.clone().sub(v).normalize(), w = b.clone().sub(v).normalize();
    const ang = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(u.dot(w), -1, 1)));
    const item = { type: 'angle', points: pts.map((p) => p.clone()), objects: [this.makeLine([a, v, b]), this.makeDots(pts)], labels: [], value: ang };
    const r = Math.min(a.distanceTo(v), b.distanceTo(v)) * 0.3;
    const arc = [];
    for (let k = 0; k <= 24; k++) {
      const t = k / 24;
      arc.push(v.clone().add(u.clone().lerp(w, t).normalize().multiplyScalar(r)));
    }
    item.objects.push(this.makeLine(arc));
    const lp = v.clone().add(u.clone().add(w).normalize().multiplyScalar(r * 1.4));
    item.labels.push(this.label(`<b>${ang.toFixed(2).replace('.', this.app.decimalSep)}°</b>`, lp, item));
    return this.register(item);
  }

  finishArea() {
    const pts = this.pending.slice();
    this.cancelPending();
    if (pts.length < 3) return;
    // Newell normal + area of planar polygon
    const n = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      n.x += (p.y - q.y) * (p.z + q.z);
      n.y += (p.z - q.z) * (p.x + q.x);
      n.z += (p.x - q.x) * (p.y + q.y);
    }
    const area = n.length() / 2;
    let perim = 0;
    for (let i = 0; i < pts.length; i++) perim += pts[i].distanceTo(pts[(i + 1) % pts.length]);
    const centroid = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const fillGeo = new THREE.BufferGeometry();
    const tri = [];
    for (let i = 1; i < pts.length - 1; i++) tri.push(pts[0], pts[i], pts[i + 1]);
    fillGeo.setFromPoints(tri);
    const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: LINE_COLOR, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthTest: false }));
    const item = { type: 'area', points: pts, objects: [this.makeLine([...pts, pts[0]]), this.makeDots(pts), fill], labels: [], value: area };
    item.labels.push(this.label(`<b>${this.app.fmtArea(area)}</b><small>U = ${this.app.fmtLen(perim)}</small>`, centroid, item));
    return this.register(item);
  }

  /** Elevation relative to the configured reference (project ±0.00 or storey). */
  elevationOf(p, hit) {
    const z = this.app.models.toIfc(p)[2];
    const ref = this.app.settings.get('elevationRef') || 'project';
    if (ref === 'storey' && hit && hit.model) {
      const el = hit.model.elements[hit.index];
      const st = el.storey !== undefined ? hit.model.elements[el.storey] : null;
      if (st) {
        const base = storeyZ(st);
        return { value: z - base, suffix: st.name };
      }
    }
    const custom = Number(this.app.settings.get('elevationZero') || 0);
    return { value: z - custom, suffix: '' };
  }

  fmtElev(p, hit) {
    const { value, suffix } = this.elevationOf(p, hit);
    const sign = Math.abs(value) < 0.0005 ? '±' : value > 0 ? '+' : '−';
    return `${sign}${this.app.fmtNum(Math.abs(value), 3)}${suffix ? ` (${suffix})` : ''}`;
  }

  createElevation(p, hit) {
    const text = this.fmtElev(p, hit);
    const item = { type: 'elevation', points: [p.clone()], objects: [this.makeDots([p])], labels: [], value: this.elevationOf(p, hit).value, hit: hit ? { model: hit.model, index: hit.index } : null };
    const el = document.createElement('div');
    el.className = 'elev-label';
    el.innerHTML = `<svg width="14" height="10" viewBox="0 0 14 10"><path d="M1 1h12L7 9z" fill="#fff" stroke="#000" stroke-width="1.4"/></svg><span>${text}</span>`;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.remove(item); });
    el.appendChild(x);
    el.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.selectItem(item); });
    item.labels.push(this.viewer.addLabel(el, p.clone()));
    return this.register(item);
  }

  /** Re-render elevation labels after the reference changed. */
  refreshElevations() {
    for (const it of this.items) {
      if (it.type !== 'elevation') continue;
      const span = it.labels[0].el.querySelector('span');
      span.textContent = this.fmtElev(it.points[0], it.hit);
    }
  }

  selectItem(item) {
    this.selected = item;
    for (const it of this.items) for (const l of it.labels) l.el.classList.toggle('selected', it === item);
  }

  remove(item) {
    if (!item) return;
    for (const o of item.objects) { this.viewer.overlay.remove(o); o.geometry.dispose(); o.material.dispose(); }
    for (const l of item.labels) this.viewer.removeLabel(l);
    this.items = this.items.filter((i) => i !== item);
    if (this.selected === item) this.selected = null;
    this.viewer.requestRender();
    this.dispatchEvent(new Event('change'));
  }

  deleteSelected() {
    if (!this.selected) return false;
    this.remove(this.selected);
    return true;
  }

  clear() {
    for (const it of [...this.items]) this.remove(it);
    this.cancelPending();
  }

  /** BCF lines for the current dimensions. */
  toBcfLines() {
    const M = this.app.models;
    const lines = [];
    for (const it of this.items) {
      if (it.type === 'distance') lines.push({ start: M.toIfc(it.points[0]), end: M.toIfc(it.points[1]) });
    }
    return lines;
  }
}
