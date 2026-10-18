import { addBoxAssembly, type BoxPart } from '../model/document.ts';
import type { RGBA, SketchDocument, Vec3 } from '../model/types.ts';
import type { LibraryEntry } from './catalog.ts';

const wood: RGBA = [166, 122, 82, 255];
const leaf: RGBA = [74, 124, 78, 255];
const pot: RGBA = [150, 92, 64, 255];
const soil: RGBA = [92, 64, 48, 255];
const skin: RGBA = [214, 176, 148, 255];
const shirt: RGBA = [70, 110, 150, 255];
const pants: RGBA = [60, 68, 84, 255];

function box(origin: Vec3, size: Vec3, color: RGBA): BoxPart {
  return { origin, size, color };
}

const MODELS: Record<string, { name: string; parts: BoxPart[] }> = {
  'builtin-chair': {
    name: '의자',
    parts: [
      box([0, 0, 0], [1.6, 1.6, 17], wood),
      box([16.4, 0, 0], [1.6, 1.6, 17], wood),
      box([0, 16.4, 0], [1.6, 1.6, 17], wood),
      box([16.4, 16.4, 0], [1.6, 1.6, 17], wood),
      box([0, 0, 17], [18, 18, 1.6], wood),
      box([0, 16.2, 18.6], [18, 1.8, 16], wood),
    ],
  },
  'builtin-table': {
    name: '테이블',
    parts: [
      box([2, 2, 0], [2.2, 2.2, 28], wood),
      box([43.8, 2, 0], [2.2, 2.2, 28], wood),
      box([2, 25.8, 0], [2.2, 2.2, 28], wood),
      box([43.8, 25.8, 0], [2.2, 2.2, 28], wood),
      box([0, 0, 28], [48, 30, 1.6], wood),
    ],
  },
  'builtin-plant': {
    name: '화분',
    parts: [
      box([1, 1, 0], [8, 8, 7], pot),
      box([2, 2, 6.2], [6, 6, 1.2], soil),
      box([1.5, 1.5, 7.4], [7, 7, 6], leaf),
      box([2.5, 2.5, 12.6], [5, 5, 5], leaf),
    ],
  },
  'builtin-person': {
    name: '사람',
    parts: [
      box([2.2, 1.2, 0], [2.2, 2.2, 30], pants),
      box([6.2, 1.2, 0], [2.2, 2.2, 30], pants),
      box([1.6, 1, 30], [8, 4.2, 20], shirt),
      box([0, 1.4, 32], [1.8, 1.8, 16], shirt),
      box([9.4, 1.4, 32], [1.8, 1.8, 16], shirt),
      box([2.6, 0.8, 50], [6, 4.6, 6.5], skin),
    ],
  },
};

export const BUILTIN: LibraryEntry[] = [
  {
    id: 'builtin-chair',
    name: '의자',
    thumb: null,
    source: 'builtin',
    credit: '앱에 포함된 기본 모형',
    categories: ['builtin', 'seating'],
    tags: ['chair', '의자'],
    dimensions: [457, 457, 876],
  },
  {
    id: 'builtin-table',
    name: '테이블',
    thumb: null,
    source: 'builtin',
    credit: '앱에 포함된 기본 모형',
    categories: ['builtin', 'table', 'furniture'],
    tags: ['table', '테이블'],
    dimensions: [1219, 762, 752],
  },
  {
    id: 'builtin-plant',
    name: '화분',
    thumb: null,
    source: 'builtin',
    credit: '앱에 포함된 기본 모형',
    categories: ['builtin', 'plants'],
    tags: ['plant', '화분'],
    dimensions: [254, 254, 447],
  },
  {
    id: 'builtin-person',
    name: '서 있는 사람',
    thumb: null,
    source: 'builtin',
    credit: '앱에 포함된 기본 모형',
    categories: ['builtin', 'people'],
    tags: ['person', '사람'],
    dimensions: [284, 168, 1435],
  },
];

export function placeBuiltin(
  doc: SketchDocument,
  id: string,
  origin: Vec3,
): { doc: SketchDocument; placementId: string } | null {
  const model = MODELS[id];
  if (!model) return null;
  return addBoxAssembly(doc, model.name, model.parts, origin);
}
