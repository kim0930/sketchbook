import { LoadingManager, Mesh, Vector3, type Color, type Material, type Object3D, type Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LibraryEntry } from '../library/catalog.ts';
import { addImportedMesh } from './document.ts';
import type { RGBA, SketchDocument, Vec3 } from './types.ts';

const MAX_TRIANGLES = 20000;
const RAW_LIMIT = 220000;
const METERS_TO_INCHES = 1 / 0.0254;

interface RawTri {
  a: number;
  b: number;
  c: number;
  color: RGBA;
}

interface PolyFile {
  url?: string;
}

interface PolyFiles {
  gltf?: Record<string, { gltf?: { url?: string; include?: Record<string, PolyFile> } }>;
}

const colorCache = new WeakMap<Material, RGBA>();

function quantize(channel: number): number {
  return Math.max(0, Math.min(255, Math.round(channel / 16) * 16));
}

function sampleTexture(texture: Texture): [number, number, number] | null {
  const image = texture.image as CanvasImageSource | undefined;
  if (!image) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, 16, 16);
    const data = context.getImageData(0, 0, 16, 16).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 16) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
    if (!n) return null;
    return [r / n, g / n, b / n];
  } catch {
    return null;
  }
}

function materialColor(material: Material | Material[]): RGBA {
  const mat = Array.isArray(material) ? material[0] : material;
  if (!mat) return [176, 168, 156, 255];
  const cached = colorCache.get(mat);
  if (cached) return cached;
  const colored = mat as Material & { color?: Color; map?: Texture | null; opacity?: number; transparent?: boolean };
  let rgb: [number, number, number] = colored.color
    ? [Math.round(colored.color.r * 255), Math.round(colored.color.g * 255), Math.round(colored.color.b * 255)]
    : [176, 168, 156];
  const bland = rgb[0] > 230 && rgb[1] > 230 && rgb[2] > 230;
  if (bland && colored.map) {
    const sampled = sampleTexture(colored.map);
    if (sampled) rgb = [Math.round(sampled[0]), Math.round(sampled[1]), Math.round(sampled[2])];
  }
  const alpha = colored.transparent ? Math.round((colored.opacity ?? 1) * 255) : 255;
  const color: RGBA = [quantize(rgb[0]), quantize(rgb[1]), quantize(rgb[2]), alpha < 250 ? alpha : 255];
  colorCache.set(mat, color);
  return color;
}

function loadScene(url: string, files: Record<string, string>): Promise<Object3D> {
  const manager = new LoadingManager();
  const mapped = Object.entries(files);
  if (mapped.length) {
    manager.setURLModifier((request) => {
      const decoded = decodeURIComponent(request.split('?')[0]);
      for (const [path, absolute] of mapped) {
        if (decoded.endsWith(path)) return absolute;
      }
      const file = decoded.split('/').pop();
      if (!file) return request;
      for (const [path, absolute] of mapped) {
        if (path === file || path.endsWith(`/${file}`)) return absolute;
      }
      return request;
    });
  }
  const loader = new GLTFLoader(manager);
  loader.setCrossOrigin('anonymous');
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (error) => reject(error instanceof Error ? error : new Error('모델을 불러오지 못했습니다')),
    );
  });
}

async function resolveSource(entry: LibraryEntry): Promise<{ url: string; files: Record<string, string> }> {
  if (entry.url) return { url: entry.url, files: {} };
  const response = await fetch(`https://api.polyhaven.com/files/${encodeURIComponent(entry.id)}`);
  if (!response.ok) throw new Error('라이브러리 파일을 찾지 못했습니다');
  const body = (await response.json()) as PolyFiles;
  const level = body.gltf?.['1k'] ?? body.gltf?.['2k'] ?? body.gltf?.['4k'];
  const url = level?.gltf?.url;
  if (!url) throw new Error('이 항목은 glTF로 제공되지 않습니다');
  const files: Record<string, string> = {};
  for (const [path, info] of Object.entries(level.gltf?.include ?? {})) {
    if (info?.url) files[path] = info.url;
  }
  return { url, files };
}

function collect(scene: Object3D): { vertices: Vec3[]; tris: RawTri[] } {
  scene.updateMatrixWorld(true);
  const vertices: Vec3[] = [];
  const tris: RawTri[] = [];
  const point = new Vector3();
  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    const color = materialColor(mesh.material);
    const base = vertices.length;
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      vertices.push([point.x * METERS_TO_INCHES, -point.z * METERS_TO_INCHES, point.y * METERS_TO_INCHES]);
    }
    const index = mesh.geometry.getIndex();
    const push = (a: number, b: number, c: number) => {
      if (a === b || b === c || a === c) return;
      tris.push({ a: base + a, b: base + b, c: base + c, color });
    };
    if (index) {
      for (let i = 0; i < index.count; i += 3) push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
    } else {
      for (let i = 0; i < position.count; i += 3) push(i, i + 1, i + 2);
    }
  });
  return { vertices, tris };
}

