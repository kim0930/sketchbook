import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls, TransformControls } from '@react-three/drei';
import {
  AxesHelper,
  BufferGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MOUSE,
  Object3D,
  PerspectiveCamera,
  Plane as ThreePlane,
  SphereGeometry,
  Raycaster,
  Vector2,
  Vector3,
  type Intersection,
} from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { TransformControls as TransformControlsImpl } from 'three-stdlib';
import {
  addCircle,
  addPolygon,
  deleteFace,
  deletePlacement,
  editingDefinition,
  faceCentroid,
  getDef,
  groundPlane,
  modelBounds,
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
import {
  add,
  closestLineParam,
  dot,
  faceNormal,
  formatLength,
  identity,
  invertMat,
  length,
  normalize,
  parseMeasures,
  planeFromPoints,
  rayPlane,
  scale,
  sub,
  transformPoint,
} from '../model/math.ts';
import type { Plane, Selection, SketchDocument, Tool, Unit, Vec3 } from '../model/types.ts';
import { buildModel, disposeModel } from '../scene/buildScene.ts';

export interface ViewportProps {
  doc: SketchDocument;
  tool: Tool;
  selection: Selection | null;
  editingPath: string[];
  drawMaterialId: string | null;
  activeLayerId: string;
  unit: Unit;
  snapInches: number;
  viewToken: number;
  viewCommand: { id: number; type: 'fit' | 'pivot' | 'iso' | 'top' | 'front' | 'right' } | null;
  numericRequest: { id: number; text: string } | null;
  onSelect: (selection: Selection | null) => void;
  onEditingPath: (path: string[]) => void;
  onCommit: (doc: SketchDocument) => void;
  onLiveMeasure: (text: string) => void;
  onEscape: () => void;
}

type Draw =
  | { kind: 'rect' | 'circle'; origin: Vec3; plane: Plane; x: number; y: number; moved: boolean }
  | { kind: 'line'; points: Vec3[]; plane: Plane }
  | { kind: 'push'; faceId: string; definitionId: string; path: string[]; anchor: Vec3; normal: Vec3; scale: number; start: number };

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

export function Viewport(props: ViewportProps) {
  return (
    <div
      className="viewport"
      onContextMenu={(event) => event.preventDefault()}
    >
      <Canvas
        camera={{ fov: 42, near: 0.05, far: 500000, position: [190, -210, 130] }}
        gl={{ antialias: true, logarithmicDepthBuffer: true }}
        onCreated={({ camera }) => {
          camera.up.set(0, 0, 1);
        }}
      >
        <color attach="background" args={['#d7e3ee']} />
        <hemisphereLight args={['#f5f9fc', '#eadfce', 0.78]} position={[0, 0, 200]} />
        <directionalLight position={[220, -280, 360]} intensity={1.2} />
        <ambientLight intensity={0.22} />
        <EditorScene {...props} />
      </Canvas>
    </div>
  );
}

function EditorScene(props: ViewportProps) {
  const { camera, gl, scene } = useThree();
  const propsRef = useRef(props);
  propsRef.current = props;
  const [preview, setPreview] = useState<SketchDocument | null>(null);
  const [rubber, setRubber] = useState<Vec3[] | null>(null);
  const [hover, setHover] = useState<PickData | null>(null);
  const previewRef = useRef<SketchDocument | null>(null);
  previewRef.current = preview;
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
    });
    group.add(markerAxes);
    return group;
  }, []);
  const gizmoDrag = useRef<{ start: Matrix4; ghost: Group; hidden: Object3D[] } | null>(null);
  const measureRef = useRef('');
  const shown = preview ?? props.doc;
  const built = useMemo(() => buildModel(shown), [shown]);
  const selectedMat = useMemo(
    () =>
      new MeshLambertMaterial({
        color: 0xc5daff,
        emissive: 0x2f62d6,
        emissiveIntensity: 0.45,
        side: 2,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    [],
  );
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
    const overlays: Mesh[] = [];
    built.group.traverse((obj) => {
      const data = obj.userData as PickData;
      if (!data.pick || !(obj as Mesh).isMesh) return;
      const mesh = obj as Mesh;
      const sameDef = (id: string | undefined, path: string[] | undefined) =>
        id === data.definitionId && samePath(data.path ?? [], path ?? []);
      const selected = props.selection?.kind === 'face' && sameDef(props.selection.definitionId, props.selection.path);
      const hovered = !selected && hover != null && sameDef(hover.definitionId, hover.path);
      if (data.batched) {
        const faceId = selected && props.selection?.kind === 'face' ? props.selection.faceId : hovered ? hover?.faceId : undefined;
        if (!faceId) return;
        const geometry = faceOverlay(mesh, faceId);
        if (!geometry) return;
        const overlay = new Mesh(geometry, selected ? selectedMat : hoverMat);
        overlay.raycast = () => {};
        mesh.add(overlay);
        overlays.push(overlay);
        return;
      }
      const faceSelected = selected && props.selection?.kind === 'face' && props.selection.faceId === data.faceId;
      const faceHovered = hovered && hover?.faceId === data.faceId;
      mesh.material = faceSelected ? selectedMat : faceHovered ? hoverMat : (data.baseMaterial as MeshLambertMaterial);
    });
    return () => {
      for (const overlay of overlays) {
        overlay.removeFromParent();
        overlay.geometry.dispose();
      }
    };
  }, [built, props.selection, hover, selectedMat, hoverMat]);

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

    const snapPoint = (point: Vec3, plane: Plane, event: PointerEvent, world: number[]) => {
      const def = editingDefinition(propsRef.current.doc, propsRef.current.editingPath);
      let best: Vec3 | null = null;
      let bestD = 15 * 15;
      const rect = el.getBoundingClientRect();
      const vertices = def.vertices.length > 8000 ? [] : def.vertices;
      for (const vertex of vertices) {
        const worldPoint = transformPoint(world, vertex);
        const projected = new Vector3(...worldPoint).project(camera);
        const sx = (projected.x * 0.5 + 0.5) * rect.width + rect.left;
        const sy = (-projected.y * 0.5 + 0.5) * rect.height + rect.top;
        const dx = sx - event.clientX;
        const dy = sy - event.clientY;
        const dist = dx * dx + dy * dy;
        if (dist < bestD) {
          bestD = dist;
          best = vertex;
        }
      }
      if (best) return best;
      const step = propsRef.current.snapInches;
      if (step <= 0) return point;
      const delta = sub(point, plane.origin);
      const u = Math.round(dot(delta, plane.u) / step) * step;
      const v = Math.round(dot(delta, plane.v) / step) * step;
      return add(plane.origin, add(scale(plane.u, u), scale(plane.v, v)));
    };

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
      const raw = rayPlane(ray.origin, ray.dir, plane.origin, plane.normal);
      if (!raw) return null;
      return { plane, point: snapPoint(raw, plane, event, world) };
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

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (grabOrbit(event)) return;
      const current = propsRef.current;
      const tool = current.tool;
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
      const picked = pick(event);
      if (!picked) {
        if (tool === 'select') current.onSelect(null);
        return;
      }
      const { hit, data } = picked;
      const path = data.path ?? [];
      const kind = hitKind(path);
      if (!kind || !data.faceId || !data.definitionId) {
        if (tool === 'select') current.onSelect(null);
        return;
      }
      const now = performance.now();
      const key = `${path.join('/')}:${data.faceId}`;
      const last = (onDown as { last?: { t: number; key: string } }).last;
      const double = Boolean(last && now - last.t < 320 && last.key === key);
      (onDown as { last?: { t: number; key: string } }).last = { t: now, key };
      if (tool === 'select' && double && kind === 'group') {
        const index = current.editingPath.length === 0 ? 0 : current.editingPath.length;
        current.onEditingPath(path.slice(0, index + 1));
        current.onSelect(null);
        return;
      }
      if (tool === 'select' || tool === 'move' || tool === 'rotate' || tool === 'scale') {
        if (kind === 'face') {
          current.onSelect({ kind: 'face', definitionId: data.definitionId, faceId: data.faceId, path: [...path] });
        } else {
          const index = current.editingPath.length === 0 ? 0 : current.editingPath.length;
          const placementId = path[index];
          if (placementId) current.onSelect({ kind: 'placement', placementId, path: path.slice(0, index + 1) });
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
          current.onSelect(null);
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
      if (moveOrbit(event)) {
        el.style.cursor = 'grabbing';
        return;
      }
      const current = propsRef.current;
      const draw = drawRef.current;
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
          point = lockAxis(draw.points[draw.points.length - 1], point, draw.plane);
          setRubber(toWorld(current, [...draw.points, point]));
          report(formatLength(length(sub(point, draw.points[draw.points.length - 1])), current.unit));
          return;
        }
        if (draw.kind === 'rect' || draw.kind === 'circle') {
          if (Math.hypot(event.clientX - draw.x, event.clientY - draw.y) > 5) draw.moved = true;
          if (draw.kind === 'rect') {
            const du = dot(sub(point, draw.origin), draw.plane.u);
            const dv = dot(sub(point, draw.origin), draw.plane.v);
            setRubber(toWorld(current, rectanglePoints(draw.origin, draw.plane.u, draw.plane.v, du, dv).concat([draw.origin])));
            report(`${formatLength(Math.abs(du), current.unit)} × ${formatLength(Math.abs(dv), current.unit)}`);
          } else {
            const radius = length(sub(point, draw.origin));
            const ring = circleRing(draw.origin, draw.plane, radius);
            setRubber(toWorld(current, ring));
            report(`반지름 ${formatLength(radius, current.unit)}`);
          }
        }
        return;
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
      if (orbitDrag.current) {
        orbitDrag.current = null;
        el.style.cursor = '';
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
      if (drawRef.current || previewRef.current) {
        drawRef.current = null;
        setPreview(null);
        setRubber(null);
        report('');
        return;
      }
      propsRef.current.onEscape();
    };

    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      queueMicrotask(() => {
        const gizmo = gizmoRef.current as unknown as { dragging?: boolean; axis?: string | null } | null;
        if (gizmo?.dragging || gizmo?.axis) return;
        onDown(event);
      });
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [camera, gl]);

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
    if (current.tool === 'pushpull' && values.length) {
      const faceId = draw?.kind === 'push' ? draw.faceId : current.selection?.kind === 'face' ? current.selection.faceId : hover?.faceId;
      const definitionId =
        draw?.kind === 'push' ? draw.definitionId : current.selection?.kind === 'face' ? current.selection.definitionId : hover?.definitionId;
      if (!faceId || !definitionId) return;
      const next = pushPull(current.doc, definitionId, faceId, values[0]);
      setPreview(null);
      drawRef.current = null;
      if (next) current.onCommit(next);
      report('');
      return;
    }
    if ((current.tool === 'move' || current.tool === 'select') && current.selection) {
      const dx = values[0] ?? 0;
      const dy = values[1] ?? 0;
      const dz = values[2] ?? 0;
      if (current.selection.kind === 'face') {
        const next = translateInDefinition(current.doc, current.selection.definitionId, current.selection.faceId, [dx, dy, dz]);
        if (next) current.onCommit(next);
      } else {
        const found = findPlacement(current.doc, current.selection.placementId);
        if (!found) return;
        const matrix = [...found.parent.placements[found.index].matrix];
        matrix[12] += dx;
        matrix[13] += dy;
        matrix[14] += dz;
        current.onCommit(setPlacementMatrix(current.doc, current.selection.placementId, matrix));
      }
    }
  };

  const beginGizmo = () => {
    const current = propsRef.current;
    if (!current.selection || !modelRef.current || gizmoDrag.current) return;
    const start = new Matrix4().compose(pivot.position, pivot.quaternion, pivot.scale);
    const ghost = new Group();
    ghost.matrixAutoUpdate = false;
    const hidden: Object3D[] = [];
    modelRef.current.traverse((obj) => {
      const data = obj.userData as PickData;
      const sel = current.selection;
      if (!sel) return;
      if (sel.kind === 'placement') {
        if (data.placementNode === sel.placementId && samePath(data.path ?? [], sel.path)) hidden.push(obj);
        return;
      }
      if (data.batched && data.definitionId === sel.definitionId && samePath(data.path ?? [], sel.path)) {
        const mesh = obj as Mesh;
        const geometry = faceOverlay(mesh, sel.faceId);
        if (!geometry) return;
        mesh.updateWorldMatrix(true, true);
        const clone = new Mesh(geometry, mesh.material);
        clone.matrix.copy(mesh.matrixWorld);
        clone.matrixAutoUpdate = false;
        clone.userData.disposeGeometry = true;
        ghost.add(clone);
        return;
      }
      if (data.faceId === sel.faceId && data.definitionId === sel.definitionId && samePath(data.path ?? [], sel.path)) hidden.push(obj);
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
    if (!current.selection) return;
    const next =
      current.selection.kind === 'face'
        ? transformFace(
            current.doc,
            current.selection.definitionId,
            current.selection.faceId,
            array,
            worldMatrixOfPath(current.doc, current.selection.path),
          )
        : transformPlacement(current.doc, current.selection.path, array);
    if (next) current.onCommit(next);
  };

  const showGizmo = (props.tool === 'move' || props.tool === 'rotate' || props.tool === 'scale') && props.selection;
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
  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    orbitHandle.position.copy(controls.target);
    const distance = camera.position.distanceTo(controls.target);
    orbitHandle.scale.setScalar(Math.max(distance * 0.05, 0.4));
  });

  return (
    <>
      <primitive object={gridRef.current} />
      <primitive object={axesRef.current} />
      <primitive object={orbitHandle} />
      <primitive ref={modelRef} object={built.group} />
      <primitive object={pivot} />
      {rubber && rubber.length >= 2 && <Line points={rubber} color="#d4533c" lineWidth={2} />}
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping={false}
        screenSpacePanning
        mouseButtons={{ LEFT: -1 as MOUSE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }}
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

function selectionCenter(doc: SketchDocument, selection: Selection | null): Vec3 | null {
  if (!selection) return null;
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
