import type {
  Definition as SkpDefinition,
  Face as SkpFace,
  Material as SkpMaterial,
  SkpModel,
} from 'openskp';
import { uid } from './ids.ts';
import { dot, newell, polygonArea, skpMatrixToMat4 } from './math.ts';
import type { Definition, Face, Layer, Material, RGB, SketchDocument, Vec3 } from './types.ts';

export interface ImportResult {
  doc: SketchDocument;
  warnings: string[];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function channel(value: number, asUnit: boolean): number {
  if (!Number.isFinite(value)) return 180;
  const scaled = asUnit ? value * 255 : value;
  return Math.max(0, Math.min(255, Math.round(scaled)));
}

function isUnitColor(values: number[]): boolean {
  return values.every((v) => v >= 0 && v <= 1) && values.some((v) => v > 0 && !Number.isInteger(v));
}

function sniffMime(data: Uint8Array): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return 'image/png';
  return null;
}

function toMaterial(source: SkpMaterial, id: string): Material {
  const rgb = [source.color.r, source.color.g, source.color.b];
  const unit = isUnitColor(rgb);
  const color = [channel(rgb[0], unit), channel(rgb[1], unit), channel(rgb[2], unit), 255] as Material['color'];
  let opacity = source.transparency;
  if (!Number.isFinite(opacity)) opacity = 1;
  if (source.color.a > 1) opacity *= source.color.a / 255;
  opacity = Math.max(0, Math.min(1, opacity));
  const textureData = source.texture?.data ?? null;
  const mime = textureData ? sniffMime(textureData) : null;
  const tileW = source.texture?.width ?? 0;
  const tileH = source.texture?.height ?? 0;
  return {
    id,
    name: source.name || '재질',
    color,
    opacity,
    texture:
      textureData && mime
        ? {
            mime,
            data: textureData,
            tileWidth: tileW > 0.05 && tileW < 5000 ? tileW : undefined,
            tileHeight: tileH > 0.05 && tileH < 5000 ? tileH : undefined,
          }
        : undefined,
  };
}

function fillGeometry(
  target: Definition,
  source: SkpDefinition,
  materialOf: (id: number | null) => string | null,
  layerId: string,
  warnings: string[],
): void {
  const indexOf = new Map<number, number>();
  for (const vertex of source.vertices) {
    indexOf.set(vertex.id, target.vertices.length);
    target.vertices.push([vertex.x, vertex.y, vertex.z]);
  }
  const edges = new Map(source.edges.map((edge) => [edge.id, edge]));
  const flags = new Map<string, { soft: boolean; smooth: boolean; hidden: boolean }>();
  const knownEdges = new Set<string>();

  const remember = (a: number, b: number, edgeId: number) => {
    const edge = edges.get(edgeId);
    if (!edge) return;
    flags.set(edgeKey(a, b), { soft: edge.soft, smooth: edge.smooth, hidden: edge.hidden });
  };

  for (const face of source.faces) {
    const loops = reconstructLoops(face, edges, indexOf, remember);
    if (loops.length === 0) {
      if (!warnings.includes('경계를 복원하지 못한 면이 있어 건너뛰었습니다.')) {
        warnings.push('경계를 복원하지 못한 면이 있어 건너뛰었습니다.');
      }
      continue;
    }
    let outerIndex = 0;
    let best = -1;
    loops.forEach((loop, index) => {
      const area = polygonArea(loop.map((i) => target.vertices[i]));
      if (area > best) {
        best = area;
        outerIndex = index;
      }
    });
    const outer = loops[outerIndex];
    const holes = loops.filter((_, index) => index !== outerIndex);
    orient(target.vertices, outer, face.normal);
    const outerNormal = newell(outer.map((i) => target.vertices[i]));
    for (const hole of holes) {
      const holeNormal = newell(hole.map((i) => target.vertices[i]));
      if (dot(holeNormal, outerNormal) > 0) hole.reverse();
    }
    const created: Face = {
      id: uid('face'),
      outer,
      holes,
      materialId: materialOf(face.materialId),
      layerId,
      hidden: face.hidden,
    };
    target.faces.push(created);
    link(target, created, flags, knownEdges);
  }
}

function reconstructLoops(
  face: SkpFace,
  edges: Map<number, SkpDefinition['edges'][number]>,
  indexOf: Map<number, number>,
  remember: (a: number, b: number, edgeId: number) => void,
): number[][] {
  const loops: number[][] = [];
  for (const loop of face.loops) {
    const verts: number[] = [];
    for (const coedge of loop) {
      const edge = edges.get(coedge.edgeId);
      if (!edge) continue;
      const startId = coedge.orientation === 1 ? edge.v1Id : edge.v2Id;
      const endId = coedge.orientation === 1 ? edge.v2Id : edge.v1Id;
      const start = indexOf.get(startId);
      const end = indexOf.get(endId);
      if (start === undefined) continue;
      if (verts.length === 0 || verts[verts.length - 1] !== start) verts.push(start);
      if (end !== undefined) remember(start, end, coedge.edgeId);
    }
    if (verts.length > 1 && verts[0] === verts[verts.length - 1]) verts.pop();
    if (verts.length >= 3) loops.push(verts);
  }
  return loops;
}

function orient(vertices: Vec3[], loop: number[], stored: Vec3): void {
  if (Math.hypot(stored[0], stored[1], stored[2]) < 1e-8) return;
  const normal = newell(loop.map((i) => vertices[i]));
  if (dot(normal, stored) < 0) loop.reverse();
}

