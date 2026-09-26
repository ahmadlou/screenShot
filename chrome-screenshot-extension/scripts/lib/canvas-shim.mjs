/**
 * canvas-shim.mjs
 * Test double for the two browser APIs the capture pipeline relies on:
 * `createImageBitmap()` and `OffscreenCanvas`. Neither exists in Node, so the
 * PNG -> JPEG path could not otherwise be exercised outside Chrome.
 *
 * Only the surface screenshot.js actually uses is implemented:
 *   createImageBitmap(blob) -> { width, height, data }
 *   new OffscreenCanvas(w, h).getContext('2d') -> fillRect / drawImage
 *   canvas.convertToBlob({ type, quality }) -> Blob
 *
 * The PNG decoder handles the truecolour 8-bit, filter-0 images produced by the
 * test fixture. The JPEG encoder emits a structurally valid baseline stream
 * (SOI/APP0/DQT/SOF0/DHT/SOS/EOI) using canonical Huffman tables.
 */

import { inflateSync } from 'node:zlib';

/** Decode the truecolour 8-bit, filter-0 PNGs the test fixture produces. */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < width; x += 1) {
      const s = src + x * channels;
      const d = (y * width + x) * 4;
      if (channels === 1) {
        out[d] = out[d + 1] = out[d + 2] = raw[s];
        out[d + 3] = 255;
      } else {
        out[d] = raw[s];
        out[d + 1] = raw[s + 1];
        out[d + 2] = raw[s + 2];
        out[d + 3] = channels === 4 ? raw[s + 3] : 255;
      }
    }
  }
  return { width, height, data: out };
}

/** Build canonical Huffman codes from a per-symbol code length. */
function canonicalCodes(lengths) {
  const codes = new Array(lengths.length).fill(0);
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < (lengths[length - 1] ?? 0); i += 1) {
      codes[index] = { code, length };
      code += 1;
      index += 1;
    }
    code <<= 1;
  }
  return codes;
}

/** Convert per-symbol lengths into DHT wire format (bits[] + values[]). */
function huffmanTable(codeLengths) {
  const bits = new Array(16).fill(0);
  const values = [];
  codeLengths.forEach((length, symbol) => {
    if (length > 0) {
      bits[length - 1] += 1;
      values.push(symbol);
    }
  });
  return { bits, values, codes: canonicalCodes(codeLengths) };
}

// DC categories 0..11, and AC EOB only. Both satisfy the Kraft inequality.
const DC_TABLE = huffmanTable([2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
const AC_TABLE = huffmanTable([1]);

/** MSB-first bit writer, as required by JPEG entropy-coded segments. */
class BitWriter {
  constructor() {
    this.bytes = [];
    this.accumulator = 0;
    this.bitCount = 0;
  }

  writeBits(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.accumulator = (this.accumulator << 1) | ((value >> i) & 1);
      this.bitCount += 1;
      if (this.bitCount === 8) {
        const byte = this.accumulator & 0xff;
        this.bytes.push(byte);
        // 0xFF in entropy data must be byte-stuffed with a 0x00.
        if (byte === 0xff) this.bytes.push(0x00);
        this.accumulator = 0;
        this.bitCount = 0;
      }
    }
  }

  writeCode(table, symbol) {
    const entry = table.codes[symbol];
    this.writeBits(entry.code, entry.length);
  }

  flush() {
    while (this.bitCount !== 0) this.writeBits(1, 1);
  }
}

function segment(marker, payload) {
  const length = payload.length + 2;
  return Buffer.concat([
    Buffer.from([0xff, marker]),
    Buffer.from([(length >> 8) & 0xff, length & 0xff]),
    payload
  ]);
}

/** Average colour of the bitmap, which is uniform for the test fixtures. */
function averageColor(bitmap) {
  const { data } = bitmap;
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = bitmap.width * bitmap.height;
  for (let i = 0; i < pixels; i += 1) {
    r += data[i * 4];
    g += data[i * 4 + 1];
    b += data[i * 4 + 2];
  }
  return [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)];
}


function encodeJpeg(bitmap) {
  const [r, g, b] = averageColor(bitmap);
  // BT.601 luma, matching the level shift JPEG applies.
  const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b) - 128;
  // A constant 8x8 block has only a DC coefficient, equal to 8 * level.
  const dc = luma * 8;

  const writer = new BitWriter();
  const blocks = Math.ceil(bitmap.width / 8) * Math.ceil(bitmap.height / 8);

  for (let i = 0; i < blocks; i += 1) {
    // Only the first block carries the DC value; the rest are flat.
    const diff = i === 0 ? dc : 0;
    const category = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
    writer.writeCode(DC_TABLE, category);
    if (category > 0) {
      writer.writeBits(diff < 0 ? diff + (1 << category) - 1 : diff, category);
    }
    writer.writeCode(AC_TABLE, 0x00); // EOB
  }
  writer.flush();

  // A flat quantisation table keeps the fixture image uniform.
  const quant = Buffer.alloc(65);
  quant[0] = 0x00;
  for (let i = 0; i < 64; i += 1) quant[1 + i] = 16;

  const app0 = Buffer.concat([
    Buffer.from('JFIF\0', 'ascii'),
    Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])
  ]);

  const sof0 = Buffer.alloc(15);
  sof0.writeUInt8(8, 0);
  sof0.writeUInt16BE(bitmap.height, 1);
  sof0.writeUInt16BE(bitmap.width, 3);
  sof0.writeUInt8(3, 5);
  [1, 2, 3].forEach((id, i) => {
    sof0.writeUInt8(id, 6 + i * 3);
    sof0.writeUInt8(0x11, 7 + i * 3); // 1x1 sampling
    sof0.writeUInt8(0, 8 + i * 3); // quantisation table 0
  });

  const dhtDc = segment(0xc4, Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from(DC_TABLE.bits),
    Buffer.from(DC_TABLE.values)
  ]));
  const dhtAc = segment(0xc4, Buffer.concat([
    Buffer.from([0x10]),
    Buffer.from(AC_TABLE.bits),
    Buffer.from(AC_TABLE.values)
  ]));

  const sos = Buffer.from([3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    segment(0xe0, app0),
    segment(0xdb, quant),
    segment(0xc0, sof0),
    dhtDc,
    dhtAc,
    segment(0xda, sos),
    Buffer.from(writer.bytes),
    Buffer.from([0xff, 0xd9]) // EOI
  ]);
}

/* ---------------- Installation ---------------- */

/** Recorded convertToBlob() calls, so tests can assert the quality mapping. */
export const canvasCalls = { convertToBlob: [], filled: 0 };

/** Define createImageBitmap + OffscreenCanvas on globalThis. */
export function installCanvasShim() {
  globalThis.createImageBitmap = async (blob) => {
    const buffer = Buffer.from(await blob.arrayBuffer());
    return { ...decodePng(buffer), close() {} };
  };

  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.context = {
        fillStyle: '#000000',
        // The real canvas flattens alpha here; recording it lets tests assert
        // that the pipeline primes an opaque white base before drawing.
        fillRect: () => {
          canvasCalls.filled += 1;
        },
        drawImage: (bitmap) => {
          this.source = bitmap;
        }
      };
    }

    getContext() {
      return this.context;
    }

    async convertToBlob({ type, quality } = {}) {
      canvasCalls.convertToBlob.push({ type, quality });
      return new Blob([encodeJpeg(this.source)], { type: type || 'image/jpeg' });
    }
  };
}

