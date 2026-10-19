import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, addAfterEffect, useFrame, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls, TransformControls } from '@react-three/drei';
import {
  AxesHelper,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  EdgesGeometry,
  Color,
  Float32BufferAttribute,
  GridHelper,
  Group,
  Matrix4,
  LineBasicMaterial,
  LineSegments,
  Line as ThreeLine,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MOUSE,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  type Camera,
  Plane as ThreePlane,
  SphereGeometry,
  TOUCH,
  Vector4,
  Raycaster,
  Vector2,
  Vector3,
  type Intersection,
} from 'three';
import { beginMp4Capture, type Mp4Capture } from './mp4Capture';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { TransformControls as TransformControlsImpl } from 'three-stdlib';
import {
  addCircle,
  addDimension,
  addPolygon,
  deleteDimension,
  deleteFace,
  deletePlacement,
  deleteEdge,
  sectorPoints,
  editingDefinition,
  faceArea,
  faceCentroid,
  getDef,
  groundPlane,
  insetDistance,
  modelBounds,
  offsetFace,
  offsetLoop,
  paintFace,
  paintPlacement,
  pointsOf,
  pushPull,
  rectanglePoints,
  setPlacementMatrix,
  transformFace,
  transformPlacement,
  translateInDefinition,
  worldMatrixOfPath,
} from '../model/document.ts';
import { boundsOfPoints, definitionLocalPoints, findPlacement } from '../model/document.ts';
import { mergeSelection, selectionKey, toggleSelection } from '../model/selection.ts';
import {
  add,
  centroid,
  closestLineParam,
  dot,
  faceNormal,
  formatArea,
  formatLength,
  identity,
  invertMat,
  length,
  multiplyMat,
  normalize,
  parseMeasures,
  planeBasis,
  planeFromPoints,
  rayPlane,
  scale,
  sub,
  transformDir,
  transformPoint,
} from '../model/math.ts';
import type { Plane, Selection, SketchDocument, Tool, Unit, Vec3 } from '../model/types.ts';
import { buildModel, disposeModel } from '../scene/buildScene.ts';

export interface ViewportProps {
  doc: SketchDocument;
  tool: Tool;
  selection: Selection[];
  editingPath: string[];
  drawMaterialId: string | null;
  activeLayerId: string;
  unit: Unit;
  snapInches: number;
  viewToken: number;
  viewCommand: { id: number; type: 'fit' | 'pivot' | 'iso' | 'top' | 'front' | 'right' } | null;
  numericRequest: { id: number; text: string } | null;
  onSelect: (selection: Selection[]) => void;
  onEditingPath: (path: string[]) => void;
  onCommit: (doc: SketchDocument) => void;
  onLiveMeasure: (text: string) => void;
  onEscape: () => void;
  placeAnchorRef: RefObject<Vec3 | null>;
}

type Draw =
  | { kind: 'rect' | 'circle'; origin: Vec3; plane: Plane; x: number; y: number; moved: boolean }
  | { kind: 'arc'; center: Vec3; plane: Plane; start: Vec3 | null }
  | { kind: 'line'; points: Vec3[]; plane: Plane }
  | { kind: 'push'; faceId: string; definitionId: string; path: string[]; anchor: Vec3; normal: Vec3; scale: number; start: number }
  | { kind: 'measure'; origin: Vec3 }
  | { kind: 'offset'; faceId: string; definitionId: string; distance: number };

const SNAP_LABEL = { endpoint: '끝점', midpoint: '중간점', center: '중심', edge: '선 위' } as const;
const SNAP_COLOR = { endpoint: 0x2e9d4a, midpoint: 0x1e88e5, center: 0x8e24aa, edge: 0xfb8c00 } as const;
const SNAP_RADIUS2 = { endpoint: 16 * 16, midpoint: 14 * 14, center: 12 * 12, edge: 9 * 9 } as const;
const SNAP_RANK = { endpoint: 0, midpoint: 1, center: 2, edge: 3 } as const;
type SnapKind = keyof typeof SNAP_LABEL;

type RoutePoint = { x: number; y: number };

function sampleRoute(points: readonly RoutePoint[], distance: number) {
  const last = points.length - 1;
  if (last < 1) return { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0, yaw: 0, done: true };
  let remain = Math.max(0, distance);
  for (let i = 0; i < last; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    const span = Math.hypot(dx, dy);
    const yaw = Math.atan2(dx, dy);
    if (remain <= span || i === last - 1) {
      const t = span < 1e-6 ? 0 : Math.min(1, remain / span);
      return {
        x: points[i].x + dx * t,
        y: points[i].y + dy * t,
        yaw,
        done: i === last - 1 && remain >= span,
      };
    }
    remain -= span;
  }
  return { x: points[last].x, y: points[last].y, yaw: 0, done: true };
}

function formatDelta(delta: Vec3, unit: Unit): string {
  return `Δx ${formatLength(delta[0], unit)} · Δy ${formatLength(delta[1], unit)} · Δz ${formatLength(delta[2], unit)}`;
}

const WALK_SPEED = 105;
const WALK_BODY = 12;
const MODEL_FOV = 42;
const WALK_FOV = 60;
const ROUTE_SPEED = 56;
const WALK_PASS_GAP = 500;
const WALK_PASS_INCHES = 48;

interface PickData {
  pick?: boolean;
  faceId?: string;
  definitionId?: string;
  path?: string[];
  placementNode?: string;
  baseMaterial?: MeshLambertMaterial;
  batched?: boolean;
}

function resolvedPick(hit: Intersection): PickData {
  const data = hit.object.userData as PickData;
  if (data.faceId || !data.batched || hit.faceIndex == null) return data;
  const geometry = (hit.object as Mesh).geometry;
  const faceIds = geometry?.userData.faceIds as string[] | undefined;
  const triFace = geometry?.userData.triFace as Uint32Array | undefined;
  const faceId = faceIds && triFace ? faceIds[triFace[hit.faceIndex]] : undefined;
  return faceId ? { ...data, faceId } : data;
}

