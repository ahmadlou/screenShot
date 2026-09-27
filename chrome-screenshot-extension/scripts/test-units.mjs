/**
 * test-units.mjs
 * Dependency-free checks for the pure logic (no Chrome APIs needed).
 * Run: node scripts/test-units.mjs
 */

import assert from 'node:assert/strict';

import {
  sanitizeDownloadFolder,
  normalizeSettings,
  DEFAULT_SETTINGS,
  SaveMode
} from '../utils/storage.js';
import {
  buildBaseFilename,
  sanitizePrefix,
  assertValidFilename,
  createUniqueFilename,
  joinPath,
  formatTimestamp
} from '../utils/filename.js';
import {
  isRestrictedPageError,
  toScreenshotError,
  ErrorCode,
  ScreenshotError
} from '../utils/errors.js';

let passed = 0;
const pending = [];

/** Async-aware check: the callback may return a promise. */
function check(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn();
        passed += 1;
        console.log(`  PASS  ${name}`);
      } catch (error) {
        console.error(`  FAIL  ${name}\n        ${error.message}`);
        process.exitCode = 1;
      }
    })()
  );
}

console.log('\nstorage: sanitizeDownloadFolder');

check('keeps a simple name', () => {
  assert.equal(sanitizeDownloadFolder('Screenshots'), 'Screenshots');
});

check('preserves spaces and hyphens in folder names', () => {
  assert.equal(sanitizeDownloadFolder('My Photos-2026'), 'My Photos-2026');
});

check('normalises backslashes to forward slashes', () => {
  assert.equal(sanitizeDownloadFolder('Photos\\2026'), 'Photos/2026');
});

check('strips a leading drive letter (Chrome rejects absolute paths)', () => {
  assert.equal(sanitizeDownloadFolder('C:/Screenshots'), 'Screenshots');
  assert.equal(sanitizeDownloadFolder('C:\\Users\\me\\Pics'), 'Users/me/Pics');
});

check('removes path traversal segments', () => {
  assert.equal(sanitizeDownloadFolder('../../etc'), 'etc');
  assert.equal(sanitizeDownloadFolder('a/../../b'), 'a/b');
});

check('removes characters Chrome rejects', () => {
  assert.equal(sanitizeDownloadFolder('a<b>c:d"e|f?g*h'), 'abcdefgh');
});

check('collapses empty segments and trims slashes', () => {
  assert.equal(sanitizeDownloadFolder('//Screenshots//2026//'), 'Screenshots/2026');
});

check('empty input stays empty', () => {
  assert.equal(sanitizeDownloadFolder(''), '');
  assert.equal(sanitizeDownloadFolder('   '), '');
});

console.log('\nstorage: normalizeSettings');

check('clamps quality into 70-100', () => {
  assert.equal(normalizeSettings({ jpegQuality: 5 }).jpegQuality, 70);
  assert.equal(normalizeSettings({ jpegQuality: 500 }).jpegQuality, 100);
  assert.equal(normalizeSettings({ jpegQuality: 'abc' }).jpegQuality, DEFAULT_SETTINGS.jpegQuality);
});

check('coerces booleans strictly', () => {
  assert.equal(normalizeSettings({ notificationsEnabled: 'yes' }).notificationsEnabled, false);
  assert.equal(normalizeSettings({ notificationsEnabled: true }).notificationsEnabled, true);
});

check('errorNotificationsEnabled defaults to on', () => {
  assert.equal(normalizeSettings({}).errorNotificationsEnabled, true);
});

check('floating button is disabled unless explicitly enabled', () => {
  assert.equal(normalizeSettings({}).floatingButtonEnabled, false);
  assert.equal(normalizeSettings({ floatingButtonEnabled: true }).floatingButtonEnabled, true);
  assert.equal(normalizeSettings({ floatingButtonEnabled: 'yes' }).floatingButtonEnabled, false);
});

check('unknown saveMode falls back to downloads', () => {
  assert.equal(normalizeSettings({ saveMode: 'evil' }).saveMode, SaveMode.DOWNLOADS);
});

check('survives corrupt input', () => {
  assert.doesNotThrow(() => normalizeSettings(null));
  assert.doesNotThrow(() => normalizeSettings('not an object'));
});

console.log('\nfilename: generation');

check('produces the documented format in local time', () => {
  const date = new Date(2026, 8, 26, 19, 58, 32);
  assert.equal(buildBaseFilename({ prefix: 'photo_', date }), 'photo_2026-09-26_19-58-32.jpg');
});

check('zero-pads every component', () => {
  assert.equal(formatTimestamp(new Date(2026, 0, 5, 7, 4, 9)).stamp, '2026-01-05_07-04-09');
});

