/**
 * make-icons.mjs
 * Generates the PNG icons. Kept in the repo so the icons are reproducible
 * without any binary assets or external tooling. Run: node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];

const BG = [47, 111, 235];   // accent blue
const FG = [255, 255, 255]; // camera body

/** CRC32, required by the PNG container format. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encode RGBA pixel data as a PNG buffer. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Prefix each scanline with filter byte 0 (None).
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Coverage of a pixel by a shape, sampled 3x3 for cheap anti-aliasing. */
function coverage(px, py, shape) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      if (shape(px + (sx + 0.5) / 3, py + (sy + 0.5) / 3)) hits += 1;
    }
  }
  return hits / 9;
}

function mix(dst, offset, colour, alpha) {
  for (let c = 0; c < 3; c += 1) {
    dst[offset + c] = Math.round(dst[offset + c] * (1 - alpha) + colour[c] * alpha);
  }
  dst[offset + 3] = Math.max(dst[offset + 3], Math.round(255 * alpha));
}

/** Draw the icon: rounded blue tile with a white camera glyph. */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 16; // scale from the 16px design grid

  const inRoundedTile = (x, y) => {
    const inset = Math.max(0.5, 0.75 * s);
    const min = inset;
    const max = size - inset;
    const r = 3.5 * s;
    const cx = Math.min(Math.max(x, min + r), max - r);
    const cy = Math.min(Math.max(y, min + r), max - r);
    if (x < min || x > max || y < min || y > max) return false;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  // Camera body.
  const bodyLeft = 2.4 * s;
  const bodyRight = 13.6 * s;
  const bodyTop = 5.4 * s;
  const bodyBottom = 13.1 * s;
  const bodyR = 1.5 * s;
  const inBody = (x, y) => {
    if (x < bodyLeft || x > bodyRight || y < bodyTop || y > bodyBottom) return false;
    const cx = Math.min(Math.max(x, bodyLeft + bodyR), bodyRight - bodyR);
    const cy = Math.min(Math.max(y, bodyTop + bodyR), bodyBottom - bodyR);
    return (x - cx) ** 2 + (y - cy) ** 2 <= bodyR * bodyR;
  };

  // Lens: an inner disc punched clean out of the body, so the tile colour shows
  // through and the lens reads clearly at every size.
  const lensCx = 8 * s;
  const lensCy = 9.25 * s;
  const lensOuter = 2.9 * s;
  const lensInner = 2.05 * s;
  const inLens = (x, y) => {
    const d = (x - lensCx) ** 2 + (y - lensCy) ** 2;
    return d <= lensOuter * lensOuter;
  };
  const inLensHole = (x, y) => {
    const d = (x - lensCx) ** 2 + (y - lensCy) ** 2;
    return d <= lensInner * lensInner;
  };

  // Shutter bump on top.
  const bump = (x, y) => {
    const bx = 5.4 * s;
    const bw = 3.4 * s;
    const br = 0.8 * s;
    const byTop = 3.9 * s;
    const byBottom = bodyTop + 0.6 * s;
    if (x < bx || x > bx + bw || y < byTop || y > byBottom) return false;
    const cx = Math.min(Math.max(x, bx + br), bx + bw - br);
    return (x - cx) ** 2 + (y - byTop - br) ** 2 <= br * br;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const tile = coverage(x, y, inRoundedTile);
      if (tile > 0) mix(rgba, offset, BG, tile);

      // Glyph is punched out of the tile, so only draw it on top of the tile.
      const glyph = Math.max(
        coverage(x, y, inBody),
        coverage(x, y, inLens),
        coverage(x, y, bump)
      );
      if (glyph > 0 && tile > 0) {
        // Punch the lens hole back out to transparent, revealing the tile.
        const hole = coverage(x, y, inLensHole);
        mix(rgba, offset, FG, Math.max(0, glyph - hole) * tile);
      }
    }
  }

  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`wrote ${file}`);
}
