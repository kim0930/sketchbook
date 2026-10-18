import { uid } from './ids.ts';
import {
  add,
  centroid,
  cross,
  dot,
  faceNormal,
  identity,
  invertMat,
  length,
  multiplyMat,
  translation,
  newell,
  normalize,
  planeBasis,
  polygonArea,
  scale,
  sub,
  transformPoint,
} from './math.ts';
import type { Definition, Dimension, Face, Plane, RGBA, SketchDocument, Vec3 } from './types.ts';

export function cloneDoc(doc: SketchDocument): SketchDocument {
  return {
    ...doc,
    materials: doc.materials.map((m) => ({
      ...m,
      color: [m.color[0], m.color[1], m.color[2], m.color[3]],
      texture: m.texture ? { ...m.texture } : undefined,
    })),
    layers: doc.layers.map((l) => ({ ...l, color: [l.color[0], l.color[1], l.color[2]] })),
    definitions: doc.definitions.map(cloneDef),
    dimensions: (doc.dimensions ?? []).map((item) => ({ id: item.id, a: [...item.a] as Vec3, b: [...item.b] as Vec3 })),
  };
}

function cloneDef(d: Definition): Definition {
  return {
    ...d,
    vertices: d.vertices.map((v) => [v[0], v[1], v[2]]),
    faces: d.faces.map((f) => ({
      ...f,
      outer: [...f.outer],
      holes: f.holes.map((h) => [...h]),
    })),
    edges: d.edges.map((e) => ({ ...e })),
    placements: d.placements.map((p) => ({ ...p, matrix: [...p.matrix] })),
  };
}

export function withDoc(doc: SketchDocument, fn: (draft: SketchDocument) => void): SketchDocument {
  const draft = cloneDoc(doc);
  fn(draft);
  return draft;
}

export function getDef(doc: SketchDocument, id: string): Definition | undefined {
  return doc.definitions.find((d) => d.id === id);
}

export function getRoot(doc: SketchDocument): Definition {
  const root = getDef(doc, doc.rootId);
  if (!root) throw new Error('루트 정의가 없습니다.');
  return root;
}

export function findPlacement(doc: SketchDocument, placementId: string): {
  parent: Definition;
  index: number;
} | null {
  for (const parent of doc.definitions) {
    const index = parent.placements.findIndex((p) => p.id === placementId);
    if (index >= 0) return { parent, index };
  }
  return null;
}

/** Outermost placement first. The same nested placement can sit under several instances, so callers pass the path they clicked. */
export function worldMatrixOfPath(doc: SketchDocument, path: readonly string[]): number[] {
  let m = identity();
  for (const id of path) {
    const found = findPlacement(doc, id);
    if (!found) break;
    m = multiplyMat(m, found.parent.placements[found.index].matrix);
  }
  return m;
}

export function parentSpaceWorld(doc: SketchDocument, path: readonly string[]): number[] {
  return worldMatrixOfPath(doc, path.slice(0, -1));
}

export function editingDefinition(doc: SketchDocument, editingPath: readonly string[]): Definition {
  if (editingPath.length === 0) return getRoot(doc);
  const found = findPlacement(doc, editingPath[editingPath.length - 1]);
  if (!found) return getRoot(doc);
  const placement = found.parent.placements[found.index];
  return getDef(doc, placement.definitionId) ?? getRoot(doc);
}

