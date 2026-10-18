import type { Selection } from './types.ts';

export function selectionKey(item: Selection): string {
  if (item.kind === 'face') return `face:${item.definitionId}:${item.faceId}:${item.path.join('/')}`;
  if (item.kind === 'edge') return `edge:${item.definitionId}:${item.edgeId}:${item.path.join('/')}`;
  if (item.kind === 'placement') return `placement:${item.placementId}`;
  return `dimension:${item.dimensionId}`;
}

export function toggleSelection(items: Selection[], item: Selection): Selection[] {
  const key = selectionKey(item);
  return items.some((entry) => selectionKey(entry) === key) ? items.filter((entry) => selectionKey(entry) !== key) : [...items, item];
}

export function mergeSelection(items: Selection[], extra: Selection[]): Selection[] {
  const map = new Map(items.map((item) => [selectionKey(item), item]));
  for (const item of extra) map.set(selectionKey(item), item);
  return [...map.values()];
}