function faceOverlay(mesh: Mesh, faceId: string): BufferGeometry | null {
  const geometry = mesh.geometry;
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  const faceIds = geometry.userData.faceIds as string[] | undefined;
  const triFace = geometry.userData.triFace as Uint32Array | undefined;
  if (!index || !position || !faceIds || !triFace) return null;
  const slot = faceIds.indexOf(faceId);
  if (slot < 0) return null;
  const positions: number[] = [];
  const normals: number[] = [];
  for (let tri = 0; tri < triFace.length; tri++) {
    if (triFace[tri] !== slot) continue;
    const corners: number[] = [];
    for (let corner = 0; corner < 3; corner++) {
      const vertex = index.getX(tri * 3 + corner);
      corners.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
    }
    const ax = corners[3] - corners[0];
    const ay = corners[4] - corners[1];
    const az = corners[5] - corners[2];
    const bx = corners[6] - corners[0];
    const by = corners[7] - corners[1];
    const bz = corners[8] - corners[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    positions.push(...corners);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  }
  if (!positions.length) return null;
  const overlay = new BufferGeometry();
  overlay.setAttribute('position', new Float32BufferAttribute(positions, 3));
  overlay.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  return overlay;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((id, index) => path[index] === id);
}

function nearlyIdentity(matrix: number[]): boolean {
  const id = identity();
  return matrix.every((value, index) => Math.abs(value - id[index]) < 1e-5);
}

type SectionCut = { axis: 'x' | 'y' | 'z'; t: number };

function clampPlanZoom(value: number) {
  return Math.min(24, Math.max(0.2, value));
}

const PLAN_ZOOM_HOME = 2;

type PlanPan = { x: number; y: number };
type PlanMetrics = {
  halfX: number;
  halfY: number;
  width: number;
  height: number;
  lookX: number;
  lookY: number;
  markX: number;
  markY: number;
  markFollowsEye: boolean;
};
type PlanAim = { seq: number; x: number; y: number; eye: boolean };

export function Viewport(props: ViewportProps) {
  const planSlot = useRef<HTMLDivElement>(null);
  const planZoom = useRef(PLAN_ZOOM_HOME);
  const planPan = useRef<PlanPan>({ x: 0, y: 0 });
  const planMetrics = useRef<PlanMetrics>({ halfX: 1, halfY: 1, width: 1, height: 1, lookX: 0, lookY: 0, markX: 0, markY: 0, markFollowsEye: false });
  const toolRef = useRef(props.tool);
  toolRef.current = props.tool;
  const [route, setRoute] = useState<RoutePoint[]>([]);
  const [routePlace, setRoutePlace] = useState(false);
  const [routeBusy, setRouteBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [routeNote, setRouteNote] = useState('');
  const [routeCommand, setRouteCommand] = useState<{ id: number; kind: 'play' | 'record' } | null>(null);
  const routePlaceRef = useRef(false);
  routePlaceRef.current = routePlace && props.tool === 'walk' && !routeBusy;
  const addRoutePoint = useRef<(x: number, y: number) => void>(() => {});
  addRoutePoint.current = (x, y) => {
    setRoute((points) => [...points, { x, y }]);
    setRouteNote('');
  };
  const onRecording = useRef<(value: boolean) => void>(() => {});
  onRecording.current = setRecording;
  const onRouteDone = useRef<(kind: 'play' | 'saved' | 'error', message?: string) => void>(() => {});
  onRouteDone.current = (_kind, message) => {
    setRouteBusy(false);
    setRecording(false);
    if (message) setRouteNote(message);
  };
  useEffect(() => {
    if (props.tool !== 'walk') setRoutePlace(false);
  }, [props.tool]);
  const planAim = useRef<PlanAim | null>(null);
  const planAiming = useRef(false);
  const planAnchor = useRef<{ x: number; y: number } | null>(null);
  const [planSize, setPlanSize] = useState<{ w: number; h: number } | null>(null);
  const walkHold = useRef<(dir: 'f' | 'b' | 'l' | 'r', down: boolean) => void>(() => {});
  const [sectionOn, setSectionOn] = useState(false);
  const [sectionAxis, setSectionAxis] = useState<SectionCut['axis']>('z');
  const [sectionT, setSectionT] = useState(0.68);
  const [eyeInches, setEyeInches] = useState(63);
  const [planToolsOpen, setPlanToolsOpen] = useState(true);
  const bounds = useMemo(() => modelBounds(props.doc), [props.doc]);
  const wasWalk = useRef(props.tool === 'walk');
  useEffect(() => {
    const walking = props.tool === 'walk';
    if (walking !== wasWalk.current) {
      planZoom.current = PLAN_ZOOM_HOME;
      planPan.current = { x: 0, y: 0 };
      wasWalk.current = walking;
    }
  }, [props.tool]);
  useEffect(() => {
    const el = planSlot.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      planZoom.current = clampPlanZoom(planZoom.current * (event.deltaY < 0 ? 1.18 : 1 / 1.18));
    };
    let pinch = 0;
    const span = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const onStart = (event: TouchEvent) => {
      if (event.touches.length < 2) return;
      pinch = span(event.touches);
      event.preventDefault();
    };
    const onMove = (event: TouchEvent) => {
      if (event.touches.length < 2 || pinch <= 0) return;
      event.preventDefault();
      const next = span(event.touches);
      planZoom.current = clampPlanZoom(planZoom.current * (next / pinch));
      pinch = next;
    };
    const onEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = 0;
    };
    const pointers = new Set<number>();
    let drag: { id: number; x: number; y: number; startX: number; startY: number; moved: boolean; aim: boolean } | null = null;
    let clickStamp = 0;
    const fromButton = (event: Event) => (event.target as Element | null)?.closest('button');
    const onMarker = (clientX: number, clientY: number) => {
      const metrics = planMetrics.current;
      const rect = el.getBoundingClientRect();
      if (metrics.width < 8 || metrics.halfX < 1e-4 || metrics.halfY < 1e-4) return false;
      const nx = (metrics.markX - metrics.lookX) / (2 * metrics.halfX) + 0.5;
      const ny = 0.5 - (metrics.markY - metrics.lookY) / (2 * metrics.halfY);
      if (nx < -0.08 || nx > 1.08 || ny < -0.08 || ny > 1.08) return false;
      const sx = rect.left + nx * rect.width;
      const sy = rect.top + ny * rect.height;
      const radius = Math.max(16, Math.min(rect.width, rect.height) * 0.07);
      return Math.hypot(clientX - sx, clientY - sy) <= radius;
    };
    const aimAt = (clientX: number, clientY: number, eye: boolean) => {
      const metrics = planMetrics.current;
      const rect = el.getBoundingClientRect();
      const nx = (clientX - rect.left) / Math.max(rect.width, 1);
      const ny = (clientY - rect.top) / Math.max(rect.height, 1);
      planAim.current = {
        seq: (planAim.current?.seq ?? 0) + 1,
        x: metrics.lookX + (nx - 0.5) * 2 * metrics.halfX,
        y: metrics.lookY + (0.5 - ny) * 2 * metrics.halfY,
        eye,
      };
    };
    const endGesture = () => {
      drag = null;
      planAiming.current = false;
      el.classList.remove('panning', 'aiming');
    };
    const onPointerDown = (event: PointerEvent) => {
      if (fromButton(event)) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pointers.add(event.pointerId);
      if (pointers.size > 1) {
        endGesture();
        return;
      }
      const aim = onMarker(event.clientX, event.clientY);
      if (aim) {
        planAnchor.current = {
          x: planMetrics.current.lookX - planPan.current.x,
          y: planMetrics.current.lookY - planPan.current.y,
        };
        planAiming.current = true;
      }
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, aim };
      try { el.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
      event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) {
        if (!drag) el.classList.toggle('aiming', onMarker(event.clientX, event.clientY));
        return;
      }
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
        drag.moved = true;
        el.classList.toggle('panning', !drag.aim);
        el.classList.toggle('aiming', drag.aim);
      }
      if (!drag.moved) return;
      if (drag.aim) {
        aimAt(event.clientX, event.clientY, toolRef.current === 'walk' || planMetrics.current.markFollowsEye);
        return;
      }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      const metrics = planMetrics.current;
      if (metrics.width < 2 || metrics.height < 2) return;
      planPan.current.x -= dx * ((metrics.halfX * 2) / metrics.width);
      planPan.current.y += dy * ((metrics.halfY * 2) / metrics.height);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId) && drag?.id !== event.pointerId) return;
      pointers.delete(event.pointerId);
      const finished = drag?.id === event.pointerId ? drag : null;
      if (!finished) return;
      endGesture();
      if (finished.moved) return;
      const now = performance.now();
      if (now - clickStamp < 280) {
        clickStamp = 0;
        return;
      }
      clickStamp = now;
      if (routePlaceRef.current && toolRef.current === 'walk' && !finished.aim) {
        const metrics = planMetrics.current;
        const rect = el.getBoundingClientRect();
        const nx = (finished.startX - rect.left) / Math.max(rect.width, 1);
        const ny = (finished.startY - rect.top) / Math.max(rect.height, 1);
        addRoutePoint.current(metrics.lookX + (nx - 0.5) * 2 * metrics.halfX, metrics.lookY + (0.5 - ny) * 2 * metrics.halfY);
        return;
      }
      aimAt(finished.startX, finished.startY, toolRef.current === 'walk' || (finished.aim && planMetrics.current.markFollowsEye));
    };
    const onDoubleClick = (event: MouseEvent) => {
      if (fromButton(event)) return;
      planPan.current = { x: 0, y: 0 };
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('dblclick', onDoubleClick);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('dblclick', onDoubleClick);
      planAiming.current = false;
      el.classList.remove('panning', 'aiming');
    };
  }, []);
  useEffect(() => {
    const stage = document.querySelector('.stage');
    if (!(stage instanceof HTMLElement)) return;
    if (!planSize) {
      stage.style.removeProperty('--plan-w');
      stage.style.removeProperty('--plan-h');
      return;
    }
    stage.style.setProperty('--plan-w', `${planSize.w}px`);
    stage.style.setProperty('--plan-h', `${planSize.h}px`);
  }, [planSize]);
  const section = sectionOn ? { axis: sectionAxis, t: sectionT } : null;
  const cutInches = bounds
    ? bounds.min[sectionAxis === 'x' ? 0 : sectionAxis === 'y' ? 1 : 2] +
      sectionT * (bounds.max[sectionAxis === 'x' ? 0 : sectionAxis === 'y' ? 1 : 2] - bounds.min[sectionAxis === 'x' ? 0 : sectionAxis === 'y' ? 1 : 2])
    : 0;
  return (
    <div
      className="viewport"
      onContextMenu={(event) => event.preventDefault()}
    >
      <Canvas
        camera={{ fov: MODEL_FOV, near: 0.05, far: 500000, position: [190, -210, 130] }}
        gl={{ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true }}
        onCreated={({ camera, gl }) => {
          camera.up.set(0, 0, 1);
          camera.layers.enable(1);
          gl.localClippingEnabled = true;
          gl.domElement.style.touchAction = 'none';
        }}
      >
        <color attach="background" args={['#d7e3ee']} />
        <hemisphereLight args={['#f5f9fc', '#eadfce', 0.78]} position={[0, 0, 200]} />
        <directionalLight position={[220, -280, 360]} intensity={1.2} />
        <ambientLight intensity={0.22} />
        <EditorScene {...props} planSlot={planSlot} planZoom={planZoom} planPan={planPan} planMetrics={planMetrics} planAim={planAim} planAiming={planAiming} planAnchor={planAnchor} section={section} eyeInches={eyeInches} walkHold={walkHold} route={route} routeCommand={routeCommand} onRecording={onRecording} onRouteDone={onRouteDone} />
      </Canvas>
      <div className={recording ? 'plan-card recording' : 'plan-card'}>
        <div className="plan-view" ref={planSlot} role="application" aria-label="평면도" title="빈 곳을 끌면 평면도가 움직입니다 · 빨간 표시를 끌거나 클릭하면 보는 위치가 이동합니다 · 두 번 클릭하면 가운데로">
          <button
            type="button"
            className="plan-resize"
            aria-label="평면도 크기"
            title="끌어서 크기 조절"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const card = event.currentTarget.parentElement;
              const start = card?.getBoundingClientRect();
              if (!start) return;
              const originX = event.clientX;
              const originY = event.clientY;
              const move = (next: PointerEvent) => {
                setPlanSize({
                  w: Math.min(520, Math.max(140, start.width + next.clientX - originX)),
                  h: Math.min(420, Math.max(96, start.height + next.clientY - originY)),
                });
              };
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}
          />
          <div className="plan-zoom">
            <button type="button" aria-label="평면도 축소" title="축소" onClick={() => { planZoom.current = clampPlanZoom(planZoom.current / 1.35); }}>
              −
            </button>
            <button type="button" aria-label="평면도 확대" title="확대" onClick={() => { planZoom.current = clampPlanZoom(planZoom.current * 1.35); }}>
              +
            </button>
          </div>
        </div>
        <div className={planToolsOpen ? 'plan-tools' : 'plan-tools collapsed'}>
          <header>
            <b>{props.tool === 'walk' ? '눈높이' : '평면도'}</b>
            <div className="plan-tools-actions">
              {planToolsOpen && (
                <button
                  type="button"
                  className={sectionOn ? 'on' : ''}
                  title="이 위치 너머를 숨깁니다. 선·사각형·원·호는 이 절단면에 그려집니다"
                  onClick={() => setSectionOn((value) => !value)}
                >
                  단면
                </button>
              )}
              <button
                type="button"
                className="plan-tools-toggle"
                aria-expanded={planToolsOpen}
                aria-label={planToolsOpen ? '도구 접기' : '도구 펼치기'}
                title={planToolsOpen ? '접기' : '펼치기'}
                onClick={() => setPlanToolsOpen((value) => !value)}
              >
                {planToolsOpen ? '−' : '+'}
              </button>
            </div>
          </header>
          {planToolsOpen && (
            <>
              {sectionOn && (
                <>
                  <select aria-label="단면 방향" value={sectionAxis} onChange={(event) => setSectionAxis(event.target.value as SectionCut['axis'])}>
                    <option value="z">수평 · 지붕 자르기</option>
                    <option value="y">정면 자르기</option>
                    <option value="x">측면 자르기</option>
                  </select>
                  <label>
                    자르는 위치 {bounds ? formatLength(cutInches, props.unit) : ''}
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.005}
                      value={sectionT}
                      aria-label="단면 위치"
                      onChange={(event) => setSectionT(Number(event.target.value))}
                    />
                  </label>
                </>
              )}
              {props.tool === 'walk' && (
                <div className="route-tools">
                  <button type="button" className={routePlace ? 'on' : ''} onClick={() => setRoutePlace((value) => !value)}>
                    점 찍기
                  </button>
                  <button type="button" disabled={!route.length || routeBusy} onClick={() => setRoute((points) => points.slice(0, -1))}>
                    취소
                  </button>
                  <button type="button" disabled={!route.length || routeBusy} onClick={() => { setRoute([]); setRouteNote(''); }}>
                    지우기
                  </button>
                  <button
                    type="button"
                    disabled={route.length < 2 || routeBusy}
                    onClick={() => { setRouteBusy(true); setRouteNote(''); setRouteCommand({ id: Date.now(), kind: 'play' }); }}
                  >
                    따라가기
                  </button>
                  <button
                    type="button"
                    disabled={route.length < 2 || routeBusy}
                    onClick={() => { setRouteBusy(true); setRouteNote(''); setRouteCommand({ id: Date.now(), kind: 'record' }); }}
                  >
                    동영상
                  </button>
                  <p>
                    {recording
                      ? '걷는 장면을 저장하는 중입니다. 화면을 끌면 시선이 돌아갑니다.'
                      : routeBusy
                        ? '경로를 따라 걷는 중입니다. 화면을 끌면 시선이 돌아갑니다.'
                        : routeNote
                          ? routeNote
                          : routePlace
                            ? `평면도를 클릭해 점을 찍습니다.${route.length ? ` 지금 ${route.length}개.` : ''}`
                            : route.length
                              ? `점 ${route.length}개. 두 점부터 그 길을 걸어갑니다.`
                              : '점 찍기로 길을 만든 뒤 따라가거나 동영상으로 저장합니다.'}
                  </p>
                </div>
              )}
              {props.tool === 'walk' && (
                <label>
                  눈높이 {formatLength(eyeInches, props.unit)}
                  <input
                    type="range"
                    min={24}
                    max={120}
                    step={0.5}
                    value={eyeInches}
                    aria-label="눈높이"
                    onChange={(event) => setEyeInches(Number(event.target.value))}
                  />
                </label>
              )}
            </>
          )}
        </div>
      </div>
      {props.tool === 'walk' && (
        <div className="walk-pad" aria-label="걷기 이동">
          {(
            [
              ['f', '앞', 'walk-f'],
              ['l', '왼쪽', 'walk-l'],
              ['b', '뒤', 'walk-b'],
              ['r', '오른쪽', 'walk-r'],
            ] as const
          ).map(([dir, label, className]) => (
            <button
              key={dir}
              type="button"
              className={className}
              aria-label={label}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                walkHold.current(dir, true);
              }}
              onPointerUp={() => walkHold.current(dir, false)}
              onPointerCancel={() => walkHold.current(dir, false)}
            >
              {label === '왼쪽' ? '좌' : label === '오른쪽' ? '우' : label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EditorScene(
  props: ViewportProps & {
    planSlot: RefObject<HTMLDivElement | null>;
    planZoom: RefObject<number>;
    planPan: RefObject<PlanPan>;
    planMetrics: RefObject<PlanMetrics>;
    planAim: RefObject<PlanAim | null>;
    planAiming: RefObject<boolean>;
    planAnchor: RefObject<{ x: number; y: number } | null>;
    route: RoutePoint[];
    routeCommand: { id: number; kind: 'play' | 'record' } | null;
    onRecording: RefObject<(value: boolean) => void>;
    onRouteDone: RefObject<(kind: 'play' | 'saved' | 'error', message?: string) => void>;
    section: SectionCut | null;
    eyeInches: number;
    walkHold: RefObject<(dir: 'f' | 'b' | 'l' | 'r', down: boolean) => void>;
  },
) {
  const { camera, gl, scene } = useThree();
  const propsRef = useRef(props);
  propsRef.current = props;
  const routeRef = useRef(props.route);
  routeRef.current = props.route;
  const hidePlan = useRef(false);
  const routePlay = useRef<{ distance: number; active: boolean; warmup: number; hold: number; record: boolean } | null>(null);
  const recorderRef = useRef<Mp4Capture | null>(null);
  const captureGen = useRef(0);
  const [preview, setPreview] = useState<SketchDocument | null>(null);
  const [rubber, setRubber] = useState<Vec3[] | null>(null);
  const [measureLock, setMeasureLock] = useState<{ a: Vec3; b: Vec3 } | null>(null);
  const measureLockRef = useRef<{ a: Vec3; b: Vec3 } | null>(null);
  const walkKeys = useRef({ f: false, b: false, l: false, r: false, fast: false });
  const walkLook = useRef<{ x: number; y: number } | null>(null);
  const walkYaw = useRef(0);
  const walkPitch = useRef(-0.08);
  const planAimSeq = useRef(0);
  const eyeApplied = useRef(props.eyeInches);
  const walkApi = useRef({
    begin: () => {},
    look: (_dx: number, _dy: number) => {},
    step: (_dx: number, _dy: number, _dz: number) => {},
    basis: () => ({ fx: 0, fy: 1, fz: 0, lx: 1, ly: 0 }),
    wallDistance: (_dx: number, _dy: number, _reach: number) => null as number | null,
    stand: (_x: number, _y: number, _yaw?: number) => {},
  });
  const walkNudge = useRef({
    prev: { f: false, b: false, l: false, r: false },
    releasedAt: { f: 0, b: 0, l: 0, r: 0 },
    passLeft: 0,
    passed: 0,
  });
  const [hover, setHover] = useState<PickData | null>(null);
  const previewRef = useRef<SketchDocument | null>(null);
  previewRef.current = preview;
  const boundsCache = useRef<{ doc: SketchDocument; bounds: ReturnType<typeof modelBounds> } | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const modelRef = useRef<Group>(null);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const gizmoRef = useRef<TransformControlsImpl>(null);
  const pivot = useMemo(() => new Object3D(), []);
  const orbitDrag = useRef<ThreePlane | null>(null);
  const orbitHandle = useMemo(() => {
    const group = new Group();
    const marker = new Mesh(
      new SphereGeometry(0.22, 18, 12),
      new MeshBasicMaterial({ color: 0xd4533c, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    marker.userData.orbitHandle = true;
    marker.renderOrder = 20;
    group.add(marker);
    const markerAxes = new AxesHelper(1.4);
    markerAxes.traverse((obj) => {
      obj.raycast = () => {};
      obj.renderOrder = 20;
      obj.layers.set(1);
    });
    group.add(markerAxes);
    marker.layers.set(1);
    markerAxes.layers.set(1);
    group.layers.set(1);
    return group;
  }, []);
  const snapMarker = useMemo(() => {
    const marker = new Mesh(
      new SphereGeometry(0.16, 16, 12),
      new MeshBasicMaterial({ color: SNAP_COLOR.endpoint, depthTest: false, transparent: true, opacity: 1 }),
    );
    marker.raycast = () => {};
    marker.layers.set(1);
    marker.renderOrder = 30;
    marker.visible = false;
    return marker;
  }, []);
  const clipPlane = useMemo(() => new ThreePlane(new Vector3(0, 0, -1), 0), []);
  const walkRay = useMemo(() => new Raycaster(), []);
  const gizmoDrag = useRef<{ start: Matrix4; ghost: Group; hidden: Object3D[] } | null>(null);
  const measureRef = useRef('');
  const shown = preview ?? props.doc;
  const built = useMemo(() => buildModel(shown), [shown]);
  const selectedMat = useMemo(
    () =>
      new MeshLambertMaterial({
        color: 0xd6e4ff,
        emissive: 0x1d4ed8,
        emissiveIntensity: 0.72,
        side: 2,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    [],
  );
  const outlineMat = useMemo(() => new LineBasicMaterial({ color: 0x1d4ed8, depthTest: false }), []);
  const hoverLineMat = useMemo(() => new LineBasicMaterial({ color: 0xd97706, depthTest: false }), []);
  const edgeMarkMat = useMemo(() => new MeshBasicMaterial({ color: 0x1d4ed8, depthTest: false }), []);
  const hoverMat = useMemo(
    () =>
      new MeshLambertMaterial({
        color: 0xfff4d2,
        emissive: 0xc47b12,
        emissiveIntensity: 0.18,
        side: 2,
        transparent: true,
        opacity: 0.92,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    [],
  );

  useLayoutEffect(() => {
    const bounds = modelBounds(props.doc);
    if (!props.section || !bounds) {
      gl.clippingPlanes = [];
      return;
    }
    const axis = props.section.axis === 'x' ? 0 : props.section.axis === 'y' ? 1 : 2;
    const min = bounds.min[axis];
    const max = bounds.max[axis];
    const cut = min + props.section.t * (max - min);
    clipPlane.normal.set(0, 0, 0).setComponent(axis, -1);
    clipPlane.constant = cut;
    gl.clippingPlanes = [clipPlane];
  }, [props.section, props.doc, gl, clipPlane]);

  useEffect(() => {
    const planCam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
    planCam.layers.set(0);
    planCam.layers.enable(2);
    const viewMark = new Group();
    const markMaterial = (color: number) =>
      new MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
    const markHalo = new Mesh(new SphereGeometry(0.9, 16, 12), markMaterial(0x1c2328));
    const markDot = new Mesh(new SphereGeometry(0.55, 16, 12), markMaterial(0xd4533c));
    const markArrow = new Mesh(new ConeGeometry(0.46, 1.45, 3), markMaterial(0xd4533c));
    markArrow.position.y = 1.7;
    for (const mesh of [markHalo, markDot, markArrow]) {
      mesh.layers.set(2);
      mesh.raycast = () => {};
      mesh.frustumCulled = false;
      mesh.renderOrder = 60;
      viewMark.add(mesh);
    }
    markHalo.renderOrder = 59;
    viewMark.layers.set(2);
    viewMark.frustumCulled = false;
    scene.add(viewMark);
    const lookFlat = new Vector3();
    const clear = new Color();
    const viewport = new Vector4();
    const scissor = new Vector4();
    const remove = addAfterEffect(() => {
      if (hidePlan.current) {
        recorderRef.current?.snapshot(gl.domElement);
        return;
      }
      const slot = props.planSlot.current;
      const canvas = gl.domElement;
      if (!slot) return;
      const canvasRect = canvas.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      const x = Math.round(slotRect.left - canvasRect.left);
      const y = Math.round(canvasRect.bottom - slotRect.bottom);
      const width = Math.round(slotRect.width);
      const height = Math.round(slotRect.height);
      if (width < 8 || height < 8) return;
      const doc = previewRef.current ?? propsRef.current.doc;
      if (boundsCache.current?.doc !== doc) boundsCache.current = { doc, bounds: modelBounds(doc) };
      const bounds = boundsCache.current.bounds;
      const center = bounds
        ? new Vector3(...bounds.center)
        : new Vector3(40, 30, 16);
      const size = bounds
        ? new Vector3(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2])
        : new Vector3(80, 60, 32);
      const zoom = clampPlanZoom(propsRef.current.planZoom.current);
      const pan = propsRef.current.planPan.current;
      const aspect = width / Math.max(height, 1);
      const walking = propsRef.current.tool === 'walk';
      const mainCam = camera as PerspectiveCamera;
      planCam.up.set(0, 1, 0);
      const fittedHalf = Math.max(size.y * 0.5, size.x * 0.5 / aspect, 4) * 1.12 / zoom;
      const held = propsRef.current.planAnchor.current;
      const lookX = (held ? held.x : walking ? mainCam.position.x : center.x) + pan.x;
      const lookY = (held ? held.y : walking ? mainCam.position.y : center.y) + pan.y;
      if (walking) {
        const eye = mainCam.position.z;
        planCam.position.set(lookX, lookY, eye + 2);
        planCam.lookAt(lookX, lookY, eye - 10);
        planCam.near = 0.4;
        const floor = bounds?.min[2] ?? eye - 120;
        planCam.far = Math.max(eye + 2 - floor + 80, 200);
        planCam.top = fittedHalf;
        planCam.bottom = -fittedHalf;
        planCam.right = fittedHalf * aspect;
        planCam.left = -fittedHalf * aspect;
      } else {
        const halfY = fittedHalf;
        planCam.position.set(lookX, lookY, center.z + Math.max(size.z, 1) + 80);
        planCam.lookAt(lookX, lookY, center.z);
        planCam.near = 0.1;
        planCam.far = Math.max(size.z, 1) * 6 + 500;
        planCam.top = halfY;
        planCam.bottom = -halfY;
        planCam.right = halfY * aspect;
        planCam.left = -halfY * aspect;
      }
      propsRef.current.planMetrics.current = {
        halfX: fittedHalf * aspect,
        halfY: fittedHalf,
        width,
        height,
        lookX,
        lookY,
        markX: 0,
        markY: 0,
        markFollowsEye: false,
      };
      const controls = controlsRef.current;
      if (controls) lookFlat.copy(controls.target).sub(mainCam.position);
      else mainCam.getWorldDirection(lookFlat);
      if (lookFlat.x * lookFlat.x + lookFlat.y * lookFlat.y < 1e-4) lookFlat.set(mainCam.up.x, mainCam.up.y, 0);
      const originX = lookX;
      const originY = lookY;
      const halfX = fittedHalf * aspect;
      const camInside =
        Math.abs(mainCam.position.x - originX) <= halfX && Math.abs(mainCam.position.y - originY) <= fittedHalf;
      const focusX = controls ? controls.target.x : mainCam.position.x;
      const focusY = controls ? controls.target.y : mainCam.position.y;
      const markX = walking || camInside ? mainCam.position.x : focusX;
      const markY = walking || camInside ? mainCam.position.y : focusY;
      viewMark.visible = true;
      propsRef.current.planMetrics.current.markX = markX;
      propsRef.current.planMetrics.current.markY = markY;
      propsRef.current.planMetrics.current.markFollowsEye = walking || camInside;
      viewMark.position.set(markX, markY, planCam.position.z - 24);
      viewMark.scale.setScalar(Math.max(fittedHalf * 0.09, 2.2));
      viewMark.rotation.z = Math.atan2(-lookFlat.x, lookFlat.y);
      planCam.updateProjectionMatrix();
      gl.getViewport(viewport);
      gl.getScissor(scissor);
      const scissorTest = gl.getScissorTest();
      gl.getClearColor(clear);
      const alpha = gl.getClearAlpha();
      gl.setScissorTest(true);
      gl.setViewport(x, y, width, height);
      gl.setScissor(x, y, width, height);
      gl.setClearColor('#e7eef5', 1);
      gl.clear(true, true, false);
      gl.render(scene, planCam);
      gl.setViewport(viewport);
      gl.setScissor(scissor);
      gl.setScissorTest(scissorTest);
      gl.setClearColor(clear, alpha);
    });
    return () => {
      remove();
      scene.remove(viewMark);
      viewMark.traverse((obj) => {
        const mesh = obj as Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (material instanceof MeshBasicMaterial) material.dispose();
      });
    };
  }, [camera, gl, scene, props.planSlot]);

  useEffect(() => {
    const el = gl.domElement;
    const zoomBy = (factor: number) => {
      const controls = controlsRef.current;
      if (!controls) return;
      const cam = camera as PerspectiveCamera;
      const offset = cam.position.clone().sub(controls.target);
      const distance = Math.min(Math.max(offset.length() * factor, 0.3), 1e8);
      if (offset.lengthSq() < 1e-8) offset.set(1, -1, 0.7);
      offset.setLength(distance);
      cam.position.copy(controls.target).add(offset);
      cam.near = Math.max(distance / 5000, 0.01);
      cam.far = distance * 50;
      cam.updateProjectionMatrix();
      controls.update();
    };
    const onWheel = (event: WheelEvent) => {
      const controls = controlsRef.current;
      if (!controls) return;
      event.preventDefault();
      if (propsRef.current.tool === 'walk') {
        const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
        const distance = Math.max(-110, Math.min(110, -pixels * 0.28));
        const { fx, fy } = walkApi.current.basis();
        walkApi.current.step(fx * distance, fy * distance, 0);
        return;
      }
      const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
      zoomBy(Math.pow(1.48, pixels / 100));
    };
    let pinch = 0;
    const pinchSpan = (touches: TouchList) => {
      const a = touches[0];
      const b = touches[1];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length < 2) return;
      pinch = pinchSpan(event.touches);
      event.preventDefault();
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length < 2 || pinch <= 0) return;
      event.preventDefault();
      const span = pinchSpan(event.touches);
      const ratio = pinch / span;
      pinch = span;
      if (propsRef.current.tool === 'walk') {
        const distance = Math.max(-110, Math.min(110, (1 - ratio) * 280));
        const { fx, fy } = walkApi.current.basis();
        walkApi.current.step(fx * distance, fy * distance, 0);
        return;
      }
      zoomBy(ratio);
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = 0;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [camera, gl]);

  useEffect(() => {
    setPreview(null);
    drawRef.current = null;
    setRubber(null);
  }, [props.doc]);

  useEffect(() => () => disposeModel(built), [built]);

  useEffect(() => {
    drawRef.current = null;
    setRubber(null);
    setPreview(null);
  }, [props.tool]);

  const report = (text: string) => {
    if (measureRef.current === text) return;
    measureRef.current = text;
    propsRef.current.onLiveMeasure(text);
  };

  const sceneBounds = () => {
    const bounds = modelBounds(propsRef.current.doc);
    if (!bounds) {
      return {
        center: new Vector3(40, 30, 16),
        size: new Vector3(80, 60, 32),
        floor: 0,
      };
    }
    return {
      center: new Vector3(...bounds.center),
      size: new Vector3(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]),
      floor: bounds.min[2],
    };
  };

  const placeGround = (center: Vector3, size: Vector3, floor: number) => {
    const span = Math.max(size.x, size.y, 48);
    const scale = (span * 2.4) / 2400;
    gridRef.current.position.set(center.x, center.y, floor);
    gridRef.current.scale.setScalar(scale);
    axesRef.current.position.set(center.x, center.y, floor);
    axesRef.current.scale.setScalar(Math.max(span * 0.18, 12) / 56);
  };

  const fitDistance = (size: Vector3, direction: Vector3) => {
    const cam = camera as PerspectiveCamera;
    const up = new Vector3(0, 0, 1);
    const right = new Vector3().crossVectors(direction, up);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const camUp = new Vector3().crossVectors(right, direction).normalize();
    const extent = (axis: Vector3) => Math.abs(axis.x) * size.x * 0.5 + Math.abs(axis.y) * size.y * 0.5 + Math.abs(axis.z) * size.z * 0.5;
    const vFov = (cam.fov * Math.PI) / 180;
    const aspect = cam.aspect > 0.05 ? cam.aspect : 1.4;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const distV = extent(camUp) / Math.tan(vFov / 2);
    const distH = extent(right) / Math.tan(hFov / 2);
    return Math.max(distV, distH, 8) * 1.28;
  };

  const lookAtTarget = (target: Vector3, direction: Vector3, distance: number) => {
    const cam = camera as PerspectiveCamera;
    const dir = direction.clone().normalize();
    cam.up.set(0, 0, 1);
    cam.position.copy(target).addScaledVector(dir, distance);
    cam.lookAt(target);
    const span = Math.max(distance, 20);
    cam.near = Math.max(span / 4000, 0.01);
    cam.far = span * 40;
    cam.updateProjectionMatrix();
    const controls = controlsRef.current;
    if (controls) {
      controls.target.copy(target);
      controls.update();
    } else {
      requestAnimationFrame(() => {
        const ready = controlsRef.current;
        if (!ready) return;
        ready.target.copy(target);
        ready.update();
      });
    }
    orbitHandle.position.copy(target);
  };

  const frame = (mode: 'fit' | 'iso' | 'top' | 'front' | 'right') => {
    const { center, size, floor } = sceneBounds();
    const cam = camera as PerspectiveCamera;
    let direction: Vector3;
    if (mode === 'top') direction = new Vector3(0, -0.02, 1);
    else if (mode === 'front') direction = new Vector3(0, -1, 0.16);
    else if (mode === 'right') direction = new Vector3(1, -0.02, 0.16);
    else if (mode === 'fit') {
      const controls = controlsRef.current;
      direction = cam.position.clone().sub(controls ? controls.target : center);
      if (direction.lengthSq() < 1e-6) direction = new Vector3(0.78, -1, 0.58);
    } else direction = new Vector3(0.78, -1, 0.58);
    direction.normalize();
    lookAtTarget(center, direction, fitDistance(size, direction));
    placeGround(center, size, floor);
  };

  const recenterPivot = () => {
    const { center, size, floor } = sceneBounds();
    const cam = camera as PerspectiveCamera;
    const controls = controlsRef.current;
    const from = controls ? controls.target.clone() : center.clone();
    const direction = cam.position.clone().sub(from);
    if (direction.lengthSq() < 1e-6) direction.set(0.78, -1, 0.58);
    lookAtTarget(center, direction.normalize(), direction.length() || fitDistance(size, direction));
    placeGround(center, size, floor);
  };

  useLayoutEffect(() => {
    frame('iso');
    // The model identity is what should be framed, not every camera tweak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.viewToken]);

  useLayoutEffect(() => {
    if (!props.viewCommand) return;
    if (props.viewCommand.type === 'pivot') recenterPivot();
    else frame(props.viewCommand.type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.viewCommand]);

  useLayoutEffect(() => {
    if (gizmoDrag.current) return;
    const center = selectionCenter(shown, props.selection);
    if (!center) return;
    pivot.position.set(center[0], center[1], center[2]);
    pivot.quaternion.identity();
    pivot.scale.set(1, 1, 1);
    pivot.updateMatrixWorld();
  }, [shown, props.selection, pivot]);

  useLayoutEffect(() => {
    const overlays: Object3D[] = [];
    const hoverItem = props.tool === 'select' ? objectUnder(hover, props.editingPath) : null;
    const hoverKey = hoverItem ? selectionKey(hoverItem) : '';
    const chosen = props.selection.filter((item) => selectionKey(item) !== hoverKey);
    const interest = hoverItem ? [...chosen, hoverItem] : chosen;
    const addOutline = (mesh: Mesh, material: LineBasicMaterial) => {
      const edges = new EdgesGeometry(mesh.geometry, 28);
      const line = new LineSegments(edges, material);
      line.raycast = () => {};
      line.renderOrder = 40;
      mesh.add(line);
      overlays.push(line);
    };
    built.group.traverse((obj) => {
      const data = obj.userData as PickData;
      if (!data.pick || !(obj as Mesh).isMesh) return;
      const mesh = obj as Mesh;
      const path = data.path ?? [];
      let whole: 'selected' | 'hover' | null = null;
      const faceHits: { id: string; role: 'selected' | 'hover' }[] = [];
      for (const item of interest) {
        const role = props.selection.some((entry) => selectionKey(entry) === selectionKey(item)) ? 'selected' : 'hover';
        if (item.kind === 'placement' && path.length >= item.path.length && item.path.every((id, index) => path[index] === id)) {
          if (role === 'selected' || !whole) whole = role;
        }
        if (item.kind === 'face' && data.definitionId === item.definitionId && samePath(path, item.path)) {
          if (!data.batched) {
            if (data.faceId === item.faceId) faceHits.push({ id: item.faceId, role });
          } else faceHits.push({ id: item.faceId, role });
        }
      }
      const selectedWhole = whole === 'selected';
      const selectedFace = faceHits.some((hit) => hit.role === 'selected');
      if (data.batched && !selectedWhole && !whole) {
        mesh.material = data.baseMaterial as MeshLambertMaterial;
        for (const hit of faceHits) {
          const geometry = faceOverlay(mesh, hit.id);
          if (!geometry) continue;
          const overlay = new Mesh(geometry, hit.role === 'selected' ? selectedMat : hoverMat);
          overlay.raycast = () => {};
          mesh.add(overlay);
          overlays.push(overlay);
          const edges = new EdgesGeometry(geometry, 1);
          const line = new LineSegments(edges, hit.role === 'selected' ? outlineMat : hoverLineMat);
          line.raycast = () => {};
          line.renderOrder = 40;
          mesh.add(line);
          overlays.push(line);
        }
        return;
      }
      const role = selectedWhole || selectedFace ? 'selected' : whole === 'hover' || faceHits.some((hit) => hit.role === 'hover') ? 'hover' : null;
      mesh.material = role === 'selected' ? selectedMat : role === 'hover' ? hoverMat : (data.baseMaterial as MeshLambertMaterial);
      if (role) addOutline(mesh, role === 'selected' ? outlineMat : hoverLineMat);
    });
    for (const item of props.selection) {
      if (item.kind !== 'edge') continue;
      const def = getDef(props.doc, item.definitionId);
      const edge = def?.edges.find((entry) => entry.id === item.edgeId);
      if (!def || !edge || !def.vertices[edge.a] || !def.vertices[edge.b]) continue;
      const matrix = worldMatrixOfPath(props.doc, item.path);
      const a = transformPoint(matrix, def.vertices[edge.a]);
      const b = transformPoint(matrix, def.vertices[edge.b]);
      const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (span < 1e-4) continue;
      const mark = new Mesh(new CylinderGeometry(Math.max(0.35, span * 0.012), Math.max(0.35, span * 0.012), span, 8), edgeMarkMat);
      mark.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      mark.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize());
      mark.raycast = () => {};
      mark.renderOrder = 41;
      scene.add(mark);
      overlays.push(mark);
    }
    return () => {
      for (const overlay of overlays) {
        overlay.removeFromParent();
        const mesh = overlay as Mesh;
        if (mesh.geometry && mesh.userData !== edgeMarkMat) mesh.geometry.dispose();
      }
    };
  }, [built, props.selection, props.tool, props.editingPath, hover, selectedMat, hoverMat, outlineMat, hoverLineMat, edgeMarkMat, props.doc, scene]);

  useEffect(() => {
    const request = props.numericRequest;
    if (!request) return;
    applyNumeric(request.text);
    // applyNumeric reads the latest draw state from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.numericRequest]);

  useEffect(() => {
    const el = gl.domElement;
    const raycaster = new Raycaster();
    raycaster.layers.enable(1);

    const ndc = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      return new Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    const cast = (event: PointerEvent) => {
      raycaster.setFromCamera(ndc(event), camera);
      return {
        origin: [raycaster.ray.origin.x, raycaster.ray.origin.y, raycaster.ray.origin.z] as Vec3,
        dir: [raycaster.ray.direction.x, raycaster.ray.direction.y, raycaster.ray.direction.z] as Vec3,
      };
    };

    const localRay = (event: PointerEvent, world: number[]) => {
      const ray = cast(event);
      const inv = invertMat(world);
      const origin = transformPoint(inv, ray.origin);
      const ahead = transformPoint(inv, add(ray.origin, ray.dir));
      return { origin, dir: normalize(sub(ahead, origin)), worldRay: ray };
    };

    const pick = (event: PointerEvent): { hit: Intersection; data: PickData } | null => {
      modelRef.current?.updateWorldMatrix(true, true);
      raycaster.setFromCamera(ndc(event), camera);
      const hits = modelRef.current ? raycaster.intersectObject(modelRef.current, true) : [];
      const hit = hits.find((item) => (item.object.userData as PickData).pick) ?? null;
      return hit ? { hit, data: resolvedPick(hit) } : null;
    };

    const hitKind = (path: string[]) => {
      const editing = propsRef.current.editingPath;
      if (editing.length === 0) return path.length === 0 ? 'face' : 'group';
      if (!startsWith(path, editing)) return null;
      return path.length === editing.length ? 'face' : 'group';
    };

    let snapNote = '';
    const project = new Vector3();
    const mat4 = new Matrix4();
    const tmp = new Vector3();
    const scanCache = { doc: null as SketchDocument | null, path: '', enabled: false };

    const showSnap = (hit: { kind: SnapKind; world: Vec3 } | null) => {
      if (!hit) {
        snapMarker.visible = false;
        snapNote = '';
        return;
      }
      snapNote = SNAP_LABEL[hit.kind];
      snapMarker.visible = true;
      snapMarker.position.set(hit.world[0], hit.world[1], hit.world[2]);
      (snapMarker.material as MeshBasicMaterial).color.setHex(SNAP_COLOR[hit.kind]);
    };

    const infer = (event: PointerEvent): { kind: SnapKind; world: Vec3; edgeLength?: number } | null => {
      const current = propsRef.current;
      const rect = el.getBoundingClientRect();
      const ray = cast(event);
      let best: { kind: SnapKind; world: Vec3; edgeLength?: number } | null = null;
      let bestScore = Infinity;
      const screen2 = (worldPoint: Vec3): number | null => {
        project.set(worldPoint[0], worldPoint[1], worldPoint[2]).project(camera);
        if (project.z < -1 || project.z > 1) return null;
        const sx = (project.x * 0.5 + 0.5) * rect.width + rect.left;
        const sy = (-project.y * 0.5 + 0.5) * rect.height + rect.top;
        return (sx - event.clientX) ** 2 + (sy - event.clientY) ** 2;
      };
      const consider = (kind: SnapKind, worldPoint: Vec3, edgeLength?: number) => {
        const dist = screen2(worldPoint);
        if (dist === null || dist > SNAP_RADIUS2[kind]) return;
        const score = SNAP_RANK[kind] * 1_000_000 + dist;
        if (score < bestScore) {
          bestScore = score;
          best = { kind, world: worldPoint, edgeLength };
        }
      };
      const toWorld = (matrix: number[], points: Vec3[]): Vec3[] => {
        mat4.fromArray(matrix);
        return points.map((p) => {
          tmp.set(p[0], p[1], p[2]).applyMatrix4(mat4);
          return [tmp.x, tmp.y, tmp.z];
        });
      };
      const considerLoop = (local: Vec3[], matrix: number[]) => {
        if (local.length < 2) return;
        const limited = local.length > 64 ? local.slice(0, 64) : local;
        const worldPts = toWorld(matrix, limited);
        for (const point of worldPts) consider('endpoint', point);
        if (local.length <= 64) {
          for (let i = 0; i < worldPts.length; i++) {
            const a = worldPts[i];
            const b = worldPts[(i + 1) % worldPts.length];
            const span = sub(b, a);
            const spanLen = length(span);
            if (spanLen < 0.05) continue;
            consider('midpoint', [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
            const t = closestLineParam(a, span, ray.origin, ray.dir);
            if (t === null || t <= 0.04 || t >= 0.96) continue;
            consider('edge', add(a, scale(span, t)), spanLen);
          }
        }
        if (local.length >= 3 && local.length <= 16) consider('center', centroid(worldPts));
      };
      const picked = pick(event);
      if (picked?.data.faceId && picked.data.definitionId) {
        const def = getDef(current.doc, picked.data.definitionId);
        const face = def?.faces.find((item) => item.id === picked.data.faceId);
        if (def && face && !face.hidden) {
          const matrix = worldMatrixOfPath(current.doc, picked.data.path ?? []);
          considerLoop(pointsOf(def, face.outer), matrix);
          for (const hole of face.holes) {
            if (hole.length >= 3 && hole.length <= 64) considerLoop(pointsOf(def, hole), matrix);
          }
        }
      }
      const pathKey = current.editingPath.join('/');
      if (scanCache.doc !== current.doc || scanCache.path !== pathKey) {
        const root = editingDefinition(current.doc, current.editingPath);
        let faces = 0;
        let verts = 0;
        const count = (def: ReturnType<typeof editingDefinition>, depth: number) => {
          faces += def.faces.length;
          verts += def.vertices.length;
          if (faces > 800 || verts > 2500 || depth > 6) return;
          for (const placement of def.placements) {
            if (faces > 800 || verts > 2500) return;
            const child = getDef(current.doc, placement.definitionId);
            if (child) count(child, depth + 1);
          }
        };
        count(root, 0);
        scanCache.doc = current.doc;
        scanCache.path = pathKey;
        scanCache.enabled = faces <= 800 && verts <= 2500;
      }
      if (scanCache.enabled) {
        const hidden = new Set(current.doc.layers.filter((layer) => !layer.visible).map((layer) => layer.id));
        let left = 800;
        const visit = (def: ReturnType<typeof editingDefinition>, matrix: number[], depth: number) => {
          if (depth > 8 || left <= 0) return;
          for (const face of def.faces) {
            if (left <= 0) return;
            if (face.hidden || hidden.has(face.layerId) || face.outer.length < 2 || face.outer.length > 64) continue;
            left -= 1;
            considerLoop(pointsOf(def, face.outer), matrix);
          }
          for (const placement of def.placements) {
            if (left <= 0) return;
            if (placement.hidden || hidden.has(placement.layerId)) continue;
            const child = getDef(current.doc, placement.definitionId);
            if (!child) continue;
            visit(child, multiplyMat(matrix, placement.matrix), depth + 1);
          }
        };
        visit(editingDefinition(current.doc, current.editingPath), worldMatrixOfPath(current.doc, current.editingPath), 0);
      }
      return best;
    };

    const pointOnPointer = (event: PointerEvent): Vec3 | null => {
      const ray = cast(event);
      const picked = pick(event);
      if (picked?.data.faceId && picked.data.definitionId) {
        const def = getDef(propsRef.current.doc, picked.data.definitionId);
        const face = def?.faces.find((item) => item.id === picked.data.faceId);
        const plane = face && def ? planeFromPoints(pointsOf(def, face.outer)) : null;
        if (plane) {
          const matrix = worldMatrixOfPath(propsRef.current.doc, picked.data.path ?? []);
          const hit = rayPlane(ray.origin, ray.dir, transformPoint(matrix, plane.origin), transformDir(matrix, plane.normal));
          if (hit) return hit;
        }
      }
      return rayPlane(ray.origin, ray.dir, [0, 0, 0], [0, 0, 1]);
    };

    const edgeNear = (event: PointerEvent, data: PickData) => {
      if (!data.faceId || !data.definitionId) return null;
      const def = getDef(propsRef.current.doc, data.definitionId);
      const face = def?.faces.find((item) => item.id === data.faceId);
      if (!def || !face) return null;
      const matrix = worldMatrixOfPath(propsRef.current.doc, data.path ?? []);
      const rect = el.getBoundingClientRect();
      const projected = new Vector3();
      const screenOf = (point: Vec3) => {
        const world = transformPoint(matrix, point);
        projected.set(world[0], world[1], world[2]).project(camera);
        return {
          x: (projected.x * 0.5 + 0.5) * rect.width + rect.left,
          y: (-projected.y * 0.5 + 0.5) * rect.height + rect.top,
        };
      };
      let best: { edgeId: string; dist: number } | null = null;
      for (const loop of [face.outer, ...face.holes]) {
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i];
          const b = loop[(i + 1) % loop.length];
          const edge = def.edges.find((item) => (item.a === a && item.b === b) || (item.a === b && item.b === a));
          const va = def.vertices[a];
          const vb = def.vertices[b];
          if (!edge || !va || !vb) continue;
          const sa = screenOf(va);
          const sb = screenOf(vb);
          const dx = sb.x - sa.x;
          const dy = sb.y - sa.y;
          const len2 = dx * dx + dy * dy;
          const t = len2 < 1e-6 ? 0 : Math.min(1, Math.max(0, ((event.clientX - sa.x) * dx + (event.clientY - sa.y) * dy) / len2));
          const dist = Math.hypot(sa.x + dx * t - event.clientX, sa.y + dy * t - event.clientY);
          if (dist <= 8 && (!best || dist < best.dist)) best = { edgeId: edge.id, dist };
        }
      }
      if (!best) return null;
      return { definitionId: def.id, edgeId: best.edgeId, path: [...(data.path ?? [])] };
    };

    const areaText = (event: PointerEvent): string | null => {
      const picked = pick(event);
      if (!picked?.data.faceId || !picked.data.definitionId) return null;
      const def = getDef(propsRef.current.doc, picked.data.definitionId);
      const face = def?.faces.find((item) => item.id === picked.data.faceId);
      if (!def || !face) return null;
      return formatArea(faceArea(def, face), propsRef.current.unit);
    };

    const snapPoint = (point: Vec3, plane: Plane, event: PointerEvent, world: number[]) => {
      const hit = infer(event);
      showSnap(hit);
      if (hit) {
        const local = transformPoint(invertMat(world), hit.world);
        const off = sub(local, plane.origin);
        return sub(local, scale(plane.normal, dot(off, plane.normal)));
      }
      const step = propsRef.current.snapInches;
      if (step <= 0) return point;
      const delta = sub(point, plane.origin);
      const u = Math.round(dot(delta, plane.u) / step) * step;
      const v = Math.round(dot(delta, plane.v) / step) * step;
      return add(plane.origin, add(scale(plane.u, u), scale(plane.v, v)));
    };

    const tagged = (text: string) => (snapNote ? `${snapNote} · ${text}` : text);

    const choosePlane = (event: PointerEvent): { plane: Plane; point: Vec3 } | null => {
      const current = propsRef.current;
      const world = worldMatrixOfPath(current.doc, current.editingPath);
      const def = editingDefinition(current.doc, current.editingPath);
      let plane = groundPlane();
      const pickedHit = pick(event);
      if (pickedHit) {
        const data = pickedHit.data;
        const path = data.path ?? [];
        if (data.definitionId === def.id && data.faceId && hitKind(path) === 'face') {
          const face = def.faces.find((item) => item.id === data.faceId);
          const next = face ? planeFromPoints(pointsOf(def, face.outer)) : null;
          if (next) plane = next;
        }
      }
      const ray = localRay(event, world);
      const section = sectionDrawingPlane(current.doc, current.editingPath, current.section);
      if (section) {
        const faceRaw = rayPlane(ray.origin, ray.dir, plane.origin, plane.normal);
        const cutRaw = rayPlane(ray.origin, ray.dir, section.plane.origin, section.plane.normal);
        const faceWorld = faceRaw ? transformPoint(world, faceRaw) : null;
        const onVisible = faceWorld ? faceWorld[section.axis] <= section.cut + 0.3 : false;
        const faceDist = faceRaw ? length(sub(faceRaw, ray.origin)) : Infinity;
        const cutDist = cutRaw ? length(sub(cutRaw, ray.origin)) : Infinity;
        if (cutRaw && (!faceRaw || !onVisible || cutDist <= faceDist + 0.5)) plane = section.plane;
      }
      const raw = rayPlane(ray.origin, ray.dir, plane.origin, plane.normal);
      if (!raw) return null;
      return { plane, point: snapPoint(raw, plane, event, world) };
    };

    const dimensionNear = (event: PointerEvent): string | null => {
      const dims = propsRef.current.doc.dimensions ?? [];
      if (!dims.length) return null;
      const rect = el.getBoundingClientRect();
      const projected = new Vector3();
      const forward = camera.getWorldDirection(new Vector3());
      let best: { id: string; dist: number } | null = null;
      const screenOfWorld = (point: Vec3) => {
        const toward = projected.set(point[0] - camera.position.x, point[1] - camera.position.y, point[2] - camera.position.z);
        if (toward.dot(forward) <= 0) return null;
        projected.set(point[0], point[1], point[2]).project(camera);
        return {
          x: (projected.x * 0.5 + 0.5) * rect.width + rect.left,
          y: (-projected.y * 0.5 + 0.5) * rect.height + rect.top,
        };
      };
      for (const dimension of dims) {
        const sa = screenOfWorld(dimension.a);
        const sb = screenOfWorld(dimension.b);
        if (!sa || !sb) continue;
        const dx = sb.x - sa.x;
        const dy = sb.y - sa.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 < 1e-6 ? 0 : Math.min(1, Math.max(0, ((event.clientX - sa.x) * dx + (event.clientY - sa.y) * dy) / len2));
        const dist = Math.hypot(sa.x + dx * t - event.clientX, sa.y + dy * t - event.clientY);
        if (dist <= 10 && (!best || dist < best.dist)) best = { id: dimension.id, dist };
      }
      return best?.id ?? null;
    };

    const finishShape = (points: Vec3[]) => {
      const current = propsRef.current;
      const def = editingDefinition(current.doc, current.editingPath);
      const next = addPolygon(current.doc, def.id, points, current.drawMaterialId, current.activeLayerId);
      if (next) current.onCommit(next);
      drawRef.current = null;
      setRubber(null);
      report('');
    };

    const grabOrbit = (event: PointerEvent) => {
      if (!controlsRef.current) return false;
      raycaster.setFromCamera(ndc(event), camera);
      const hit = raycaster.intersectObject(orbitHandle, true).some((item) => item.object.userData.orbitHandle);
      if (!hit) return false;
      const normal = camera.getWorldDirection(new Vector3());
      orbitDrag.current = new ThreePlane().setFromNormalAndCoplanarPoint(normal, controlsRef.current.target);
      return true;
    };

    const moveOrbit = (event: PointerEvent) => {
      const plane = orbitDrag.current;
      const controls = controlsRef.current;
      if (!plane || !controls) return false;
      raycaster.setFromCamera(ndc(event), camera);
      const point = new Vector3();
      if (raycaster.ray.intersectPlane(plane, point)) {
        controls.target.copy(point);
        controls.update();
        orbitHandle.position.copy(point);
      }
      return true;
    };

    let selectDrag: { x: number; y: number; shift: boolean; alt: boolean } | null = null;
    let lastPick: { t: number; key: string } | null = null;
    const marqueeEl = document.createElement('div');
    marqueeEl.className = 'marquee';
    const showMarquee = (x: number, y: number, w: number, h: number) => {
      if (!marqueeEl.isConnected) document.body.appendChild(marqueeEl);
      marqueeEl.style.left = `${x}px`;
      marqueeEl.style.top = `${y}px`;
      marqueeEl.style.width = `${w}px`;
      marqueeEl.style.height = `${h}px`;
    };
    const hideMarquee = () => marqueeEl.remove();

    const clickedObject = (event: PointerEvent, alt: boolean): Selection | null => {
      const picked = pick(event);
      const dimensionId = dimensionNear(event);
      if (alt) {
        const near = picked ? edgeNear(event, picked.data) : null;
        if (near && hitKind(near.path) === 'face') {
          return { kind: 'edge', definitionId: near.definitionId, edgeId: near.edgeId, path: near.path };
        }
        if (picked?.data.faceId && picked.data.definitionId && hitKind(picked.data.path ?? []) === 'face') {
          return { kind: 'face', definitionId: picked.data.definitionId, faceId: picked.data.faceId, path: [...(picked.data.path ?? [])] };
        }
        return dimensionId ? { kind: 'dimension', dimensionId } : null;
      }
      if (!picked) return dimensionId ? { kind: 'dimension', dimensionId } : null;
      const path = picked.data.path ?? [];
      const kind = hitKind(path);
      if (!kind || !picked.data.faceId || !picked.data.definitionId) return dimensionId ? { kind: 'dimension', dimensionId } : null;
      if (kind === 'face') {
        return { kind: 'face', definitionId: picked.data.definitionId, faceId: picked.data.faceId, path: [...path] };
      }
      const index = propsRef.current.editingPath.length;
      const placementId = path[index];
      if (!placementId) return null;
      return { kind: 'placement', placementId, path: path.slice(0, index + 1) };
    };

    const objectsInRect = (x0: number, y0: number, x1: number, y1: number): Selection[] => {
      const current = propsRef.current;
      const rect = el.getBoundingClientRect();
      const hits = (points: Vec3[]) => screenBoxOverlaps(points, camera, rect, x0, y0, x1, y1);
      const def = editingDefinition(current.doc, current.editingPath);
      const world = worldMatrixOfPath(current.doc, current.editingPath);
      const items: Selection[] = [];
      for (const face of def.faces) {
        if (face.hidden) continue;
        const points = pointsOf(def, face.outer).map((point) => transformPoint(world, point));
        if (hits(points)) items.push({ kind: 'face', definitionId: def.id, faceId: face.id, path: [...current.editingPath] });
      }
      for (const placement of def.placements) {
        if (placement.hidden) continue;
        const child = getDef(current.doc, placement.definitionId);
        if (!child) continue;
        const matrix = multiplyMat(world, placement.matrix);
        const points = definitionLocalPoints(current.doc, child).map((point) => transformPoint(matrix, point));
        if (hits(points)) items.push({ kind: 'placement', placementId: placement.id, path: [...current.editingPath, placement.id] });
      }
      for (const dimension of current.doc.dimensions ?? []) {
        if (hits([dimension.a, dimension.b])) items.push({ kind: 'dimension', dimensionId: dimension.id });
      }
      return items;
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (propsRef.current.tool === 'walk') return;
      if (grabOrbit(event)) return;
      const current = propsRef.current;
      const tool = current.tool;
      if (tool === 'navigate') return;
      if (tool === 'measure') {
        const hit = infer(event);
        showSnap(hit);
        const worldPoint = hit?.world ?? pointOnPointer(event);
        if (!worldPoint) return;
        const draw = drawRef.current;
        if (draw?.kind === 'measure') {
          measureLockRef.current = null;
          setMeasureLock(null);
          drawRef.current = null;
          setRubber(null);
          const delta = sub(worldPoint, draw.origin);
          const next = addDimension(current.doc, draw.origin, worldPoint);
          if (next) current.onCommit(next);
          report(`거리 ${formatLength(length(delta), current.unit)} · ${formatDelta(delta, current.unit)}`);
          return;
        }
        measureLockRef.current = null;
        setMeasureLock(null);
        drawRef.current = { kind: 'measure', origin: worldPoint };
        report(hit ? `${SNAP_LABEL[hit.kind]} · 다음 점을 찍습니다` : '다음 점을 찍습니다');
        return;
      }
      if (tool === 'offset') {
        const pickedFace = pick(event);
        const path = pickedFace?.data.path ?? [];
        if (!pickedFace?.data.faceId || !pickedFace.data.definitionId || hitKind(path) !== 'face') {
          report('면을 클릭한 뒤 안팎으로 끕니다');
          return;
        }
        drawRef.current = { kind: 'offset', faceId: pickedFace.data.faceId, definitionId: pickedFace.data.definitionId, distance: 0 };
        current.onSelect([{ kind: 'face', definitionId: pickedFace.data.definitionId, faceId: pickedFace.data.faceId, path }]);
        report('안쪽으로 끌면 테두리가 생기고, 바깥으로 끌면 면이 넓어집니다');
        return;
      }
      if (tool === 'arc') {
        const picked = choosePlane(event);
        if (!picked) return;
        const draw = drawRef.current;
        const world = worldMatrixOfPath(current.doc, current.editingPath);
        const ray = localRay(event, world);
        if (!draw || draw.kind !== 'arc') {
          drawRef.current = { kind: 'arc', center: picked.point, plane: picked.plane, start: null };
          report('시작점을 찍으면 반지름이 정해집니다');
          return;
        }
        const raw = rayPlane(ray.origin, ray.dir, draw.plane.origin, draw.plane.normal);
        const point = snapPoint(raw ?? picked.point, draw.plane, event, world);
        if (!draw.start) {
          if (length(sub(point, draw.center)) < 0.05) return;
          drawRef.current = { ...draw, start: point };
          report('끝점을 찍으면 반시계 방향 부채꼴이 생깁니다. 치수는 각도(도)입니다');
          return;
        }
        const loop = sectorPoints(draw.center, draw.plane, draw.start, point);
        const def = editingDefinition(current.doc, current.editingPath);
        const next = loop ? addPolygon(current.doc, def.id, loop, current.drawMaterialId, current.activeLayerId) : null;
        if (next) current.onCommit(next);
        drawRef.current = null;
        setRubber(null);
        report('');
        return;
      }
      if (tool === 'rect' || tool === 'circle' || tool === 'line') {
        const picked = choosePlane(event);
        if (!picked) return;
        const draw = drawRef.current;
        if (tool === 'line') {
          const plane = draw?.kind === 'line' ? draw.plane : picked.plane;
          const world = worldMatrixOfPath(current.doc, current.editingPath);
          const ray = localRay(event, world);
          const raw = rayPlane(ray.origin, ray.dir, plane.origin, plane.normal);
          const point = snapPoint(raw ?? picked.point, plane, event, world);
          const points = draw?.kind === 'line' ? draw.points : [];
          if (points.length >= 3 && length(sub(point, points[0])) < Math.max(current.snapInches, 0.4)) {
            finishShape(points);
            return;
          }
          const nextPoints = [...points, point];
          drawRef.current = { kind: 'line', points: nextPoints, plane };
          setRubber(toWorld(current, [...nextPoints, point]));
          return;
        }
        if (draw && (draw.kind === 'rect' || draw.kind === 'circle') && draw.kind === tool) {
          const world = worldMatrixOfPath(current.doc, current.editingPath);
          const ray = localRay(event, world);
          const raw = rayPlane(ray.origin, ray.dir, draw.plane.origin, draw.plane.normal);
          if (raw) commitDraw(snapPoint(raw, draw.plane, event, world));
          return;
        }
        drawRef.current = { kind: tool, origin: picked.point, plane: picked.plane, x: event.clientX, y: event.clientY, moved: false };
        return;
      }
      if (tool === 'select') {
        selectDrag = { x: event.clientX, y: event.clientY, shift: event.shiftKey, alt: event.altKey };
        return;
      }
      if (tool === 'erase') {
        const dimensionId = dimensionNear(event);
        if (dimensionId) {
          const next = deleteDimension(current.doc, dimensionId);
          if (next) {
            current.onSelect([]);
            current.onCommit(next);
          }
          return;
        }
      }
      const picked = pick(event);
      const nearEdge = picked ? edgeNear(event, picked.data) : null;
      if (nearEdge && hitKind(nearEdge.path) === 'face' && tool === 'erase') {
        const next = deleteEdge(current.doc, nearEdge.definitionId, nearEdge.edgeId);
        if (next) {
          current.onSelect([]);
          current.onCommit(next);
        }
        return;
      }
      if (!picked) return;
      const { hit, data } = picked;
      const path = data.path ?? [];
      const kind = hitKind(path);
      if (!kind || !data.faceId || !data.definitionId) return;
      if (tool === 'move' || tool === 'rotate' || tool === 'scale') {
        if (kind === 'face') {
          current.onSelect([{ kind: 'face', definitionId: data.definitionId, faceId: data.faceId, path: [...path] }]);
        } else {
          const index = current.editingPath.length === 0 ? 0 : current.editingPath.length;
          const placementId = path[index];
          if (placementId) current.onSelect([{ kind: 'placement', placementId, path: path.slice(0, index + 1) }]);
        }
        return;
      }
      if (tool === 'paint') {
        const next =
          kind === 'face'
            ? paintFace(current.doc, data.definitionId, data.faceId, current.drawMaterialId)
            : paintPlacement(current.doc, path[current.editingPath.length === 0 ? 0 : current.editingPath.length], current.drawMaterialId);
        current.onCommit(next);
        return;
      }
      if (tool === 'erase') {
        const next =
          kind === 'face'
            ? deleteFace(current.doc, data.definitionId, data.faceId)
            : deletePlacement(current.doc, path[current.editingPath.length === 0 ? 0 : current.editingPath.length]);
        if (next) {
          current.onSelect([]);
          current.onCommit(next);
        }
        return;
      }
      if (tool === 'pushpull') {
        const def = getDef(current.doc, data.definitionId);
        const face = def?.faces.find((item) => item.id === data.faceId);
        if (!def || !face) return;
        const normal = faceNormal(pointsOf(def, face.outer));
        const world = worldMatrixOfPath(current.doc, path);
        const scaled: Vec3 = [
          world[0] * normal[0] + world[4] * normal[1] + world[8] * normal[2],
          world[1] * normal[0] + world[5] * normal[1] + world[9] * normal[2],
          world[2] * normal[0] + world[6] * normal[1] + world[10] * normal[2],
        ];
        const factor = length(scaled) || 1;
        const anchor: Vec3 = [hit.point.x, hit.point.y, hit.point.z];
        const ray = cast(event);
        const start = closestLineParam(anchor, normalize(scaled), ray.origin, ray.dir) ?? 0;
        drawRef.current = {
          kind: 'push',
          faceId: face.id,
          definitionId: def.id,
          path: [...path],
          anchor,
          normal: normalize(scaled),
          scale: factor,
          start,
        };
      }
    };

    const commitDraw = (point: Vec3) => {
      const draw = drawRef.current;
      const current = propsRef.current;
      if (!draw || (draw.kind !== 'rect' && draw.kind !== 'circle')) return;
      const def = editingDefinition(current.doc, current.editingPath);
      if (draw.kind === 'rect') {
        const du = dot(sub(point, draw.origin), draw.plane.u);
        const dv = dot(sub(point, draw.origin), draw.plane.v);
        if (Math.abs(du) < 0.05 || Math.abs(dv) < 0.05) return;
        const next = addPolygon(
          current.doc,
          def.id,
          rectanglePoints(draw.origin, draw.plane.u, draw.plane.v, du, dv),
          current.drawMaterialId,
          current.activeLayerId,
        );
        if (next) current.onCommit(next);
      } else {
        const radius = length(sub(point, draw.origin));
        if (radius < 0.05) return;
        const next = addCircle(current.doc, def.id, draw.origin, draw.plane.normal, radius, current.drawMaterialId, current.activeLayerId);
        if (next) current.onCommit(next);
      }
      drawRef.current = null;
      setRubber(null);
      report('');
    };

    const onMove = (event: PointerEvent) => {
      if (pointers.size > 1) return;
      if (selectDrag && propsRef.current.tool === 'select') {
        const dx = event.clientX - selectDrag.x;
        const dy = event.clientY - selectDrag.y;
        if (Math.hypot(dx, dy) > 5) {
          showMarquee(Math.min(selectDrag.x, event.clientX), Math.min(selectDrag.y, event.clientY), Math.abs(dx), Math.abs(dy));
          el.style.cursor = 'crosshair';
        }
        return;
      }
      if (moveOrbit(event)) {
        el.style.cursor = 'grabbing';
        return;
      }
      const current = propsRef.current;
      if (current.tool === 'navigate') {
        el.style.cursor = 'grab';
        snapMarker.visible = false;
        setHover((prev) => (prev ? null : prev));
        return;
      }
      if (current.tool === 'walk') {
        snapMarker.visible = false;
        if (walkLook.current) {
          const dx = event.clientX - walkLook.current.x;
          const dy = event.clientY - walkLook.current.y;
          walkLook.current = { x: event.clientX, y: event.clientY };
          walkApi.current.look(dx, dy);
          el.style.cursor = 'grabbing';
        } else el.style.cursor = 'crosshair';
        setHover((prev) => (prev ? null : prev));
        return;
      }
      if (current.tool === 'measure') {
        const hit = infer(event);
        showSnap(hit);
        const draw = drawRef.current;
        if (draw?.kind === 'measure') {
          const worldPoint = hit?.world ?? pointOnPointer(event);
          if (!worldPoint) return;
          setRubber([draw.origin, worldPoint]);
          const delta = sub(worldPoint, draw.origin);
          const note = hit ? `${SNAP_LABEL[hit.kind]} · ` : '';
          report(`${note}거리 ${formatLength(length(delta), current.unit)} · ${formatDelta(delta, current.unit)}`);
          return;
        }
        if (hit?.kind === 'edge' && hit.edgeLength != null) {
          report(`선 길이 ${formatLength(hit.edgeLength, current.unit)}`);
          return;
        }
        if (hit?.kind === 'center') {
          const area = areaText(event);
          report(area ? `중심 · 면적 ${area}` : '중심');
          return;
        }
        if (hit) {
          report(SNAP_LABEL[hit.kind]);
          return;
        }
        const area = areaText(event);
        report(area ? `면적 ${area}` : '');
        return;
      }
      const draw = drawRef.current;
      if (draw?.kind === 'offset') {
        const def = getDef(current.doc, draw.definitionId);
        const face = def?.faces.find((item) => item.id === draw.faceId);
        const outer = def && face ? pointsOf(def, face.outer) : null;
        const plane = outer ? planeFromPoints(outer) : null;
        if (!def || !face || !outer || !plane) return;
        const world = worldMatrixOfPath(current.doc, current.editingPath);
        const ray = localRay(event, world);
        const raw = rayPlane(ray.origin, ray.dir, plane.origin, plane.normal);
        if (!raw) return;
        const distance = insetDistance(outer, raw);
        if (distance === null) return;
        draw.distance = distance;
        const shifted = offsetLoop(outer, distance);
        if (shifted) setRubber(toWorld(current, [...shifted, shifted[0]]));
        report(`${distance >= 0 ? '안쪽' : '바깥'} ${formatLength(Math.abs(distance), current.unit)}`);
        return;
      }
      if (draw?.kind === 'arc') {
        const world = worldMatrixOfPath(current.doc, current.editingPath);
        const ray = localRay(event, world);
        const raw = rayPlane(ray.origin, ray.dir, draw.plane.origin, draw.plane.normal);
        if (!raw) return;
        const point = snapPoint(raw, draw.plane, event, world);
        if (!draw.start) {
          const radius = length(sub(point, draw.center));
          setRubber(toWorld(current, circleRing(draw.center, draw.plane, radius)));
          report(tagged(`반지름 ${formatLength(radius, current.unit)}`));
          return;
        }
        const loop = sectorPoints(draw.center, draw.plane, draw.start, point);
        if (loop) setRubber(toWorld(current, [...loop, loop[0]]));
        const startAngle = Math.atan2(dot(sub(draw.start, draw.center), draw.plane.v), dot(sub(draw.start, draw.center), draw.plane.u));
        const endAngle = Math.atan2(dot(sub(point, draw.center), draw.plane.v), dot(sub(point, draw.center), draw.plane.u));
        let sweep = endAngle - startAngle;
        if (sweep <= 1e-3) sweep += Math.PI * 2;
        report(tagged(`${Math.round((sweep * 180) / Math.PI)}°`));
        return;
      }
      if (draw?.kind === 'push') {
        const ray = cast(event);
        const param = closestLineParam(draw.anchor, draw.normal, ray.origin, ray.dir);
        if (param === null) return;
        const distance = (param - draw.start) / draw.scale;
        const next = pushPull(current.doc, draw.definitionId, draw.faceId, distance);
        setPreview(next);
        report(formatLength(distance, current.unit));
        return;
      }
      if (draw && (draw.kind === 'rect' || draw.kind === 'circle' || draw.kind === 'line')) {
        const world = worldMatrixOfPath(current.doc, current.editingPath);
        const ray = localRay(event, world);
        const raw = rayPlane(ray.origin, ray.dir, draw.plane.origin, draw.plane.normal);
        if (!raw) return;
        let point = snapPoint(raw, draw.plane, event, world);
        if (draw.kind === 'line' && draw.points.length) {
          if (!snapNote) point = lockAxis(draw.points[draw.points.length - 1], point, draw.plane);
          setRubber(toWorld(current, [...draw.points, point]));
          report(tagged(formatLength(length(sub(point, draw.points[draw.points.length - 1])), current.unit)));
          return;
        }
        if (draw.kind === 'rect' || draw.kind === 'circle') {
          if (Math.hypot(event.clientX - draw.x, event.clientY - draw.y) > 5) draw.moved = true;
          if (draw.kind === 'rect') {
            const du = dot(sub(point, draw.origin), draw.plane.u);
            const dv = dot(sub(point, draw.origin), draw.plane.v);
            setRubber(toWorld(current, rectanglePoints(draw.origin, draw.plane.u, draw.plane.v, du, dv).concat([draw.origin])));
            report(tagged(`${formatLength(Math.abs(du), current.unit)} × ${formatLength(Math.abs(dv), current.unit)}`));
          } else {
            const radius = length(sub(point, draw.origin));
            const ring = circleRing(draw.origin, draw.plane, radius);
            setRubber(toWorld(current, ring));
            report(tagged(`반지름 ${formatLength(radius, current.unit)}`));
          }
        }
        return;
      }
      if (current.tool === 'line' || current.tool === 'rect' || current.tool === 'circle' || current.tool === 'arc') {
        const hit = infer(event);
        showSnap(hit);
        report(hit ? SNAP_LABEL[hit.kind] : '');
      } else {
        snapMarker.visible = false;
      }
      const picked = pick(event);
      const data = picked?.data ?? null;
      if (data?.pick && data.faceId && data.path && hitKind(data.path)) {
        setHover((prev) =>
          prev &&
          prev.faceId === data.faceId &&
          prev.definitionId === data.definitionId &&
          samePath(prev.path ?? [], data.path ?? [])
            ? prev
            : data,
        );
      } else setHover((prev) => (prev ? null : prev));
    };

    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size > 0) return;
      if (propsRef.current.tool === 'walk') {
        walkLook.current = null;
        el.style.cursor = 'crosshair';
        return;
      }
      if (propsRef.current.tool === 'navigate') el.style.cursor = 'grab';
      if (orbitDrag.current) {
        orbitDrag.current = null;
        el.style.cursor = propsRef.current.tool === 'navigate' ? 'grab' : '';
        return;
      }
      if (selectDrag) {
        const start = selectDrag;
        selectDrag = null;
        hideMarquee();
        const current = propsRef.current;
        const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5;
        if (moved) {
          const hits = objectsInRect(start.x, start.y, event.clientX, event.clientY);
          current.onSelect(start.shift ? mergeSelection(current.selection, hits) : hits);
          return;
        }
        const item = clickedObject(event, start.alt);
        if (!start.shift && !start.alt && item?.kind === 'placement') {
          const key = selectionKey(item);
          const now = performance.now();
          if (lastPick && now - lastPick.t < 320 && lastPick.key === key) {
            current.onEditingPath(item.path);
            current.onSelect([]);
            lastPick = null;
            return;
          }
          lastPick = { t: now, key };
        } else lastPick = null;
        if (!item) {
          if (!start.shift) current.onSelect([]);
          return;
        }
        current.onSelect(start.shift ? toggleSelection(current.selection, item) : [item]);
        return;
      }
      const draw = drawRef.current;
      if (!draw) return;
      if (draw.kind === 'push') {
        const next = previewRef.current;
        setPreview(null);
        drawRef.current = null;
        report('');
        if (next) propsRef.current.onCommit(next);
        return;
      }
      if (draw.kind === 'offset') {
        const distance = draw.distance;
        drawRef.current = null;
        setRubber(null);
        report('');
        const next = offsetFace(propsRef.current.doc, draw.definitionId, draw.faceId, distance);
        if (next) propsRef.current.onCommit(next);
        return;
      }
      if ((draw.kind === 'rect' || draw.kind === 'circle') && draw.moved && Math.hypot(event.clientX - draw.x, event.clientY - draw.y) > 6) {
        const world = worldMatrixOfPath(propsRef.current.doc, propsRef.current.editingPath);
        const ray = localRay(event, world);
        const raw = rayPlane(ray.origin, ray.dir, draw.plane.origin, draw.plane.normal);
        if (!raw) return;
        commitDraw(snapPoint(raw, draw.plane, event, world));
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (propsRef.current.tool === 'walk') return;
      if (drawRef.current || previewRef.current || measureLockRef.current) {
        drawRef.current = null;
        setPreview(null);
        setRubber(null);
        measureLockRef.current = null;
        setMeasureLock(null);
        snapMarker.visible = false;
        report('');
        return;
      }
      snapMarker.visible = false;
      propsRef.current.onEscape();
    };

    const pointers = new Set<number>();
    const down = (event: PointerEvent) => {
      pointers.add(event.pointerId);
      if (pointers.size > 1) {
        drawRef.current = null;
        setPreview(null);
        setRubber(null);
        walkLook.current = null;
        return;
      }
      if (event.button !== 0) return;
      if (propsRef.current.tool === 'walk') {
        walkLook.current = { x: event.clientX, y: event.clientY };
        el.style.cursor = 'grabbing';
        return;
      }
      if (propsRef.current.tool === 'navigate') el.style.cursor = 'grabbing';
      queueMicrotask(() => {
        const gizmo = gizmoRef.current as unknown as { dragging?: boolean; axis?: string | null } | null;
        if (gizmo?.dragging || gizmo?.axis) return;
        onDown(event);
      });
    };
    const onLeave = () => {
      snapMarker.visible = false;
      walkLook.current = null;
    };
    const onWalkKey = (event: KeyboardEvent) => {
      if (propsRef.current.tool !== 'walk') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const down = event.type === 'keydown';
      if (event.key === 'Shift') {
        walkKeys.current.fast = down;
        return;
      }
      const key = event.key.toLowerCase();
      const slot =
        key === 'w' || key === 'arrowup' ? 'f'
        : key === 's' || key === 'arrowdown' ? 'b'
        : key === 'a' || key === 'arrowleft' ? 'l'
        : key === 'd' || key === 'arrowright' ? 'r'
        : null;
      if (!slot) return;
      event.preventDefault();
      walkKeys.current[slot] = down;
    };
    const onCancel = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      walkLook.current = null;
      if (pointers.size > 0) return;
      selectDrag = null;
      hideMarquee();
      drawRef.current = null;
      setPreview(null);
      setRubber(null);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('pointerleave', onLeave);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onWalkKey);
    window.addEventListener('keyup', onWalkKey);
    return () => {
      hideMarquee();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onWalkKey);
      window.removeEventListener('keyup', onWalkKey);
    };
  }, [camera, gl]);

  useEffect(() => {
    const el = gl.domElement;
    el.style.cursor =
      props.tool === 'navigate'
        ? 'grab'
        : props.tool === 'walk' ||
            props.tool === 'measure' ||
            props.tool === 'offset' ||
            props.tool === 'line' ||
            props.tool === 'rect' ||
            props.tool === 'circle' ||
            props.tool === 'arc'
          ? 'crosshair'
          : '';
    if (props.tool === 'navigate' || props.tool === 'walk') setHover(null);
    const cam = camera as PerspectiveCamera;
    if (props.tool === 'walk') {
      cam.fov = WALK_FOV;
      cam.updateProjectionMatrix();
      walkApi.current.begin();
    } else {
      if (Math.abs(cam.fov - MODEL_FOV) > 0.1) {
        cam.fov = MODEL_FOV;
        cam.updateProjectionMatrix();
      }
      routePlay.current = null;
      captureGen.current += 1;
      const recording = recorderRef.current;
      recorderRef.current = null;
      if (recording) recording.finish();
      else {
        hidePlan.current = false;
        props.onRouteDone.current('play', '');
      }
      walkKeys.current = { f: false, b: false, l: false, r: false, fast: false };
      walkLook.current = null;
      walkNudge.current = {
        prev: { f: false, b: false, l: false, r: false },
        releasedAt: { f: 0, b: 0, l: 0, r: 0 },
        passLeft: 0,
        passed: 0,
      };
    };
    if (props.tool !== 'measure') {
      measureLockRef.current = null;
      setMeasureLock(null);
      if (drawRef.current?.kind === 'measure') {
        drawRef.current = null;
        setRubber(null);
      }
    }
    snapMarker.visible = false;
  }, [props.tool, gl]);

  useEffect(() => {
    if (props.tool !== 'walk') {
      eyeApplied.current = props.eyeInches;
      return;
    }
    const delta = props.eyeInches - eyeApplied.current;
    eyeApplied.current = props.eyeInches;
    if (Math.abs(delta) < 1e-3) return;
    camera.position.z += delta;
    walkApi.current.look(0, 0);
  }, [props.eyeInches, props.tool, camera]);

  const applyNumeric = (text: string) => {
    const current = propsRef.current;
    const values = text.trim() ? parseMeasures(text, current.unit) : null;
    const draw = drawRef.current;
    const def = editingDefinition(current.doc, current.editingPath);
    if (current.tool === 'line') {
      if (!values && draw?.kind === 'line' && draw.points.length >= 3) {
        const next = addPolygon(current.doc, def.id, draw.points, current.drawMaterialId, current.activeLayerId);
        if (next) current.onCommit(next);
        drawRef.current = null;
        setRubber(null);
        report('');
      } else if (values && draw?.kind === 'line' && draw.points.length) {
        const origin = draw.points[draw.points.length - 1];
        const point = add(origin, scale(draw.plane.u, values[0]));
        drawRef.current = { ...draw, points: [...draw.points, point] };
        setRubber(toWorld(current, [...draw.points, point]));
      }
      return;
    }
    if (current.tool === 'arc' && draw?.kind === 'arc' && draw.start && values?.length) {
      const sweepDeg = values[0];
      const radius = length(sub(draw.start, draw.center));
      if (radius >= 0.05 && Math.abs(sweepDeg) >= 1 && Math.abs(sweepDeg) <= 360) {
        if (Math.abs(sweepDeg) >= 359) {
          const next = addCircle(current.doc, def.id, draw.center, draw.plane.normal, radius, current.drawMaterialId, current.activeLayerId);
          if (next) current.onCommit(next);
        } else {
          const startAngle = Math.atan2(dot(sub(draw.start, draw.center), draw.plane.v), dot(sub(draw.start, draw.center), draw.plane.u));
          const endAngle = startAngle + (Math.abs(sweepDeg) * Math.PI) / 180;
          const end = add(
            draw.center,
            add(scale(draw.plane.u, Math.cos(endAngle) * radius), scale(draw.plane.v, Math.sin(endAngle) * radius)),
          );
          let loop = sectorPoints(draw.center, draw.plane, draw.start, end);
          if (loop && sweepDeg < 0) loop = [loop[0], ...loop.slice(1).reverse()];
          const next = loop ? addPolygon(current.doc, def.id, loop, current.drawMaterialId, current.activeLayerId) : null;
          if (next) current.onCommit(next);
        }
      }
      drawRef.current = null;
      setRubber(null);
      report('');
      return;
    }
    if (!values) return;
    if ((current.tool === 'rect' || current.tool === 'circle') && draw && (draw.kind === 'rect' || draw.kind === 'circle')) {
      if (draw.kind === 'rect') {
        const du = values[0];
        const dv = values[1] ?? values[0];
        const next = addPolygon(
          current.doc,
          def.id,
          rectanglePoints(draw.origin, draw.plane.u, draw.plane.v, du, dv),
          current.drawMaterialId,
          current.activeLayerId,
        );
        if (next) current.onCommit(next);
      } else if (values[0] > 0) {
        const next = addCircle(current.doc, def.id, draw.origin, draw.plane.normal, values[0], current.drawMaterialId, current.activeLayerId);
        if (next) current.onCommit(next);
      }
      drawRef.current = null;
      setRubber(null);
      report('');
      return;
    }
    if (current.tool === 'offset' && values.length) {
      const faceSel = current.selection.find((item) => item.kind === 'face');
      const faceId = draw?.kind === 'offset' ? draw.faceId : faceSel?.faceId ?? null;
      const definitionId = draw?.kind === 'offset' ? draw.definitionId : faceSel?.definitionId ?? null;
      if (!faceId || !definitionId) return;
      const next = offsetFace(current.doc, definitionId, faceId, values[0]);
      drawRef.current = null;
      setRubber(null);
      setPreview(null);
      if (next) current.onCommit(next);
      report('');
      return;
    }
    if (current.tool === 'pushpull' && values.length) {
      const faceSel = current.selection.find((item) => item.kind === 'face');
      const faceId = draw?.kind === 'push' ? draw.faceId : faceSel?.faceId ?? hover?.faceId;
      const definitionId = draw?.kind === 'push' ? draw.definitionId : faceSel?.definitionId ?? hover?.definitionId;
      if (!faceId || !definitionId) return;
      const next = pushPull(current.doc, definitionId, faceId, values[0]);
      setPreview(null);
      drawRef.current = null;
      if (next) current.onCommit(next);
      report('');
      return;
    }
    if ((current.tool === 'move' || current.tool === 'select') && current.selection.length) {
      const dx = values[0] ?? 0;
      const dy = values[1] ?? 0;
      const dz = values[2] ?? 0;
      let next = current.doc;
      let changed = false;
      for (const item of current.selection) {
        if (item.kind === 'face') {
          const updated = translateInDefinition(next, item.definitionId, item.faceId, [dx, dy, dz]);
          if (updated) {
            next = updated;
            changed = true;
          }
        } else if (item.kind === 'placement') {
          const found = findPlacement(next, item.placementId);
          if (!found) continue;
          const matrix = [...found.parent.placements[found.index].matrix];
          matrix[12] += dx;
          matrix[13] += dy;
          matrix[14] += dz;
          next = setPlacementMatrix(next, item.placementId, matrix);
          changed = true;
        }
      }
      if (changed) current.onCommit(next);
    }
  };

  const beginGizmo = () => {
    const current = propsRef.current;
    const movable = current.selection.filter((item) => item.kind === 'face' || item.kind === 'placement');
    if (!movable.length || !modelRef.current || gizmoDrag.current) return;
    const start = new Matrix4().compose(pivot.position, pivot.quaternion, pivot.scale);
    const ghost = new Group();
    ghost.matrixAutoUpdate = false;
    const hidden: Object3D[] = [];
    modelRef.current.traverse((obj) => {
      const data = obj.userData as PickData;
      for (const sel of movable) {
        if (sel.kind === 'placement') {
          if (data.placementNode === sel.placementId && samePath(data.path ?? [], sel.path)) hidden.push(obj);
          continue;
        }
        if (data.batched && data.definitionId === sel.definitionId && samePath(data.path ?? [], sel.path)) {
          const mesh = obj as Mesh;
          const geometry = faceOverlay(mesh, sel.faceId);
          if (!geometry) continue;
          mesh.updateWorldMatrix(true, true);
          const clone = new Mesh(geometry, mesh.material);
          clone.matrix.copy(mesh.matrixWorld);
          clone.matrixAutoUpdate = false;
          clone.userData.disposeGeometry = true;
          ghost.add(clone);
          continue;
        }
        if (data.faceId === sel.faceId && data.definitionId === sel.definitionId && samePath(data.path ?? [], sel.path)) hidden.push(obj);
      }
    });
    for (const obj of hidden) {
      obj.updateWorldMatrix(true, true);
      obj.traverse((child) => {
        const drawable = child as { isMesh?: boolean; isLineSegments?: boolean; matrixWorld: Matrix4 };
        if (!drawable.isMesh && !drawable.isLineSegments) return;
        child.updateWorldMatrix(true, false);
        const clone = child.clone(false);
        clone.matrix.copy(child.matrixWorld);
        clone.matrixAutoUpdate = false;
        clone.visible = true;
        ghost.add(clone);
      });
      obj.visible = false;
    }
    scene.add(ghost);
    gizmoDrag.current = { start, ghost, hidden };
  };

  const gizmoDelta = () => {
    const drag = gizmoDrag.current;
    if (!drag) return null;
    const end = new Matrix4().compose(pivot.position, pivot.quaternion, pivot.scale);
    const delta = drag.start.clone().invert();
    delta.premultiply(end);
    return delta;
  };

  const moveGhost = () => {
    const drag = gizmoDrag.current;
    const delta = gizmoDelta();
    if (!drag || !delta) return;
    drag.ghost.matrix.copy(delta);
    drag.ghost.matrixWorldNeedsUpdate = true;
  };

  const endGizmo = () => {
    const drag = gizmoDrag.current;
    if (!drag) return;
    const delta = gizmoDelta();
    scene.remove(drag.ghost);
    drag.ghost.traverse((child) => {
      if ((child as Mesh).userData.disposeGeometry) (child as Mesh).geometry.dispose();
    });
    for (const obj of drag.hidden) obj.visible = true;
    gizmoDrag.current = null;
    if (!delta) return;
    const array = delta.toArray();
    if (nearlyIdentity(array)) return;
    const current = propsRef.current;
    let next = current.doc;
    let changed = false;
    for (const item of current.selection) {
      if (item.kind === 'face') {
        const updated = transformFace(next, item.definitionId, item.faceId, array, worldMatrixOfPath(next, item.path));
        if (updated) {
          next = updated;
          changed = true;
        }
      } else if (item.kind === 'placement') {
        const updated = transformPlacement(next, item.path, array);
        if (updated) {
          next = updated;
          changed = true;
        }
      }
    }
    if (changed) current.onCommit(next);
  };

  const showGizmo =
    (props.tool === 'move' || props.tool === 'rotate' || props.tool === 'scale') &&
    props.selection.some((item) => item.kind === 'face' || item.kind === 'placement');
  const gridRef = useRef<GridHelper>(null!);
  if (!gridRef.current) {
    const helper = new GridHelper(2400, 240, 0x8ea0b3, 0xc5d2de);
    helper.rotation.x = Math.PI / 2;
    helper.traverse((obj) => {
      obj.raycast = () => {};
    });
    gridRef.current = helper;
  }
  const axesRef = useRef<AxesHelper>(null!);
  if (!axesRef.current) {
    const helper = new AxesHelper(56);
    helper.traverse((obj) => {
      obj.raycast = () => {};
    });
    axesRef.current = helper;
  }
  const walkScratch = useMemo(
    () => ({ origin: new Vector3(), dir: new Vector3(), dest: new Vector3(), normal: new Vector3() }),
    [],
  );
  {
    const cam = camera as PerspectiveCamera;
    const solidHits = (origin: Vector3, direction: Vector3, far: number) => {
      const root = modelRef.current;
      if (!root) return [] as Intersection[];
      root.updateWorldMatrix(true, true);
      walkRay.set(origin, direction);
      walkRay.near = 0;
      walkRay.far = far;
      return walkRay.intersectObject(root, true).filter((hit) => (hit.object.userData as PickData).pick);
    };
    const upward = (hit: Intersection) => {
      const normal = hit.face?.normal;
      if (!normal) return false;
      return normal.clone().transformDirection(hit.object.matrixWorld).z > 0.55;
    };
    const lowestFloor = (x: number, y: number) => {
      const bounds = modelBounds(propsRef.current.doc);
      const top = (bounds?.max[2] ?? 80) + 48;
      const bottom = bounds?.min[2] ?? 0;
      walkScratch.origin.set(x, y, top);
      walkScratch.dir.set(0, 0, -1);
      let best: number | null = null;
      for (const hit of solidHits(walkScratch.origin, walkScratch.dir, top - bottom + 96)) {
        if (!upward(hit)) continue;
        if (best === null || hit.point.z < best) best = hit.point.z;
      }
      return best ?? bottom;
    };
    const applyLook = () => {
      const pitch = walkPitch.current;
      const cos = Math.cos(pitch);
      walkScratch.dir.set(Math.sin(walkYaw.current) * cos, Math.cos(walkYaw.current) * cos, Math.sin(pitch));
      cam.up.set(0, 0, 1);
      walkScratch.dest.copy(cam.position).add(walkScratch.dir);
      cam.lookAt(walkScratch.dest);
      const controls = controlsRef.current;
      if (controls) controls.target.copy(cam.position).addScaledVector(walkScratch.dir, 120);
    };
    const step = (dx: number, dy: number, dz: number) => {
      cam.position.x += dx;
      cam.position.y += dy;
      cam.position.z += dz;
      applyLook();
    };
    const wallDistance = (dx: number, dy: number, reach: number) => {
      const len = Math.hypot(dx, dy);
      if (len < 1e-6 || reach <= 0) return null;
      walkScratch.dir.set(dx / len, dy / len, 0);
      let nearest: number | null = null;
      for (const drop of [0, 32]) {
        walkScratch.origin.set(cam.position.x, cam.position.y, cam.position.z - drop);
        for (const hit of solidHits(walkScratch.origin, walkScratch.dir, reach)) {
          const normal = hit.face?.normal;
          if (normal) {
            walkScratch.normal.copy(normal).transformDirection(hit.object.matrixWorld);
            if (Math.abs(walkScratch.normal.z) > 0.72) continue;
          }
          if (nearest === null || hit.distance < nearest) nearest = hit.distance;
        }
      }
      return nearest;
    };
    const basis = () => {
      const yaw = walkYaw.current;
      return {
        fx: Math.sin(yaw),
        fy: Math.cos(yaw),
        fz: 0,
        lx: Math.cos(yaw),
        ly: -Math.sin(yaw),
      };
    };
    props.walkHold.current = (dir, down) => {
      walkKeys.current[dir] = down;
    };
    walkApi.current = {
      begin() {
        const controls = controlsRef.current;
        const focus = controls ? controls.target : cam.position;
        const facing = new Vector3();
        cam.getWorldDirection(facing);
        walkYaw.current = Math.atan2(facing.x, facing.y);
        walkPitch.current = -0.08;
        const eye = propsRef.current.eyeInches;
        const here = lowestFloor(cam.position.x, cam.position.y) + eye;
        if (Math.abs(cam.position.z - here) < 48) cam.position.z = here;
        else cam.position.set(focus.x, focus.y, lowestFloor(focus.x, focus.y) + eye);
        eyeApplied.current = eye;
        cam.near = 0.45;
        cam.far = 250000;
        cam.updateProjectionMatrix();
        orbitHandle.visible = false;
        applyLook();
      },
      look(dx, dy) {
        walkYaw.current -= dx * 0.0042;
        walkPitch.current = Math.max(-1.15, Math.min(1.15, walkPitch.current + dy * 0.0034));
        applyLook();
      },
      step,
      basis,
      wallDistance,
      stand(x: number, y: number, yaw?: number) {
        if (yaw != null) {
          walkYaw.current = yaw;
          walkPitch.current = -0.08;
        }
        const eye = propsRef.current.eyeInches;
        cam.position.x = x;
        cam.position.y = y;
        cam.position.z = lowestFloor(x, y) + eye;
        eyeApplied.current = eye;
        applyLook();
      },
    };
  }

  const routeMark = useMemo(() => {
    const group = new Group();
    group.layers.set(2);
    group.frustumCulled = false;
    const line = new ThreeLine(new BufferGeometry(), new LineBasicMaterial({ color: 0xd4533c, depthTest: false }));
    line.layers.set(2);
    line.frustumCulled = false;
    line.renderOrder = 55;
    group.add(line);
    return group;
  }, []);
  const routeDot = useMemo(() => new SphereGeometry(1, 10, 8), []);
  const routeDotMat = useMemo(() => new MeshBasicMaterial({ color: 0xd4533c, depthTest: false }), []);
  useLayoutEffect(() => {
    const line = routeMark.children[0] as ThreeLine;
    const positions: number[] = [];
    for (const point of props.route) positions.push(point.x, point.y, 8);
    line.geometry.setAttribute('position', new Float32BufferAttribute(positions.length ? positions : [0, 0, 0], 3));
    line.geometry.computeBoundingSphere();
    line.visible = props.route.length >= 2;
    for (let index = routeMark.children.length - 1; index >= 1; index--) routeMark.children[index].removeFromParent();
    for (const point of props.route) {
      const dot = new Mesh(routeDot, routeDotMat);
      dot.position.set(point.x, point.y, 8);
      dot.layers.set(2);
      dot.frustumCulled = false;
      dot.userData.routeDot = true;
      routeMark.add(dot);
    }
  }, [props.route, routeMark, routeDot, routeDotMat]);

  useEffect(() => {
    const command = props.routeCommand;
    if (!command || propsRef.current.tool !== 'walk') return;
    const points = routeRef.current;
    if (points.length < 2) {
      props.onRouteDone.current('error', '점을 두 개 이상 찍어 주세요.');
      return;
    }
    const yaw = Math.atan2(points[1].x - points[0].x, points[1].y - points[0].y);
    walkApi.current.stand(points[0].x, points[0].y, yaw);
    const record = command.kind === 'record';
    if (!record) {
      routePlay.current = { distance: 0, active: true, warmup: 0, hold: 0, record: false };
      return;
    }
    const canvas = gl.domElement;
    const id = ++captureGen.current;
    hidePlan.current = true;
    props.onRecording.current(true);
    void beginMp4Capture(canvas, (blob, error) => {
      hidePlan.current = false;
      recorderRef.current = null;
      props.onRecording.current(false);
      if (!blob) {
        props.onRouteDone.current('error', error || '동영상 프레임을 만들지 못했습니다.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${propsRef.current.doc.name || 'walk'}-walk.mp4`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      props.onRouteDone.current('saved', '동영상을 MP4로 저장했습니다.');
    }).then((capture) => {
      if (!capture || captureGen.current !== id || propsRef.current.tool !== 'walk') {
        capture?.discard();
        if (captureGen.current === id) {
          routePlay.current = null;
          hidePlan.current = false;
          props.onRecording.current(false);
        }
        return;
      }
      recorderRef.current = capture;
      routePlay.current = { distance: 0, active: true, warmup: 0.2, hold: 0, record: true };
    });
  }, [props.routeCommand, gl]);

  useFrame((_, delta) => {
    const markScale = Math.max(propsRef.current.planMetrics.current.halfY * 0.018, 1.4);
    for (const child of routeMark.children) {
      if (child.userData.routeDot) child.scale.setScalar(markScale);
    }
    const playing = props.tool === 'walk' ? routePlay.current : null;
    if (playing?.active) {
      orbitHandle.visible = false;
      const dt = Math.min(delta, 0.05);
      if (playing.warmup > 0) playing.warmup -= dt;
      else {
        playing.distance += ROUTE_SPEED * dt;
        const sample = sampleRoute(routeRef.current, playing.distance);
        walkApi.current.stand(sample.x, sample.y);
        if (sample.done) {
          playing.hold += dt;
          if (playing.hold > 0.7) {
            const recorded = playing.record;
            routePlay.current = null;
            const rec = recorderRef.current;
            recorderRef.current = null;
            if (recorded && rec) rec.finish();
            else props.onRouteDone.current('play', '경로를 끝까지 걸었습니다.');
          }
        }
      }
    } else if (props.tool === 'walk') {
      orbitHandle.visible = false;
      const keys = walkKeys.current;
      const speed = (keys.fast ? WALK_SPEED * 2.6 : WALK_SPEED) * Math.min(delta, 0.05);
      const { fx, fy, lx, ly } = walkApi.current.basis();
      let mx = 0;
      let my = 0;
      if (keys.f) { mx += fx; my += fy; }
      if (keys.b) { mx -= fx; my -= fy; }
      if (keys.l) { mx -= lx; my -= ly; }
      if (keys.r) { mx += lx; my += ly; }
      const nudge = walkNudge.current;
      const now = performance.now();
      const heading = { f: [fx, fy], b: [-fx, -fy], l: [-lx, -ly], r: [lx, ly] } as const;
      for (const slot of ['f', 'b', 'l', 'r'] as const) {
        const down = keys[slot];
        if (down && !nudge.prev[slot]) {
          const [hx, hy] = heading[slot];
          const ahead = walkApi.current.wallDistance(hx, hy, WALK_BODY + 8);
          if (ahead != null && ahead <= WALK_BODY + 8 && now - nudge.releasedAt[slot] <= WALK_PASS_GAP) {
            nudge.passLeft = WALK_PASS_INCHES;
            nudge.passed = 0;
          }
        }
        if (!down && nudge.prev[slot]) nudge.releasedAt[slot] = now;
        nudge.prev[slot] = down;
      }
      const mag = Math.hypot(mx, my);
      if (mag > 0) {
        let dist = speed;
        if (nudge.passLeft > 0) {
          dist = Math.min(dist, nudge.passLeft);
          nudge.passLeft -= dist;
          nudge.passed += dist;
          if (nudge.passed > 14) {
            const clear = walkApi.current.wallDistance(mx, my, WALK_BODY + 16);
            if (clear == null || clear > WALK_BODY + 10) nudge.passLeft = 0;
          }
        } else {
          const ahead = walkApi.current.wallDistance(mx, my, WALK_BODY + dist + 2);
          if (ahead != null) {
            const allowed = ahead - WALK_BODY;
            dist = allowed <= 0.35 ? 0 : Math.min(dist, allowed);
          }
        }
        walkApi.current.step((mx / mag) * dist, (my / mag) * dist, 0);
      } else walkApi.current.step(0, 0, 0);
    } else orbitHandle.visible = true;
    const controls = controlsRef.current;
    const aim = propsRef.current.planAim.current;
    if (aim && aim.seq !== planAimSeq.current && !routePlay.current?.active) {
      planAimSeq.current = aim.seq;
      const cam = camera as PerspectiveCamera;
      if (props.tool === 'walk' || aim.eye) {
        const dx = aim.x - cam.position.x;
        const dy = aim.y - cam.position.y;
        cam.position.x = aim.x;
        cam.position.y = aim.y;
        if (props.tool === 'walk') walkApi.current.look(0, 0);
        else if (controls) {
          controls.target.x += dx;
          controls.target.y += dy;
          controls.update();
        }
      } else if (controls) {
        const dx = aim.x - controls.target.x;
        const dy = aim.y - controls.target.y;
        controls.target.x = aim.x;
        controls.target.y = aim.y;
        cam.position.x += dx;
        cam.position.y += dy;
        controls.update();
      }
    }
    if (!propsRef.current.planAiming.current && propsRef.current.planAnchor.current) {
      const anchor = propsRef.current.planAnchor.current;
      if (props.tool === 'walk') {
        propsRef.current.planPan.current.x += anchor.x - camera.position.x;
        propsRef.current.planPan.current.y += anchor.y - camera.position.y;
      }
      propsRef.current.planAnchor.current = null;
    }
    if (!controls) return;
    orbitHandle.position.copy(controls.target);
    const anchor = props.placeAnchorRef;
    if (!anchor.current) anchor.current = [0, 0, 0];
    anchor.current[0] = controls.target.x;
    anchor.current[1] = controls.target.y;
    anchor.current[2] = controls.target.z;
    const distance = camera.position.distanceTo(controls.target);
    orbitHandle.scale.setScalar(Math.max(distance * 0.05, 0.4));
    if (snapMarker.visible) {
      const snapDistance = camera.position.distanceTo(snapMarker.position);
      snapMarker.scale.setScalar(Math.max(snapDistance * 0.035, 0.25));
    }
  });

  return (
    <>
      <primitive object={gridRef.current} />
      <primitive object={axesRef.current} />
      <primitive object={orbitHandle} />
      <primitive object={routeMark} />
      <primitive object={snapMarker} />
      <primitive ref={modelRef} object={built.group} />
      <primitive object={pivot} />
      {(props.doc.dimensions ?? []).map((dimension) => {
        const selected = props.selection.some((item) => item.kind === 'dimension' && item.dimensionId === dimension.id);
        const mid: Vec3 = [
          (dimension.a[0] + dimension.b[0]) / 2,
          (dimension.a[1] + dimension.b[1]) / 2,
          (dimension.a[2] + dimension.b[2]) / 2,
        ];
        return (
          <group key={dimension.id}>
            <Line points={[dimension.a, dimension.b]} color={selected ? '#0d47a1' : '#1565c0'} lineWidth={selected ? 3 : 2} depthTest={false} />
            <Html position={mid} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
              <span className={selected ? 'dim-label on' : 'dim-label'}>{formatLength(length(sub(dimension.b, dimension.a)), props.unit)}</span>
            </Html>
          </group>
        );
      })}
      {measureLock && <Line points={[measureLock.a, measureLock.b]} color="#1565c0" lineWidth={2} depthTest={false} />}
      {rubber && rubber.length >= 2 && (
        <Line points={rubber} color={props.tool === 'measure' ? '#1565c0' : '#d4533c'} lineWidth={2} depthTest={props.tool === 'measure' ? false : undefined} />
      )}
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enabled={props.tool !== 'walk'}
        enableDamping={false}
        enableZoom={false}
        screenSpacePanning
        mouseButtons={
          props.tool === 'navigate'
            ? { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN }
            : { LEFT: -1 as MOUSE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }
        }
        touches={
          props.tool === 'navigate'
            ? { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }
            : { ONE: -1 as TOUCH, TWO: TOUCH.DOLLY_PAN }
        }
      />
      {showGizmo && (
        <TransformControls
          ref={gizmoRef}
          object={pivot}
          mode={props.tool === 'rotate' ? 'rotate' : props.tool === 'scale' ? 'scale' : 'translate'}
          space="world"
          size={0.85}
          onMouseDown={beginGizmo}
          onObjectChange={moveGhost}
          onMouseUp={endGizmo}
        />
      )}
    </>
  );
}

function toWorld(current: ViewportProps, points: Vec3[]): Vec3[] {
  const matrix = worldMatrixOfPath(current.doc, current.editingPath);
  return points.map((point) => transformPoint(matrix, point));
}

function lockAxis(origin: Vec3, point: Vec3, plane: Plane): Vec3 {
  const delta = sub(point, origin);
  const span = length(delta);
  if (span < 1e-6) return point;
  const axes = [plane.u, plane.v, plane.normal];
  let best = 0;
  let score = 0;
  axes.forEach((axis, index) => {
    const value = Math.abs(dot(normalize(delta), axis));
    if (value > score) {
      score = value;
      best = index;
    }
  });
  if (score < Math.cos((10 * Math.PI) / 180)) return point;
  return add(origin, scale(axes[best], dot(delta, axes[best])));
}

function circleRing(center: Vec3, plane: Plane, radius: number): Vec3[] {
  const points: Vec3[] = [];
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    points.push(add(center, add(scale(plane.u, Math.cos(angle) * radius), scale(plane.v, Math.sin(angle) * radius))));
  }
  return points;
}

function sectionDrawingPlane(
  doc: SketchDocument,
  editingPath: readonly string[],
  section: SectionCut | null,
): { plane: Plane; axis: 0 | 1 | 2; cut: number } | null {
  if (!section) return null;
  const bounds = modelBounds(doc);
  if (!bounds) return null;
  const axis = section.axis === 'x' ? 0 : section.axis === 'y' ? 1 : 2;
  const min = bounds.min[axis];
  const max = bounds.max[axis];
  const span = max - min;
  const cut = min + section.t * (Math.abs(span) < 1e-4 ? 1 : span);
  const origin: Vec3 = [bounds.center[0], bounds.center[1], bounds.center[2]];
  origin[axis] = cut;
  const normal: Vec3 = [0, 0, 0];
  normal[axis] = -1;
  const inverse = invertMat(worldMatrixOfPath(doc, editingPath));
  const localOrigin = transformPoint(inverse, origin);
  const localNormal = transformDir(inverse, normal);
  const basis = planeBasis(localNormal);
  return { plane: { origin: localOrigin, normal: localNormal, u: basis.u, v: basis.v }, axis, cut };
}

function objectUnder(data: PickData | null, editingPath: readonly string[]): Selection | null {
  if (!data?.definitionId || !data.faceId) return null;
  const path = data.path ?? [];
  if (path.length < editingPath.length || !editingPath.every((id, index) => path[index] === id)) return null;
  if (path.length === editingPath.length) {
    return { kind: 'face', definitionId: data.definitionId, faceId: data.faceId, path: [...path] };
  }
  const placementId = path[editingPath.length];
  if (!placementId) return null;
  return { kind: 'placement', placementId, path: path.slice(0, editingPath.length + 1) };
}

function screenBoxOverlaps(points: Vec3[], camera: Camera, rect: DOMRect, x0: number, y0: number, x1: number, y1: number): boolean {
  if (!points.length) return false;
  const projected = new Vector3();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const point of points) {
    projected.set(point[0], point[1], point[2]).project(camera);
    if (projected.z < -1 || projected.z > 1) continue;
    const x = (projected.x * 0.5 + 0.5) * rect.width + rect.left;
    const y = (-projected.y * 0.5 + 0.5) * rect.height + rect.top;
    any = true;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!any) return false;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  return maxX >= left && minX <= right && maxY >= top && minY <= bottom;
}

function selectionCenter(doc: SketchDocument, items: Selection[]): Vec3 | null {
  const centers = items.map((item) => selectionCenterOne(doc, item)).filter((item): item is Vec3 => item !== null);
  if (!centers.length) return null;
  const acc: Vec3 = [0, 0, 0];
  for (const center of centers) {
    acc[0] += center[0];
    acc[1] += center[1];
    acc[2] += center[2];
  }
  return [acc[0] / centers.length, acc[1] / centers.length, acc[2] / centers.length];
}

function selectionCenterOne(doc: SketchDocument, selection: Selection): Vec3 | null {
  if (selection.kind === 'dimension') {
    const dimension = (doc.dimensions ?? []).find((item) => item.id === selection.dimensionId);
    if (!dimension) return null;
    return [(dimension.a[0] + dimension.b[0]) / 2, (dimension.a[1] + dimension.b[1]) / 2, (dimension.a[2] + dimension.b[2]) / 2];
  }
  if (selection.kind === 'edge') {
    const def = getDef(doc, selection.definitionId);
    const edge = def?.edges.find((item) => item.id === selection.edgeId);
    if (!def || !edge) return null;
    const a = def.vertices[edge.a];
    const b = def.vertices[edge.b];
    if (!a || !b) return null;
    return transformPoint(worldMatrixOfPath(doc, selection.path), [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  }
  if (selection.kind === 'face') {
    const def = getDef(doc, selection.definitionId);
    const face = def?.faces.find((item) => item.id === selection.faceId);
    if (!def || !face) return null;
    return transformPoint(worldMatrixOfPath(doc, selection.path), faceCentroid(def, face));
  }
  const found = findPlacement(doc, selection.placementId);
  if (!found) return null;
  const def = getDef(doc, found.parent.placements[found.index].definitionId);
  if (!def) return null;
  const points = definitionLocalPoints(doc, def).map((point) => transformPoint(worldMatrixOfPath(doc, selection.path), point));
  return boundsOfPoints(points)?.center ?? transformPoint(worldMatrixOfPath(doc, selection.path), [0, 0, 0]);
}