export function usageCount(doc: SketchDocument, definitionId: string): number {
  let n = 0;
  for (const def of doc.definitions) {
    for (const p of def.placements) if (p.definitionId === definitionId) n += 1;
  }
  return n;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function ensureEdge(def: Definition, a: number, b: number): void {
  if (a === b) return;
  const key = edgeKey(a, b);
  if (def.edges.some((e) => edgeKey(e.a, e.b) === key)) return;
  def.edges.push({ id: uid('edge'), a, b, soft: false, smooth: false, hidden: false });
}

function linkFace(def: Definition, face: Face): void {
  for (const loop of [face.outer, ...face.holes]) {
    for (let i = 0; i < loop.length; i++) ensureEdge(def, loop[i], loop[(i + 1) % loop.length]);
  }
}

function pruneEdges(def: Definition): void {
  const used = new Set<string>();
  for (const face of def.faces) {
    for (const loop of [face.outer, ...face.holes]) {
      for (let i = 0; i < loop.length; i++) used.add(edgeKey(loop[i], loop[(i + 1) % loop.length]));
    }
  }
  def.edges = def.edges.filter((e) => used.has(edgeKey(e.a, e.b)));
}

function findOrAddVertex(def: Definition, p: Vec3): number {
  const eps = 1e-4;
  if (def.vertices.length <= 8000) {
    for (let i = 0; i < def.vertices.length; i++) {
      const v = def.vertices[i];
      if (Math.abs(v[0] - p[0]) <= eps && Math.abs(v[1] - p[1]) <= eps && Math.abs(v[2] - p[2]) <= eps) {
        return i;
      }
    }
  }
  def.vertices.push([p[0], p[1], p[2]]);
  return def.vertices.length - 1;
}

export function appendPolygon(
  def: Definition,
  loops: Vec3[][],
  materialId: string | null,
  layerId: string,
): string | null {
  const outerPts = loops[0];
  if (!outerPts || outerPts.length < 3 || polygonArea(outerPts) < 1e-6) return null;
  const toIndex = (pts: Vec3[]) => pts.map((p) => findOrAddVertex(def, p));
  const outer = toIndex(outerPts);
  const holes = loops.slice(1).filter((h) => h.length >= 3).map(toIndex);
  const face: Face = { id: uid('face'), outer, holes, materialId, layerId, hidden: false };
  def.faces.push(face);
  linkFace(def, face);
  return face.id;
}

export function appendBox(
  def: Definition,
  origin: Vec3,
  size: Vec3,
  materialId: string | null,
  layerId: string,
): void {
  const [ox, oy, oz] = origin;
  const [sx, sy, sz] = size;
  const base = def.vertices.length;
  const corners: Vec3[] = [
    [ox, oy, oz],
    [ox + sx, oy, oz],
    [ox + sx, oy + sy, oz],
    [ox, oy + sy, oz],
    [ox, oy, oz + sz],
    [ox + sx, oy, oz + sz],
    [ox + sx, oy + sy, oz + sz],
    [ox, oy + sy, oz + sz],
  ];
  def.vertices.push(...corners);
  const loops = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  for (const loop of loops) {
    const face: Face = {
      id: uid('face'),
      outer: loop.map((i) => base + i),
      holes: [],
      materialId,
      layerId,
      hidden: false,
    };
    def.faces.push(face);
    linkFace(def, face);
  }
}

export function pointsOf(def: Definition, indices: number[]): Vec3[] {
  return indices.map((i) => def.vertices[i]);
}

function faceUses(face: Face, vertex: number): boolean {
  if (face.outer.includes(vertex)) return true;
  return face.holes.some((h) => h.includes(vertex));
}

export function pushPull(doc: SketchDocument, definitionId: string, faceId: string, distance: number): SketchDocument | null {
  if (!Number.isFinite(distance) || Math.abs(distance) < 1e-6) return null;
  let changed = false;
  const next = withDoc(doc, (draft) => {
    const def = getDef(draft, definitionId);
    const face = def?.faces.find((f) => f.id === faceId);
    if (!def || !face) return;
    const outer = pointsOf(def, face.outer);
    const normal = faceNormal(outer);
    if (length(normal) < 0.5) return;
    const ids = new Set<number>([...face.outer, ...face.holes.flat()]);
    const shared = [...ids].some((v) => def.faces.some((f) => f.id !== face.id && faceUses(f, v)));
    if (shared) {
      for (const v of ids) def.vertices[v] = add(def.vertices[v], scale(normal, distance));
      changed = true;
      return;
    }
    const remap = new Map<number, number>();
    for (const v of ids) {
      const nv = def.vertices.length;
      remap.set(v, nv);
      def.vertices.push(add(def.vertices[v], scale(normal, distance)));
    }
    const bottom: Face = {
      id: uid('face'),
      outer: [...face.outer].reverse(),
      holes: face.holes.map((h) => [...h].reverse()),
      materialId: face.materialId,
      layerId: face.layerId,
      hidden: false,
    };
    def.faces.push(bottom);
    linkFace(def, bottom);
    for (const loop of [face.outer, ...face.holes]) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const side: Face = {
          id: uid('face'),
          outer: [a, b, remap.get(b)!, remap.get(a)!],
          holes: [],
          materialId: face.materialId,
          layerId: face.layerId,
          hidden: false,
        };
        def.faces.push(side);
        linkFace(def, side);
      }
    }
    face.outer = face.outer.map((v) => remap.get(v)!);
    face.holes = face.holes.map((h) => h.map((v) => remap.get(v)!));
    linkFace(def, face);
    changed = true;
  });
  return changed ? next : null;
}

export function addPolygon(
  doc: SketchDocument,
  definitionId: string,
  points: Vec3[],
  materialId: string | null,
  layerId: string,
  holes: Vec3[][] = [],
): SketchDocument | null {
  let id: string | null = null;
  const next = withDoc(doc, (draft) => {
    const def = getDef(draft, definitionId);
    if (!def) return;
    id = appendPolygon(def, [points, ...holes], materialId, layerId);
  });
  return id ? next : null;
}

