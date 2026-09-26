/**
 * test-pipeline.mjs
 * Integration test for the capture pipeline using a mock chrome.* API and a real
 * PNG -> JPEG encode, so the conversion path is genuinely exercised.
 *
 * Run: node scripts/test-pipeline.mjs
 */

import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { installCanvasShim, canvasCalls } from './lib/canvas-shim.mjs';

// The pipeline uses createImageBitmap/OffscreenCanvas, which Node lacks.
installCanvasShim();

/* ---------------- Minimal PNG encoder (test fixture) ---------------- */

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
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Build a solid-colour PNG of the given size. */
function makePng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- Mock chrome.* environment ---------------- */

const downloads = [];
const existingNames = new Set();
let captureShouldFail = false;
let stored = {};

globalThis.chrome = {
  runtime: {
    getURL: (p) => `chrome-extension://test/${p}`,
    getManifest: () => ({ version: '1.0.0' }),
    openOptionsPage: () => {},
    OnInstalledReason: { INSTALL: 'install', UPDATE: 'update' },
    onMessage: { addListener: (fn) => { globalThis.__onMessage = fn; } },
    onInstalled: { addListener: (fn) => { globalThis.__onInstalled = fn; } },
    sendMessage: async (msg) => globalThis.__onMessage(msg, {}, () => {})
  },
  commands: {
    onCommand: { addListener: (fn) => { globalThis.__onCommand = fn; } },
    getAll: async () => [{ name: 'capture-screenshot', shortcut: 'Ctrl+Shift+S' }]
  },
  storage: {
    local: {
      get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
      set: async (obj) => { Object.assign(stored, obj); }
    }
  },
  downloads: {
    download: async ({ url, filename, saveAs, conflictAction }) => {
      // Emulate Chrome's uniquify safety net.
      let finalName = filename;
      let n = 1;
      while (existingNames.has(finalName)) {
        const dot = filename.lastIndexOf('.');
        finalName = `${filename.slice(0, dot)} (${n++})${filename.slice(dot)}`;
      }
      existingNames.add(finalName);
      downloads.push({ url, filename: finalName, saveAs, conflictAction });
      return downloads.length;
    },
    search: async ({ id, filename, limit }) => {
      if (typeof id === 'number') {
        const item = downloads[id - 1];
        if (!item) return [];
        return [{ id, state: 'complete', filename: `/Downloads/${item.filename}` }];
      }
      return [...existingNames]
        .filter((n) => n.includes(filename))
        .slice(0, limit ?? 10)
        .map((n) => ({ id: 1, state: 'complete', filename: n }));
    }
  },
  tabs: {
    captureVisibleTab: async () => {
      if (captureShouldFail) {
        throw new Error('Cannot access contents of url "chrome://extensions"');
      }
      return `data:image/png;base64,${makePng(64, 48, [220, 40, 40]).toString('base64')}`;
    }
  },
  windows: { WINDOW_ID_CURRENT: -2 },
  notifications: { create: async () => {}, clear: async () => {} },
  permissions: { contains: async () => true, request: async () => true }
};

