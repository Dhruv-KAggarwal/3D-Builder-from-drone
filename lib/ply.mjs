// Exact names only. Substring matching silently sizes "uint8" as 4 bytes, which
// corrupts the stride of any PLY written with the numeric type aliases that
// OpenMVS and other tools emit.
const PLY_TYPE_SIZES = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

function plyTypeSize(type) {
  const name = String(type || '').toLowerCase();
  const size = PLY_TYPE_SIZES[name];
  if (!size) throw new Error(`Unsupported PLY property type "${type}".`);
  return size;
}

function readPlyNumber(bytes, offset, type) {
  const name = String(type || '').toLowerCase();
  if (name === 'float' || name === 'float32') return bytes.readFloatLE(offset);
  if (name === 'double' || name === 'float64') return bytes.readDoubleLE(offset);
  if (name === 'int' || name === 'int32') return bytes.readInt32LE(offset);
  if (name === 'uint' || name === 'uint32') return bytes.readUInt32LE(offset);
  if (name === 'short' || name === 'int16') return bytes.readInt16LE(offset);
  if (name === 'ushort' || name === 'uint16') return bytes.readUInt16LE(offset);
  if (name === 'uchar' || name === 'uint8') return bytes[offset];
  if (name === 'char' || name === 'int8') return bytes.readInt8(offset);
  return bytes[offset];
}

export function parsePly(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const headerEnd = bytes.indexOf(Buffer.from('end_header'));
  if (headerEnd < 0) throw new Error('PLY header is missing.');
  let headerSize = headerEnd + 'end_header'.length;
  if (bytes[headerSize] === 13) headerSize += 1;
  if (bytes[headerSize] === 10) headerSize += 1;
  const header = bytes.slice(0, headerEnd).toString('ascii');
  const vertexCount = Number((header.match(/element vertex\s+(\d+)/) || [])[1] || 0);
  const faceCount = Number((header.match(/element face\s+(\d+)/) || [])[1] || 0);
  const binary = /format binary_little_endian/i.test(header);
  const headerLines = header.split(/\r?\n/);
  const properties = [];
  let faceProperty = { countType: 'uchar', indexType: 'int' };
  let collecting = false;
  let collectingFaces = false;
  for (const line of headerLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('element vertex')) {
      collecting = true;
      collectingFaces = false;
    } else if (trimmed.startsWith('element face')) {
      collecting = false;
      collectingFaces = true;
    } else if (trimmed.startsWith('element ')) {
      collecting = false;
      collectingFaces = false;
    } else if (collecting && trimmed.startsWith('property ')) {
      const parts = trimmed.split(/\s+/);
      if (parts[1] === 'list') properties.push({ type: `list ${parts[2]} ${parts[3]}`, name: parts[4] });
      else properties.push({ type: parts[1], name: parts[2] });
    } else if (collectingFaces && trimmed.startsWith('property list')) {
      const parts = trimmed.split(/\s+/);
      faceProperty = { countType: parts[2], indexType: parts[3] };
    }
  }

  const positions = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  let hasColor = false;
  let hasNormal = false;

  if (binary) {
    let offset = headerSize;
    for (let i = 0; i < vertexCount; i += 1) {
      const index = i * 3;
      for (const property of properties) {
        if (String(property.type).startsWith('list ')) {
          const count = bytes.readUInt8(offset);
          offset += 1 + count * 4;
          continue;
        }
        if (property.name === 'x') positions[index] = bytes.readFloatLE(offset);
        else if (property.name === 'y') positions[index + 1] = bytes.readFloatLE(offset);
        else if (property.name === 'z') positions[index + 2] = bytes.readFloatLE(offset);
        else if (property.name === 'nx') {
          normals[index] = bytes.readFloatLE(offset);
          hasNormal = true;
        } else if (property.name === 'ny') normals[index + 1] = bytes.readFloatLE(offset);
        else if (property.name === 'nz') normals[index + 2] = bytes.readFloatLE(offset);
        else if (property.name === 'red' || property.name === 'r' || property.name === 'diffuse_red') {
          colors[index] = property.type.includes('float') ? Math.round(bytes.readFloatLE(offset) * 255) : bytes[offset];
          hasColor = true;
        } else if (property.name === 'green' || property.name === 'g' || property.name === 'diffuse_green') {
          colors[index + 1] = property.type.includes('float') ? Math.round(bytes.readFloatLE(offset) * 255) : bytes[offset];
        } else if (property.name === 'blue' || property.name === 'b' || property.name === 'diffuse_blue') {
          colors[index + 2] = property.type.includes('float') ? Math.round(bytes.readFloatLE(offset) * 255) : bytes[offset];
        }
        offset += plyTypeSize(property.type);
      }
    }
    const faces = new Uint32Array(Math.max(0, faceCount) * 3);
    const countSize = plyTypeSize(faceProperty.countType);
    const indexSize = plyTypeSize(faceProperty.indexType);
    let write = 0;
    for (let i = 0; i < faceCount; i += 1) {
      const count = readPlyNumber(bytes, offset, faceProperty.countType);
      offset += countSize;
      let first = 0;
      let prev = 0;
      for (let j = 0; j < count; j += 1) {
        const index = readPlyNumber(bytes, offset, faceProperty.indexType);
        offset += indexSize;
        if (j === 0) first = index;
        else if (j === 1) prev = index;
        else if (write + 3 <= faces.length) {
          faces[write] = first;
          faces[write + 1] = prev;
          faces[write + 2] = index;
          write += 3;
          prev = index;
        }
      }
    }
    return {
      positions,
      colors: hasColor ? colors : null,
      normals: hasNormal ? normals : null,
      indices: write ? faces.subarray(0, write) : null,
      vertexCount,
    };
  }

  const text = bytes.slice(headerSize).toString('ascii').split(/\r?\n/);
  const faces = [];
  for (let i = 0; i < vertexCount; i += 1) {
    const parts = (text[i] || '').trim().split(/\s+/);
    const map = {};
    properties.forEach((property, index) => { map[property.name] = parts[index]; });
    positions[i * 3] = Number(map.x);
    positions[i * 3 + 1] = Number(map.y);
    positions[i * 3 + 2] = Number(map.z);
    if (map.nx != null) {
      hasNormal = true;
      normals[i * 3] = Number(map.nx);
      normals[i * 3 + 1] = Number(map.ny);
      normals[i * 3 + 2] = Number(map.nz);
    }
    if (map.red != null || map.r != null) {
      hasColor = true;
      colors[i * 3] = Number(map.red ?? map.r);
      colors[i * 3 + 1] = Number(map.green ?? map.g);
      colors[i * 3 + 2] = Number(map.blue ?? map.b);
    }
  }
  for (let i = 0; i < faceCount; i += 1) {
    const parts = (text[vertexCount + i] || '').trim().split(/\s+/).map(Number);
    const count = parts[0];
    const verts = parts.slice(1, 1 + count);
    for (let j = 1; j < verts.length - 1; j += 1) faces.push(verts[0], verts[j], verts[j + 1]);
  }
  return {
    positions,
    colors: hasColor ? colors : null,
    normals: hasNormal ? normals : null,
    indices: faces.length ? new Uint32Array(faces) : null,
    vertexCount,
  };
}