/** Pie slice from `start` around `center`, sweeping counter-clockwise to the angle of `end`. */
export function sectorPoints(center: Vec3, plane: Plane, start: Vec3, end: Vec3): Vec3[] | null {
  const radius = length(sub(start, center));
  if (radius < 0.05) return null;
  const startAngle = Math.atan2(dot(sub(start, center), plane.v), dot(sub(start, center), plane.u));
  const endAngle = Math.atan2(dot(sub(end, center), plane.v), dot(sub(end, center), plane.u));
  let sweep = endAngle - startAngle;
  if (sweep <= 1e-3) sweep += Math.PI * 2;
  if (sweep < 0.05) return null;
  const steps = Math.max(3, Math.min(48, Math.round(sweep / (Math.PI / 16))));
  const points: Vec3[] = [center];
  for (let i = 0; i <= steps; i++) {
    const angle = startAngle + (sweep * i) / steps;
    points.push(add(center, add(scale(plane.u, Math.cos(angle) * radius), scale(plane.v, Math.sin(angle) * radius))));
  }
  if (polygonArea(points) < 1e-4) return null;
  return points;
}

export function addCircle(
  doc: SketchDocument,
  definitionId: string,
  center: Vec3,
  normal: Vec3,
  radius: number,
  materialId: string | null,
  layerId: string,
  segments = 24,
): SketchDocument | null {
  if (radius <= 1e-4) return null;
  const n = normalize(normal);
  const { u, v } = planeBasis(n);
  const points: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(add(center, add(scale(u, Math.cos(a) * radius), scale(v, Math.sin(a) * radius))));
  }
  return addPolygon(doc, definitionId, points, materialId, layerId);
}

export function addDimension(doc: SketchDocument, a: Vec3, b: Vec3): SketchDocument | null {
  if (length(sub(a, b)) < 0.05) return null;
  return withDoc(doc, (draft) => {
    const item: Dimension = { id: uid('dim'), a: [a[0], a[1], a[2]], b: [b[0], b[1], b[2]] };
    draft.dimensions.push(item);
  });
}

export function deleteDimension(doc: SketchDocument, dimensionId: string): SketchDocument | null {
  if (!(doc.dimensions ?? []).some((item) => item.id === dimensionId)) return null;
  return withDoc(doc, (draft) => {
    draft.dimensions = draft.dimensions.filter((item) => item.id !== dimensionId);
  });
}

export interface BoxPart {
  origin: Vec3;
  size: Vec3;
  color: RGBA;
}

export function addBoxAssembly(
  doc: SketchDocument,
  name: string,
  parts: BoxPart[],
  placeAt: Vec3,
): { doc: SketchDocument; placementId: string } | null {
  if (!parts.length) return null;
  let placementId = '';
  const next = withDoc(doc, (draft) => {
    const materials = new Map<string, string>();
    const materialFor = (color: RGBA) => {
      const key = color.join(',');
      const found = materials.get(key);
      if (found) return found;
      const id = uid('mat');
      draft.materials.push({ id, name, color: [color[0], color[1], color[2], color[3]], opacity: color[3] / 255 });
      materials.set(key, id);
      return id;
    };
    const def: Definition = {
      id: uid('def'),
      name,
      kind: 'definition',
      vertices: [],
      faces: [],
      edges: [],
      placements: [],
    };
    for (const part of parts) {
      if (part.size[0] <= 0 || part.size[1] <= 0 || part.size[2] <= 0) continue;
      appendBox(def, part.origin, part.size, materialFor(part.color), draft.defaultLayerId);
    }
    if (!def.faces.length) return;
    draft.definitions.push(def);
    placementId = uid('inst');
    getRoot(draft).placements.push({
      id: placementId,
      name,
      definitionId: def.id,
      matrix: translation(placeAt[0], placeAt[1], placeAt[2]),
      materialId: null,
      layerId: draft.defaultLayerId,
      hidden: false,
    });
  });
  return placementId ? { doc: next, placementId } : null;
}

export function deleteFace(doc: SketchDocument, definitionId: string, faceId: string): SketchDocument | null {
  let changed = false;
  const next = withDoc(doc, (draft) => {
    const def = getDef(draft, definitionId);
    if (!def) return;
    const before = def.faces.length;
    def.faces = def.faces.filter((f) => f.id !== faceId);
    if (def.faces.length === before) return;
    pruneEdges(def);
    changed = true;
  });
  return changed ? next : null;
}

