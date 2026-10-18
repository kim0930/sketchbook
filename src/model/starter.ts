import { appendBox } from './document.ts';
import { uid } from './ids.ts';
import { rotationZ, translation } from './math.ts';
import type { Definition, SketchDocument } from './types.ts';

export function createEmpty(name = '제목 없음'): SketchDocument {
  const materialId = uid('mat');
  const layerId = uid('layer');
  const rootId = uid('root');
  return {
    name,
    sourceVersion: '',
    materials: [
      { id: materialId, name: '기본', color: [255, 255, 255, 255], opacity: 1, isDefault: true },
    ],
    layers: [{ id: layerId, name: 'Layer0', color: [140, 140, 140], visible: true, isDefault: true }],
    definitions: [
      { id: rootId, name: '모델', kind: 'root', vertices: [], faces: [], edges: [], placements: [] },
    ],
    rootId,
    defaultMaterialId: materialId,
    defaultLayerId: layerId,
    dimensions: [],
  };
}

export function createStarter(): SketchDocument {
  const doc = createEmpty('예제');
  const wood = uid('mat');
  const stone = uid('mat');
  doc.materials.push(
    { id: wood, name: '목재', color: [196, 149, 106, 255], opacity: 1 },
    { id: stone, name: '석재', color: [214, 210, 200, 255], opacity: 1 },
  );
  const furniture = uid('layer');
  doc.layers.push({ id: furniture, name: '가구', color: [196, 149, 106], visible: true });

  const slab: Definition = {
    id: uid('def'),
    name: '받침',
    kind: 'definition',
    vertices: [],
    faces: [],
    edges: [],
    placements: [],
  };
  appendBox(slab, [0, 0, 0], [168, 112, 3], stone, doc.defaultLayerId);

  const box: Definition = {
    id: uid('def'),
    name: '상자',
    kind: 'definition',
    vertices: [],
    faces: [],
    edges: [],
    placements: [],
  };
  appendBox(box, [0, 0, 0], [42, 30, 26], wood, furniture);

  doc.definitions.push(slab, box);
  const root = doc.definitions[0];
  root.placements.push(
    {
      id: uid('inst'),
      name: '받침',
      definitionId: slab.id,
      matrix: translation(0, 0, 0),
      materialId: null,
      layerId: doc.defaultLayerId,
      hidden: false,
    },
    {
      id: uid('inst'),
      name: '상자 1',
      definitionId: box.id,
      matrix: translation(18, 16, 3),
      materialId: null,
      layerId: furniture,
      hidden: false,
    },
    {
      id: uid('inst'),
      name: '상자 2',
      definitionId: box.id,
      matrix: rotationZ((18 * Math.PI) / 180, [96, 48, 3]),
      materialId: null,
      layerId: furniture,
      hidden: false,
    },
  );
  return doc;
}
