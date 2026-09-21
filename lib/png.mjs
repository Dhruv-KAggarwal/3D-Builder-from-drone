import { deflateSync, inflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

const PNG_CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function unfilterScanlines(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let i = 0; i < stride; i += 1) {
      const value = raw[src + i];
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = y > 0 && i >= channels ? out[prev + i - channels] : 0;
      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + a;
      else if (filter === 2) restored = value + b;
      else if (filter === 3) restored = value + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        restored = value + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
      } else throw new Error(`Unsupported PNG filter type ${filter}.`);
      out[dst + i] = restored & 0xff;
    }
  }
  return out;
}

/**
 * Minimal reader for the 8-bit non-interlaced PNGs this project writes, so the
 * offline renderer can sample a baked texture without a browser or a native
 * image library.
 */
export function decodePng(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error('Interlaced PNGs are not supported.');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8) throw new Error(`Unsupported PNG bit depth ${depth}.`);
  const channels = PNG_CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}.`);
  const raw = inflateSync(Buffer.concat(idat));
  const planes = unfilterScanlines(raw, width, height, channels);
  if (channels === 3) return { width, height, data: planes };
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    if (channels === 1 || channels === 2) {
      const g = planes[i * channels];
      rgb[i * 3] = g;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = g;
    } else {
      rgb[i * 3] = planes[i * 4];
      rgb[i * 3 + 1] = planes[i * 4 + 1];
      rgb[i * 3 + 2] = planes[i * 4 + 2];
    }
  }
  return { width, height, data: rgb };
}

export function encodePng(rgb, width, height) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