function link(
  def: Definition,
  face: Face,
  flags: Map<string, { soft: boolean; smooth: boolean; hidden: boolean }>,
  known: Set<string>,
): void {
  for (const loop of [face.outer, ...face.holes]) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const key = edgeKey(a, b);
      if (known.has(key)) continue;
      known.add(key);
      const flag = flags.get(key);
      def.edges.push({
        id: uid('edge'),
        a,
        b,
        soft: flag?.soft ?? false,
        smooth: flag?.smooth ?? false,
        hidden: flag?.hidden ?? false,
      });
    }
  }
}

export function importModel(model: SkpModel, fileName = '모델'): ImportResult {
  const warnings: string[] = [];
  const materials: Material[] = [];
  const materialBySource = new Map<number, string>();
  const seen = new Set<SkpMaterial>();

  const pushMaterial = (source: SkpMaterial, sourceId: number | null) => {
    if (seen.has(source)) {
      if (sourceId !== null) {
        const existing = materials.find((m) => m.name === (source.name || '재질'));
        if (existing) materialBySource.set(sourceId, existing.id);
      }
      return;
    }
    seen.add(source);
    const id = uid('mat');
    materials.push(toMaterial(source, id));
    if (sourceId !== null) materialBySource.set(sourceId, id);
  };

  for (const [id, material] of model.materialsById) pushMaterial(material, id);
  for (const material of model.materials) pushMaterial(material, material.id);

  const defaultMaterial: Material = {
    id: uid('mat'),
    name: '기본',
    color: [255, 255, 255, 255],
    opacity: 1,
    isDefault: true,
  };
  materials.unshift(defaultMaterial);

  const layers: Layer[] = [];
  const layerByName = new Map<string, string>();
  for (const layer of model.layers) {
    const color: RGB = [
      channel(layer.color.r, false),
      channel(layer.color.g, false),
      channel(layer.color.b, false),
    ];
    const id = uid('layer');
    const isDefault = layer.name === 'Layer0' || layer.name === 'Untagged';
    layers.push({ id, name: layer.name || 'Layer0', color, visible: !layer.hidden, isDefault });
    layerByName.set(layer.name, id);
  }
  if (!layers.some((layer) => layer.isDefault)) {
    const id = uid('layer');
    layers.unshift({ id, name: 'Layer0', color: [140, 140, 140], visible: true, isDefault: true });
    layerByName.set('Layer0', id);
  }
  const defaultLayerId = layers.find((layer) => layer.isDefault)?.id ?? layers[0].id;

  const root: Definition = {
    id: uid('root'),
    name: '모델',
    kind: 'root',
    vertices: [],
    faces: [],
    edges: [],
    placements: [],
  };
  const defBySource = new Map<number, Definition>();
  let unnamed = 1;
  for (const [id, source] of model.definitions) {
    const def: Definition = {
      id: uid('def'),
      name: source.name || `컴포넌트 ${unnamed++}`,
      kind: 'definition',
      vertices: [],
      faces: [],
      edges: [],
      placements: [],
    };
    defBySource.set(id, def);
  }

  const materialOf = (id: number | null) => (id === null ? null : materialBySource.get(id) ?? null);
  fillGeometry(root, model.root, materialOf, defaultLayerId, warnings);
  for (const [id, source] of model.definitions) {
    const def = defBySource.get(id);
    if (def) fillGeometry(def, source, materialOf, defaultLayerId, warnings);
  }

  const place = (parent: Definition, source: SkpDefinition) => {
    for (const instance of source.instances) {
      const def = defBySource.get(instance.refIdx);
      if (!def) {
        warnings.push(`정의 #${instance.refIdx}를 찾지 못해 배치 하나를 건너뛰었습니다.`);
        continue;
      }
      parent.placements.push({
        id: uid('inst'),
        name: instance.name || def.name,
        definitionId: def.id,
        matrix: skpMatrixToMat4(instance.matrix),
        materialId: instance.materialId === null ? null : materialBySource.get(instance.materialId) ?? null,
        layerId: (instance.layer && layerByName.get(instance.layer)) || defaultLayerId,
        hidden: instance.hidden,
      });
    }
  };
  place(root, model.root);
  for (const [id, source] of model.definitions) {
    const def = defBySource.get(id);
    if (def) place(def, source);
  }

  if (model.pages.length) warnings.push('저장된 장면(씬)은 편집 대상으로 가져오지 않습니다.');
  if (model.dimensions.length || model.root.dimensions.length) {
    warnings.push('스케치업 치수선 위치는 가져오지 못합니다. 이 앱에서 잰 치수는 같은 브라우저에 남습니다.');
  }
  const looseNotes = [...model.definitions.values(), model.root].some(
    (def) => def.texts.length || def.sectionPlanes.length || def.constructionLines.length,
  );
  if (looseNotes) warnings.push('문자, 단면, 보조선은 편집 대상으로 가져오지 않습니다.');

  const uniqueWarnings = [...new Set(warnings)];
  const baseName = fileName.replace(/\.skp$/i, '') || '모델';
  const doc: SketchDocument = {
    name: baseName,
    sourceVersion: model.version || '',
    materials,
    layers,
    definitions: [root, ...defBySource.values()],
    rootId: root.id,
    defaultMaterialId: defaultMaterial.id,
    defaultLayerId,
    dimensions: [],
  };
  return { doc, warnings: uniqueWarnings };
}
