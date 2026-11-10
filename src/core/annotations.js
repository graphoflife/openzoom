import * as THREE from 'three';
import { promptDialog } from '../ui/dom.js';

const COLOR = 0xe8202a;

function disposeLine(viewer, obj) {
  if (!obj) return;
  viewer.overlay.remove(obj);
  obj.geometry.dispose();
  obj.material.dispose();
}

/**
 * Markup drawn on a plane in 3D: click a surface to draw on it, Shift = plane facing the camera.
 * Tools: line, arrow, ellipse, cloud, rect, text.
 */
export class Annotations {
  constructor(app) {
    this.app = app;
    this.viewer = app.viewer;
    this.items = [];
    this.selected = null;
    this.drag = null;
  }

  /** The tool for app.setTool that draws one kind of markup by dragging. */
  tool(kind) {
    return {
      id: `ann.${kind}`, hint: 'status.annotate',
      down: (e) => this.down(e, kind),
      move: (e) => this.move(e),
      up: () => this.up(),
    };
  }

  down(e, kind) {
    const hit = this.viewer.pick(e.clientX, e.clientY, this.app.models.models);
    const cam = this.viewer.camera;
    const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    let point, normal;
    if (hit && !e.shiftKey) {
      point = hit.point.clone();
      normal = hit.normal.clone();
    } else {
      const ray = this.viewer.rayFrom(e.clientX, e.clientY);
      const dist = hit ? hit.distance : cam.position.distanceTo(this.app.controls.target);
      point = ray.at(dist, new THREE.Vector3());
      normal = camDir.clone().negate();
    }
    point.addScaledVector(normal, 0.01);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    let v = camUp.clone().projectOnPlane(normal);
    if (v.lengthSq() < 1e-6) v = new THREE.Vector3(0, 0, -1).projectOnPlane(normal);
    v.normalize();
    const u = new THREE.Vector3().crossVectors(v, normal).normalize();
    this.drag = { kind, plane, origin: point, u, v, end: point.clone(), obj: null };
    return true;
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    const ray = this.viewer.rayFrom(e.clientX, e.clientY);
    const p = ray.intersectPlane(d.plane, new THREE.Vector3());
    if (!p) return;
    d.end.copy(p);
    disposeLine(this.viewer, d.obj);
    d.obj = this.build(d);
    if (d.obj) this.viewer.overlay.add(d.obj);
  }

  async up() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    disposeLine(this.viewer, d.obj);
    if (d.kind === 'text') {
      const text = await promptDialog(this.app.t('cmd.annText'), this.app.t('cmd.annText'), '');
      if (text) this.addItem({ kind: 'text', text, origin: d.origin.clone(), end: d.end.clone(), plane: d.plane, u: d.u, v: d.v });
      return;
    }
    if (d.origin.distanceTo(d.end) < 1e-3) return;
    this.addItem({ ...d, end: d.end.clone(), obj: null });
  }

  addItem(it) {
    it.obj = it.kind === 'text' ? null : this.build(it);
    if (it.obj) this.viewer.overlay.add(it.obj);
    if (it.kind === 'text' || it.kind === 'arrow') {
      const el = document.createElement('div');
      el.className = 'ann-label';
      el.textContent = it.text || '';
      if (it.kind === 'text') {
        el.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.select(it); });
        it.label = this.viewer.addLabel(el, it.origin.clone());
      }
    }
    this.items.push(it);
    this.viewer.requestRender();
  }

  /** Line geometry for a shape in its plane coordinates. */
  build(d) {
    const { origin, end, u, v } = d;
    const rel = end.clone().sub(origin);
    const a = rel.dot(u), b = rel.dot(v);
    const P = (x, y) => origin.clone().addScaledVector(u, x).addScaledVector(v, y);
    let pts = [];
    if (d.kind === 'line') pts = [origin, end];
    else if (d.kind === 'arrow') {
      const len = Math.hypot(a, b) || 1;
      const dx = a / len, dy = b / len;
      const s = Math.min(len * 0.25, this.app.controls.worldPerPixel(end) * 18);
      const left = P(a - s * (dx * 0.87 - dy * 0.5), b - s * (dy * 0.87 + dx * 0.5));
      const right = P(a - s * (dx * 0.87 + dy * 0.5), b - s * (dy * 0.87 - dx * 0.5));
      pts = [origin, end, left, end, right];
    } else if (d.kind === 'rect') pts = [P(0, 0), P(a, 0), P(a, b), P(0, b), P(0, 0)];
    else if (d.kind === 'ellipse') {
      for (let k = 0; k <= 64; k++) {
        const t = (k / 64) * Math.PI * 2;
        pts.push(P(a / 2 + (a / 2) * Math.cos(t), b / 2 + (b / 2) * Math.sin(t)));
      }
    } else if (d.kind === 'cloud') {
      const corners = [[0, 0], [a, 0], [a, b], [0, b], [0, 0]];
      const r = Math.max(Math.min(Math.abs(a), Math.abs(b)) / 8, 1e-3);
      for (let k = 0; k < 4; k++) {
        const [x0, y0] = corners[k], [x1, y1] = corners[k + 1];
        const len = Math.hypot(x1 - x0, y1 - y0);
        const n = Math.max(1, Math.round(len / (2 * r)));
        const nx = (y1 - y0) / len, ny = -(x1 - x0) / len;
        const outward = Math.sign(a * b) || 1;
        for (let s = 0; s < n; s++) {
          for (let q = 0; q <= 8; q++) {
            const t = (s + q / 8) / n;
            const bump = Math.sin((q / 8) * Math.PI) * r * 0.8 * outward;
            pts.push(P(x0 + (x1 - x0) * t - nx * bump, y0 + (y1 - y0) * t - ny * bump));
          }
        }
      }
    } else return null;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true }));
    line.renderOrder = 11;
    return line;
  }

  select(it) {
    this.selected = it;
    for (const x of this.items) x.label?.el.classList.toggle('selected', x === it);
  }

  deleteSelected() {
    if (!this.selected) return false;
    this.remove(this.selected);
    return true;
  }

  remove(it) {
    if (it.obj) { this.viewer.overlay.remove(it.obj); it.obj.geometry.dispose(); it.obj.material.dispose(); }
    if (it.label) this.viewer.removeLabel(it.label);
    this.items = this.items.filter((x) => x !== it);
    if (this.selected === it) this.selected = null;
    this.viewer.requestRender();
  }

  clear() { for (const it of [...this.items]) this.remove(it); }

  /** Draw all HTML labels (dimensions, elevations, texts) into a snapshot canvas. */
  drawOnto(g, w, h) {
    const v = new THREE.Vector3();
    g.font = `${Math.round(12 * (w / this.viewer.canvas.clientWidth))}px sans-serif`;
    g.textBaseline = 'middle';
    for (const item of this.viewer.labelItems) {
      if (item.hidden || item.el.style.display === 'none') continue;
      const text = (item.el.querySelector('b')?.textContent || item.el.querySelector('span')?.textContent || item.el.textContent || '').replace('×', '').trim();
      if (!text) continue;
      v.copy(item.position).project(this.viewer.camera);
      const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h;
      const tw = g.measureText(text).width + 8;
      const isAnn = item.el.classList.contains('ann-label');
      g.fillStyle = isAnn ? 'rgba(255,255,255,0.9)' : 'rgba(30,30,30,0.85)';
      g.fillRect(x - tw / 2, y - 9, tw, 18);
      g.fillStyle = isAnn ? '#e8202a' : '#ffd400';
      g.textAlign = 'center';
      g.fillText(text, x, y);
    }
  }
}
