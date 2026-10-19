import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseSkp } from 'openskp';
import {
  addLayer,
  addMaterial,
  boundsOfPoints,
  definitionLocalPoints,
  deleteDimension,
  deleteEdge,
  deleteFace,
  deleteMaterial,
  deletePlacement,
  faceArea,
  findPlacement,
  getDef,
  makeUnique,
  paintFace,
  renamePlacement,
  selectionValid,
  setFaceLayer,
  setPlacementLayer,
  updateLayer,
  updateMaterial,
  usageCount,
  duplicatePlacement,
  groupFace,
  modelBounds,
  pasteFaceLoops,
  pastePlacementCopies,
  pointsOf,
  worldStep,
} from './model/document.ts';
import { exportSkp } from './model/exportSkp.ts';
import { toGlb, toObj, toStl } from './model/exportMesh.ts';
import { importModel } from './model/importSkp.ts';
import { importLibraryModel } from './model/importGltf.ts';
import type { ParseMessage } from './parseWorker.ts';
import { formatArea, formatLength, transformPoint, UNIT_LABEL } from './model/math.ts';
import { toggleSelection } from './model/selection.ts';
import { createEmpty, createStarter } from './model/starter.ts';
import type { Dimension, Selection, SketchDocument, Tool, Unit, Vec3 } from './model/types.ts';
import type { LibraryEntry } from './library/catalog.ts';
import { placeBuiltin } from './library/builtin.ts';
import {
  IconArc,
  IconCircle,
  IconErase,
  IconHand,
  IconLine,
  IconMeasure,
  IconMove,
  IconOffset,
  IconPaint,
  IconPush,
  IconRect,
  IconRedo,
  IconRotate,
  IconScale,
  IconSelect,
  IconUndo,
  IconWalk,
} from './ui/icons.tsx';
import { LibraryPanel } from './ui/LibraryPanel.tsx';
import { Viewport } from './viewport/Viewport.tsx';

const TOOLS: { id: Tool; label: string; name?: string; key: string; hint: string; icon: ReactNode }[] = [
  { id: 'navigate', label: '탐색', key: 'H', hint: '왼쪽 드래그로 둘러보고, 오른쪽 드래그로 이동합니다. 모델은 선택되지 않습니다.', icon: <IconHand /> },
  { id: 'walk', label: '걷기', key: 'K', hint: '바라보는 방향으로 WASD·방향키가 움직입니다. 시야는 세로 60도입니다. 벽은 한 번 막히고, 같은 방향키를 빠르게 다시 누르면 통과합니다. Shift는 더 빠릅니다. 평면도에서 경로를 찍으면 그 길을 걸어가고 동영상으로 저장합니다.', icon: <IconWalk /> },
  { id: 'select', label: '선택', key: 'V', hint: '클릭하면 그룹이나 면이 선택됩니다. Shift+클릭으로 더하고, 드래그하면 영역 안을 고릅니다. Alt+클릭은 선입니다. 더블클릭으로 그룹 안으로 들어갑니다.', icon: <IconSelect /> },
  { id: 'line', label: '선', key: 'L', hint: '점을 이어서 클릭하고, 시작점에 맞추거나 Enter로 면을 닫습니다. 끝점·중간점·선 위에 붙습니다.', icon: <IconLine /> },
  { id: 'rect', label: '사각형', key: 'R', hint: '첫 모서리와 반대 모서리를 찍습니다. 치수는 80, 60 처럼 입력합니다. 끝점·중간점에 붙습니다.', icon: <IconRect /> },
  { id: 'circle', label: '원', key: 'C', hint: '중심을 찍고 반지름을 정합니다. 끝점·중간점·중심에 붙습니다.', icon: <IconCircle /> },
  { id: 'arc', label: '호', key: 'A', hint: '중심, 시작, 끝을 찍으면 반시계 방향 부채꼴 면이 생깁니다. 치수는 각도(도)입니다. 단면이 켜져 있으면 절단면에 그려집니다.', icon: <IconArc /> },
  { id: 'offset', label: '오프셋', key: 'O', hint: '면을 클릭한 뒤 안팎으로 끕니다. 안쪽으로 끌면 테두리와 안쪽 면이 나뉩니다. 치수로 두께를 줄 수 있습니다.', icon: <IconOffset /> },
  { id: 'measure', label: '측정', key: 'T', hint: '두 점을 찍으면 치수로 남습니다. 선 위에서는 길이, 면 위에서는 면적을 보여 줍니다.', icon: <IconMeasure /> },
  { id: 'pushpull', label: '밀기/끌기', name: '밀기', key: 'P', hint: '면을 드래그해 입체로 만들거나 두께를 바꿉니다.', icon: <IconPush /> },
  { id: 'move', label: '이동', key: 'M', hint: '선택한 뒤 축 핸들을 드래그합니다. 치수는 x, y, z.', icon: <IconMove /> },
  { id: 'rotate', label: '회전', key: 'Q', hint: '선택한 물체를 빨간·초록·파란 축으로 회전합니다.', icon: <IconRotate /> },
  { id: 'scale', label: '배율', key: 'S', hint: '선택한 물체의 크기를 바꿉니다.', icon: <IconScale /> },
  { id: 'paint', label: '페인트', key: 'B', hint: '현재 재질을 면이나 그룹에 칠합니다.', icon: <IconPaint /> },
  { id: 'erase', label: '지우개', key: 'E', hint: '면, 그룹, 치수를 지웁니다. 선 근처를 클릭하면 그 선과 붙은 면이 지워집니다.', icon: <IconErase /> },
];

const UNITS: Unit[] = ['mm', 'cm', 'm', 'in', 'ft'];

type Clip =
  | { kind: 'face'; definitionId: string; loops: Vec3[][]; materialId: string | null; layerId: string; step: Vec3 }
  | { kind: 'placement'; placementId: string; path: string[]; step: Vec3 };