function loopHasEdge(loop: number[], a: number, b: number): boolean {
  for (let i = 0; i < loop.length; i++) {
    const u = loop[i];
    const v = loop[(i + 1) % loop.length];
    if ((u === a && v === b) || (u === b && v === a)) return true;
  }
  return false;
}

export function deleteEdge(doc: SketchDocument, definitionId: string, edgeId: string): SketchDocument | null {
  let changed = false;
  const next = withDoc(doc, (draft) => {
    const def = getDef(draft, definitionId);
    const edge = def?.edges.find((item) => item.id === edgeId);
    if (!def || !edge) return;
    def.faces = def.faces.filter((face) => {
      const uses = [face.outer, ...face.holes].some((loop) => loopHasEdge(loop, edge.a, edge.b));
      return !uses;
    });
    pruneEdges(def);
    changed = true;
  });
  return changed ? next : null;
}

function lineMeet(origin: Vec3, dir: Vec3, otherOrigin: Vec3, otherDir: Vec3): Vec3 | null {
  const crossed = cross(dir, otherDir);
  const denom = dot(crossed, crossed);
  if (denom < 1e-10) return null;
  const s = dot(cross(sub(otherOrigin, origin), otherDir), crossed) / denom;
  return add(origin, scale(dir, s));
}

/** Moves each edge along the face interior. Positive distance shrinks the loop. */
export function offsetLoop(points: Vec3[], distance: number): Vec3[] | null {
  if (points.length < 3 || Math.abs(distance) < 1e-4) return null;
  const normal = faceNormal(points);
  if (length(normal) < 0.5) return null;
  const count = points.length;
  const next: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const prev = points[(i - 1 + count) % count];
    const curr = points[i];
    const following = points[(i + 1) % count];
    const d0 = normalize(sub(curr, prev));
    const d1 = normalize(sub(following, curr));
    if (length(d0) < 0.5 || length(d1) < 0.5) return null;
    const n0 = normalize(cross(normal, d0));
    const n1 = normalize(cross(normal, d1));
    const p0 = add(curr, scale(n0, distance));
    const p1 = add(curr, scale(n1, distance));
    const hit = lineMeet(p0, d0, p1, d1);
    const miter = normalize(add(n0, n1));
    next.push(hit ?? add(curr, scale(length(miter) < 0.5 ? n0 : miter, distance)));
  }
  const before = polygonArea(points);
  const after = polygonArea(next);
  if (after < 1e-4) return null;
  if (distance > 0 && after >= before * 0.995) return null;
  return next;
}

