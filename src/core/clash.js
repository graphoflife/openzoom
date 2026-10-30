import * as THREE from 'three';
import { elementGeometry, elementDistance } from './elementgeom.js';
import { evaluate, uuid } from './smartviews.js';

const IDENTITY = new THREE.Matrix4();
const NEVER = ['IfcSpace', 'IfcOpeningElement', 'IfcVirtualElement', 'IfcAnnotation', 'IfcGrid', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcZone'];

/**
 * Clash detection between two element sets.
 * Hard clash: triangle meshes intersect and the intersection-curve bounding box
 * is thicker than the tolerance (filters touching faces). Clearance: closest
 * distance below the clearance value.
 */
export class ClashManager extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.tests = [];
    this.running = null;
  }

  newTest(name) {
    const t = {
      guid: uuid(), name, mode: 'hard', tolerance: 0.01, clearance: 0.05,
      setA: { kind: 'types', value: ['IfcDistributionElement', 'IfcFlowSegment', 'IfcFlowFitting'] },
      setB: { kind: 'types', value: ['IfcBuildingElement', 'IfcBuiltElement'] },
      ignoreSameModel: false, results: [], lastRun: null,
    };
    this.tests.push(t);
    this.changed();
    return t;
  }

  removeTest(t) {
    this.tests = this.tests.filter((x) => x !== t);
    this.changed();
  }

  changed() { this.dispatchEvent(new Event('change')); }

  /** Resolve a set definition to gids of elements with geometry. */
  resolveSet(set) {
    const M = this.app.models;
    const ok = (m, i, el) => m.hasGeom[i] && m.visible && !NEVER.some((c) => el.supers.includes(c));
    switch (set.kind) {
      case 'all': return M.allGids(ok);
      case 'model': return M.allGids((m, i, el) => ok(m, i, el) && (set.value || []).includes(m.name));
      case 'types': return M.allGids((m, i, el) => ok(m, i, el) && (set.value || []).some((c) => el.supers.includes(c)));
      case 'visible': return M.allGids((m, i, el) => ok(m, i, el) && m.isVisible(i));
      case 'guids': {
        const s = new Set(set.value || []);
        return M.allGids((m, i, el) => ok(m, i, el) && s.has(el.guid));
      }
      case 'smartview': {
        const found = this.app.smartViews.findView(set.value);
        if (!found) return [];
        const res = evaluate(found.view, M.models);
        const out = [];
        for (const w of res.perModel) for (let i = 0; i < w.model.count; i++) if (w.vis[i] && ok(w.model, i, w.model.elements[i])) out.push(w.model.base + i);
        return out;
      }
      default: return [];
    }
  }

  cancel() { if (this.running) this.running.cancelled = true; }

  async run(test, onProgress) {
    const M = this.app.models;
    const job = { cancelled: false };
    this.running = job;
    const A = this.resolveSet(test.setA);
    const B = this.resolveSet(test.setB);
    const margin = test.mode === 'clearance' ? test.clearance : 0;
    const boxes = new Map();
    const boxOf = (gid) => {
      let b = boxes.get(gid);
      if (!b) { const m = M.modelOf(gid); b = m.bbox(gid - m.base, new THREE.Box3()); boxes.set(gid, b); }
      return b;
    };
    // sweep and prune along x
    const items = [];
    for (const g of A) items.push({ g, set: 0, b: boxOf(g) });
    for (const g of B) items.push({ g, set: 1, b: boxOf(g) });
    items.sort((p, q) => p.b.min.x - q.b.min.x);
    const pairs = [];
    const seen = new Set();
    const active = [];
    for (const it of items) {
      for (let k = active.length - 1; k >= 0; k--) if (active[k].b.max.x + margin < it.b.min.x) active.splice(k, 1);
      for (const o of active) {
        if (o.set === it.set) continue;
        const a = o.b, b = it.b;
        if (a.min.y > b.max.y + margin || b.min.y > a.max.y + margin || a.min.z > b.max.z + margin || b.min.z > a.max.z + margin) continue;
        const ga = o.set === 0 ? o.g : it.g, gb = o.set === 0 ? it.g : o.g;
        if (ga === gb) continue;
        const key = ga < gb ? `${ga}:${gb}` : `${gb}:${ga}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([ga, gb]);
      }
      active.push(it);
    }

    const results = [];
    const prev = new Map(test.results.map((r) => [r.key, r]));
    const t0 = performance.now();
    for (let p = 0; p < pairs.length; p++) {
      if (job.cancelled) break;
      if (performance.now() - t0 > 30 && p % 25 === 0) {
        onProgress?.(p / pairs.length, results.length);
        await new Promise((r) => setTimeout(r, 0));
      }
      const [ga, gb] = pairs[p];
      const mA = M.modelOf(ga), mB = M.modelOf(gb);
      if (test.ignoreSameModel && mA === mB) continue;
      const iA = ga - mA.base, iB = gb - mB.base;
      if (mA === mB && related(mA, iA, iB)) continue;
      const r = test.mode === 'clearance' ? this.clearanceCheck(mA, iA, mB, iB, test.clearance) : this.hardCheck(mA, iA, mB, iB, test.tolerance);
      if (!r) continue;
      const elA = mA.elements[iA], elB = mB.elements[iB];
      const key = `${elA.guid}:${elB.guid}`;
      const old = prev.get(key);
      results.push({
        id: old?.id || uuid(), key, a: ga, b: gb, guidA: elA.guid, guidB: elB.guid,
        nameA: elA.name || elA.cls, nameB: elB.name || elB.cls, clsA: elA.cls, clsB: elB.cls,
        modelA: mA.name, modelB: mB.name,
        point: r.point.toArray(), depth: r.depth, distance: r.distance ?? 0,
        status: old ? (old.status === 'resolved' ? 'active' : old.status) : 'new',
      });
    }
    // clashes from the previous run that disappeared are resolved
    const now = new Set(results.map((r) => r.key));
    for (const old of test.results) if (!now.has(old.key) && old.status !== 'resolved') results.push({ ...old, status: 'resolved', a: -1, b: -1 });
    if (!job.cancelled) {
      test.results = results;
      test.lastRun = new Date().toISOString();
    }
    this.running = null;
    onProgress?.(1, results.length);
    this.changed();
    return { results, pairs: pairs.length, cancelled: job.cancelled };
  }

  hardCheck(mA, iA, mB, iB, tolerance) {
    const gA = elementGeometry(mA, iA), gB = elementGeometry(mB, iB);
    if (!gA || !gB) return null;
    const box = new THREE.Box3();
    const seg = new THREE.Line3();
    let n = 0;
    const n1 = new THREE.Vector3(), n2 = new THREE.Vector3();
    gA.boundsTree.bvhcast(gB.boundsTree, IDENTITY, {
      intersectsTriangles(t1, t2) {
        // coplanar contact is touching, not penetrating (and has no intersection segment)
        t1.getNormal(n1);
        t2.getNormal(n2);
        if (Math.abs(n1.dot(n2)) > 0.99999 && Math.abs(n1.dot(t2.a) - n1.dot(t1.a)) < 1e-5) return false;
        if (t1.intersectsTriangle(t2, seg) && Number.isFinite(seg.start.x + seg.start.y + seg.start.z + seg.end.x + seg.end.y + seg.end.z)) {
          box.expandByPoint(seg.start);
          box.expandByPoint(seg.end);
          n++;
        }
        return n > 4000;
      },
    });
    if (n === 0) {
      // no surface intersection: one element may lie completely inside the other
      const bA = mA.bbox(iA, new THREE.Box3()), bB = mB.bbox(iB, new THREE.Box3());
      if (bB.containsBox(bA) && pointInside(gB, firstVertex(gA))) return containment(bA, tolerance);
      if (bA.containsBox(bB) && pointInside(gA, firstVertex(gB))) return containment(bB, tolerance);
      return null;
    }
    // nearly coplanar triangles can yield stray segments: clamp to the common bounding box
    box.intersect(mA.bbox(iA, new THREE.Box3())).intersect(mB.bbox(iB, new THREE.Box3()));
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const sorted = [size.x, size.y, size.z].sort((a, b) => a - b);
    // thickness of the intersection region ~ smallest extent of the intersection curve box
    const depth = sorted[0];
    if (depth <= tolerance) return null;
    return { point: box.getCenter(new THREE.Vector3()), depth };
  }

  clearanceCheck(mA, iA, mB, iB, clearance) {
    const res = elementDistance(mA, iA, mB, iB, clearance);
    if (!res || res.distance > clearance) return null;
    return { point: res.a.clone().add(res.b).multiplyScalar(0.5), depth: 0, distance: res.distance };
  }
}

function containment(box, tolerance) {
  const s = box.getSize(new THREE.Vector3());
  const depth = Math.min(s.x, s.y, s.z);
  if (depth <= tolerance) return null;
  return { point: box.getCenter(new THREE.Vector3()), depth };
}

function firstVertex(g) {
  return new THREE.Vector3().fromBufferAttribute(g.attributes.position, 0);
}

/** Ray parity test (odd number of crossings = inside). */
function pointInside(g, p) {
  const dir = new THREE.Vector3(0.5773, 0.5774, 0.5775).normalize();
  const hits = g.boundsTree.raycast(new THREE.Ray(p, dir), THREE.DoubleSide);
  const uniq = [];
  for (const h of hits) if (!uniq.some((d) => Math.abs(d - h.distance) < 1e-6)) uniq.push(h.distance);
  return uniq.length % 2 === 1;
}

/** Same element tree branch (assembly and its parts, wall and its opening). */
function related(m, a, b) {
  const isAncestor = (x, y) => {
    let p = m.elements[y].parent;
    while (p >= 0) { if (p === x) return true; p = m.elements[p].parent; }
    return false;
  };
  return isAncestor(a, b) || isAncestor(b, a);
}
