import * as THREE from 'three';
import { exportBCF, importBCF, newGuid, colorToBcf, bcfToColor } from './bcf.js';

// Tiny IndexedDB key/value store (issues contain snapshots, too big for localStorage).
const DB = 'openzoom';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function kvGet(key) {
  try {
    const db = await idb();
    return await new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); });
  } catch { return undefined; }
}
export async function kvSet(key, value) {
  try {
    const db = await idb();
    await new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); tx.oncomplete = res; tx.onerror = res; });
  } catch { /* private mode */ }
}

/** BCF issues: create from the current view, restore viewpoints, import/export. */
export class IssueManager extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.issues = [];
    this.selected = null;
    kvGet('issues').then((list) => { if (Array.isArray(list) && !this.issues.length) { this.issues = list; this.changed(false); } });
  }

  changed(persist = true) {
    if (persist) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => kvSet('issues', this.issues), 400);
    }
    this.dispatchEvent(new Event('change'));
  }

  author() { return this.app.settings.get('author') || 'OpenZoom'; }

  /** Capture camera, visibility, colours, selection and clipping as a BCF viewpoint. */
  captureViewpoint() {
    const app = this.app;
    const M = app.models;
    const cam = app.viewer.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const camera = cam.isOrthographicCamera
      ? { type: 'orthographic', position: M.toIfc(cam.position), direction: M.dirToIfc(dir), up: M.dirToIfc(up), viewToWorldScale: (cam.top - cam.bottom) / cam.zoom, aspectRatio: app.viewer.aspect }
      : { type: 'perspective', position: M.toIfc(cam.position), direction: M.dirToIfc(dir), up: M.dirToIfc(up), fov: cam.fov, aspectRatio: app.viewer.aspect };
    const visible = [], hidden = [];
    const colors = new Map();
    let spacesVisible = false, openingsVisible = false;
    for (const m of M.models) {
      for (let i = 0; i < m.count; i++) {
        if (!m.hasGeom[i]) continue;
        const el = m.elements[i];
        if (!el.guid) continue;
        const vis = m.visible && m.isVisible(i);
        (vis ? visible : hidden).push(el.guid);
        if (vis && el.cls === 'IfcSpace') spacesVisible = true;
        if (vis && el.supers.includes('IfcOpeningElement')) openingsVisible = true;
        if (vis && m.colors[i * 4 + 3]) {
          const key = colorToBcf(m.colors[i * 4], m.colors[i * 4 + 1], m.colors[i * 4 + 2]);
          if (!colors.has(key)) colors.set(key, []);
          colors.get(key).push(el.guid);
        }
      }
    }
    const defaultVisible = visible.length >= hidden.length;
    const selection = [];
    for (const gid of app.state.selection) { const el = M.element(gid); if (el?.guid) selection.push(el.guid); }
    return {
      guid: newGuid(),
      snapshot: this.snapshot(),
      camera,
      components: {
        selection,
        visibilityDefault: defaultVisible,
        exceptions: defaultVisible ? hidden : visible,
        coloring: [...colors].map(([color, guids]) => ({ color, guids })),
        viewSetupHints: { spacesVisible, spaceBoundariesVisible: false, openingsVisible },
      },
      clippingPlanes: app.sections.toBcf(),
      lines: app.measure.toBcfLines(),
    };
  }

  snapshot() {
    const src = this.app.viewer.canvas;
    this.app.viewer.render();
    const w = Math.min(1280, src.width);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = Math.round((src.height / src.width) * w);
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, c.width, c.height);
    this.app.annotations?.drawOnto(g, c.width, c.height);
    return c.toDataURL('image/png');
  }

  create(fields = {}) {
    const now = new Date().toISOString();
    const issue = {
      guid: newGuid(), title: fields.title || `Issue ${this.issues.length + 1}`, description: fields.description || '',
      status: 'Open', type: fields.type || 'Issue', priority: fields.priority || 'Normal', assignedTo: '', stage: '', labels: fields.labels || [],
      dueDate: '', creationDate: now, creationAuthor: this.author(), modifiedDate: '', modifiedAuthor: '', index: this.issues.length + 1,
      referencedModels: this.app.models.models.map((m) => m.name), comments: [], viewpoints: [this.captureViewpoint()],
    };
    this.issues.push(issue);
    this.selected = issue;
    this.changed();
    return issue;
  }

  touch(issue) {
    issue.modifiedDate = new Date().toISOString();
    issue.modifiedAuthor = this.author();
    this.changed();
  }

  remove(issue) {
    this.issues = this.issues.filter((i) => i !== issue);
    if (this.selected === issue) this.selected = null;
    this.changed();
  }

  /** Apply a BCF viewpoint to the 3D view. */
  showViewpoint(vp) {
    if (!vp) return;
    const app = this.app;
    const M = app.models;
    const c = vp.components || {};
    if (M.models.length) {
      app.state.record();
      const exc = new Set(c.exceptions || []);
      const def = c.visibilityDefault !== false;
      const hints = c.viewSetupHints || {};
      app.state.showSpaces = !!hints.spacesVisible;
      app.state.showOpenings = !!hints.openingsVisible;
      const colorOf = new Map();
      for (const col of c.coloring || []) {
        const rgb = bcfToColor(col.color);
        if (rgb) for (const g of col.guids) colorOf.set(g, rgb);
      }
      for (const m of M.models) {
        // BCF has no model switch: element visibility carries it, so show the model itself
        m.visible = true;
        m.group.visible = true;
        for (let i = 0; i < m.count; i++) {
          const el = m.elements[i];
          let vis = exc.has(el.guid) ? !def : def;
          if (el.cls === 'IfcSpace' && !hints.spacesVisible && !exc.has(el.guid)) vis = false;
          if (el.supers.includes('IfcOpeningElement') && !hints.openingsVisible && !exc.has(el.guid)) vis = false;
          m.flags[i * 4] = vis ? 255 : 0;
          m.flags[i * 4 + 1] = 0;
          const rgb = colorOf.get(el.guid);
          if (rgb) { m.colors[i * 4] = rgb.r; m.colors[i * 4 + 1] = rgb.g; m.colors[i * 4 + 2] = rgb.b; m.colors[i * 4 + 3] = 255; } else m.colors[i * 4 + 3] = 0;
        }
      }
      app.state.legend = null;
      app.state.changed();
      const sel = [];
      for (const g of c.selection || []) { const gid = M.findByGuid(g); if (gid >= 0) sel.push(gid); }
      app.state.select(sel);
    }
    app.sections.fromBcf(vp.clippingPlanes || []);
    this.applyCamera(vp.camera);
  }

  /** Move the camera to a BCF camera (IFC coordinates). */
  applyCamera(cam) {
    const app = this.app;
    const M = app.models;
    if (cam && cam.position) {
      const pos = M.fromIfc(cam.position);
      const dir = M.dirFromIfc(cam.direction).normalize();
      const up = cam.up ? M.dirFromIfc(cam.up).normalize() : new THREE.Vector3(0, 1, 0);
      const dist = Math.max(app.controls.sceneRadius * 0.5, 5);
      const target = pos.clone().addScaledVector(dir, dist);
      if (cam.type === 'orthographic') {
        app.controls.setProjection('orthographic');
        app.controls.flyTo(pos, target, true, up, cam.viewToWorldScale || 20);
      } else {
        app.controls.setProjection('perspective');
        if (cam.fov) { app.viewer.perspCam.fov = THREE.MathUtils.clamp(cam.fov, 20, 100); app.viewer.perspCam.updateProjectionMatrix(); }
        app.controls.flyTo(pos, target, true, up);
      }
    }
  }

  exportBcf(version = '2.1') {
    const name = this.app.models.models[0]?.project?.name || 'OpenZoom';
    return exportBCF(this.issues, { version, projectName: name });
  }

  async importBcf(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const res = importBCF(buf);
    for (const issue of res.issues) {
      const idx = this.issues.findIndex((i) => i.guid === issue.guid);
      if (idx >= 0) this.issues[idx] = issue; else this.issues.push(issue);
    }
    this.changed();
    return res.issues.length;
  }
}
