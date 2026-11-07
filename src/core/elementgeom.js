import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

// Per-element triangle geometry (world coordinates) with a BVH, built on demand
// from the merged chunk buffers. Used by clash detection and object distances.

const MAX_CACHE = 4000;

export function elementGeometry(model, idx) {
  if (!model.geomCache) model.geomCache = new Map();
  const cache = model.geomCache;
  let g = cache.get(idx);
  if (g) {
    // least recently used eviction: move the hit to the end
    cache.delete(idx);
    cache.set(idx, g);
    return g;
  }
  const ranges = model.ranges[idx];
  if (!ranges) return null;
  let nv = 0, ni = 0;
  for (const r of ranges) { nv += r.vCount; ni += r.iCount; }
  const pos = new Float32Array(nv * 3);
  const index = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const r of ranges) {
    const c = model.chunks[r.chunk];
    pos.set(c.position.subarray(r.vStart * 3, (r.vStart + r.vCount) * 3), vo * 3);
    for (let k = 0; k < r.iCount; k++) index[io + k] = c.index[r.iStart + k] - r.vStart + vo;
    vo += r.vCount;
    io += r.iCount;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundsTree = new MeshBVH(geometry, { targetLeafSize: 8 });
  g = geometry;
  cache.set(idx, g);
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    cache.get(first).dispose();
    cache.delete(first);
  }
  return g;
}

const IDENTITY = new THREE.Matrix4();

/** Minimal distance between two elements: {distance, a: Vector3, b: Vector3}. */
export function elementDistance(mA, iA, mB, iB, maxDistance = Infinity) {
  const gA = elementGeometry(mA, iA);
  const gB = elementGeometry(mB, iB);
  if (!gA || !gB) return null;
  const a = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const b = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const res = gA.boundsTree.closestPointToGeometry(gB, IDENTITY, a, b, 0, maxDistance);
  if (!res) return null;
  return { distance: a.distance, a: a.point, b: b.point };
}

/** True when the triangle meshes of two elements intersect. */
export function elementsIntersect(mA, iA, mB, iB) {
  const gA = elementGeometry(mA, iA);
  const gB = elementGeometry(mB, iB);
  if (!gA || !gB) return false;
  return gA.boundsTree.intersectsGeometry(gB, IDENTITY);
}

export function clearGeometryCache(model) {
  if (!model.geomCache) return;
  for (const g of model.geomCache.values()) g.dispose();
  model.geomCache.clear();
}
