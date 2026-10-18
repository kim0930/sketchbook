export type Vec3 = [number, number, number];
export type RGBA = [number, number, number, number];
export type RGB = [number, number, number];

export type Unit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export type Tool =
  | 'navigate'
  | 'walk'
  | 'select'
  | 'line'
  | 'rect'
  | 'circle'
  | 'arc'
  | 'pushpull'
  | 'move'
  | 'rotate'
  | 'scale'
  | 'paint'
  | 'erase'
  | 'offset'
  | 'measure';

export interface Material {
  id: string;
  name: string;
  color: RGBA;
  /** 0–1, 1 is opaque. */
  opacity: number;
  texture?: {
    mime: string;
    data: Uint8Array;
    /** Texture tile size in inches, when the file recorded one. */
    tileWidth?: number;
    tileHeight?: number;
  };
  isDefault?: boolean;
}

export interface Layer {
  id: string;
  name: string;
  color: RGB;
  visible: boolean;
  isDefault?: boolean;
}

export interface Face {
  id: string;
  outer: number[];
  holes: number[][];
  materialId: string | null;
  layerId: string;
  hidden: boolean;
}

export interface Edge {
  id: string;
  a: number;
  b: number;
  soft: boolean;
  smooth: boolean;
  hidden: boolean;
}

export interface Placement {
  id: string;
  name: string;
  definitionId: string;
  /** Column-major 4×4, SketchUp axes (Z up), inches. */
  matrix: number[];
  materialId: string | null;
  layerId: string;
  hidden: boolean;
}

export interface Definition {
  id: string;
  name: string;
  kind: 'root' | 'definition';
  vertices: Vec3[];
  faces: Face[];
  edges: Edge[];
  placements: Placement[];
}

export interface Dimension {
  id: string;
  a: Vec3;
  b: Vec3;
}

export interface SketchDocument {
  name: string;
  sourceVersion: string;
  materials: Material[];
  layers: Layer[];
  definitions: Definition[];
  rootId: string;
  defaultMaterialId: string;
  defaultLayerId: string;
  /** World-space lengths, in inches. */
  dimensions: Dimension[];
}

export type Selection =
  | { kind: 'face'; definitionId: string; faceId: string; path: string[] }
  | { kind: 'edge'; definitionId: string; edgeId: string; path: string[] }
  | { kind: 'placement'; placementId: string; path: string[] }
  | { kind: 'dimension'; dimensionId: string };

export interface Plane {
  origin: Vec3;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
}
