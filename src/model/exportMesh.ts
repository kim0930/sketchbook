import earcut from 'earcut';
import { BufferAttribute, BufferGeometry, DoubleSide, Group, Matrix4, Mesh, MeshStandardMaterial } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { getDef, getRoot } from './document.ts';
import { dot, faceNormal, planeBasis, sub } from './math.ts';
import type { Definition, RGB, SketchDocument, Vec3 } from './types.ts';

interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  color: RGB;
}

function materialColor(doc: SketchDocument, materialId: string | null, inherited: string | null): RGB {
  const id = materialId ?? inherited ?? doc.defaultMaterialId;
  const material = doc.materials.find((item) => item.id === id);
  return material ? [material.color[0], material.color[1], material.color[2]] : [220, 220, 220];
}

function faceTriangles(loops: Vec3[][]): [Vec3, Vec3, Vec3][] {
  const outer = loops[0];
  if (!outer || outer.length < 3) return [];
  const normal = faceNormal(outer);
  if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) return [];
  const { u, v } = planeBasis(normal);
  const points = loops.flat();
  const coords: number[] = [];
  const holeOf: number[] = [];
  loops.forEach((loop, index) => {
    if (index > 0) holeOf.push(coords.length / 2);
    for (const point of loop) {
      const d = sub(point, outer[0]);
      coords.push(dot(d, u), dot(d, v));
    }
  });
  const indices = earcut(coords, holeOf.length ? holeOf : undefined, 2);
  const tris: [Vec3, Vec3, Vec3][] = [];
  for (let i = 0; i < indices.length; i += 3) {
    tris.push([points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]]);
  }
  return tris;
}

function apply(matrix: Matrix4, point: Vec3): Vec3 {
  const [x, y, z] = point;
  const e = matrix.elements;
  return [
    e[0] * x + e[4] * y + e[8] * z + e[12],
    e[1] * x + e[5] * y + e[9] * z + e[13],
    e[2] * x + e[6] * y + e[10] * z + e[14],
  ];
}

function collect(
  doc: SketchDocument,
  def: Definition,
  matrix: Matrix4,
  inherited: string | null,
  out: Triangle[],
  stack: Set<string>,
): void {
  if (stack.has(def.id)) return;
  stack.add(def.id);
  const visible = (layerId: string) => doc.layers.find((layer) => layer.id === layerId)?.visible !== false;
  for (const face of def.faces) {
    if (face.hidden || !visible(face.layerId)) continue;
    const loops = [face.outer, ...face.holes].map((loop) => loop.map((index) => def.vertices[index]).filter(Boolean));
    const color = materialColor(doc, face.materialId, inherited);
    for (const [a, b, c] of faceTriangles(loops)) {
      out.push({ a: apply(matrix, a), b: apply(matrix, b), c: apply(matrix, c), color });
    }
  }
  for (const placement of def.placements) {
    if (placement.hidden || !visible(placement.layerId)) continue;
    const child = getDef(doc, placement.definitionId);
    if (!child) continue;
    collect(doc, child, matrix.clone().multiply(new Matrix4().fromArray(placement.matrix)), placement.materialId ?? inherited, out, stack);
  }
  stack.delete(def.id);
}

export function collectTriangles(doc: SketchDocument): Triangle[] {
  const out: Triangle[] = [];
  collect(doc, getRoot(doc), new Matrix4(), null, out, new Set());
  return out;
}

export function toObj(doc: SketchDocument): string {
  const lines = ['# 스케치북 OBJ — 인치, Z-up'];
  let index = 1;
  for (const tri of collectTriangles(doc)) {
    for (const p of [tri.a, tri.b, tri.c]) lines.push(`v ${p[0]} ${p[1]} ${p[2]}`);
    lines.push(`f ${index} ${index + 1} ${index + 2}`);
    index += 3;
  }
  return lines.join('\n');
}

export function toStl(doc: SketchDocument): Uint8Array {
  const tris = collectTriangles(doc);
  const buffer = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buffer);
  view.setUint32(80, tris.length, true);
  tris.forEach((tri, index) => {
    const offset = 84 + index * 50;
    const n = faceNormal([tri.a, tri.b, tri.c]);
    [n[0], n[1], n[2], ...tri.a, ...tri.b, ...tri.c].forEach((value, i) => view.setFloat32(offset + i * 4, value, true));
  });
  return new Uint8Array(buffer);
}

function yupMeters(p: Vec3): [number, number, number] {
  const s = 0.0254;
  return [p[0] * s, p[2] * s, -p[1] * s];
}

export async function toGlb(doc: SketchDocument): Promise<ArrayBuffer> {
  const tris = collectTriangles(doc);
  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 9);
  const colors = new Float32Array(tris.length * 9);
  tris.forEach((tri, index) => {
    const n = faceNormal([tri.a, tri.b, tri.c]);
    const normal: [number, number, number] = [n[0], n[2], -n[1]];
    [tri.a, tri.b, tri.c].forEach((point, corner) => {
      const p = yupMeters(point);
      const o = index * 9 + corner * 3;
      positions[o] = p[0];
      positions[o + 1] = p[1];
      positions[o + 2] = p[2];
      normals[o] = normal[0];
      normals[o + 1] = normal[1];
      normals[o + 2] = normal[2];
      colors[o] = tri.color[0] / 255;
      colors[o + 1] = tri.color[1] / 255;
      colors[o + 2] = tri.color[2] / 255;
    });
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, side: DoubleSide }),
  );
  const group = new Group();
  group.add(mesh);
  const result = await new GLTFExporter().parseAsync(group, { binary: true });
  geometry.dispose();
  (mesh.material as MeshStandardMaterial).dispose();
  return result as ArrayBuffer;
}
