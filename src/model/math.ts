import { Matrix4, Vector3 } from 'three';
import type { Plane, Unit, Vec3 } from './types.ts';

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-12) return [0, 0, 0];
  return scale(a, 1 / len);
}

export function newell(points: Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

export function polygonArea(points: Vec3[]): number {
  const n = newell(points);
  return 0.5 * length(n);
}

export function faceNormal(points: Vec3[]): Vec3 {
  return normalize(newell(points));
}

export function planeBasis(normal: Vec3): { u: Vec3; v: Vec3 } {
  const n = normalize(normal);
  const helper: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(helper, n));
  const v = normalize(cross(n, u));
  return { u, v };
}

export function planeFromPoints(points: Vec3[]): Plane | null {
  if (points.length < 3) return null;
  const normal = faceNormal(points);
  if (length(normal) < 0.5) return null;
  const edge = normalize(sub(points[1], points[0]));
  const u = length(edge) < 0.5 ? planeBasis(normal).u : edge;
  const v = normalize(cross(normal, u));
  return { origin: points[0], normal, u, v };
}

export function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function rotationZ(radians: number, origin: Vec3 = [0, 0, 0]): number[] {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, origin[0], origin[1], origin[2], 1];
}

export function multiplyMat(a: number[], b: number[]): number[] {
  return new Matrix4().fromArray(a).multiply(new Matrix4().fromArray(b)).toArray();
}

export function invertMat(m: number[]): number[] {
  return new Matrix4().fromArray(m).invert().toArray();
}

export function transformPoint(m: number[], p: Vec3): Vec3 {
  const v = new Vector3(p[0], p[1], p[2]).applyMatrix4(new Matrix4().fromArray(m));
  return [v.x, v.y, v.z];
}

export function transformDir(m: number[], d: Vec3): Vec3 {
  const v = new Vector3(d[0], d[1], d[2]).transformDirection(new Matrix4().fromArray(m));
  return [v.x, v.y, v.z];
}

/** SketchUp 13-float (row-major 3×3, translation, homogeneous 1) → column-major 4×4. */
export function skpMatrixToMat4(matrix: number[]): number[] {
  if (matrix.length >= 16) return matrix.slice(0, 16);
  if (matrix.length < 12) return identity();
  const m00 = matrix[0];
  const m01 = matrix[1];
  const m02 = matrix[2];
  const m10 = matrix[3];
  const m11 = matrix[4];
  const m12 = matrix[5];
  const m20 = matrix[6];
  const m21 = matrix[7];
  const m22 = matrix[8];
  const tx = matrix[9] ?? 0;
  const ty = matrix[10] ?? 0;
  const tz = matrix[11] ?? 0;
  return [m00, m10, m20, 0, m01, m11, m21, 0, m02, m12, m22, 0, tx, ty, tz, 1];
}

export function mat4ToSkp(m: number[]): {
  translation: Vec3;
  matrix3x3: [number, number, number, number, number, number, number, number, number];
} {
  return {
    matrix3x3: [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]],
    translation: [m[12], m[13], m[14]],
  };
}

export function centroid(points: Vec3[]): Vec3 {
  if (points.length === 0) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const n = points.length;
  return [x / n, y / n, z / n];
}

const PER_INCH: Record<Unit, number> = {
  mm: 25.4,
  cm: 2.54,
  m: 0.0254,
  in: 1,
  ft: 1 / 12,
};

export const UNIT_LABEL: Record<Unit, string> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  in: 'in',
  ft: 'ft',
};

export function fromInches(inches: number, unit: Unit): number {
  return inches * PER_INCH[unit];
}

export function toInches(value: number, unit: Unit): number {
  return value / PER_INCH[unit];
}

export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  const text = value.toFixed(digits);
  return text.replace(/\.?0+$/, '') || '0';
}

export function formatLength(inches: number, unit: Unit): string {
  return `${formatNumber(fromInches(inches, unit))} ${UNIT_LABEL[unit]}`;
}

export function formatArea(squareInches: number, unit: Unit): string {
  const factor = PER_INCH[unit];
  return `${formatNumber(squareInches * factor * factor)} ${UNIT_LABEL[unit]}²`;
}

export function parseMeasures(text: string, unit: Unit): number[] | null {
  const parts = text
    .trim()
    .toLowerCase()
    .split(/[,x×\s]+/)
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;
  const values: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n)) return null;
    values.push(toInches(n, unit));
  }
  return values;
}

export function projectToPlane(points: Vec3[]): Vec3[] {
  if (points.length < 3) return points.map((p) => [p[0], p[1], p[2]]);
  const n = faceNormal(points);
  const origin = points[0];
  return points.map((p) => sub(p, scale(n, dot(sub(p, origin), n))));
}

export function rayPlane(origin: Vec3, dir: Vec3, planeOrigin: Vec3, planeNormal: Vec3): Vec3 | null {
  const denom = dot(dir, planeNormal);
  if (Math.abs(denom) < 1e-8) return null;
  const t = dot(sub(planeOrigin, origin), planeNormal) / denom;
  if (t < 0) return null;
  return add(origin, scale(dir, t));
}

/** Parameter along `lineDir` of the point on the line closest to the ray. */
export function closestLineParam(linePoint: Vec3, lineDir: Vec3, rayOrigin: Vec3, rayDir: Vec3): number | null {
  const w0 = sub(linePoint, rayOrigin);
  const a = dot(lineDir, lineDir);
  const b = dot(lineDir, rayDir);
  const c = dot(rayDir, rayDir);
  const d = dot(lineDir, w0);
  const e = dot(rayDir, w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-10) return null;
  return (b * e - c * d) / denom;
}
