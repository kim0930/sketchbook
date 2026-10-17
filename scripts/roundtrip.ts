import { parseSkp } from 'openskp';
import { addPolygon, getRoot, pushPull } from '../src/model/document.ts';
import { exportSkp } from '../src/model/exportSkp.ts';
import { importModel } from '../src/model/importSkp.ts';
import { createEmpty, createStarter } from '../src/model/starter.ts';

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

let doc = createEmpty('박스');
const rootId = getRoot(doc).id;
const drawn = addPolygon(
  doc,
  rootId,
  [
    [0, 0, 0],
    [40, 0, 0],
    [40, 30, 0],
    [0, 30, 0],
  ],
  doc.defaultMaterialId,
  doc.defaultLayerId,
);
if (!drawn) throw new Error('사각형을 만들지 못했습니다.');
doc = drawn;
const faceId = getRoot(doc).faces[0]?.id;
if (!faceId) throw new Error('면이 없습니다.');
const solid = pushPull(doc, rootId, faceId, 20);
if (!solid) throw new Error('밀기/끌기에 실패했습니다.');
doc = solid;
if (getRoot(doc).faces.length !== 6) throw new Error(`육면체가 아닙니다: ${getRoot(doc).faces.length}`);
const heights = getRoot(doc).vertices.map((vertex) => vertex[2]);
const minZ = Math.min(...heights);
const maxZ = Math.max(...heights);
if (Math.abs(minZ) > 1e-6 || Math.abs(maxZ - 20) > 1e-6) throw new Error(`높이 ${minZ}~${maxZ}`);

const exported = exportSkp(doc);
const model = parseSkp(bufferOf(exported.bytes));
const imported = importModel(model, 'box.skp').doc;
const faceCount = imported.definitions.reduce((sum, def) => sum + def.faces.length, 0);
if (faceCount < 6) throw new Error(`다시 읽은 면 수 ${faceCount}`);
const importedRoot = getRoot(imported);
const top = importedRoot.faces
  .map((face) => {
    const z = face.outer.reduce((sum, index) => sum + importedRoot.vertices[index][2], 0) / face.outer.length;
    return { face, z };
  })
  .sort((a, b) => b.z - a.z)[0];
const pulled = pushPull(imported, importedRoot.id, top.face.id, 10);
if (!pulled) throw new Error('가져온 면을 밀지 못했습니다.');
const pulledTop = Math.max(...getRoot(pulled).vertices.map((vertex) => vertex[2]));
if (pulledTop < 29) throw new Error(`가져온 뒤 높이 ${pulledTop}`);

const starter = exportSkp(createStarter());
const starterModel = parseSkp(bufferOf(starter.bytes));
const starterDoc = importModel(starterModel, 'starter.skp').doc;
const starterFaces = starterDoc.definitions.reduce((sum, def) => sum + def.faces.length, 0);
if (starterFaces < 12) throw new Error(`예제 면 수 ${starterFaces}`);

console.log(`ok box=${faceCount} starter=${starterFaces} version=${model.version}`);