function pointInLoop(points: Vec3[], point: Vec3, normal: Vec3): boolean {
  const { u, v } = planeBasis(normal);
  const origin = points[0];
  const flat = points.map((p) => {
    const d = sub(p, origin);
    return [dot(d, u), dot(d, v)] as const;
  });
  const delta = sub(point, origin);
  const x = dot(delta, u);
  const y = dot(delta, v);
  let inside = false;
  for (let i = 0, j = flat.length - 1; i < flat.length; j = i++) {
    const [xi, yi] = flat[i];
    const [xj, yj] = flat[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(point: Vec3, a: Vec3, b: Vec3): number {
  const span = sub(b, a);
  const spanLen = length(span);
  if (spanLen < 1e-8) return length(sub(point, a));
  const t = Math.min(1, Math.max(0, dot(sub(point, a), span) / (spanLen * spanLen)));
  return length(sub(point, add(a, scale(span, t))));
}

/** Positive when `point` is inside the loop: the distance to the nearest edge. */
export function insetDistance(points: Vec3[], point: Vec3): number | null {
  if (points.length < 3) return null;
  const normal = faceNormal(points);
  if (length(normal) < 0.5) return null;
  let nearest = Infinity;
  for (let i = 0; i < points.length; i++) {
    nearest = Math.min(nearest, segmentDistance(point, points[i], points[(i + 1) % points.length]));
  }
  if (!Number.isFinite(nearest)) return null;
  return pointInLoop(points, point, normal) ? nearest : -nearest;
}

export function offsetFace(doc: SketchDocument, definitionId: string, faceId: string, distance: number): SketchDocument | null {
  if (Math.abs(distance) < 0.05) return null;
  const sourceDef = getDef(doc, definitionId);
  const sourceFace = sourceDef?.faces.find((face) => face.id === faceId);
  if (!sourceDef || !sourceFace || sourceFace.outer.length > 64) return null;
  const outer = pointsOf(sourceDef, sourceFace.outer);
  const shifted = offsetLoop(outer, distance);
  if (!shifted) return null;
  let changed = false;
  const next = withDoc(doc, (draft) => {
    const def = getDef(draft, definitionId);
    const face = def?.faces.find((item) => item.id === faceId);
    if (!def || !face) return;
    const indices = shifted.map((point) => findOrAddVertex(def, point));
    if (distance > 0) {
      face.holes = [...face.holes, [...indices].reverse()];
      linkFace(def, face);
      const inner: Face = {
        id: uid('face'),
        outer: indices,
        holes: [],
        materialId: face.materialId,
        layerId: face.layerId,
        hidden: false,
      };
      def.faces.push(inner);
      linkFace(def, inner);
    } else {
      face.outer = indices;
      linkFace(def, face);
      pruneEdges(def);
    }
    changed = true;
  });
  return changed ? next : null;
}

export function groupFace(
  doc: SketchDocument,
  definitionId: string,
  faceId: string,
): { doc: SketchDocument; placementId: string } | null {
  const parent = getDef(doc, definitionId);
  const face = parent?.faces.find((item) => item.id === faceId);
  if (!parent || !face) return null;
  let placementId = '';
  const next = withDoc(doc, (draft) => {
    const def = getDef(draft, definitionId);
    const source = def?.faces.find((item) => item.id === faceId);
    if (!def || !source) return;
    const used = [...new Set([...source.outer, ...source.holes.flat()])];
    const map = new Map<number, number>();
    const vertices: Vec3[] = used.map((index, order) => {
      map.set(index, order);
      return [def.vertices[index][0], def.vertices[index][1], def.vertices[index][2]];
    });
    const remap = (loop: number[]) => loop.map((index) => map.get(index) ?? 0);
    const childFace: Face = {
      id: uid('face'),
      outer: remap(source.outer),
      holes: source.holes.map(remap),
      materialId: source.materialId,
      layerId: source.layerId,
      hidden: false,
    };
    const child: Definition = {
      id: uid('def'),
      name: '그룹',
      kind: 'definition',
      vertices,
      faces: [childFace],
      edges: [],
      placements: [],
    };
    linkFace(child, childFace);
    draft.definitions.push(child);
    def.faces = def.faces.filter((item) => item.id !== faceId);
    pruneEdges(def);
    placementId = uid('inst');
    def.placements.push({
      id: placementId,
      name: '그룹',
      definitionId: child.id,
      matrix: identity(),
      materialId: null,
      layerId: source.layerId,
      hidden: false,
    });
  });
  return placementId ? { doc: next, placementId } : null;
}

export function worldStep(points: Vec3[]): Vec3 {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0]);
    maxX = Math.max(maxX, point[0]);
  }
  const span = maxX - minX;
  return [span > 0.5 ? span : 24, 0, 0];
}

export function pasteFaceLoops(
  doc: SketchDocument,
  definitionId: string,
  loops: Vec3[][],
  materialId: string | null,
  layerId: string,
  copies: number,
  step: Vec3,
): SketchDocument | null {
  const outer = loops[0];
  if (!outer || outer.length < 3 || copies < 1) return null;
  let changed = false;
  const next = withDoc(doc, (draft) => {
    const def = getDef(draft, definitionId);
    if (!def) return;
    for (let copy = 1; copy <= copies; copy++) {
      const shift = scale(step, copy);
      const moved = loops.map((loop) => loop.map((point) => add(point, shift)));
      if (appendPolygon(def, moved, materialId, layerId)) changed = true;
    }
  });
  return changed ? next : null;
}

export function pastePlacementCopies(
  doc: SketchDocument,
  placementId: string,
  copies: number,
  step: Vec3,
): { doc: SketchDocument; ids: string[] } | null {
  const found = findPlacement(doc, placementId);
  if (!found || copies < 1) return null;
  const source = found.parent.placements[found.index];
  const ids: string[] = [];
  const next = withDoc(doc, (draft) => {
    const loc = findPlacement(draft, placementId);
    if (!loc) return;
    const parent = loc.parent;
    const placement = parent.placements[loc.index];
    for (let copy = 1; copy <= copies; copy++) {
      const id = uid('inst');
      const matrix = [...placement.matrix];
      const shift = scale(step, copy);
      matrix[12] += shift[0];
      matrix[13] += shift[1];
      matrix[14] += shift[2];
      parent.placements.push({
        id,
        name: source.name,
        definitionId: source.definitionId,
        matrix,
        materialId: source.materialId,
        layerId: source.layerId,
        hidden: source.hidden,
      });
      ids.push(id);
    }
  });
  return ids.length ? { doc: next, ids } : null;
}