export function writeBinaryPly(positions, colors, indices) {
  const vertexCount = positions.length / 3;
  const faceCount = indices ? indices.length / 3 : 0;
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${vertexCount}`,
    'property float x',
    'property float y',
    'property float z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    ...(faceCount ? [`element face ${faceCount}`, 'property list uchar int vertex_indices'] : []),
    'end_header\n',
  ].join('\n');
  const headerBuf = Buffer.from(header);
  const body = Buffer.alloc(vertexCount * 15 + faceCount * 13);
  let offset = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    body.writeFloatLE(positions[i * 3], offset);
    body.writeFloatLE(positions[i * 3 + 1], offset + 4);
    body.writeFloatLE(positions[i * 3 + 2], offset + 8);
    body[offset + 12] = colors ? colors[i * 3] : 160;
    body[offset + 13] = colors ? colors[i * 3 + 1] : 160;
    body[offset + 14] = colors ? colors[i * 3 + 2] : 160;
    offset += 15;
  }
  if (indices) {
    for (let i = 0; i < indices.length; i += 3) {
      body[offset] = 3;
      body.writeUInt32LE(indices[i], offset + 1);
      body.writeUInt32LE(indices[i + 1], offset + 5);
      body.writeUInt32LE(indices[i + 2], offset + 9);
      offset += 13;
    }
  }
  return Buffer.concat([headerBuf, body.subarray(0, offset)]);
}
