import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseSkp } from 'openskp';
import {
  addLayer,
  addMaterial,
  boundsOfPoints,
  definitionLocalPoints,
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
  modelBounds,
} from './model/document.ts';
import { exportSkp } from './model/exportSkp.ts';
import { toGlb, toObj, toStl } from './model/exportMesh.ts';
import { importModel } from './model/importSkp.ts';
import { importLibraryModel } from './model/importGltf.ts';
import type { ParseMessage } from './parseWorker.ts';
import { formatArea, formatLength, UNIT_LABEL } from './model/math.ts';
import { createEmpty, createStarter } from './model/starter.ts';
import type { Selection, SketchDocument, Tool, Unit, Vec3 } from './model/types.ts';
import type { LibraryEntry } from './library/catalog.ts';
import {
  IconCircle,
  IconErase,
  IconHand,
  IconLine,
  IconMeasure,
  IconMove,
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

const TOOLS: { id: Tool; label: string; key: string; hint: string; icon: ReactNode }[] = [
  { id: 'navigate', label: '탐색', key: 'H', hint: '왼쪽 드래그로 둘러보고, 오른쪽 드래그로 이동합니다. 모델은 선택되지 않습니다.', icon: <IconHand /> },
  { id: 'walk', label: '걷기', key: 'K', hint: '바라보는 방향으로 WASD·방향키가 움직입니다. 벽은 통과하고, Shift는 더 빠릅니다. 눈높이는 평면도 아래에서 조절합니다.', icon: <IconWalk /> },
  { id: 'select', label: '선택', key: 'V', hint: '클릭으로 선택, 더블클릭으로 그룹 안으로 들어갑니다.', icon: <IconSelect /> },
  { id: 'line', label: '선', key: 'L', hint: '점을 이어서 클릭하고, 시작점에 맞추거나 Enter로 면을 닫습니다. 끝점·중간점·선 위에 붙습니다.', icon: <IconLine /> },
  { id: 'rect', label: '사각형', key: 'R', hint: '첫 모서리와 반대 모서리를 찍습니다. 치수는 80, 60 처럼 입력합니다. 끝점·중간점에 붙습니다.', icon: <IconRect /> },
  { id: 'circle', label: '원', key: 'C', hint: '중심을 찍고 반지름을 정합니다. 끝점·중간점·중심에 붙습니다.', icon: <IconCircle /> },
  { id: 'measure', label: '측정', key: 'T', hint: '두 점을 찍으면 거리와 Δx Δy Δz를 재고, 선 위에서는 길이, 면 위에서는 면적을 보여 줍니다.', icon: <IconMeasure /> },
  { id: 'pushpull', label: '밀기/끌기', key: 'P', hint: '면을 드래그해 입체로 만들거나 두께를 바꿉니다.', icon: <IconPush /> },
  { id: 'move', label: '이동', key: 'M', hint: '선택한 뒤 축 핸들을 드래그합니다. 치수는 x, y, z.', icon: <IconMove /> },
  { id: 'rotate', label: '회전', key: 'Q', hint: '선택한 물체를 빨간·초록·파란 축으로 회전합니다.', icon: <IconRotate /> },
  { id: 'scale', label: '배율', key: 'S', hint: '선택한 물체의 크기를 바꿉니다.', icon: <IconScale /> },
  { id: 'paint', label: '페인트', key: 'B', hint: '현재 재질을 면이나 그룹에 칠합니다.', icon: <IconPaint /> },
  { id: 'erase', label: '지우개', key: 'E', hint: '면이나 그룹을 지웁니다.', icon: <IconErase /> },
];

const UNITS: Unit[] = ['mm', 'cm', 'm', 'in', 'ft'];

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

function validPath(doc: SketchDocument, path: string[]): string[] {
  const next: string[] = [];
  for (const id of path) {
    if (!findPlacement(doc, id)) break;
    next.push(id);
  }
  return next;
}

export default function App() {
  const [doc, setDoc] = useState<SketchDocument>(() => createStarter());
  const [past, setPast] = useState<SketchDocument[]>([]);
  const [future, setFuture] = useState<SketchDocument[]>([]);
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editingPath, setEditingPath] = useState<string[]>([]);
  const [unit, setUnit] = useState<Unit>('mm');
  const [snap, setSnap] = useState(0);
  const [drawMaterialId, setDrawMaterialId] = useState<string | null>(null);
  const [activeLayerId, setActiveLayerId] = useState(doc.defaultLayerId);
  const [panel, setPanel] = useState<'info' | 'material' | 'layer' | 'tree'>('info');
  const [typed, setTyped] = useState('');
  const [live, setLive] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [toasts, setToasts] = useState<string[]>([]);
  const [help, setHelp] = useState(true);
  const [menu, setMenu] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState<string | null>(null);
  const [viewToken, setViewToken] = useState(1);
  const [viewCommand, setViewCommand] = useState<ViewportCommand>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const [numericRequest, setNumericRequest] = useState<{ id: number; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const docRef = useRef(doc);
  const placeAnchorRef = useRef<Vec3 | null>(null);
  const dropSlot = useRef(0);
  const libraryLock = useRef(false);
  docRef.current = doc;

  const path = useMemo(() => validPath(doc, editingPath), [doc, editingPath]);
  const safeSelection = selection && selectionValid(doc, selection) ? selection : null;
  const activeTool = TOOLS.find((item) => item.id === tool) ?? TOOLS[0];

  useEffect(() => {
    if (path.length !== editingPath.length) setEditingPath(path);
  }, [path, editingPath.length]);

  useEffect(() => {
    if (selection && !selectionValid(doc, selection)) setSelection(null);
  }, [doc, selection]);

  const toast = (message: string) => {
    setToasts((items) => [...items.slice(-2), message]);
    window.setTimeout(() => setToasts((items) => items.slice(1)), 6400);
  };

  const replaceDoc = (next: SketchDocument) => {
    setDoc(next);
    setPast([]);
    setFuture([]);
    setSelection(null);
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
      const placed = await importLibraryModel(docRef.current, entry, origin);
      if (!placed) {
        toast('이 모델에서 가져올 면이 없습니다');
        return;
      }
      commit(placed.doc);
      setSelection({ kind: 'placement', placementId: placed.placementId, path: [placed.placementId] });
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

  const openBuffer = async (buffer: ArrayBuffer, filename: string) => {
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
      setLoading('화면을 만들고 있습니다');
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
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

  const saveSkp = () => {
    try {
      const result = exportSkp(doc);
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
        if (!safeSelection) return;
        event.preventDefault();
        const next =
          safeSelection.kind === 'face'
            ? deleteFace(doc, safeSelection.definitionId, safeSelection.faceId)
            : deletePlacement(doc, safeSelection.placementId);
        if (next) {
          setSelection(null);
          commit(next);
        }
        return;
      }
      if (event.key.toLowerCase() === 'f') {
        setViewCommand({ id: Date.now(), type: 'fit' });
        return;
      }
      if (event.key === 'Enter') {
        setNumericRequest({ id: Date.now(), text: typed });
        setTyped('');
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
    <div className="app">
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
          <button type="button" className={libraryOpen ? 'on' : ''} onClick={() => setLibraryOpen((open) => !open)}>
            라이브러리
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
            </button>
          ))}
        </nav>
        {libraryOpen && <LibraryPanel busyId={libraryBusy} onImport={(entry) => void importEntry(entry)} onClose={() => setLibraryOpen(false)} />}

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
              else setSelection(null);
            }}
          />
          {help && (
            <div className="help">
              <p>
                탐색(H)은 선택 없이 둘러봅니다. 걷기(K)는 사람 시점으로 벽을 통과해 움직이고, 눈높이를 조절할 수 있습니다. 측정(T)은 두 점의 거리를 재고, 선·면 위에서는 길이와 면적을 보여 줍니다. 라이브러리에서 가구나 사람을 놓을 수 있습니다.
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
                setNumericRequest({ id: Date.now(), text: typed });
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

function InfoPanel({
  doc,
  selection,
  unit,
  paintId,
  onCommit,
  onDrawMaterial,
}: {
  doc: SketchDocument;
  selection: Selection | null;
  unit: Unit;
  paintId: string;
  onCommit: (doc: SketchDocument) => void;
  onDrawMaterial: (id: string) => void;
}) {
  if (!selection) {
    const bounds = boundsOfPoints(definitionLocalPoints(doc, doc.definitions[0]));
    return (
      <div className="stack">
        <p className="muted">아무것도 선택하지 않았습니다. 빈 칸을 클릭하면 선택이 풀립니다.</p>
        {bounds && (
          <p>
            모델 크기 {formatLength(bounds.max[0] - bounds.min[0], unit)} × {formatLength(bounds.max[1] - bounds.min[1], unit)} ×{' '}
            {formatLength(bounds.max[2] - bounds.min[2], unit)}
          </p>
        )}
        <p className="muted">저장 파일은 SketchUp 2013–2020 형식입니다. 최신 SketchUp에서 열 수 있고, 장면·치수·문자는 포함되지 않습니다.</p>
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
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
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
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  onEnter: (path: string[]) => void;
}) {
  return (
    <>
      {def.placements.map((placement) => {
        const child = getDef(doc, placement.definitionId);
        const next = [...path, placement.id];
        const active = selection?.kind === 'placement' && selection.placementId === placement.id;
        return (
          <div key={placement.id}>
            <button
              type="button"
              className={active ? 'tree active' : 'tree'}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onSelect({ kind: 'placement', placementId: placement.id, path: next })}
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
