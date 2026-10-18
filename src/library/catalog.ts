import { BUILTIN } from './builtin.ts';

export interface LibraryEntry {
  id: string;
  name: string;
  thumb: string | null;
  source: 'polyhaven' | 'khronos' | 'builtin';
  credit: string;
  polycount?: number;
  categories: string[];
  tags: string[];
  url?: string;
  /** Millimeters, Poly Haven axis order. */
  dimensions?: [number, number, number];
}

export type LibraryCategory = 'builtin' | 'furniture' | 'seating' | 'table' | 'plants' | 'props' | 'people';

export const LIBRARY_CATEGORIES: { id: LibraryCategory; label: string }[] = [
  { id: 'builtin', label: '기본' },
  { id: 'furniture', label: '가구' },
  { id: 'seating', label: '의자' },
  { id: 'table', label: '테이블' },
  { id: 'plants', label: '식물' },
  { id: 'props', label: '소품' },
  { id: 'people', label: '사람' },
];

const PEOPLE: LibraryEntry[] = [
  {
    id: 'cesium-man',
    name: '서 있는 사람',
    thumb: 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/CesiumMan/screenshot/screenshot.gif',
    source: 'khronos',
    credit: 'Cesium Man © 2017 Cesium, CC BY 4.0',
    url: 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/CesiumMan/glTF-Binary/CesiumMan.glb',
    categories: ['people'],
    tags: ['person', 'human'],
  },
  {
    id: 'rigged-figure',
    name: '사람 피규어',
    thumb: 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/RiggedFigure/screenshot/screenshot.gif',
    source: 'khronos',
    credit: 'Rigged Figure © 2017 Cesium, CC BY 4.0',
    url: 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/RiggedFigure/glTF-Binary/RiggedFigure.glb',
    categories: ['people'],
    tags: ['person', 'figure'],
  },
];

interface PolyAsset {
  name?: string;
  categories?: string[];
  tags?: string[];
  polycount?: number;
  thumbnail_url?: string;
  dimensions?: number[];
}

const MAX_POLY = 80000;
const ANIMAL = /cat|shark|whale|ray|horse|elephant|bull|animal|dog|bird|fish/i;

let catalogPromise: Promise<LibraryEntry[]> | null = null;

export function loadPolyhavenCatalog(): Promise<LibraryEntry[]> {
  if (!catalogPromise) {
    catalogPromise = fetch('https://api.polyhaven.com/assets?t=models', { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error('가구 목록을 불러오지 못했습니다');
        const data = (await response.json()) as Record<string, PolyAsset>;
        const list: LibraryEntry[] = [];
        for (const [id, item] of Object.entries(data)) {
          if ((item.polycount ?? 0) > MAX_POLY) continue;
          const dimensions = item.dimensions;
          list.push({
            id,
            name: item.name || id,
            thumb: item.thumbnail_url ?? null,
            source: 'polyhaven',
            credit: 'Poly Haven, CC0',
            polycount: item.polycount,
            categories: item.categories ?? [],
            tags: item.tags ?? [],
            dimensions:
              dimensions && dimensions.length >= 3
                ? [dimensions[0], dimensions[1], dimensions[2]]
                : undefined,
          });
        }
        list.sort((a, b) => a.name.localeCompare(b.name, 'en'));
        return list;
      })
      .catch((error: unknown) => {
        catalogPromise = null;
        throw error;
      });
  }
  return catalogPromise;
}

export function isPersonLike(entry: LibraryEntry): boolean {
  const blob = `${entry.name} ${entry.tags.join(' ')}`;
  if (/bust|figure/i.test(blob)) return true;
  return /statue/i.test(blob) && !ANIMAL.test(blob);
}

function matchesQuery(entry: LibraryEntry, query: string): boolean {
  if (!query) return true;
  return `${entry.name} ${entry.tags.join(' ')} ${entry.id}`.toLowerCase().includes(query);
}

export function filterCatalog(entries: LibraryEntry[], category: LibraryCategory, query: string): LibraryEntry[] {
  const q = query.trim().toLowerCase();
  const bundled = BUILTIN.filter((entry) => entry.categories.includes(category) && matchesQuery(entry, q));
  if (category === 'builtin') return bundled;
  if (category === 'people') {
    const curated = PEOPLE.filter((entry) => matchesQuery(entry, q));
    const figures = entries.filter((entry) => isPersonLike(entry) && matchesQuery(entry, q));
    return [...bundled, ...curated, ...figures];
  }
  return [...bundled, ...entries.filter((entry) => entry.categories.includes(category) && matchesQuery(entry, q))];
}