export function deletePlacement(doc: SketchDocument, placementId: string): SketchDocument | null {
  const found = findPlacement(doc, placementId);
  if (!found) return null;
  return withDoc(doc, (draft) => {
    const parent = getDef(draft, found.parent.id);
    if (!parent) return;
    const placement = parent.placements.find((p) => p.id === placementId);
    parent.placements = parent.placements.filter((p) => p.id !== placementId);
    if (!placement) return;
    const dropUnused = (defId: string) => {
      const def = getDef(draft, defId);
      if (!def || def.kind === 'root') return;
      if (usageCount(draft, defId) > 0) return;
      for (const child of def.placements) dropUnused(child.definitionId);
      draft.definitions = draft.definitions.filter((d) => d.id !== defId);
    };
    dropUnused(placement.definitionId);
  });
}

export function paintFace(
  doc: SketchDocument,
  definitionId: string,
  faceId: string,
  materialId: string | null,
): SketchDocument {
  return withDoc(doc, (draft) => {
    const face = getDef(draft, definitionId)?.faces.find((f) => f.id === faceId);
    if (face) face.materialId = materialId;
  });
}

export function paintPlacement(doc: SketchDocument, placementId: string, materialId: string | null): SketchDocument {
  return withDoc(doc, (draft) => {
    const found = findPlacement(draft, placementId);
    if (!found) return;
    found.parent.placements[found.index].materialId = materialId;
  });
}

export function setFaceLayer(doc: SketchDocument, definitionId: string, faceId: string, layerId: string): SketchDocument {
  return withDoc(doc, (draft) => {
    const face = getDef(draft, definitionId)?.faces.find((f) => f.id === faceId);
    if (face) face.layerId = layerId;
  });
}

export function setPlacementLayer(doc: SketchDocument, placementId: string, layerId: string): SketchDocument {
  return withDoc(doc, (draft) => {
    const found = findPlacement(draft, placementId);
    if (found) found.parent.placements[found.index].layerId = layerId;
  });
}

export function renamePlacement(doc: SketchDocument, placementId: string, name: string): SketchDocument {
  return withDoc(doc, (draft) => {
    const found = findPlacement(draft, placementId);
    if (found) found.parent.placements[found.index].name = name;
  });
}

export function setPlacementMatrix(doc: SketchDocument, placementId: string, matrix: number[]): SketchDocument {
  return withDoc(doc, (draft) => {
    const found = findPlacement(draft, placementId);
    if (found) found.parent.placements[found.index].matrix = [...matrix];
  });
}

export function mapFaceVertices(
  doc: SketchDocument,
  definitionId: string,
  faceId: string,
  mapper: (point: Vec3, index: number) => Vec3,
): SketchDocument | null {
  let changed = false;
  const next = withDoc(doc, (draft) => {
    const def = getDef(draft, definitionId);
    const face = def?.faces.find((f) => f.id === faceId);
    if (!def || !face) return;
    const ids = new Set<number>([...face.outer, ...face.holes.flat()]);
    for (const index of ids) {
      def.vertices[index] = mapper(def.vertices[index], index);
    }
    changed = true;
  });
  return changed ? next : null;
}

export function transformFace(
  doc: SketchDocument,
  definitionId: string,
  faceId: string,
  deltaWorld: number[],
  definitionWorld: number[],
): SketchDocument | null {
  const inv = invertMat(definitionWorld);
  return mapFaceVertices(doc, definitionId, faceId, (local) => {
    const world = transformPoint(definitionWorld, local);
    const moved = transformPoint(deltaWorld, world);
    return transformPoint(inv, moved);
  });
}

export function transformPlacement(
  doc: SketchDocument,
  path: readonly string[],
  deltaWorld: number[],
): SketchDocument | null {
  const placementId = path[path.length - 1];
  if (!placementId) return null;
  const found = findPlacement(doc, placementId);
  if (!found) return null;
  const placement = found.parent.placements[found.index];
  const parent = parentSpaceWorld(doc, path);
  const newLocal = multiplyMat(multiplyMat(invertMat(parent), deltaWorld), multiplyMat(parent, placement.matrix));
  return setPlacementMatrix(doc, placementId, newLocal);
}

export function translateInDefinition(
  doc: SketchDocument,
  definitionId: string,
  faceId: string,
  delta: Vec3,
): SketchDocument | null {
  if (length(delta) < 1e-8) return null;
  return mapFaceVertices(doc, definitionId, faceId, (p) => add(p, delta));
}

