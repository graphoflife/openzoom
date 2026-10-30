import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Navigation like BIMcollab Zoom:
 * Orbit: left drag rotate, Shift+left / middle drag pan, wheel zoom (Alt = fast),
 *        arrows pan, double middle click = zoom to fit.
 * Fly:   W/S/A/D, Q/E turn, PageUp/PageDown elevator, Alt+Up/Down look, ',' '.' speed.
 */
export class Controls extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.viewer = app.viewer;
    this.canvas = this.viewer.canvas;
    this.mode = 'orbit';
    this.target = new THREE.Vector3();
    this.pivot = new THREE.Vector3();
    this.flySpeed = 4; // m/s
    this.keys = new Set();
    this.drag = null;
    this.lastMiddle = 0;
    this.anim = null;
    this.sceneRadius = 50;

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('auxclick', (e) => e.preventDefault());
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.viewer.onBeforeRender.push(() => this.tick());
    this.lastTick = performance.now();
    this.pointers = new Map();
    this.interceptors = []; // tools that may take over a drag: {down(e)->bool, move(e), up(e), hover?(e)}
    this.captured = null;
  }

  get camera() { return this.viewer.camera; }

  setMode(mode) {
    this.mode = mode;
    this.dispatchEvent(new Event('mode'));
  }

  // --- Pointer handling ------------------------------------------------------
  onDown(e) {
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.stopAnimation();
    if (e.button === 0) {
      for (const it of this.interceptors) {
        if (it.down(e)) { this.captured = it; return; }
      }
    }
    if (e.button === 1) {
      e.preventDefault();
      const now = performance.now();
      if (now - this.lastMiddle < 350) { this.app.zoomToFit(); this.lastMiddle = 0; return; }
      this.lastMiddle = now;
    }
    let action = null;
    if (this.pointers.size === 2) action = 'pinch';
    else if (e.button === 1 || (e.button === 0 && e.shiftKey && this.mode === 'orbit') || e.button === 2) action = e.button === 2 ? 'none' : 'pan';
    else if (e.button === 0) action = this.mode === 'fly' ? 'look' : 'rotate';
    const hit = action === 'rotate' || action === 'pan' ? this.app.pickPoint(e.clientX, e.clientY) : null;
    if (action === 'rotate') this.pivot.copy(hit || this.target);
    if (action === 'pan') this.panDepthPoint = hit ? hit.clone() : this.target.clone();
    this.drag = { action, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button, moved: false, e };
  }

  onMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.captured) { this.captured.move(e); this.viewer.requestRender(); return; }
    const d = this.drag;
    if (!d) {
      for (const it of this.interceptors) it.hover?.(e);
      this.dispatchEvent(new CustomEvent('hover', { detail: e }));
      return;
    }
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true;
    if (!d.moved) return;
    d.x = e.clientX; d.y = e.clientY;
    if (d.action === 'rotate') this.rotate(dx, dy);
    else if (d.action === 'look') this.look(dx, dy);
    else if (d.action === 'pan') this.pan(dx, dy);
    else if (d.action === 'pinch') this.pinch();
    this.viewer.requestRender();
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.captured) { this.captured.up(e); this.captured = null; this.dispatchEvent(new Event('change')); return; }
    const d = this.drag;
    this.drag = null;
    this.lastPinch = null;
    if (!d) return;
    if (!d.moved && d.action !== 'pinch') {
      this.dispatchEvent(new CustomEvent('click', { detail: { event: e, button: d.button } }));
    }
    if (d.moved) this.dispatchEvent(new Event('change'));
  }

  onWheel(e) {
    e.preventDefault();
    this.stopAnimation();
    const delta = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) / 100, 3);
    if (e.ctrlKey || e.metaKey) {
      this.dispatchEvent(new CustomEvent('ctrlwheel', { detail: { delta, event: e } }));
      return;
    }
    const fast = e.altKey;
    const hit = this.app.pickPoint(e.clientX, e.clientY);
    this.zoomAt(e.clientX, e.clientY, delta * (fast ? 3 : 1), hit);
    this.dispatchEvent(new Event('change'));
  }

  // --- Camera operations -------------------------------------------------------
  rotate(dx, dy) {
    const cam = this.camera;
    const speed = 0.005;
    // yaw around world up through pivot
    _q.setFromAxisAngle(UP, -dx * speed);
    this.rotateAround(this.pivot, _q);
    // pitch around camera right axis, clamped to avoid flipping
    const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion);
    const fwd = _w.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
    let dp = -dy * speed;
    const limit = Math.PI / 2 - 0.01;
    if (pitch + dp > limit) dp = limit - pitch;
    if (pitch + dp < -limit) dp = -limit - pitch;
    _q.setFromAxisAngle(right, dp);
    this.rotateAround(this.pivot, _q);
  }

  rotateAround(point, q) {
    const cam = this.camera;
    cam.position.sub(point).applyQuaternion(q).add(point);
    this.target.sub(point).applyQuaternion(q).add(point);
    cam.quaternion.premultiply(q);
    this.syncOther();
  }

  look(dx, dy) {
    const cam = this.camera;
    const dist = cam.position.distanceTo(this.target);
    this.pivot.copy(cam.position);
    this.rotate(-dx * 0.5, -dy * 0.5);
    this.target.copy(cam.position).add(_v.set(0, 0, -1).applyQuaternion(cam.quaternion).multiplyScalar(dist || 10));
  }

  worldPerPixel(point) {
    const cam = this.camera;
    const h = this.canvas.clientHeight || 1;
    if (cam.isOrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / h;
    const fwd = _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const depth = Math.max(0.1, _w.copy(point).sub(cam.position).dot(fwd));
    return (2 * depth * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / h;
  }

  pan(dx, dy) {
    const cam = this.camera;
    const s = this.worldPerPixel(this.panDepthPoint || this.target);
    const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(-dx * s);
    const up = _w.set(0, 1, 0).applyQuaternion(cam.quaternion).multiplyScalar(dy * s);
    const move = right.add(up);
    cam.position.add(move);
    this.target.add(move);
    this.syncOther();
  }

  pinch() {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
    if (this.lastPinch) {
      const f = this.lastPinch.dist / dist;
      this.zoomAt(cx, cy, (f - 1) * 6, null);
      this.panDepthPoint = this.target.clone();
      this.pan(cx - this.lastPinch.cx, cy - this.lastPinch.cy);
    }
    this.lastPinch = { dist, cx, cy };
  }

  zoomAt(clientX, clientY, delta, hit) {
    const cam = this.camera;
    const factor = Math.pow(1.18, delta);
    if (cam.isOrthographicCamera) {
      const before = this.unproject(clientX, clientY);
      cam.zoom = THREE.MathUtils.clamp(cam.zoom / factor, 0.001, 10000);
      cam.updateProjectionMatrix();
      const after = this.unproject(clientX, clientY);
      const d = before.sub(after);
      cam.position.add(d);
      this.target.add(d);
    } else {
      const ray = this.viewer.rayFrom(clientX, clientY).clone();
      const dist = hit ? hit.distanceTo(cam.position) : Math.max(cam.position.distanceTo(this.target), 1);
      let step = dist * (1 - 1 / factor); // > 0 zooms out, < 0 zooms in
      if (delta < 0 && dist < 0.3) step = -0.3; // allow pushing through when very close
      const move = ray.direction.clone().multiplyScalar(-step);
      cam.position.add(move);
      if (hit) this.target.copy(hit);
      else {
        const fwd = _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
        if (_w.copy(this.target).sub(cam.position).dot(fwd) < 0.5) this.target.add(move);
      }
    }
    this.syncOther();
    this.viewer.requestRender();
  }

  unproject(clientX, clientY) {
    const ndc = this.viewer.ndc(clientX, clientY);
    return new THREE.Vector3(ndc.x, ndc.y, 0).unproject(this.camera);
  }

  /** Keep the inactive camera in sync so switching projection keeps the view. */
  syncOther() {
    const v = this.viewer;
    const p = v.perspCam, o = v.orthoCam;
    if (v.camera === p) {
      o.position.copy(p.position);
      o.quaternion.copy(p.quaternion);
      const dist = Math.max(p.position.distanceTo(this.target), 0.5);
      o.userData.height = 2 * dist * Math.tan(THREE.MathUtils.degToRad(p.fov / 2));
      o.zoom = 1;
      v.updateOrtho();
    } else {
      p.quaternion.copy(o.quaternion);
      const h = (o.top - o.bottom) / o.zoom;
      const dist = h / (2 * Math.tan(THREE.MathUtils.degToRad(p.fov / 2)));
      const fwd = _v.set(0, 0, -1).applyQuaternion(o.quaternion);
      // orthographic camera sits far back; perspective is placed at matching distance from target
      const depth = _w.copy(this.target).sub(o.position).dot(fwd);
      p.position.copy(o.position).add(fwd.multiplyScalar(depth - dist));
    }
    this.updateClipRange();
  }

  updateClipRange() {
    const p = this.viewer.perspCam;
    const r = this.sceneRadius;
    p.near = THREE.MathUtils.clamp(r / 2000, 0.01, 0.5);
    p.far = Math.max(r * 20, 1000);
    p.updateProjectionMatrix();
    const o = this.viewer.orthoCam;
    o.near = -r * 20; o.far = r * 20;
    o.updateProjectionMatrix();
  }

  setProjection(type) {
    const v = this.viewer;
    const want = type === 'orthographic' ? v.orthoCam : v.perspCam;
    if (v.camera === want) return;
    this.syncOther();
    v.camera = want;
    this.syncOther();
    v.requestRender();
    this.dispatchEvent(new Event('projection'));
  }

  get isOrtho() { return this.viewer.camera.isOrthographicCamera; }

  // --- Animated view changes -----------------------------------------------
  /** Place the camera looking along `dir` at `box`, optionally animated. */
  fitBox(box, dir, animate = true, up) {
    if (!box || box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 0.5);
    const cam = this.viewer.perspCam;
    const fov = THREE.MathUtils.degToRad(cam.fov);
    const fovH = 2 * Math.atan(Math.tan(fov / 2) * this.viewer.aspect);
    const dist = r / Math.sin(Math.min(fov, fovH) / 2) * 1.05;
    const d = (dir ? dir.clone() : _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion).clone()).normalize();
    const pos = sphere.center.clone().sub(d.clone().multiplyScalar(dist));
    // orthographic: fit the sphere into the narrower screen dimension
    this.flyTo(pos, sphere.center, animate, up, (2 * r * 1.1) / Math.min(1, this.viewer.aspect));
  }

  flyTo(position, target, animate = true, up, orthoHeight) {
    const cam = this.camera;
    const m = new THREE.Matrix4().lookAt(position, target, up || UP);
    const endQ = new THREE.Quaternion().setFromRotationMatrix(m);
    if (Math.abs(_v.copy(target).sub(position).normalize().y) > 0.999 && !up) {
      // looking straight up/down: keep north (IFC +Y = -Z) up
      const m2 = new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, 0, -1));
      endQ.setFromRotationMatrix(m2);
    }
    const start = { pos: cam.position.clone(), q: cam.quaternion.clone(), target: this.target.clone(), h: this.viewer.orthoCam.userData.height, zoom: this.viewer.orthoCam.zoom };
    const end = { pos: position.clone(), q: endQ, target: target.clone(), h: orthoHeight };
    const apply = (t) => {
      const v = this.viewer;
      const k = t * t * (3 - 2 * t);
      if (v.camera.isOrthographicCamera) {
        // ortho camera stays far back along the view direction
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().slerpQuaternions(start.q, end.q, k));
        const tgt = new THREE.Vector3().lerpVectors(start.target, end.target, k);
        v.orthoCam.position.copy(tgt).sub(fwd.multiplyScalar(this.sceneRadius * 4));
        v.orthoCam.quaternion.slerpQuaternions(start.q, end.q, k);
        if (end.h) {
          const h0 = (start.h || end.h) / (start.zoom || 1);
          v.orthoCam.userData.height = h0 + (end.h - h0) * k;
          v.orthoCam.zoom = 1;
          v.updateOrtho();
        }
        this.target.copy(tgt);
        this.syncOther();
      } else {
        cam.position.lerpVectors(start.pos, end.pos, k);
        cam.quaternion.slerpQuaternions(start.q, end.q, k);
        this.target.lerpVectors(start.target, end.target, k);
        this.syncOther();
      }
      v.requestRender();
    };
    this.stopAnimation();
    if (!animate) { apply(1); this.dispatchEvent(new Event('change')); return; }
    const t0 = performance.now();
    this.anim = { step: () => {
      const t = Math.min(1, (performance.now() - t0) / 450);
      apply(t);
      if (t >= 1) { this.anim = null; this.dispatchEvent(new Event('change')); }
    } };
  }

  stopAnimation() { this.anim = null; }

  // --- Keyboard driven movement (fly mode + arrow panning) -----------------------
  keyDown(e) {
    const flyKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'PageUp', 'PageDown'];
    const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (e.ctrlKey || e.metaKey) return false;
    if (this.mode === 'fly' && !e.altKey && flyKeys.includes(e.code)) { this.keys.add(e.code); return true; }
    if (arrows.includes(e.code)) {
      if (this.mode === 'fly' && e.altKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
        this.pivot.copy(this.camera.position);
        this.rotate(0, e.code === 'ArrowUp' ? -25 : 25);
        this.viewer.requestRender();
        return true;
      }
      if (e.altKey) return false;
      this.keys.add(e.code);
      this.fastPan = e.shiftKey;
      return true;
    }
    if (this.mode === 'fly' && (e.key === ',' || e.key === '.')) {
      this.flySpeed = THREE.MathUtils.clamp(this.flySpeed * (e.key === '.' ? 1.5 : 1 / 1.5), 0.2, 200);
      this.dispatchEvent(new Event('speed'));
      return true;
    }
    return false;
  }

  levelCamera() {
    const cam = this.camera;
    const fwd = _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) return;
    const tgt = cam.position.clone().add(fwd.normalize().multiplyScalar(Math.max(cam.position.distanceTo(this.target), 2)));
    this.flyTo(cam.position.clone(), tgt, true);
  }

  tick() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (this.anim) this.anim.step();
    if (!this.keys.size) return;
    const cam = this.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const move = new THREE.Vector3();
    if (this.mode === 'fly') {
      const flat = fwd.clone(); flat.y = 0; flat.normalize();
      const s = this.flySpeed * dt;
      if (this.keys.has('KeyW')) move.addScaledVector(flat, s);
      if (this.keys.has('KeyS')) move.addScaledVector(flat, -s);
      if (this.keys.has('KeyA')) move.addScaledVector(right, -s);
      if (this.keys.has('KeyD')) move.addScaledVector(right, s);
      if (this.keys.has('PageUp')) move.y += s;
      if (this.keys.has('PageDown')) move.y -= s;
      if (this.keys.has('KeyQ') || this.keys.has('KeyE')) {
        this.pivot.copy(cam.position);
        _q.setFromAxisAngle(UP, (this.keys.has('KeyQ') ? 1 : -1) * dt * 1.2);
        this.rotateAround(this.pivot, _q);
      }
    }
    const px = (this.fastPan ? 900 : 300) * dt;
    if (this.keys.has('ArrowLeft') || this.keys.has('ArrowRight') || this.keys.has('ArrowUp') || this.keys.has('ArrowDown')) {
      this.panDepthPoint = this.target.clone();
      const dx = (this.keys.has('ArrowLeft') ? -px : 0) + (this.keys.has('ArrowRight') ? px : 0);
      const dy = (this.keys.has('ArrowUp') ? -px : 0) + (this.keys.has('ArrowDown') ? px : 0);
      if (this.mode === 'fly' && (this.keys.has('ArrowUp') || this.keys.has('ArrowDown'))) {
        move.addScaledVector(fwd, (this.keys.has('ArrowUp') ? 1 : -1) * this.flySpeed * dt);
        this.pan(-dx, 0);
      } else this.pan(-dx, -dy);
    }
    if (move.lengthSq()) {
      cam.position.add(move);
      this.target.add(move);
      this.syncOther();
    }
    this.viewer.requestRender();
  }
}
