import * as THREE from 'three';

const PLANE_COLOR = 0xff8a00;
const SEL_COLOR = 0xff3d00;
let nextId = 1;

/**
 * Section planes and section box.
 * Plane normals point to the kept side (three.js clipping convention).
 */
export class Sections extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.viewer = app.viewer;
    this.planes = []; // {id, plane, group, quad, outline, helperVisible}
    this.box = null; // {min, max, planes, group, handles}
    this.selected = null; // plane entry or null
    this.helpersVisible = true;
    this.suspended = false;
    this.creating = false;
    this.drag = null;
    app.controls.interceptors.push(this);
    app.controls.addEventListener('ctrlwheel', (e) => this.onCtrlWheel(e.detail.delta));
    // keep grips a constant size on screen
    this.viewer.onBeforeRender.push(() => this.scaleHandles());
  }

  get radius() { return this.app.controls.sceneRadius || 50; }

  // --- planes -------------------------------------------------------------------
  startCreatePlane() {
    this.creating = true;
    this.app.status(this.app.t('status.clickSurfacePlane'));
  }

  /**
   * Plane through point that cuts away the side the normal points to. The small
   * default offset keeps the clicked surface itself visible.
   */
  addPlane(point, normal, select = true, offset = 0.001) {
    const n = normal.clone().normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.clone().negate(), point.clone().addScaledVector(n, offset));
    const entry = { id: nextId++, plane, helperVisible: true };
    this.buildHelper(entry, point);
    this.planes.push(entry);
    if (select) this.select(entry);
    this.update();
    return entry;
  }

  addAxisPlane(axis) {
    const box = this.app.models.visibleBox();
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const n = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[axis];
    this.addPlane(c, n);
  }

  buildHelper(entry, anchor) {
    const size = this.radius * 2.2;
    const group = new THREE.Group();
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: PLANE_COLOR, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }),
    );
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)),
      new THREE.LineBasicMaterial({ color: PLANE_COLOR, transparent: true, opacity: 0.9 }),
    );
    quad.renderOrder = 5;
    group.add(quad, outline);
    // grip to drag the plane even where the cut model fills the screen
    const handle = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: PLANE_COLOR, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    handle.renderOrder = 12;
    entry.group = group;
    entry.quad = quad;
    entry.outline = outline;
    entry.handle = handle;
    entry.anchor = anchor.clone();
    this.viewer.scene.add(group);
    this.viewer.overlay.add(handle);
    this.placeHelper(entry);
  }

  placeHelper(entry) {
    const p = entry.plane;
    const center = p.projectPoint(entry.anchor, new THREE.Vector3());
    entry.group.position.copy(center);
    entry.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), p.normal);
    entry.group.visible = this.helpersVisible && entry.helperVisible && !this.suspended;
    entry.handle.position.copy(center);
    entry.handle.visible = entry.group.visible;
  }

  select(entry) {
    if (this.selected === entry) return;
    this.selected = entry;
    for (const e of this.planes) {
      const sel = e === entry;
      e.quad.material.opacity = sel ? 0.2 : 0.1;
      e.outline.material.color.setHex(sel ? SEL_COLOR : PLANE_COLOR);
      e.handle.material.color.setHex(sel ? SEL_COLOR : PLANE_COLOR);
    }
    this.viewer.requestRender();
    this.dispatchEvent(new Event('change'));
  }

  removePlane(entry) {
    if (!entry) return;
    this.viewer.scene.remove(entry.group);
    this.viewer.overlay.remove(entry.handle);
    entry.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    entry.handle.geometry.dispose();
    entry.handle.material.dispose();
    this.planes = this.planes.filter((e) => e !== entry);
    if (this.selected === entry) this.selected = null;
    if (this.floorPlan === entry) this.floorPlan = null;
    this.update();
  }

  deleteSelected() {
    if (this.selected) { this.removePlane(this.selected); return true; }
    return false;
  }

  deleteAll() {
    for (const e of [...this.planes]) this.removePlane(e);
    this.removeBox();
    this.update();
  }

  flipSelected() {
    const e = this.selected;
    if (!e) return;
    e.plane.negate();
    this.placeHelper(e);
    this.update();
  }

  toggleSelectedHelper() {
    if (!this.selected) return false;
    this.selected.helperVisible = !this.selected.helperVisible;
    this.placeHelper(this.selected);
    this.viewer.requestRender();
    return true;
  }

  toggleHelpers() {
    this.helpersVisible = !this.helpersVisible;
    this.refreshHelpers();
  }

  toggleSuspend() {
    this.suspended = !this.suspended;
    this.viewer.clippingSuspended = this.suspended;
    this.refreshHelpers();
    this.viewer.applyClipping();
    this.dispatchEvent(new Event('change'));
  }

  refreshHelpers() {
    for (const e of this.planes) this.placeHelper(e);
    if (this.box) this.box.group.visible = this.helpersVisible && !this.suspended;
    this.viewer.requestRender();
  }

  // --- box --------------------------------------------------------------------------
  createBox(box) {
    this.removeBox();
    if (!box || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const margin = Math.max(0.05, Math.max(size.x, size.y, size.z) * 0.02);
    const b = box.clone().expandByScalar(margin);
    const group = new THREE.Group();
    const lines = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: PLANE_COLOR, depthTest: false, transparent: true }),
    );
    group.add(lines);
    const handles = [];
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (let k = 0; k < 6; k++) {
      const h = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({ color: PLANE_COLOR, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      h.userData.face = k;
      h.userData.dir = new THREE.Vector3(...dirs[k]);
      handles.push(h);
      group.add(h);
    }
    this.viewer.overlay.add(group);
    this.box = { min: b.min.clone(), max: b.max.clone(), planes: Array.from({ length: 6 }, () => new THREE.Plane()), group, lines, handles };
    this.updateBox();
  }

  removeBox() {
    if (!this.box) return;
    this.viewer.overlay.remove(this.box.group);
    this.box.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.box = null;
    this.update();
  }

  updateBox() {
    const bx = this.box;
    const { min, max } = bx;
    const P = bx.planes;
    P[0].set(new THREE.Vector3(-1, 0, 0), max.x);
    P[1].set(new THREE.Vector3(1, 0, 0), -min.x);
    P[2].set(new THREE.Vector3(0, -1, 0), max.y);
    P[3].set(new THREE.Vector3(0, 1, 0), -min.y);
    P[4].set(new THREE.Vector3(0, 0, -1), max.z);
    P[5].set(new THREE.Vector3(0, 0, 1), -min.z);
    const c = min.clone().add(max).multiplyScalar(0.5);
    const s = max.clone().sub(min);
    bx.lines.position.copy(c);
    bx.lines.scale.set(Math.max(s.x, 1e-3), Math.max(s.y, 1e-3), Math.max(s.z, 1e-3));
    const centers = [
      [max.x, c.y, c.z], [min.x, c.y, c.z], [c.x, max.y, c.z], [c.x, min.y, c.z], [c.x, c.y, max.z], [c.x, c.y, min.z],
    ];
    bx.handles.forEach((h, k) => h.position.set(...centers[k]));
    this.scaleHandles();
    bx.group.visible = this.helpersVisible && !this.suspended;
    this.update();
  }

  scaleHandles() {
    const handles = this.planes.map((p) => p.handle);
    if (this.box) handles.push(...this.box.handles);
    for (const h of handles) h.scale.setScalar(this.app.controls.worldPerPixel(h.position) * 7);
  }

  onCtrlWheel(delta) {
    if (this.box) {
      const s = this.box.max.clone().sub(this.box.min);
      const step = Math.max(s.x, s.y, s.z) * 0.03 * -delta;
      this.box.min.addScalar(-step);
      this.box.max.addScalar(step);
      if (this.box.max.x <= this.box.min.x || this.box.max.y <= this.box.min.y || this.box.max.z <= this.box.min.z) {
        this.box.min.addScalar(step); this.box.max.addScalar(-step);
      }
      this.updateBox();
    } else if (this.selected) {
      this.selected.plane.constant += delta * this.radius * 0.01;
      this.placeHelper(this.selected);
      this.update();
    }
  }

  // --- pointer interaction (controls interceptor) --------------------------------------
  down(e) {
    if (this.creating) {
      const hit = this.app.viewer.pick(e.clientX, e.clientY, this.app.models.models);
      this.creating = false;
      this.app.status('');
      if (hit) this.addPlane(hit.point, hit.normal);
      return true;
    }
    if (e.shiftKey || e.altKey) return false;
    const ray = this.viewer.rayFrom(e.clientX, e.clientY).clone();
    if (this.box && this.box.group.visible) {
      this.scaleHandles();
      const rc = new THREE.Raycaster(ray.origin, ray.direction);
      const hits = rc.intersectObjects(this.box.handles, false);
      if (hits.length) {
        const h = hits[0].object;
        const axisPoint = h.position.clone();
        this.drag = { kind: 'box', face: h.userData.face, dir: h.userData.dir.clone(), origin: axisPoint, start: this.box[h.userData.face % 2 === 0 ? 'max' : 'min'].clone(), t0: this.axisParam(ray, axisPoint, h.userData.dir) };
        return true;
      }
    }
    // section planes: drag the grip, or the plane where no model is behind it
    const shown = this.planes.filter((p) => p.group.visible);
    if (!shown.length) return false;
    this.scaleHandles();
    const rc = new THREE.Raycaster(ray.origin, ray.direction);
    let hit = rc.intersectObjects(shown.map((p) => p.handle), false)[0];
    let entry = hit && shown.find((p) => p.handle === hit.object);
    if (!entry) {
      hit = rc.intersectObjects(shown.map((p) => p.quad), false)[0];
      if (!hit || this.app.viewer.pick(e.clientX, e.clientY, this.app.models.models)) return false;
      entry = shown.find((p) => p.quad === hit.object);
    }
    this.app.state.clearSelection();
    this.select(entry);
    const n = entry.plane.normal.clone();
    const origin = entry.plane.projectPoint(hit.point, new THREE.Vector3());
    this.drag = { kind: 'plane', entry, n, origin, c0: entry.plane.constant, t0: this.axisParam(ray, origin, n), moved: false };
    return true;
  }

  /** Parameter t of the point on line (origin + t*dir) closest to the ray. */
  axisParam(ray, origin, dir) {
    const w0 = origin.clone().sub(ray.origin);
    const a = dir.dot(dir), b = dir.dot(ray.direction), c = ray.direction.dot(ray.direction);
    const d = dir.dot(w0), e = ray.direction.dot(w0);
    const den = a * c - b * b;
    if (Math.abs(den) < 1e-9) return 0;
    return (b * e - c * d) / den;
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    const ray = this.viewer.rayFrom(e.clientX, e.clientY).clone();
    if (d.kind === 'plane') {
      const t = this.axisParam(ray, d.origin, d.n) - d.t0;
      d.entry.plane.constant = d.c0 - t;
      d.moved = true;
      this.placeHelper(d.entry);
      this.update();
    } else if (d.kind === 'box') {
      const t = this.axisParam(ray, d.origin, d.dir) - d.t0;
      const key = d.face % 2 === 0 ? 'max' : 'min';
      const axis = ['x', 'x', 'y', 'y', 'z', 'z'][d.face];
      const sign = d.face % 2 === 0 ? 1 : -1;
      let v = d.start[axis] + sign * t;
      if (key === 'max') v = Math.max(v, this.box.min[axis] + 0.01);
      else v = Math.min(v, this.box.max[axis] - 0.01);
      this.box[key][axis] = v;
      this.updateBox();
    }
  }

  up() { this.drag = null; }

  // --- state --------------------------------------------------------------------------
  allPlanes() {
    const out = this.planes.map((p) => p.plane);
    if (this.box) out.push(...this.box.planes);
    return out;
  }

  update() {
    this.viewer.setClipPlanes(this.allPlanes());
    this.dispatchEvent(new Event('change'));
  }

  get active() { return this.planes.length > 0 || !!this.box; }

  /** Floor plan: horizontal cut at the given height, keep everything below. */
  setFloorPlan(height) {
    this.clearFloorPlan();
    if (height === null || height === undefined) return;
    const box = this.app.models.visibleBox();
    const anchor = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    anchor.y = height;
    const entry = this.addPlane(anchor, new THREE.Vector3(0, 1, 0), false);
    entry.floorPlan = true;
    entry.helperVisible = false;
    this.placeHelper(entry);
    this.floorPlan = entry;
  }

  clearFloorPlan() {
    if (this.floorPlan) this.removePlane(this.floorPlan);
    this.floorPlan = null;
  }

  // --- project file ---------------------------------------------------------------------
  serialize() {
    return {
      planes: this.planes.filter((p) => !p.floorPlan).map((p) => ({
        normal: p.plane.normal.toArray(), constant: p.plane.constant, anchor: p.anchor.toArray(), helperVisible: p.helperVisible,
      })),
      box: this.box ? { min: this.box.min.toArray(), max: this.box.max.toArray() } : null,
      suspended: this.suspended,
    };
  }

  deserialize(s) {
    this.deleteAll();
    if (!s) return;
    for (const p of s.planes || []) {
      const entry = { id: nextId++, plane: new THREE.Plane(new THREE.Vector3().fromArray(p.normal), p.constant), helperVisible: p.helperVisible !== false };
      this.buildHelper(entry, new THREE.Vector3().fromArray(p.anchor || [0, 0, 0]));
      this.planes.push(entry);
    }
    if (s.box) {
      this.createBox(new THREE.Box3(new THREE.Vector3().fromArray(s.box.min), new THREE.Vector3().fromArray(s.box.max)));
      // createBox adds a margin; restore the exact saved extents
      this.box.min.fromArray(s.box.min);
      this.box.max.fromArray(s.box.max);
      this.updateBox();
    }
    if (!!s.suspended !== this.suspended) this.toggleSuspend();
    this.update();
  }

  // --- BCF conversion ------------------------------------------------------------------
  toBcf() {
    const M = this.app.models;
    return this.allPlanes().map((p) => {
      const loc = p.coplanarPoint(new THREE.Vector3());
      // BCF: direction points to the invisible (clipped) side
      return { location: M.toIfc(loc), direction: M.dirToIfc(p.normal.clone().negate()) };
    });
  }

  fromBcf(list) {
    this.deleteAll();
    const M = this.app.models;
    for (const c of list || []) {
      const p = M.fromIfc(c.location);
      const d = M.dirFromIfc(c.direction).normalize();
      this.addPlane(p, d, false, 0);
    }
    this.update();
  }
}