function arrayCount(text: string): number | null {
  const match = text.trim().match(/^(\d+)\s*[x×*]$/i);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 1 || count > 40) return null;
  return count;
}

function dimensionStorageKey(name: string) {
  return `sketchbook-dims:${name}`;
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function readSavedDimensions(name: string): Dimension[] {
  try {
    const raw = localStorage.getItem(dimensionStorageKey(name));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as { id?: unknown; a?: unknown; b?: unknown };
      if (typeof record.id !== 'string' || !isVec3(record.a) || !isVec3(record.b)) return [];
      return [{ id: record.id, a: record.a, b: record.b }];
    });
  } catch {
    return [];
  }
}

function writeSavedDimensions(name: string, dimensions: Dimension[]) {
  try {
    localStorage.setItem(dimensionStorageKey(name), JSON.stringify(dimensions));
  } catch {
    /* 저장 공간이 없어도 편집은 계속됩니다. */
  }
}

function bytesPart(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function download(data: BlobPart, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const STAGE_LABEL: Record<string, string> = {
  tlv_walk: '파일 기록을 읽는 중',
  legacy_defs: '구성 요소를 읽는 중',
  build_scene: '배치를 읽는 중',
  import: '형상을 구성하고 있습니다',
};

function parseInWorker(
  buffer: ArrayBuffer,
  onProgress: (text: string) => void,
): Promise<{ doc: SketchDocument; warnings: string[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' });
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('10분이 지나도 해석이 끝나지 않았습니다'));
    }, 600000);
    worker.onmessage = (event: MessageEvent<ParseMessage>) => {
      const data = event.data;
      if (data.ok === 'progress') {
        const label = STAGE_LABEL[data.stage] ?? '파일을 읽는 중';
        onProgress(data.total > 1 ? `${label} (${data.current}/${data.total})` : label);
        return;
      }
      window.clearTimeout(timer);
      worker.terminate();
      if (data.ok) resolve({ doc: data.doc, warnings: data.warnings });
      else reject(new Error(data.error || '해석 실패'));
    };
    worker.onerror = (event) => {
      window.clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || '워커 오류'));
    };
    worker.postMessage(buffer, [buffer]);
  });
}

const DEFAULT_MODEL = '261015_과천 과천동 3D_v2017.skp';

let defaultModelBuffer: Promise<ArrayBuffer> | null = null;

function loadDefaultModel(): Promise<ArrayBuffer> {
  if (!defaultModelBuffer) {
    defaultModelBuffer = fetch(`${import.meta.env.BASE_URL}default.skp`)
      .then((response) => {
        if (!response.ok) throw new Error('기본 모형을 찾지 못했습니다');
        return response.arrayBuffer();
      })
      .catch((error: unknown) => {
        defaultModelBuffer = null;
        throw error;
      });
  }
  return defaultModelBuffer;
}

function validPath(doc: SketchDocument, path: string[]): string[] {
  const next: string[] = [];
  for (const id of path) {
    if (!findPlacement(doc, id)) break;
    next.push(id);
  }
  return next;
}