function disposeScene(scene: Object3D) {
  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const map = (material as Material & { map?: Texture | null }).map;
      map?.dispose();
      material.dispose();
    }
  });
}

function decimate(vertices: Vec3[], tris: RawTri[]): { vertices: Vec3[]; tris: RawTri[] } {
  if (tris.length <= MAX_TRIANGLES) return { vertices, tris };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const vertex of vertices) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], vertex[axis]);
      max[axis] = Math.max(max[axis], vertex[axis]);
    }
  }
  const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-3);
  let cells = 96;
  let best = { vertices, tris };
  for (let attempt = 0; attempt < 7 && best.tris.length > MAX_TRIANGLES; attempt++) {
    const cell = span / cells;
    const map = new Map<string, number>();
    const nextVertices: Vec3[] = [];
    const indexOf = (index: number) => {
      const vertex = vertices[index];
      const key = `${Math.round((vertex[0] - min[0]) / cell)},${Math.round((vertex[1] - min[1]) / cell)},${Math.round((vertex[2] - min[2]) / cell)}`;
      const found = map.get(key);
      if (found !== undefined) return found;
      const id = nextVertices.length;
      nextVertices.push([vertex[0], vertex[1], vertex[2]]);
      map.set(key, id);
      return id;
    };
    const nextTris: RawTri[] = [];
    const seen = new Set<string>();
    for (const tri of tris) {
      const a = indexOf(tri.a);
      const b = indexOf(tri.b);
      const c = indexOf(tri.c);
      if (a === b || b === c || a === c) continue;
      const key = [a, b, c].sort((left, right) => left - right).join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      nextTris.push({ a, b, c, color: tri.color });
    }
    best = { vertices: nextVertices, tris: nextTris };
    cells = Math.max(10, Math.floor(cells * 0.62));
  }
  return best;
}

function placeOnGround(vertices: Vec3[], entry: LibraryEntry): Vec3[] {
  if (!vertices.length) return vertices;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const vertex of vertices) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], vertex[axis]);
      max[axis] = Math.max(max[axis], vertex[axis]);
    }
  }
  const height = Math.max(max[2] - min[2], 1e-6);
  let scale = 1;
  if (entry.dimensions) {
    const heightMm = height * 25.4;
    let closest = entry.dimensions[0];
    for (const size of entry.dimensions) {
      if (Math.abs(size - heightMm) < Math.abs(closest - heightMm)) closest = size;
    }
    if (closest > 1 && Math.abs(closest - heightMm) / closest > 0.12) scale = closest / 25.4 / height;
  } else if (entry.source === 'khronos' && (height < 60 || height > 80)) {
    scale = 68 / height;
  }
  const centerX = (min[0] + max[0]) / 2;
  const centerY = (min[1] + max[1]) / 2;
  return vertices.map((vertex) => [
    (vertex[0] - centerX) * scale,
    (vertex[1] - centerY) * scale,
    (vertex[2] - min[2]) * scale,
  ]);
}

export async function importLibraryModel(
  doc: SketchDocument,
  entry: LibraryEntry,
  origin: Vec3,
): Promise<{ doc: SketchDocument; placementId: string } | null> {
  let scene: Object3D | null = null;
  try {
    const source = await resolveSource(entry);
    scene = await loadScene(source.url, source.files);
    const collected = collect(scene);
    if (collected.tris.length > RAW_LIMIT) throw new Error('이 모델은 면이 너무 많아 가져올 수 없습니다');
    const reduced = decimate(collected.vertices, collected.tris);
    const grounded = placeOnGround(reduced.vertices, entry);
    return addImportedMesh(
      doc,
      entry.name,
      grounded,
      reduced.tris.map((tri) => ({ indices: [tri.a, tri.b, tri.c], color: tri.color })),
      origin,
    );
  } catch (error) {
    if (error instanceof Error && /failed to fetch|network/i.test(error.message)) {
      throw new Error('라이브러리에 연결하지 못했습니다');
    }
    throw error instanceof Error ? error : new Error('모델을 불러오지 못했습니다');
  } finally {
    if (scene) disposeScene(scene);
  }
}