export function translatePlacement(doc: SketchDocument, path: readonly string[], worldDelta: Vec3): SketchDocument | null {
  if (length(worldDelta) < 1e-8) return null;
  const placementId = path[path.length - 1];
  if (!placementId) return null;
  const found = findPlacement(doc, placementId);
  if (!found) return null;
  const placement = found.parent.placements[found.index];
  const parent = parentSpaceWorld(doc, path);
  const origin = transformPoint(parent, [placement.matrix[12], placement.matrix[13], placement.matrix[14]]);
  const moved = transformPoint(invertMat(parent), add(origin, worldDelta));
  const matrix = [...placement.matrix];
  matrix[12] = moved[0];
  matrix[13] = moved[1];
  matrix[14] = moved[2];
  return setPlacementMatrix(doc, placementId, matrix);
}

export function makeUnique(doc: SketchDocument, placementId: string): SketchDocument | null {
  const found = findPlacement(doc, placementId);
  if (!found) return null;
  const sourceId = found.parent.placements[found.index].definitionId;
  if (usageCount(doc, sourceId) < 2) return null;
  return withDoc(doc, (draft) => {
    const source = getDef(draft, sourceId);
    const loc = findPlacement(draft, placementId);
    if (!source || !loc) return;
    const copy = cloneDef(source);
    copy.id = uid('def');
    copy.name = `${source.name || '컴포넌트'} 사본`;
    copy.kind = 'definition';
    draft.definitions.push(copy);
    loc.parent.placements[loc.index].definitionId = copy.id;
  });
}

export function addImportedMesh(
  doc: SketchDocument,
  name: string,
  vertices: Vec3[],
  triangles: { indices: [number, number, number]; color: RGBA }[],
  origin: Vec3,
): { doc: SketchDocument; placementId: string } | null {
  if (vertices.length < 3 || triangles.length === 0) return null;
  const faces = triangles.filter((tri) => {
    const [a, b, c] = tri.indices;
    return a !== b && b !== c && a !== c && a < vertices.length && b < vertices.length && c < vertices.length;
  });
  if (!faces.length) return null;
  let placementId = '';
  const next = withDoc(doc, (draft) => {
    let layer = draft.layers.find((item) => item.name === '라이브러리');
    if (!layer) {
      layer = { id: uid('layer'), name: '라이브러리', color: [90, 130, 150], visible: true };
      draft.layers.push(layer);
    }
    const materialIds = new Map<string, string>();
    const materialFor = (color: RGBA) => {
      const key = color.join(',');
      const cached = materialIds.get(key);
      if (cached) return cached;
      const found = draft.materials.find(
        (item) => item.color[0] === color[0] && item.color[1] === color[1] && item.color[2] === color[2] && Math.round(item.opacity * 255) === color[3],
      );
      if (found) {
        materialIds.set(key, found.id);
        return found.id;
      }
      const id = uid('mat');
      draft.materials.push({ id, name, color: [...color], opacity: color[3] / 255 });
      materialIds.set(key, id);
      return id;
    };
    const def: Definition = {
      id: uid('def'),
      name,
      kind: 'definition',
      vertices: vertices.map((vertex) => [vertex[0], vertex[1], vertex[2]]),
      faces: faces.map((tri) => ({
        id: uid('face'),
        outer: [...tri.indices],
        holes: [],
        materialId: materialFor(tri.color),
        layerId: layer.id,
        hidden: false,
      })),
      edges: [],
      placements: [],
    };
    draft.definitions.push(def);
    placementId = uid('inst');
    getRoot(draft).placements.push({
      id: placementId,
      name,
      definitionId: def.id,
      matrix: translation(origin[0], origin[1], origin[2]),
      materialId: null,
      layerId: layer.id,
      hidden: false,
    });
  });
  return placementId ? { doc: next, placementId } : null;
}

export function duplicatePlacement(doc: SketchDocument, definitionId: string): SketchDocument {
  return withDoc(doc, (draft) => {
    const root = getRoot(draft);
    const def = getDef(draft, definitionId);
    if (!def || def.kind === 'root') return;
    const shift = 24;
    root.placements.push({
      id: uid('inst'),
      name: def.name,
      definitionId,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, shift, shift, 0, 1],
      materialId: null,
      layerId: doc.defaultLayerId,
      hidden: false,
    });
  });
}

export function addMaterial(doc: SketchDocument, name: string, color: [number, number, number, number]): SketchDocument {
  return withDoc(doc, (draft) => {
    draft.materials.push({
      id: uid('mat'),
      name,
      color,
      opacity: color[3] / 255,
    });
  });
}

export function updateMaterial(
  doc: SketchDocument,
  materialId: string,
  patch: Partial<{ name: string; color: [number, number, number, number]; opacity: number }>,
): SketchDocument {
  return withDoc(doc, (draft) => {
    const mat = draft.materials.find((m) => m.id === materialId);
    if (!mat) return;
    if (patch.name !== undefined) mat.name = patch.name;
    if (patch.color) mat.color = patch.color;
    if (patch.opacity !== undefined) mat.opacity = patch.opacity;
  });
}