const { performCapture } = await import('../background/service-worker.js');
const { loadSettings, saveSettings, resetSettings } = await import('../utils/storage.js');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}\n        ${error.message}`);
    process.exitCode = 1;
  }
}


console.log('\npipeline: defaults');

await check('uses documented defaults on a clean install', async () => {
  await resetSettings();
  const settings = await loadSettings();
  assert.equal(settings.filenamePrefix, 'photo_');
  assert.equal(settings.jpegQuality, 92);
  assert.equal(settings.notificationsEnabled, false);
  assert.equal(settings.errorNotificationsEnabled, true);
  assert.equal(settings.downloadFolder, 'Screenshots');
  // The Save As dialog is not configurable: saving is always silent.
  assert.ok(!('saveAs' in settings), 'saveAs must not be a setting any more');
});

console.log('\npipeline: successful capture');

await check('captures, converts and saves a JPG', async () => {
  const result = await performCapture();
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.match(result.filename, /^photo_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(_\d+)?\.jpg$/);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, `Screenshots/${result.filename}`);
});

await check('saves silently (saveAs false) with uniquify conflictAction', async () => {
  assert.equal(downloads[0].saveAs, false);
  assert.equal(downloads[0].conflictAction, 'uniquify');
});

await check('the saved payload is a real JPEG data URL', async () => {
  assert.match(downloads[0].url, /^data:image\/jpeg;base64,/);
  const bytes = Buffer.from(downloads[0].url.split(',')[1], 'base64');
  // JPEG start-of-image and end-of-image markers.
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  assert.equal(bytes[bytes.length - 2], 0xff);
  assert.equal(bytes[bytes.length - 1], 0xd9);
  assert.ok(bytes.length > 100, 'encoded image suspiciously small');
  // A baseline JPEG must carry a JFIF APP0 segment.
  assert.equal(bytes.toString('ascii', 6, 11), 'JFIF\0');
});

await check('requests JPEG output with the configured quality', async () => {
  const last = canvasCalls.convertToBlob.at(-1);
  assert.equal(last.type, 'image/jpeg');
  // 92% must be forwarded as the 0-1 fraction the canvas API expects.
  assert.ok(Math.abs(last.quality - 0.92) < 0.001, `got ${last.quality}`);
});

await check('primes an opaque base before drawing (no black alpha)', async () => {
  assert.ok(canvasCalls.filled > 0, 'fillRect was never called');
});

await check('quality 70 is clamped into the documented 0.70-1.0 range', async () => {
  await saveSettings({ jpegQuality: 70 });
  await performCapture();
  assert.ok(Math.abs(canvasCalls.convertToBlob.at(-1).quality - 0.7) < 0.001);
  await saveSettings({ jpegQuality: 92 });
});

await check('reports a concrete on-disk path', async () => {
  const result = await performCapture();
  assert.ok(result.path.startsWith('/Downloads/Screenshots/'), result.path);
});

console.log('\npipeline: repeated captures');

await check('ten rapid captures all produce unique names', async () => {
  const before = downloads.length;
  const names = [];
  for (let i = 0; i < 10; i += 1) {
    const result = await performCapture();
    assert.equal(result.ok, true, JSON.stringify(result.error));
    names.push(result.filename);
  }
  assert.equal(downloads.length, before + 10);
  assert.equal(new Set(names).size, 10, `duplicate names: ${names.join(', ')}`);
});

await check('concurrent captures are serialised, not raced', async () => {
  const before = downloads.length;
  const results = await Promise.all(Array.from({ length: 5 }, () => performCapture()));
  for (const result of results) assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(downloads.length, before + 5);
  assert.equal(new Set(results.map((r) => r.filename)).size, 5);
});

console.log('\npipeline: settings are honoured');

await check('honours a custom prefix and folder', async () => {
  await saveSettings({ filenamePrefix: 'capture_', downloadFolder: 'Photos/2026' });
  const result = await performCapture();
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.match(result.filename, /^capture_/);
  assert.ok(result.path.includes('/Photos/2026/'), result.path);
});

await check('honours a non-default quality', async () => {
  await saveSettings({ filenamePrefix: 'photo_', downloadFolder: 'Screenshots', jpegQuality: 70 });
  const result = await performCapture();
  assert.equal(result.ok, true, JSON.stringify(result.error));
});

await check('never requests a Save As dialog, whatever the settings', async () => {
  // Even a hostile/corrupt stored saveAs value must not reach the API.
  await saveSettings({ saveAs: true, filenamePrefix: 'photo_', downloadFolder: 'Screenshots' });
  const before = downloads.length;
  await performCapture();
  assert.equal(downloads[before].saveAs, false, 'a Save As dialog was requested');
  await performCapture();
  assert.equal(downloads[before + 1].saveAs, false, 'a Save As dialog was requested');
});

console.log('\npipeline: failure handling');

await check('restricted page is reported, not thrown', async () => {
  captureShouldFail = true;
  const result = await performCapture();
  captureShouldFail = false;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'RESTRICTED_PAGE');
  assert.ok(result.error.message.length > 0);
});

await check('recovers on the next capture after a failure', async () => {
  const before = downloads.length;
  const result = await performCapture();
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(downloads.length, before + 1);
});

await check('directory mode without a grant fails cleanly', async () => {
  await saveSettings({ saveMode: 'directory' });
  const result = await performCapture();
  // No handle is stored in this environment, so it must fail gracefully.
  assert.equal(result.ok, false);
  assert.ok(
    ['DIRECTORY_UNAVAILABLE', 'DIRECTORY_PERMISSION_DENIED'].includes(result.error.code),
    result.error.code
  );
  await saveSettings({ saveMode: 'downloads' });
});

console.log(`\n${passed} checks passed.\n`);

