import { computeNormals } from './geometry.mjs';

function pad4(buffer, fill = 0x20) {
  const extra = (4 - (buffer.length % 4)) % 4;
  return extra ? Buffer.concat([buffer, Buffer.alloc(extra, fill)]) : buffer;
}

function accessorMinMax(values, stride) {
  const min = Array(stride).fill(Infinity);
  const max = Array(stride).fill(-Infinity);
  for (let i = 0; i < values.length; i += stride) {
    for (let k = 0; k < stride; k += 1) {
      min[k] = Math.min(min[k], values[i + k]);
      max[k] = Math.max(max[k], values[i + k]);
    }
  }
  return { min, max };
}

function padRgb(rgb) {
  const count = rgb.length / 3;
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function writeGlb(mesh, pointCloud) {
  const chunks = [];
  const views = [];
  const accessors = [];
  const pushBuffer = (data, target = 0, byteStride = 0) => {
    const aligned = pad4(Buffer.from(data.buffer, data.byteOffset, data.byteLength), 0);
    const view = { buffer: 0, byteOffset: chunks.reduce((sum, item) => sum + item.length, 0), byteLength: data.byteLength };
    if (target) view.target = target;
    if (byteStride) view.byteStride = byteStride;
    views.push(view);
    chunks.push(aligned);
    return views.length - 1;
  };

  const meshNormals = computeNormals(mesh.positions, mesh.indices);
  const meshPosStats = accessorMinMax(mesh.positions, 3);
  const colors = padRgb(mesh.colors || new Uint8Array(mesh.positions.length).fill(150));
  const posView = pushBuffer(mesh.positions, 34962);
  const nrmView = pushBuffer(meshNormals, 34962);
  const uvView = pushBuffer(mesh.uvs, 34962);
  const colView = pushBuffer(colors, 34962, 4);
  const idxView = pushBuffer(mesh.indices, 34963);
  accessors.push(
    { bufferView: posView, componentType: 5126, count: mesh.positions.length / 3, type: 'VEC3', min: meshPosStats.min, max: meshPosStats.max },
    { bufferView: nrmView, componentType: 5126, count: mesh.positions.length / 3, type: 'VEC3' },
    { bufferView: uvView, componentType: 5126, count: mesh.uvs.length / 2, type: 'VEC2' },
    { bufferView: colView, byteOffset: 0, componentType: 5121, count: mesh.positions.length / 3, type: 'VEC3', normalized: true },
    { bufferView: idxView, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' },
  );

  const primitives = [{
    attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, COLOR_0: 3 },
    indices: 4,
    material: 0,
    mode: 4,
  }];
  const meshes = [{ name: 'Terrain', primitives }];
  const nodes = [{ name: 'Terrain', mesh: 0 }];

  if (pointCloud?.positions?.length) {
    const cloudPos = accessorMinMax(pointCloud.positions, 3);
    const cloudColors = padRgb(pointCloud.colors || new Uint8Array(pointCloud.positions.length).fill(180));
    const cloudPosView = pushBuffer(pointCloud.positions, 34962);
    const cloudColView = pushBuffer(cloudColors, 34962, 4);
    accessors.push(
      { bufferView: cloudPosView, componentType: 5126, count: pointCloud.positions.length / 3, type: 'VEC3', min: cloudPos.min, max: cloudPos.max },
      { bufferView: cloudColView, componentType: 5121, count: pointCloud.positions.length / 3, type: 'VEC3', normalized: true },
    );
    meshes.push({
      name: 'PhotoPoints',
      primitives: [{ attributes: { POSITION: accessors.length - 2, COLOR_0: accessors.length - 1 }, material: 1, mode: 0 }],
    });
    nodes.push({ name: 'PhotoPoints', mesh: 1 });
  }

  const pbr = { metallicFactor: 0.02, roughnessFactor: 0.92, baseColorFactor: [1, 1, 1, 1] };
  const textured = Boolean(mesh.ortho?.length && mesh.textured !== false);
  const json = {
    asset: { version: '2.0', generator: 'Skyforge single-pass reconstructor' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, index) => index) }],
    nodes,
    meshes,
    materials: [
      {
        name: 'TerrainSurface',
        pbrMetallicRoughness: pbr,
        doubleSided: true,
        extras: { vertexColor: !textured },
      },
      { name: 'PhotoPoints', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } },
    ],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: 0 }],
  };
  if (mesh.ortho?.length) {
    const imageView = pushBuffer(mesh.ortho);
    json.images = [{ bufferView: imageView, mimeType: 'image/png' }];
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
    json.textures = [{ sampler: 0, source: 0 }];
    pbr.baseColorTexture = { index: 0, texCoord: 0 };
  }
  if (textured) {
    delete primitives[0].attributes.COLOR_0;
  }
  json.buffers[0].byteLength = chunks.reduce((sum, item) => sum + item.length, 0);
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json)));
  const binChunk = Buffer.concat(chunks);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  const body = Buffer.concat([jsonHeader, jsonChunk, binHeader, binChunk]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}