export function deleteMaterial(doc: SketchDocument, materialId: string): SketchDocument | null {
  const mat = doc.materials.find((m) => m.id === materialId);
  if (!mat || mat.isDefault) return null;
  return withDoc(doc, (draft) => {
    draft.materials = draft.materials.filter((m) => m.id !== materialId);
    for (const def of draft.definitions) {
      for (const face of def.faces) if (face.materialId === materialId) face.materialId = null;
      for (const p of def.placements) if (p.materialId === materialId) p.materialId = null;
    }
  });
}

export function addLayer(doc: SketchDocument, name: string): SketchDocument {
  return withDoc(doc, (draft) => {
    draft.layers.push({
      id: uid('layer'),
      name,
      color: [120, 144, 156],
      visible: true,
    });
  });
}

export function updateLayer(
  doc: SketchDocument,
  layerId: string,
  patch: Partial<{ name: string; visible: boolean; color: [number, number, number] }>,
): SketchDocument {
  return withDoc(doc, (draft) => {
    const layer = draft.layers.find((l) => l.id === layerId);
    if (!layer) return;
    if (patch.name !== undefined && !layer.isDefault) layer.name = patch.name;
    if (patch.visible !== undefined) layer.visible = patch.visible;
    if (patch.color) layer.color = patch.color;
  });
}

export function faceCentroid(def: Definition, face: Face): Vec3 {
  return centroid(pointsOf(def, face.outer));
}

export function faceArea(def: Definition, face: Face): number {
  const outer = polygonArea(pointsOf(def, face.outer));
  const holes = face.holes.reduce((sum, h) => sum + polygonArea(pointsOf(def, h)), 0);
  return Math.max(0, outer - holes);
}

export function modelBounds(doc: SketchDocument): { min: Vec3; max: Vec3; center: Vec3 } | null {
  const root = getRoot(doc);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  const visit = (def: Definition, matrix: number[], guard: Set<string>) => {
    if (guard.has(def.id)) return;
    guard.add(def.id);
    for (const vertex of def.vertices) {
      const point = transformPoint(matrix, vertex);
      any = true;
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    }
    for (const placement of def.placements) {
      if (placement.hidden) continue;
      const child = getDef(doc, placement.definitionId);
      if (!child) continue;
      visit(child, multiplyMat(matrix, placement.matrix), guard);
    }
    guard.delete(def.id);
  };
  visit(root, identity(), new Set());
  if (!any) return null;
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

export function boundsOfPoints(points: Vec3[]): { min: Vec3; max: Vec3; center: Vec3 } | null {
  if (points.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  }
  return { min, max, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
}

export function definitionLocalPoints(doc: SketchDocument, def: Definition, guard = new Set<string>()): Vec3[] {
  if (guard.has(def.id)) return [];
  guard.add(def.id);
  const points = [...def.vertices];
  for (const placement of def.placements) {
    const child = getDef(doc, placement.definitionId);
    if (!child) continue;
    for (const p of definitionLocalPoints(doc, child, guard)) points.push(transformPoint(placement.matrix, p));
  }
  guard.delete(def.id);
  return points;
}

export function selectionValid(
  doc: SketchDocument,
  selection: { kind: string; definitionId?: string; faceId?: string; edgeId?: string; placementId?: string; dimensionId?: string } | null,
): boolean {
  if (!selection) return false;
  if (selection.kind === 'face' && selection.definitionId && selection.faceId) {
    return Boolean(getDef(doc, selection.definitionId)?.faces.some((f) => f.id === selection.faceId));
  }
  if (selection.kind === 'edge' && selection.definitionId && selection.edgeId) {
    return Boolean(getDef(doc, selection.definitionId)?.edges.some((edge) => edge.id === selection.edgeId));
  }
  if (selection.kind === 'placement' && selection.placementId) return Boolean(findPlacement(doc, selection.placementId));
  if (selection.kind === 'dimension' && selection.dimensionId) {
    return Boolean((doc.dimensions ?? []).some((item) => item.id === selection.dimensionId));
  }
  return false;
}

export function groundPlane(): Plane {
  return { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] };
}

export function rectanglePoints(origin: Vec3, u: Vec3, v: Vec3, du: number, dv: number): Vec3[] {
  const p0 = origin;
  const p1 = add(origin, scale(u, du));
  const p2 = add(p1, scale(v, dv));
  const p3 = add(origin, scale(v, dv));
  return [p0, p1, p2, p3];
}

export function signedAreaNormal(points: Vec3[]): Vec3 {
  return normalize(newell(points));
}
