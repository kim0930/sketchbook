import { create, type ComponentDefinitionBuilder } from 'openskp';
import { getDef, getRoot } from './document.ts';
import { dot, faceNormal, mat4ToSkp, planeBasis, projectToPlane, sub } from './math.ts';
import type { Definition, SketchDocument, Vec3 } from './types.ts';

export interface ExportResult {
  bytes: Uint8Array;
  warnings: string[];
}

function uniqueName(name: string, used: Set<string>): string {
  const base = name.trim() || '이름없음';
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base} ${i}`)) i++;
  const next = `${base} ${i}`;
  used.add(next);
  return next;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function uvPins(points: Vec3[]): [[number, number, number], [number, number]][] | undefined {
  if (points.length < 3) return undefined;
  const normal = faceNormal(points);
  if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) return undefined;
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
  let iU = 0;
  let iV = 0;
  proj.forEach(([uu, vv], index) => {
    if (uu < minU) minU = uu;
    if (vv < minV) minV = vv;
    if (uu > maxU) {
      maxU = uu;
      iU = index;
    }
    if (vv > maxV) {
      maxV = vv;
      iV = index;
    }
  });
  if (iU === 0) iU = Math.min(1, points.length - 1);
  if (iV === 0 || iV === iU) {
    iV = points.findIndex((_, index) => index !== 0 && index !== iU);
  }
  if (iV < 0) return undefined;
  const du = maxU - minU || 1;
  const dv = maxV - minV || 1;
  const uv = (index: number): [number, number] => [(proj[index][0] - minU) / du, (proj[index][1] - minV) / dv];
  return [
    [points[0], uv(0)],
    [points[iU], uv(iU)],
    [points[iV], uv(iV)],
  ];
}

function orderedDefinitions(doc: SketchDocument): Definition[] {
  const defs = doc.definitions.filter((def) => def.kind !== 'root');
  const ids = new Set(defs.map((def) => def.id));
  const needs = new Map<string, Set<string>>();
  for (const def of defs) {
    needs.set(
      def.id,
      new Set(def.placements.map((p) => p.definitionId).filter((id) => ids.has(id) && id !== def.id)),
    );
  }
  const done = new Set<string>();
  const ordered: Definition[] = [];
  for (let guard = 0; ordered.length < defs.length && guard < defs.length + 1; guard++) {
    for (const def of defs) {
      if (done.has(def.id)) continue;
      const pending = [...(needs.get(def.id) ?? [])].some((id) => !done.has(id));
      if (!pending) {
        ordered.push(def);
        done.add(def.id);
      }
    }
  }
  for (const def of defs) if (!done.has(def.id)) ordered.push(def);
  return ordered;
}

interface FaceTarget {
  addFace: ComponentDefinitionBuilder['addFace'];
  addInstance: ComponentDefinitionBuilder['addInstance'];
}

function writeContents(
  target: FaceTarget,
  def: Definition,
  doc: SketchDocument,
  materialHandle: Map<string, number>,
  layerHandle: Map<string, number>,
  builders: Map<string, ComponentDefinitionBuilder>,
  textured: Set<string>,
  warnings: string[],
): void {
  for (const face of def.faces) {
    const raw = face.outer.map((index) => def.vertices[index]).filter(Boolean);
    if (raw.length < 3) continue;
    const points = projectToPlane(raw);
    const holes = face.holes
      .map((hole) => projectToPlane(hole.map((index) => def.vertices[index]).filter(Boolean)))
      .filter((hole) => hole.length >= 3);
    const material = face.materialId ? materialHandle.get(face.materialId) : undefined;
    const layer = layerHandle.get(face.layerId) ?? layerHandle.get(doc.defaultLayerId);
    const frontUv = face.materialId && textured.has(face.materialId) ? uvPins(points) : undefined;
    const options = {
      material,
      layer,
      hidden: face.hidden || undefined,
      holes: holes.length ? holes : undefined,
      frontUv,
    };
    try {
      target.addFace(points, options);
    } catch {
      try {
        target.addFace(points, { ...options, holes: undefined, autoTriangulate: true });
        warnings.push('한 면을 평면에 맞추지 못해 삼각형으로 나눠 저장했습니다.');
      } catch {
        warnings.push('저장하지 못한 면이 있습니다.');
      }
    }
  }
  for (const placement of def.placements) {
    const builder = builders.get(placement.definitionId);
    if (!builder) {
      warnings.push(`「${placement.name || '배치'}」의 정의를 저장하지 못했습니다.`);
      continue;
    }
    const { translation, matrix3x3 } = mat4ToSkp(placement.matrix);
    target.addInstance(builder, {
      name: placement.name,
      translation,
      matrix3x3,
      material: placement.materialId ? materialHandle.get(placement.materialId) : undefined,
      layer: layerHandle.get(placement.layerId),
      hidden: placement.hidden || undefined,
    });
  }
}

export function exportSkp(doc: SketchDocument): ExportResult {
  const warnings: string[] = [];
  const builder = create();
  const usedMaterials = new Set<string>();
  const materialHandle = new Map<string, number>();
  const textured = new Set<string>();

  for (const material of doc.materials) {
    const name = uniqueName(material.name, usedMaterials);
    const rgb: [number, number, number, number] = [
      clampByte(material.color[0]),
      clampByte(material.color[1]),
      clampByte(material.color[2]),
      255,
    ];
    const opacity = Math.max(0, Math.min(1, material.opacity));
    try {
      if (material.texture) {
        const handle = builder.addTextureMaterial(name, material.texture.data, material.texture.mime, 1, 1, opacity);
        materialHandle.set(material.id, handle);
        textured.add(material.id);
      } else {
        materialHandle.set(material.id, builder.addMaterial(name, rgb, opacity));
      }
    } catch {
      materialHandle.set(material.id, builder.addMaterial(name, rgb, opacity));
      warnings.push(`재질 「${material.name}」의 텍스처를 저장하지 못해 색만 저장했습니다.`);
    }
  }

  const usedLayers = new Set<string>();
  const layerHandle = new Map<string, number>();
  for (const layer of doc.layers) {
    const name = uniqueName(layer.name, usedLayers);
    layerHandle.set(
      layer.id,
      builder.addLayer(name, {
        color: [clampByte(layer.color[0]), clampByte(layer.color[1]), clampByte(layer.color[2])],
        hidden: !layer.visible,
      }),
    );
  }

  const builders = new Map<string, ComponentDefinitionBuilder>();
  const ordered = orderedDefinitions(doc);
  const ready = new Set<string>();
  for (const def of ordered) {
    const blocked = def.placements.some((p) => getDef(doc, p.definitionId)?.kind !== 'root' && !ready.has(p.definitionId));
    if (blocked) warnings.push(`「${def.name}」 안의 순환 참조 배치는 빠집니다.`);
    const handle = builder.addComponentDefinition(def.name || '컴포넌트', (scope) => {
      writeContents(
        {
          addFace: scope.addFace.bind(scope),
          addInstance: (definition, options) => {
            if (!ready.has(definitionKey(builders, definition))) return;
            scope.addInstance(definition, options);
          },
        },
        def,
        doc,
        materialHandle,
        layerHandle,
        builders,
        textured,
        warnings,
      );
    });
    builders.set(def.id, handle);
    ready.add(def.id);
  }

  const root = getRoot(doc);
  writeContents(
    {
      addFace: builder.addFace.bind(builder),
      addInstance: builder.addInstance.bind(builder),
    },
    root,
    doc,
    materialHandle,
    layerHandle,
    builders,
    textured,
    warnings,
  );

  for (const dimension of doc.dimensions ?? []) {
    const span = Math.hypot(
      dimension.b[0] - dimension.a[0],
      dimension.b[1] - dimension.a[1],
      dimension.b[2] - dimension.a[2],
    );
    if (span < 0.05) continue;
    try {
      builder.addDimension(dimension.a, dimension.b, 8);
    } catch {
      warnings.push('치수선 일부를 SketchUp 파일에 넣지 못했습니다.');
    }
  }

  return { bytes: builder.toBytes(), warnings: [...new Set(warnings)] };
}

function definitionKey(
  builders: Map<string, ComponentDefinitionBuilder>,
  definition: ComponentDefinitionBuilder,
): string {
  for (const [id, builder] of builders) if (builder === definition) return id;
  return '';
}