export default function App() {
  const [doc, setDoc] = useState<SketchDocument>(() => createEmpty());
  const [past, setPast] = useState<SketchDocument[]>([]);
  const [future, setFuture] = useState<SketchDocument[]>([]);
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection[]>([]);
  const [editingPath, setEditingPath] = useState<string[]>([]);
  const [unit, setUnit] = useState<Unit>('mm');
  const [snap, setSnap] = useState(0);
  const [drawMaterialId, setDrawMaterialId] = useState<string | null>(null);
  const [activeLayerId, setActiveLayerId] = useState(doc.defaultLayerId);
  const [panel, setPanel] = useState<'info' | 'material' | 'layer' | 'tree'>('info');
  const [typed, setTyped] = useState('');
  const [live, setLive] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState<string | null>('스케치업 파일을 읽고 있습니다');
  const [toasts, setToasts] = useState<string[]>([]);
  const [help, setHelp] = useState(true);
  const [menu, setMenu] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState<string | null>(null);
  const [viewToken, setViewToken] = useState(1);
  const [viewCommand, setViewCommand] = useState<ViewportCommand>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const [numericRequest, setNumericRequest] = useState<{ id: number; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const skipDefault = useRef(false);
  const docRef = useRef(doc);
  const placeAnchorRef = useRef<Vec3 | null>(null);
  const dimensionsReady = useRef(false);
  useEffect(() => {
    if (!dimensionsReady.current) {
      dimensionsReady.current = true;
      return;
    }
    writeSavedDimensions(doc.name, doc.dimensions ?? []);
  }, [doc]);
  const dropSlot = useRef(0);
  const libraryLock = useRef(false);
  docRef.current = doc;

  const path = useMemo(() => validPath(doc, editingPath), [doc, editingPath]);
  const safeSelection = useMemo(() => selection.filter((item) => selectionValid(doc, item)), [doc, selection]);
  const activeTool = TOOLS.find((item) => item.id === tool) ?? TOOLS[0];

  useEffect(() => {
    if (path.length !== editingPath.length) setEditingPath(path);
  }, [path, editingPath.length]);

  useEffect(() => {
    if (safeSelection.length !== selection.length) setSelection(safeSelection);
  }, [doc, selection]);

  const toast = (message: string) => {
    setToasts((items) => [...items.slice(-2), message]);
    window.setTimeout(() => setToasts((items) => items.slice(1)), 6400);
  };

  const replaceDoc = (next: SketchDocument) => {
    skipDefault.current = true;
    setDoc(next);
    setPast([]);
    setFuture([]);
    setSelection([]);
    setEditingPath([]);
    setDirty(false);
    setDrawMaterialId(null);
    setActiveLayerId(next.defaultLayerId);
    setViewToken((value) => value + 1);
    setTyped('');
    setLive('');
    dropSlot.current = 0;
  };

  const importEntry = async (entry: LibraryEntry) => {
    if (libraryLock.current) return;
    libraryLock.current = true;
    setLibraryBusy(entry.id);
    try {
      const anchor = placeAnchorRef.current;
      const bounds = modelBounds(docRef.current);
      const slot = dropSlot.current;
      dropSlot.current += 1;
      const origin: Vec3 = [
        (anchor?.[0] ?? bounds?.center[0] ?? 0) + (slot % 4) * 56,
        (anchor?.[1] ?? bounds?.center[1] ?? 0) + (Math.floor(slot / 4) % 3) * 56,
        bounds?.min[2] ?? 0,
      ];
      const placed =
        entry.source === 'builtin' ? placeBuiltin(docRef.current, entry.id, origin) : await importLibraryModel(docRef.current, entry, origin);
      if (!placed) {
        toast('이 모델에서 가져올 면이 없습니다');
        return;
      }
      commit(placed.doc);
      setSelection([{ kind: 'placement', placementId: placed.placementId, path: [placed.placementId] }]);
      toast(`가져왔습니다: ${entry.name}. ${entry.credit}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : '가져오기에 실패했습니다');
    } finally {
      libraryLock.current = false;
      setLibraryBusy(null);
    }
  };

  const commit = (next: SketchDocument) => {
    setPast((items) => [...items, docRef.current].slice(-30));
    setFuture([]);
    setDoc(next);
    setDirty(true);
  };

  const clipRef = useRef<Clip | null>(null);

  const copySelection = (silent = false) => {
    const copyable = safeSelection.filter((item) => item.kind === 'face' || item.kind === 'placement');
    const current = copyable.length === 1 ? copyable[0] : null;
    if (!current) {
      if (!silent) toast('복사할 그룹이나 면을 하나만 선택하세요.');
      return false;
    }
    if (current.kind === 'face') {
      const def = getDef(doc, current.definitionId);
      const face = def?.faces.find((item) => item.id === current.faceId);
      if (!def || !face) return false;
      const loops = [face.outer, ...face.holes].map((loop) => pointsOf(def, loop).map((point) => [point[0], point[1], point[2]] as Vec3));
      clipRef.current = {
        kind: 'face',
        definitionId: def.id,
        loops,
        materialId: face.materialId,
        layerId: face.layerId,
        step: worldStep(loops[0]),
      };
      if (!silent) toast('면을 복사했습니다. Ctrl+V로 붙여넣거나, 치수에 3x 처럼 입력하세요.');
      return true;
    }
    const found = findPlacement(doc, current.placementId);
    if (!found) return false;
    const placement = found.parent.placements[found.index];
    const def = getDef(doc, placement.definitionId);
    const placed = def
      ? definitionLocalPoints(doc, def).map((point) => transformPoint(placement.matrix, point))
      : [[placement.matrix[12], placement.matrix[13], placement.matrix[14]] as Vec3];
    clipRef.current = { kind: 'placement', placementId: placement.id, path: [...current.path], step: worldStep(placed) };
    if (!silent) toast('그룹을 복사했습니다. Ctrl+V로 붙여넣거나, 치수에 3x 처럼 입력하세요.');
    return true;
  };

  const pasteCopies = (copies: number) => {
    const clip = clipRef.current;
    if (!clip || copies < 1) {
      toast('복사한 면이나 그룹이 없습니다.');
      return;
    }
    if (clip.kind === 'face') {
      const next = pasteFaceLoops(docRef.current, clip.definitionId, clip.loops, clip.materialId, clip.layerId, copies, clip.step);
      if (!next) {
        toast('붙여넣을 위치가 없습니다.');
        return;
      }
      commit(next);
      toast(copies === 1 ? '면을 붙여넣었습니다.' : `면을 ${copies}개 붙여넣었습니다.`);
      return;
    }
    const placed = pastePlacementCopies(docRef.current, clip.placementId, copies, clip.step);
    if (!placed) {
      toast('붙여넣을 그룹이 없습니다.');
      return;
    }
    commit(placed.doc);
    const id = placed.ids[placed.ids.length - 1];
    if (id) setSelection([{ kind: 'placement', placementId: id, path: [...clip.path.slice(0, -1), id] }]);
    toast(copies === 1 ? '그룹을 붙여넣었습니다.' : `그룹을 ${copies}개 붙여넣었습니다.`);
  };

  const repeatSelection = (copies: number) => {
    if (!copySelection(true)) {
      toast('면이나 그룹을 선택한 뒤 배열하세요.');
      return;
    }
    pasteCopies(copies);
  };

  const makeGroup = () => {
    const face = safeSelection.length === 1 && safeSelection[0].kind === 'face' ? safeSelection[0] : null;
    if (!face) {
      toast('그룹으로 만들 면을 하나만 선택하세요.');
      return;
    }
    const grouped = groupFace(doc, face.definitionId, face.faceId);
    if (!grouped) return;
    commit(grouped.doc);
    setSelection([
      {
        kind: 'placement',
        placementId: grouped.placementId,
        path: [...face.path, grouped.placementId],
      },
    ]);
    toast('선택한 면을 그룹으로 만들었습니다.');
  };

  const undo = () => {
    setPast((items) => {
      if (!items.length) return items;
      const previous = items[items.length - 1];
      setFuture((queue) => [docRef.current, ...queue]);
      setDoc(previous);
      setDirty(true);
      return items.slice(0, -1);
    });
  };

  const redo = () => {
    setFuture((items) => {
      if (!items.length) return items;
      const [next, ...rest] = items;
      setPast((queue) => [...queue, docRef.current].slice(-30));
      setDoc(next);
      setDirty(true);
      return rest;
    });
  };

  const openBuffer = async (buffer: ArrayBuffer, filename: string, mode?: 'default') => {
    if (mode === 'default' && skipDefault.current) return;
    setLoading('스케치업 파일을 읽고 있습니다');
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    try {
      const heavy = buffer.byteLength > 32 * 1024 * 1024;
      let doc: SketchDocument;
      let warnings: string[];
      try {
        const parsed = await parseInWorker(heavy ? buffer : buffer.slice(0), setLoading);
        doc = parsed.doc;
        warnings = parsed.warnings;
      } catch (error) {
        if (heavy || buffer.byteLength === 0) throw error;
        setLoading('형상을 구성하고 있습니다');
        const result = importModel(parseSkp(buffer), filename);
        doc = result.doc;
        warnings = result.warnings;
      }
      doc = { ...doc, name: filename.replace(/\.skp$/i, '') || '모델' };
      const saved = readSavedDimensions(doc.name);
      if (saved.length) doc = { ...doc, dimensions: saved };
      setLoading('화면을 만들고 있습니다');
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
      if (mode === 'default' && skipDefault.current) return;
      replaceDoc(doc);
      const note = doc.sourceVersion ? `SketchUp ${doc.sourceVersion}` : '스케치업 파일';
      toast(warnings[0] ? `${note}을 열었습니다. ${warnings[0]}` : `${note}을 열었습니다.`);
    } catch (error) {
      console.error(error);
      const detail = error instanceof Error ? error.message : '';
      toast(detail ? `파일을 열지 못했습니다. ${detail}` : '이 .skp 파일을 읽지 못했습니다. SketchUp 2013 이후 파일인지 확인해 주세요.');
    } finally {
      setLoading(null);
    }
  };

  const openFile = async (file: File) => {
    skipDefault.current = true;
    if (!file.name.toLowerCase().endsWith('.skp')) {
      toast('.skp 파일만 열 수 있습니다.');
      return;
    }
    const megabytes = file.size / (1024 * 1024);
    if (megabytes > 40) {
      toast(`${megabytes.toFixed(0)}MB 파일입니다. 읽는 동안 이 탭을 그대로 두세요.`);
    }
    await openBuffer(await file.arrayBuffer(), file.name);
  };

  const openBufferRef = useRef(openBuffer);
  openBufferRef.current = openBuffer;

  useEffect(() => {
    let cancel = false;
    loadDefaultModel()
      .then((buffer) => {
        if (cancel || skipDefault.current) {
          if (!cancel) setLoading(null);
          return;
        }
        const megabytes = buffer.byteLength / (1024 * 1024);
        if (megabytes > 40) toast(`${megabytes.toFixed(0)}MB 파일입니다. 읽는 동안 이 탭을 그대로 두세요.`);
        return openBufferRef.current(buffer.slice(0), DEFAULT_MODEL, 'default');
      })
      .catch((error) => {
        if (cancel) return;
        console.error(error);
        setLoading(null);
        toast(error instanceof Error ? error.message : '기본 모형을 열지 못했습니다.');
      });
    return () => {
      cancel = true;
    };
  }, []);

  const saveSkp = () => {
    try {
      const result = exportSkp(doc);
      writeSavedDimensions(doc.name, doc.dimensions ?? []);
      download(bytesPart(result.bytes), `${doc.name || '모델'}.skp`, 'application/octet-stream');
      setDirty(false);
      toast(result.warnings[0] ?? 'SketchUp 2013–2020 호환 .skp로 저장했습니다. 최신 SketchUp에서도 열립니다.');
    } catch (error) {
      console.error(error);
      toast('저장에 실패했습니다.');
    }
  };

  const saveOther = async (kind: 'glb' | 'obj' | 'stl') => {
    setMenu(false);
    try {
      if (kind === 'obj') download(toObj(doc), `${doc.name || '모델'}.obj`, 'text/plain');
      else if (kind === 'stl') download(bytesPart(toStl(doc)), `${doc.name || '모델'}.stl`, 'model/stl');
      else download(await toGlb(doc), `${doc.name || '모델'}.glb`, 'model/gltf-binary');
    } catch (error) {
      console.error(error);
      toast('내보내기에 실패했습니다.');
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveSkp();
        return;
      }
      if (meta && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        fileRef.current?.click();
        return;
      }
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (!typing && meta && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelection();
        return;
      }
      if (!typing && meta && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteCopies(1);
        return;
      }
      if (typing) return;
      if (toolRef.current === 'walk') {
        const key = event.key.toLowerCase();
        if (key === 'escape') {
          event.preventDefault();
          setTool('navigate');
          return;
        }
        if (key === 'f' || key === 'w' || key === 'a' || key === 's' || key === 'd' || key.startsWith('arrow')) {
          event.preventDefault();
          return;
        }
      }
      if (event.key === 'Backspace' && typed) {
        event.preventDefault();
        setTyped((value) => value.slice(0, -1));
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!safeSelection.length) return;
        event.preventDefault();
        const next = deleteMany(doc, safeSelection);
        if (next) {
          setSelection([]);
          commit(next);
        }
        return;
      }
      if (event.key.toLowerCase() === 'f') {
        setViewCommand({ id: Date.now(), type: 'fit' });
        return;
      }
      if (event.key === 'Enter') {
        const copies = arrayCount(typed);
        if (copies) {
          event.preventDefault();
          repeatSelection(copies);
          setTyped('');
          return;
        }
        setNumericRequest({ id: Date.now(), text: typed });
        setTyped('');
        return;
      }
      if (event.key.toLowerCase() === 'g' && safeSelection.length === 1 && safeSelection[0].kind === 'face') {
        event.preventDefault();
        makeGroup();
        return;
      }
      if (/^[\d.+\-]$/.test(event.key) || event.key === ',' || event.key.toLowerCase() === 'x') {
        setTyped((value) => value + event.key);
        return;
      }
      const found = TOOLS.find((item) => item.key.toLowerCase() === event.key.toLowerCase());
      if (found) setTool(found.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // save/undo close over the latest doc via the render that registered this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, typed, safeSelection, past, future]);

  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  useEffect(() => {
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file) void openFile(file);
    };
    const onOver = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const faces = doc.definitions.reduce((sum, def) => sum + def.faces.length, 0);
  const defs = doc.definitions.filter((def) => def.kind !== 'root').length;
  const paintId = drawMaterialId ?? doc.defaultMaterialId;

  return (
    <div className={inspectorOpen ? 'app inspector-open' : 'app'}>
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <strong>스케치북</strong>
            <small>SketchUp 편집기</small>
          </div>
        </div>
        <input
          className="doc-name"
          aria-label="문서 이름"
          value={doc.name}
          onChange={(event) => {
            setDoc({ ...doc, name: event.target.value });
            setDirty(true);
          }}
        />
        {dirty && <span className="dirty">수정됨</span>}
        <div className="top-actions">
          <button type="button" onClick={() => fileRef.current?.click()}>
            열기
          </button>
          <button type="button" className="primary" onClick={saveSkp}>
            SKP 저장
          </button>
          <div className="menu">
            <button type="button" onClick={() => setMenu((open) => !open)}>
              내보내기
            </button>
            {menu && (
              <div className="menu-pop">
                <button type="button" onClick={() => void saveOther('glb')}>
                  GLB · 미터, Y-up
                </button>
                <button type="button" onClick={() => void saveOther('obj')}>
                  OBJ · 인치, Z-up
                </button>
                <button type="button" onClick={() => void saveOther('stl')}>
                  STL · 인치, Z-up
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              if (dirty && !window.confirm('저장하지 않은 변경이 있습니다. 새 스케치를 만들까요?')) return;
              replaceDoc(createEmpty());
            }}
          >
            새 스케치
          </button>
          <button type="button" onClick={() => replaceDoc(createStarter())}>
            예제
          </button>
          <button
            type="button"
            className={libraryOpen ? 'on' : ''}
            onClick={() => {
              setLibraryOpen((open) => !open);
              setInspectorOpen(false);
            }}
          >
            라이브러리
          </button>
          <button
            type="button"
            className={inspectorOpen ? 'inspector-btn on' : 'inspector-btn'}
            aria-pressed={inspectorOpen}
            onClick={() => {
              setInspectorOpen((open) => !open);
              setLibraryOpen(false);
            }}
          >
            속성
          </button>
          <button type="button" className="icon-btn" disabled={!past.length} onClick={undo} title="실행 취소 (Ctrl+Z)">
            <IconUndo />
          </button>
          <button type="button" className="icon-btn" disabled={!future.length} onClick={redo} title="다시 실행 (Ctrl+Shift+Z)">
            <IconRedo />
          </button>
        </div>
        <input
          ref={fileRef}
          hidden
          type="file"
          accept=".skp,application/octet-stream"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void openFile(file);
          }}
        />
      </header>

      <div className="workspace">
        <nav className="tools" aria-label="도구">
          {TOOLS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tool === item.id ? 'tool active' : 'tool'}
              title={`${item.label} (${item.key})`}
              aria-label={item.label}
              onClick={() => setTool(item.id)}
            >
              {item.icon}
              <span>{item.name ?? item.label}</span>
            </button>
          ))}
        </nav>
        {libraryOpen && <LibraryPanel busyId={libraryBusy} onImport={(entry) => void importEntry(entry)} onClose={() => setLibraryOpen(false)} />}

        {inspectorOpen && (
          <button type="button" className="sheet-backdrop" aria-label="속성 닫기" onClick={() => setInspectorOpen(false)} />
        )}
        <div className="stage">
          {path.length > 0 && (
            <div className="banner">
              {crumbs(doc, path).map((crumb, index) => (
                <button key={crumb.path.join('/') || 'root'} type="button" onClick={() => setEditingPath(crumb.path)}>
                  {index > 0 && <span className="sep">/</span>}
                  {crumb.label}
                </button>
              ))}
              <span className="banner-note">그룹 편집 중 · Esc로 한 단계 나갑니다</span>
              {(() => {
                const open = findPlacement(doc, path[path.length - 1]);
                const defId = open?.parent.placements[open.index].definitionId;
                if (!defId || usageCount(doc, defId) < 2) return null;
                return (
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => {
                      const next = makeUnique(doc, path[path.length - 1]);
                      if (next) commit(next);
                    }}
                  >
                    이 배치만 고유하게
                  </button>
                );
              })()}
            </div>
          )}
          <Viewport
            doc={doc}
            tool={tool}
            selection={safeSelection}
            editingPath={path}
            drawMaterialId={paintId}
            activeLayerId={activeLayerId}
            unit={unit}
            snapInches={snap}
            viewToken={viewToken}
            viewCommand={viewCommand}
            numericRequest={numericRequest}
            onSelect={setSelection}
            onEditingPath={setEditingPath}
            onCommit={commit}
            onLiveMeasure={setLive}
            placeAnchorRef={placeAnchorRef}
            onEscape={() => {
              if (path.length) setEditingPath(path.slice(0, -1));
              else setSelection([]);
            }}
          />
          {help && (
            <div className="help">
              <p>
                탐색(H)은 선택 없이 둘러봅니다. 선택(V)은 클릭으로 그룹이나 면을 고르고, Shift+클릭이나 드래그로 여러 개를 고릅니다. 걷기(K)는 사람 시점입니다. 벽은 한 번에 막히고, 같은 방향키를 빠르게 다시 누르면 통과합니다. 호(A)는 중심·시작·끝으로 부채꼴을 만듭니다. 측정은 치수로 남고, 단면이 켜져 있으면 그 면에 그립니다. 오프셋(O)은 면을 안팎으로 띄웁니다. Ctrl+C, Ctrl+V로 복사하고 치수에 3x를 입력하면 옆으로 배열합니다. 평면도는 드래그로 옮기고, 클릭하면 그곳을 바라봅니다.
                <span className="touch-help"> 한 손가락은 고른 도구이고, 두 손가락으로 밀면 화면이 움직이고 벌리면 확대됩니다. 걷기에서는 화면을 끌어 둘러보고 오른쪽 버튼으로 이동합니다.</span>
              </p>
              <button type="button" onClick={() => setHelp(false)}>
                닫기
              </button>
            </div>
          )}
          {loading && (
            <div className="loading">
              <span /> {loading}
            </div>
          )}
        </div>

        <aside className="panel">
          <div className="tabs">
            {(
              [
                ['info', '정보'],
                ['material', '재질'],
                ['layer', '태그'],
                ['tree', '구조'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" className={panel === id ? 'active' : ''} onClick={() => setPanel(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="panel-body">
            {panel === 'info' && (
              <InfoPanel
                doc={doc}
                selection={safeSelection}
                unit={unit}
                onCommit={commit}
                onDrawMaterial={setDrawMaterialId}
                paintId={paintId}
                onCopy={copySelection}
                onGroup={makeGroup}
              />
            )}
            {panel === 'material' && (
              <MaterialPanel
                doc={doc}
                paintId={paintId}
                onPaint={setDrawMaterialId}
                onCommit={commit}
              />
            )}
            {panel === 'layer' && (
              <LayerPanel doc={doc} activeLayerId={activeLayerId} onActive={setActiveLayerId} onCommit={commit} />
            )}
            {panel === 'tree' && (
              <TreePanel
                doc={doc}
                selection={safeSelection}
                onSelect={setSelection}
                onEnter={setEditingPath}
                onCommit={commit}
              />
            )}
          </div>
        </aside>
      </div>

      <footer className="status">
        <span className="tool-hint">
          <b>{activeTool.label}</b> {activeTool.hint}
        </span>
        {safeSelection.length > 0 && <span className="sel-count">{selectionSummary(safeSelection)}</span>}
        {live && <span className="readout">{live}</span>}
        <label className="measure">
          치수
          <input
            value={typed}
            placeholder="숫자 입력"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                const copies = arrayCount(typed);
                if (copies) repeatSelection(copies);
                else setNumericRequest({ id: Date.now(), text: typed });
                setTyped('');
              }
            }}
          />
        </label>
        <select value={unit} aria-label="단위" onChange={(event) => setUnit(event.target.value as Unit)}>
          {UNITS.map((item) => (
            <option key={item} value={item}>
              {UNIT_LABEL[item]}
            </option>
          ))}
        </select>
        <select
          value={String(snap)}
          aria-label="모눈 스냅"
          title="끝점, 중간점, 중심, 선 위 스냅은 항상 동작합니다. 이 값은 빈 평면의 모눈입니다."
          onChange={(event) => setSnap(Number(event.target.value))}
        >
          <option value="0">모눈 끄기</option>
          <option value={1 / 25.4}>1 mm</option>
          <option value={10 / 25.4}>10 mm</option>
          <option value="1">1 in</option>
          <option value="12">1 ft</option>
        </select>
        <div className="views">
          <button type="button" title="모델을 화면 가운데 맞춥니다 (F)" onClick={() => setViewCommand({ id: Date.now(), type: 'fit' })}>
            화면 맞춤
          </button>
          <button
            type="button"
            title="회전점을 모델 중심으로 옮깁니다. 빨간 점을 드래그하면 회전점을 직접 옮길 수 있습니다."
            onClick={() => setViewCommand({ id: Date.now(), type: 'pivot' })}
          >
            회전점
          </button>
          {(
            [
              ['iso', '등각'],
              ['top', '위'],
              ['front', '앞'],
              ['right', '오른쪽'],
            ] as const
          ).map(([type, label]) => (
            <button key={type} type="button" onClick={() => setViewCommand({ id: Date.now(), type })}>
              {label}
            </button>
          ))}
        </div>
        <span className="stats">
          면 {faces} · 정의 {defs}
        </span>
      </footer>
      <div className="toasts">
        {toasts.map((item, index) => (
          <div key={`${item}-${index}`} className="toast">
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

type ViewportCommand = { id: number; type: 'fit' | 'pivot' | 'iso' | 'top' | 'front' | 'right' } | null;

function crumbs(doc: SketchDocument, path: string[]) {
  const items: { label: string; path: string[] }[] = [{ label: '모델', path: [] }];
  path.forEach((id, index) => {
    const found = findPlacement(doc, id);
    items.push({
      label: found?.parent.placements[found.index].name || '그룹',
      path: path.slice(0, index + 1),
    });
  });
  return items;
}

function deleteMany(doc: SketchDocument, items: Selection[]): SketchDocument | null {
  let next = doc;
  let changed = false;
  for (const item of items) {
    if (item.kind !== 'placement') continue;
    const updated = deletePlacement(next, item.placementId);
    if (updated) {
      next = updated;
      changed = true;
    }
  }
  for (const item of items) {
    const updated =
      item.kind === 'face'
        ? deleteFace(next, item.definitionId, item.faceId)
        : item.kind === 'edge'
          ? deleteEdge(next, item.definitionId, item.edgeId)
          : item.kind === 'dimension'
            ? deleteDimension(next, item.dimensionId)
            : null;
    if (updated) {
      next = updated;
      changed = true;
    }
  }
  return changed ? next : null;
}

function selectionSummary(items: Selection[]): string {
  const counts = { placement: 0, face: 0, edge: 0, dimension: 0 };
  for (const item of items) counts[item.kind] += 1;
  const parts = [
    counts.placement ? `그룹 ${counts.placement}` : '',
    counts.face ? `면 ${counts.face}` : '',
    counts.edge ? `선 ${counts.edge}` : '',
    counts.dimension ? `치수 ${counts.dimension}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function selectionListKey(item: Selection): string {
  if (item.kind === 'face') return `face:${item.faceId}`;
  if (item.kind === 'edge') return `edge:${item.edgeId}`;
  if (item.kind === 'placement') return `placement:${item.placementId}`;
  return `dimension:${item.dimensionId}`;
}

function selectionListLabel(doc: SketchDocument, item: Selection): string {
  if (item.kind === 'face') return '면';
  if (item.kind === 'edge') return '선';
  if (item.kind === 'dimension') return '치수';
  const found = findPlacement(doc, item.placementId);
  return found?.parent.placements[found.index].name || '그룹';
}

function InfoPanel({
  doc,
  selection: items,
  unit,
  paintId,
  onCommit,
  onDrawMaterial,
  onCopy,
  onGroup,
}: {
  doc: SketchDocument;
  selection: Selection[];
  unit: Unit;
  paintId: string;
  onCommit: (doc: SketchDocument) => void;
  onDrawMaterial: (id: string) => void;
  onCopy: () => void;
  onGroup: () => void;
}) {
  if (items.length > 1) {
    return (
      <div className="stack">
        <h3>{items.length}개 선택</h3>
        <ul className="sel-list">
          {items.map((item) => (
            <li key={selectionListKey(item)}>{selectionListLabel(doc, item)}</li>
          ))}
        </ul>
        <p className="muted">Shift+클릭으로 빼거나 더합니다. Delete로 선택한 것을 모두 지웁니다.</p>
      </div>
    );
  }
  const selection = items[0];
  if (!selection) {
    const bounds = boundsOfPoints(definitionLocalPoints(doc, doc.definitions[0]));
    return (
      <div className="stack">
        <p className="muted">아무것도 선택하지 않았습니다. 객체를 클릭하면 파랗게 표시됩니다. Shift+클릭이나 드래그로 여러 개를 고릅니다.</p>
        {bounds && (
          <p>
            모델 크기 {formatLength(bounds.max[0] - bounds.min[0], unit)} × {formatLength(bounds.max[1] - bounds.min[1], unit)} ×{' '}
            {formatLength(bounds.max[2] - bounds.min[2], unit)}
          </p>
        )}
        <p className="muted">
          저장 파일은 SketchUp 2013–2020 형식입니다. 이 앱에서 잰 치수는 같은 브라우저에서 그 파일 이름으로 다시 열리면 돌아옵니다.
        </p>
        <label>
          그릴 재질
          <select value={paintId} onChange={(event) => onDrawMaterial(event.target.value)}>
            {doc.materials.map((material) => (
              <option key={material.id} value={material.id}>
                {material.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }
  if (selection.kind === 'face') {
    const def = getDef(doc, selection.definitionId);
    const face = def?.faces.find((item) => item.id === selection.faceId);
    if (!def || !face) return null;
    return (
      <div className="stack">
        <h3>면</h3>
        <p>면적 {formatArea(faceArea(def, face), unit)}</p>
        <p className="muted">{def.kind === 'root' ? '최상위 지오메트리' : def.name}</p>
        <label>
          재질
          <select
            value={face.materialId ?? doc.defaultMaterialId}
            onChange={(event) => onCommit(paintFace(doc, def.id, face.id, event.target.value))}
          >
            {doc.materials.map((material) => (
              <option key={material.id} value={material.id}>
                {material.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          태그
          <select value={face.layerId} onChange={(event) => onCommit(setFaceLayer(doc, def.id, face.id, event.target.value))}>
            {doc.layers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={onGroup}>그룹으로 만들기 (G)</button>
        <button type="button" onClick={() => onCopy()}>복사 (Ctrl+C)</button>
      </div>
    );
  }
  if (selection.kind === 'edge') {
    const def = getDef(doc, selection.definitionId);
    const edge = def?.edges.find((item) => item.id === selection.edgeId);
    const a = def && edge ? def.vertices[edge.a] : null;
    const b = def && edge ? def.vertices[edge.b] : null;
    const span = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0;
    return (
      <div className="stack">
        <h3>선</h3>
        <p>길이 {formatLength(span, unit)}</p>
        <p className="muted">Delete로 지우면 이 선에 붙은 면도 함께 지워집니다.</p>
        <button
          type="button"
          onClick={() => {
            if (!def || !edge) return;
            const next = deleteEdge(doc, def.id, edge.id);
            if (next) onCommit(next);
          }}
        >
          선 지우기
        </button>
      </div>
    );
  }
  if (selection.kind === 'dimension') {
    const dimension = (doc.dimensions ?? []).find((item) => item.id === selection.dimensionId);
    const span = dimension ? Math.hypot(dimension.b[0] - dimension.a[0], dimension.b[1] - dimension.a[1], dimension.b[2] - dimension.a[2]) : 0;
    return (
      <div className="stack">
        <h3>치수</h3>
        <p>길이 {formatLength(span, unit)}</p>
        <p className="muted">Delete로 지웁니다. 저장한 뒤 같은 브라우저에서 이 파일을 다시 열면 치수가 돌아옵니다.</p>
        <button
          type="button"
          onClick={() => {
            if (!dimension) return;
            const next = deleteDimension(doc, dimension.id);
            if (next) onCommit(next);
          }}
        >
          치수 지우기
        </button>
      </div>
    );
  }
  const found = findPlacement(doc, selection.placementId);
  if (!found) return null;
  const placement = found.parent.placements[found.index];
  const def = getDef(doc, placement.definitionId);
  const uses = def ? usageCount(doc, def.id) : 0;
  return (
    <div className="stack">
      <h3>{uses > 1 ? '컴포넌트' : '그룹'}</h3>
      <label>
        이름
        <input value={placement.name} onChange={(event) => onCommit(renamePlacement(doc, placement.id, event.target.value))} />
      </label>
      <p className="muted">
        정의 {def?.name} · 배치 {uses}개{uses > 1 ? ' · 안을 고치면 모든 배치가 바뀝니다' : ''}
      </p>
      <p>
        위치 {formatLength(placement.matrix[12], unit)}, {formatLength(placement.matrix[13], unit)}, {formatLength(placement.matrix[14], unit)}
      </p>
      <label>
        태그
        <select value={placement.layerId} onChange={(event) => onCommit(setPlacementLayer(doc, placement.id, event.target.value))}>
          {doc.layers.map((layer) => (
            <option key={layer.id} value={layer.id}>
              {layer.name}
            </option>
          ))}
        </select>
      </label>
      {uses > 1 && (
        <button
          type="button"
          onClick={() => {
            const next = makeUnique(doc, placement.id);
            if (next) onCommit(next);
          }}
        >
          이 배치만 고유하게
        </button>
      )}
      <button type="button" onClick={() => onCopy()}>복사 (Ctrl+C)</button>
    </div>
  );
}

function MaterialPanel({
  doc,
  paintId,
  onPaint,
  onCommit,
}: {
  doc: SketchDocument;
  paintId: string;
  onPaint: (id: string | null) => void;
  onCommit: (doc: SketchDocument) => void;
}) {
  return (
    <div className="stack">
      <button
        type="button"
        onClick={() => {
          const next = addMaterial(doc, `재질 ${doc.materials.length + 1}`, [196, 112, 78, 255]);
          onCommit(next);
          const created = next.materials[next.materials.length - 1];
          if (created) onPaint(created.id);
        }}
      >
        재질 추가
      </button>
      {doc.materials.map((material) => (
        <div key={material.id} className={material.id === paintId ? 'swatch current' : 'swatch'}>
          <button
            type="button"
            className="chip"
            style={{ background: `rgba(${material.color[0]}, ${material.color[1]}, ${material.color[2]}, ${material.opacity})` }}
            onClick={() => onPaint(material.id)}
            aria-label={`${material.name} 선택`}
          />
          <input
            value={material.name}
            onChange={(event) => onCommit(updateMaterial(doc, material.id, { name: event.target.value }))}
          />
          <input
            type="color"
            value={rgbHex(material.color[0], material.color[1], material.color[2])}
            onChange={(event) => {
              const [r, g, b] = hexRgb(event.target.value);
              onCommit(updateMaterial(doc, material.id, { color: [r, g, b, 255] }));
            }}
          />
          {!material.isDefault && (
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                const next = deleteMaterial(doc, material.id);
                if (next) onCommit(next);
                if (paintId === material.id) onPaint(null);
              }}
            >
              삭제
            </button>
          )}
          <label className="opacity">
            불투명도
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={material.opacity}
              onChange={(event) => onCommit(updateMaterial(doc, material.id, { opacity: Number(event.target.value) }))}
            />
          </label>
        </div>
      ))}
    </div>
  );
}

function LayerPanel({
  doc,
  activeLayerId,
  onActive,
  onCommit,
}: {
  doc: SketchDocument;
  activeLayerId: string;
  onActive: (id: string) => void;
  onCommit: (doc: SketchDocument) => void;
}) {
  return (
    <div className="stack">
      <button
        type="button"
        onClick={() => {
          const next = addLayer(doc, `태그 ${doc.layers.length + 1}`);
          onCommit(next);
          const created = next.layers[next.layers.length - 1];
          if (created) onActive(created.id);
        }}
      >
        태그 추가
      </button>
      {doc.layers.map((layer) => (
        <label key={layer.id} className="layer-row">
          <input type="checkbox" checked={layer.visible} onChange={(event) => onCommit(updateLayer(doc, layer.id, { visible: event.target.checked }))} />
          <input value={layer.name} disabled={layer.isDefault} onChange={(event) => onCommit(updateLayer(doc, layer.id, { name: event.target.value }))} />
          <button type="button" className={activeLayerId === layer.id ? 'text-btn on' : 'text-btn'} onClick={() => onActive(layer.id)}>
            {activeLayerId === layer.id ? '그리는 중' : '이 태그로'}
          </button>
        </label>
      ))}
      <p className="muted">숨긴 태그는 화면에서만 빠지고, 저장할 때도 숨김으로 기록됩니다.</p>
    </div>
  );
}

function TreePanel({
  doc,
  selection,
  onSelect,
  onEnter,
  onCommit,
}: {
  doc: SketchDocument;
  selection: Selection[];
  onSelect: (selection: Selection[]) => void;
  onEnter: (path: string[]) => void;
  onCommit: (doc: SketchDocument) => void;
}) {
  const root = doc.definitions[0];
  return (
    <div className="stack">
      <p className="muted">더블클릭하면 그룹 안으로 들어갑니다.</p>
      <TreeNodes
        doc={doc}
        def={root}
        path={[]}
        depth={0}
        selection={selection}
        onSelect={onSelect}
        onEnter={onEnter}
      />
      <h3>정의</h3>
      {doc.definitions
        .filter((def) => def.kind !== 'root')
        .map((def) => (
          <div key={def.id} className="tree-def">
            <span>
              {def.name} · 면 {def.faces.length} · 배치 {usageCount(doc, def.id)}
            </span>
            <button type="button" className="text-btn" onClick={() => onCommit(duplicatePlacement(doc, def.id))}>
              배치
            </button>
          </div>
        ))}
    </div>
  );
}

function TreeNodes({
  doc,
  def,
  path,
  depth,
  selection,
  onSelect,
  onEnter,
}: {
  doc: SketchDocument;
  def: SketchDocument['definitions'][number];
  path: string[];
  depth: number;
  selection: Selection[];
  onSelect: (selection: Selection[]) => void;
  onEnter: (path: string[]) => void;
}) {
  return (
    <>
      {def.placements.map((placement) => {
        const child = getDef(doc, placement.definitionId);
        const next = [...path, placement.id];
        const item: Selection = { kind: 'placement', placementId: placement.id, path: next };
        const active = selection.some((entry) => entry.kind === 'placement' && entry.placementId === placement.id);
        return (
          <div key={placement.id}>
            <button
              type="button"
              className={active ? 'tree active' : 'tree'}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={(event) => onSelect(event.shiftKey ? toggleSelection(selection, item) : [item])}
              onDoubleClick={() => onEnter(next)}
            >
              {placement.name || child?.name || '그룹'}
              <small>{child && usageCount(doc, child.id) > 1 ? '컴포넌트' : '그룹'}</small>
            </button>
            {child && depth < 8 && (
              <TreeNodes
                doc={doc}
                def={child}
                path={next}
                depth={depth + 1}
                selection={selection}
                onSelect={onSelect}
                onEnter={onEnter}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

function hexRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}
