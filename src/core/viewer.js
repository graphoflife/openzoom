import * as THREE from 'three';
import { sharedUniforms } from './materials.js';

const BACKGROUNDS = {
  zoom: ['#2c5d9c', '#9cc0e8'],
  light: ['#d9dee6', '#ffffff'],
  dark: ['#1b1f27', '#3b4250'],
  white: ['#ffffff', '#ffffff'],
};

/** Renderer, scene, cameras, on-demand render loop and picking. */
export class Viewer extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.sortObjects = true;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;

    this.scene = new THREE.Scene();
    this.overlay = new THREE.Scene(); // measurements, gizmos: drawn without clipping on top
    this.perspCam = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
    this.orthoCam = new THREE.OrthographicCamera(-10, 10, 10, -10, -5000, 5000);
    this.camera = this.perspCam;
    this.perspCam.position.set(20, 15, 25);
    this.perspCam.lookAt(0, 0, 0);

    this.labels = document.createElement('div');
    this.labels.className = 'label-layer';
    container.appendChild(this.labels);
    this.labelItems = new Set();

    this.clipPlanes = [];
    this.clippingSuspended = false;
    this.raycaster = new THREE.Raycaster();
    this.needsRender = true;
    this.onBeforeRender = [];
    this.setBackground('zoom');

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      for (const fn of this.onBeforeRender) fn();
      if (this.needsRender) {
        this.needsRender = false;
        this.render();
      }
    };
    loop();
  }

  setBackground(name) {
    const [top, bottom] = BACKGROUNDS[name] || BACKGROUNDS.zoom;
    const c = document.createElement('canvas');
    c.width = 4; c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    if (this.scene.background) this.scene.background.dispose();
    this.scene.background = tex;
    this.backgroundName = name;
    this.requestRender();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.perspCam.aspect = w / h;
    this.perspCam.updateProjectionMatrix();
    this.updateOrtho();
    this.requestRender();
  }

  get aspect() { return (this.container.clientWidth || 1) / (this.container.clientHeight || 1); }

  updateOrtho() {
    const o = this.orthoCam;
    const hh = (o.userData.height || 20) / 2;
    o.left = -hh * this.aspect; o.right = hh * this.aspect; o.top = hh; o.bottom = -hh;
    o.updateProjectionMatrix();
  }

  requestRender() { this.needsRender = true; }

  setClipPlanes(planes) {
    this.clipPlanes = planes;
    this.applyClipping();
  }

  /** Section planes clip only the model materials (local clipping), not helpers. */
  applyClipping() {
    const active = this.clippingSuspended ? [] : this.clipPlanes;
    this.scene.traverse((o) => {
      const m = o.material;
      if (m && m.userData.clippable) m.clippingPlanes = active;
    });
    sharedUniforms.uSection.value = active.length ? 1 : 0;
    this.requestRender();
  }

  render() {
    const r = this.renderer;
    r.autoClear = true;
    r.render(this.scene, this.camera);
    r.autoClear = false;
    r.clearDepth();
    r.render(this.overlay, this.camera);
    this.updateLabels();
    this.dispatchEvent(new Event('render'));
  }

  // --- HTML labels anchored at 3D points -----------------------------------
  addLabel(el, position) {
    const item = { el, position };
    this.labels.appendChild(el);
    this.labelItems.add(item);
    this.requestRender();
    return item;
  }

  removeLabel(item) {
    if (!item) return;
    item.el.remove();
    this.labelItems.delete(item);
    this.requestRender();
  }

  updateLabels() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const v = new THREE.Vector3();
    for (const item of this.labelItems) {
      v.copy(item.position).project(this.camera);
      const hidden = v.z > 1 || v.z < -1 || item.hidden;
      item.el.style.display = hidden ? 'none' : '';
      if (!hidden) item.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
  }

  // --- Picking ----------------------------------------------------------------
  ndc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  rayFrom(clientX, clientY) {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    return this.raycaster.ray;
  }

  isClipped(point) {
    if (this.clippingSuspended) return false;
    for (const p of this.clipPlanes) if (p.distanceToPoint(point) < -1e-6) return true;
    return false;
  }

  /**
   * Pick the nearest visible element under the cursor.
   * @returns {{gid, model, index, point, normal, face, chunk}|null}
   */
  pick(clientX, clientY, models, { includeHidden = false } = {}) {
    const ray = this.rayFrom(clientX, clientY).clone();
    let best = null;
    for (const model of models) {
      if (!model.visible) continue;
      for (const mesh of model.meshes) {
        const g = mesh.geometry;
        const hits = g.boundsTree.raycast(ray, THREE.DoubleSide);
        for (const h of hits) {
          if (best && h.distance >= best.distance) continue;
          const eid = g.attributes.eid.array[h.face.a];
          if (!includeHidden && !model.isVisible(eid)) continue;
          if (this.isClipped(h.point)) continue;
          best = { distance: h.distance, gid: model.base + eid, model, index: eid, point: h.point.clone(), face: h.face, chunk: mesh.userData.chunk, mesh };
        }
      }
    }
    if (best) {
      const n = best.face.normal.clone();
      if (n.dot(ray.direction) > 0) n.negate();
      best.normal = n;
    }
    return best;
  }

  screenshot(type = 'image/png', quality) {
    this.render();
    return this.canvas.toDataURL(type, quality);
  }
}
