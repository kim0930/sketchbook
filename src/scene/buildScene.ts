import earcut from 'earcut';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  Uint16BufferAttribute,
  Uint32BufferAttribute,
  SRGBColorSpace,
  RepeatWrapping,
  Texture,
  type Material,
} from 'three';
import { getDef, getRoot, pointsOf } from '../model/document.ts';
import { dot, faceNormal, planeBasis, sub } from '../model/math.ts';
import type { Definition, Face, Placement, SketchDocument, Vec3 } from '../model/types.ts';

export interface BuiltModel {
  group: Group;
  materials: Material[];
}

export function disposeModel(built: BuiltModel): void {
  const geometries = new Set<BufferGeometry>();
  built.group.traverse((obj) => {
    const mesh = obj as Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of built.materials) {
    const extra = material.userData.dispose as (() => void) | undefined;
    extra?.();
    material.dispose();
  }
}

function triangulate(vertices: Vec3[], face: Face): { points: Vec3[]; indices: number[] } | null {
  const lists = [face.outer, ...face.holes].map((loop) => pointsOf({ vertices } as Definition, loop));
  const outer = lists[0];
  if (!outer || outer.length < 3) return null;
  const normal = faceNormal(outer);
  if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) return null;
  const { u, v } = planeBasis(normal);
  const points = lists.flat();
  const coords: number[] = [];
  const holeIndices: number[] = [];
  lists.forEach((loop, index) => {
    if (index > 0) holeIndices.push(coords.length / 2);
    for (const p of loop) {
      const d = sub(p, outer[0]);
      coords.push(dot(d, u), dot(d, v));
    }
  });
  let local = earcut(coords, holeIndices.length ? holeIndices : undefined, 2);
  if (local.length === 0 && face.holes.length === 0) {
    local = [];
    for (let i = 1; i < outer.length - 1; i++) local.push(0, i, i + 1);
  }
  if (local.length < 3) return null;
  const a = points[local[0]];
  const b = points[local[1]];
  const c = points[local[2]];
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const tn: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  if (dot(tn, normal) < 0) {
    for (let i = 0; i < local.length; i += 3) {
      const swap = local[i + 1];
      local[i + 1] = local[i + 2];
      local[i + 2] = swap;
    }
  }
  return { points, indices: local };
}

function uvsFor(points: Vec3[], tileW?: number, tileH?: number): Float32Array {
  const normal = faceNormal(points);
  const { u, v } = planeBasis(normal);
  const origin = points[0];
  const proj = points.map((p) => {
    const d = sub(p, origin);
    return [dot(d, u), dot(d, v)] as [number, number];
  });
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const [uu, vv] of proj) {
    minU = Math.min(minU, uu);
    minV = Math.min(minV, vv);
    maxU = Math.max(maxU, uu);
    maxV = Math.max(maxV, vv);
  }
  const spanU = maxU - minU || 1;
  const spanV = maxV - minV || 1;
  const tw = tileW && tileW > 0.05 ? tileW : spanU;
  const th = tileH && tileH > 0.05 ? tileH : spanV;
  const uvs = new Float32Array(points.length * 2);
  proj.forEach(([uu, vv], index) => {
    uvs[index * 2] = (uu - minU) / tw;
    uvs[index * 2 + 1] = (vv - minV) / th;
  });
  return uvs;
}