check('honours a custom prefix', () => {
  const date = new Date(2026, 8, 26, 19, 58, 32);
  assert.equal(
    buildBaseFilename({ prefix: 'screenshot_', date }),
    'screenshot_2026-09-26_19-58-32.jpg'
  );
});

check('strips illegal characters from the prefix', () => {
  assert.equal(sanitizePrefix('a/b:c*'), 'abc');
  assert.equal(sanitizePrefix('   '), '');
});

check('falls back to photo_ when the prefix is unusable', () => {
  const date = new Date(2026, 8, 26, 19, 58, 32);
  assert.equal(buildBaseFilename({ prefix: '///', date }), 'photo_2026-09-26_19-58-32.jpg');
});


console.log('\nfilename: validation');

check('accepts a normal name', () => {
  const name = 'photo_2026-09-26_19-58-32.jpg';
  assert.equal(assertValidFilename(name), name);
});

check('rejects an empty name', () => {
  assert.throws(() => assertValidFilename(''), ScreenshotError);
});

check('rejects illegal characters', () => {
  assert.throws(() => assertValidFilename('a/b.jpg'), ScreenshotError);
  assert.throws(() => assertValidFilename('a:b.jpg'), ScreenshotError);
});

check('rejects reserved Windows device names', () => {
  assert.throws(() => assertValidFilename('con.jpg'), ScreenshotError);
  assert.throws(() => assertValidFilename('LPT1.jpg'), ScreenshotError);
});

console.log('\nfilename: uniqueness');

check('joinPath builds a relative path', () => {
  assert.equal(joinPath('Screenshots', 'a.jpg'), 'Screenshots/a.jpg');
  assert.equal(joinPath('', 'a.jpg'), 'a.jpg');
  assert.equal(joinPath('/Screenshots/', 'a.jpg'), 'Screenshots/a.jpg');
});

// Fixed local time with a non-zero millisecond component, so the millisecond
// suffix path is exercised deterministically.
const date = new Date(2026, 8, 26, 19, 58, 32, 32);

check('uses the plain name when nothing is taken', async () => {
  const result = await createUniqueFilename({ prefix: 'photo_', date, exists: async () => false });
  assert.equal(result.filename, 'photo_2026-09-26_19-58-32.jpg');
});

check('adds milliseconds on the first collision', async () => {
  const taken = new Set(['photo_2026-09-26_19-58-32.jpg']);
  const result = await createUniqueFilename({
    prefix: 'photo_',
    date,
    exists: async (name) => taken.has(name)
  });
  assert.equal(result.filename, 'photo_2026-09-26_19-58-32_032.jpg');
});

check('counts up when milliseconds also collide', async () => {
  const taken = new Set([
    'photo_2026-09-26_19-58-32.jpg',
    'photo_2026-09-26_19-58-32_032.jpg'
  ]);
  const result = await createUniqueFilename({
    prefix: 'photo_',
    date,
    exists: async (name) => taken.has(name)
  });
  assert.equal(result.filename, 'photo_2026-09-26_19-58-32_2.jpg');
});

check('never repeats a name across many collisions', async () => {
  const taken = new Set();
  const names = [];
  for (let i = 0; i < 50; i += 1) {
    const result = await createUniqueFilename({
      prefix: 'photo_',
      date,
      exists: async (name) => taken.has(name)
    });
    assert.ok(!taken.has(result.filename), `duplicate generated: ${result.filename}`);
    taken.add(result.filename);
    names.push(result.filename);
  }
  assert.equal(new Set(names).size, 50);
});

check('gives up cleanly rather than looping forever', async () => {
  await assert.rejects(
    () => createUniqueFilename({ prefix: 'photo_', date, exists: async () => true }),
    ScreenshotError
  );
});

console.log('\nerrors: classification');

check('detects restricted page failures', () => {
  assert.equal(
    isRestrictedPageError(new Error('Cannot access contents of url "chrome://extensions"')),
    true
  );
  assert.equal(isRestrictedPageError(new Error('The tab was closed')), true);
  assert.equal(isRestrictedPageError(new Error('Some other problem')), false);
});

check('normalises unknown errors', () => {
  const error = toScreenshotError(new Error('boom'));
  assert.ok(error instanceof ScreenshotError);
  assert.equal(error.code, ErrorCode.UNKNOWN);
  assert.ok(error.userMessage.length > 0);
});

check('preserves an existing ScreenshotError', () => {
  const original = new ScreenshotError(ErrorCode.DOWNLOAD_FAILED);
  assert.equal(toScreenshotError(original), original);
});

check('every error code has a message', () => {
  for (const code of Object.values(ErrorCode)) {
    assert.ok(new ScreenshotError(code).userMessage, `missing message for ${code}`);
  }
});

await Promise.all(pending);
console.log(`\n${passed} checks passed.\n`);