function makeMaterial(
  doc: SketchDocument,
  materialId: string | null,
  cache: Map<string, MeshLambertMaterial>,
  bucket: Material[],
): MeshLambertMaterial {
  const key = materialId ?? doc.defaultMaterialId;
  const cached = cache.get(key);
  if (cached) return cached;
  const source = doc.materials.find((m) => m.id === key) ?? doc.materials[0];
  const color = source?.color ?? [255, 255, 255, 255];
  const opacity = source?.opacity ?? 1;
  const mat = new MeshLambertMaterial({
    color: (color[0] << 16) | (color[1] << 8) | color[2],
    side: DoubleSide,
    transparent: opacity < 0.999,
    opacity,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  if (source?.texture) {
    const { data, mime, tileWidth, tileHeight } = source.texture;
    const url = URL.createObjectURL(new Blob([Uint8Array.from(data)], { type: mime }));
    let gone = false;
    const img = new Image();
    img.onload = () => {
      if (gone) {
        URL.revokeObjectURL(url);
        return;
      }
      const tex = new Texture(img);
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      tex.needsUpdate = true;
      mat.map = tex;
      mat.needsUpdate = true;
    };
    img.src = url;
    mat.userData.tileWidth = tileWidth;
    mat.userData.tileHeight = tileHeight;
    mat.userData.dispose = () => {
      gone = true;
      URL.revokeObjectURL(url);
      mat.map?.dispose();
    };
  }
  cache.set(key, mat);
  bucket.push(mat);
  return mat;
}

const BATCH_AT = 500;

interface CachedFace {
  geometry: BufferGeometry;
  materialId: string | null;
  faceId?: string;
  batched?: boolean;
}

interface CachedDraw {
  faces: CachedFace[];
  edges: BufferGeometry | null;
}

function setIndex(geometry: BufferGeometry, indices: number[]): void {
  geometry.setIndex(indices.length > 65535 ? new Uint32BufferAttribute(indices, 1) : new Uint16BufferAttribute(indices, 1));
}

function faceGeometry(points: Vec3[], indices: number[], tileW?: number, tileH?: number): BufferGeometry {
  const geometry = new BufferGeometry();
  const positions = new Float32Array(points.length * 3);
  const normals = new Float32Array(points.length * 3);
  const normal = faceNormal(points);
  points.forEach((p, index) => {
    positions[index * 3] = p[0];
    positions[index * 3 + 1] = p[1];
    positions[index * 3 + 2] = p[2];
    normals[index * 3] = normal[0];
    normals[index * 3 + 1] = normal[1];
    normals[index * 3 + 2] = normal[2];
  });
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvsFor(points, tileW, tileH), 2));
  setIndex(geometry, indices);
  return geometry;
}

function tilesOf(doc: SketchDocument, materialId: string | null): { tileW?: number; tileH?: number } {
  const source = doc.materials.find((item) => item.id === (materialId ?? doc.defaultMaterialId));
  return { tileW: source?.texture?.tileWidth, tileH: source?.texture?.tileHeight };
}

function batchFaces(doc: SketchDocument, vertices: Vec3[], faces: Face[], materialId: string | null): CachedFace | null {
  const { tileW, tileH } = tilesOf(doc, materialId);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const faceIds: string[] = [];
  const triFace: number[] = [];
  for (const face of faces) {
    const tri = triangulate(vertices, face);
    if (!tri) continue;
    const start = positions.length / 3;
    const normal = faceNormal(tri.points);
    const uv = uvsFor(tri.points, tileW, tileH);
    tri.points.forEach((p, index) => {
      positions.push(p[0], p[1], p[2]);
      normals.push(normal[0], normal[1], normal[2]);
      uvs.push(uv[index * 2], uv[index * 2 + 1]);
    });
    const slot = faceIds.length;
    faceIds.push(face.id);
    for (let i = 0; i < tri.indices.length; i += 3) {
      indices.push(start + tri.indices[i], start + tri.indices[i + 1], start + tri.indices[i + 2]);
      triFace.push(slot);
    }
  }
  if (!indices.length) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  setIndex(geometry, indices);
  geometry.userData.faceIds = faceIds;
  geometry.userData.triFace = Uint32Array.from(triFace);
  return { geometry, materialId, batched: true };
}

function drawFor(
  doc: SketchDocument,
  def: Definition,
  inherited: string | null,
  hiddenLayers: Set<string>,
  drawCache: Map<string, CachedDraw>,
): CachedDraw {
  const key = `${def.id}\0${inherited ?? ''}`;
  const cached = drawCache.get(key);
  if (cached) return cached;
  const visible = def.faces.filter((face) => !face.hidden && !hiddenLayers.has(face.layerId));
  const faces: CachedFace[] = [];
  if (visible.length >= BATCH_AT) {
    const groups = new Map<string, Face[]>();
    for (const face of visible) {
      const id = face.materialId ?? inherited ?? '';
      const list = groups.get(id);
      if (list) list.push(face);
      else groups.set(id, [face]);
    }
    for (const [id, group] of groups) {
      const batched = batchFaces(doc, def.vertices, group, id || inherited);
      if (batched) faces.push(batched);
    }
  } else {
    for (const face of visible) {
      const tri = triangulate(def.vertices, face);
      if (!tri) continue;
      const materialId = face.materialId ?? inherited;
      const { tileW, tileH } = tilesOf(doc, materialId);
      faces.push({ geometry: faceGeometry(tri.points, tri.indices, tileW, tileH), materialId, faceId: face.id });
    }
  }
  let edges: BufferGeometry | null = null;
  if (def.edges.length) {
    const segments: number[] = [];
    for (const edge of def.edges) {
      if (edge.hidden || edge.soft || edge.smooth) continue;
      const a = def.vertices[edge.a];
      const b = def.vertices[edge.b];
      if (!a || !b) continue;
      segments.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    if (segments.length) {
      edges = new BufferGeometry();
      edges.setAttribute('position', new Float32BufferAttribute(segments, 3));
    }
  }
  const draw = { faces, edges };
  drawCache.set(key, draw);
  return draw;
}

function addFaces(
  parent: Group,
  doc: SketchDocument,
  def: Definition,
  path: string[],
  inherited: string | null,
  cache: Map<string, MeshLambertMaterial>,
  bucket: Material[],
  stack: Set<string>,
  hiddenLayers: Set<string>,
  drawCache: Map<string, CachedDraw>,
  lineMat: LineBasicMaterial,
): void {
  if (stack.has(def.id)) return;
  stack.add(def.id);
  const draw = drawFor(doc, def, inherited, hiddenLayers, drawCache);
  for (const item of draw.faces) {
    const material = makeMaterial(doc, item.materialId, cache, bucket);
    const mesh = new Mesh(item.geometry, material);
    mesh.userData.pick = true;
    mesh.userData.faceId = item.faceId;
    mesh.userData.batched = item.batched ?? false;
    mesh.userData.definitionId = def.id;
    mesh.userData.path = path;
    mesh.userData.baseMaterial = material;
    parent.add(mesh);
  }
  if (draw.edges) {
    const lines = new LineSegments(draw.edges, lineMat);
    lines.raycast = () => {};
    parent.add(lines);
  }
  for (const placement of def.placements) addPlacement(parent, doc, placement, path, cache, bucket, stack, hiddenLayers, drawCache, lineMat);
  stack.delete(def.id);
}

function addPlacement(
  parent: Group,
  doc: SketchDocument,
  placement: Placement,
  path: string[],
  cache: Map<string, MeshLambertMaterial>,
  bucket: Material[],
  stack: Set<string>,
  hiddenLayers: Set<string>,
  drawCache: Map<string, CachedDraw>,
  lineMat: LineBasicMaterial,
): void {
  if (placement.hidden || hiddenLayers.has(placement.layerId)) return;
  const def = getDef(doc, placement.definitionId);
  if (!def) return;
  const group = new Group();
  group.matrix.fromArray(placement.matrix);
  group.matrixAutoUpdate = false;
  const nextPath = [...path, placement.id];
  group.userData.placementNode = placement.id;
  group.userData.path = nextPath;
  group.userData.definitionId = def.id;
  addFaces(group, doc, def, nextPath, placement.materialId, cache, bucket, stack, hiddenLayers, drawCache, lineMat);
  parent.add(group);
}

export function buildModel(doc: SketchDocument): BuiltModel {
  const group = new Group();
  group.name = 'skp-model';
  const cache = new Map<string, MeshLambertMaterial>();
  const materials: Material[] = [];
  const lineMat = new LineBasicMaterial({ color: 0x2c3136 });
  materials.push(lineMat);
  const hiddenLayers = new Set(doc.layers.filter((layer) => !layer.visible).map((layer) => layer.id));
  const root = getRoot(doc);
  addFaces(group, doc, root, [], null, cache, materials, new Set(), hiddenLayers, new Map(), lineMat);
  return { group, materials };
}
