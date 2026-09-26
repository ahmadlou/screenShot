/**
 * filename.js
 * Builds `photo_YYYY-MM-DD_HH-mm-ss.jpg` style names in the user's LOCAL time
 * and guarantees the result never overwrites an existing file.
 *
 * Chrome's downloads API offers conflictAction:"uniquify" as a safety net, but we
 * also verify existence up-front so the name we *report* to the user is the name
 * that was actually used, and so direct file writes (File System Access) get the
 * same protection.
 */

import { ErrorCode, ScreenshotError } from './errors.js';

/** Windows reserved device names; rejected as a whole filename. */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

const MAX_BASE_LENGTH = 120;

function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}

/**
 * @param {Date} date
 * @returns {{date: string, time: string, stamp: string}} Local-time components.
 */
export function formatTimestamp(date = new Date()) {
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return { date: datePart, time: timePart, stamp: `${datePart}_${timePart}` };
}

/**
 * Strip characters that are illegal in file names on any supported platform.
 * @param {string} value
 * @returns {string}
 */
export function sanitizePrefix(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\.+$/g, '')
    .trim();
}

/**
 * The name a user would expect, before collision handling.
 * @param {object} options
 * @param {string} options.prefix
 * @param {Date}   [options.date]
 * @returns {string} e.g. "photo_2026-09-26_19-58-32.jpg"
 */
export function buildBaseFilename({ prefix, date = new Date() }) {
  const { stamp } = formatTimestamp(date);
  const safePrefix = sanitizePrefix(prefix) || 'photo_';
  return `${safePrefix}${stamp}.jpg`;
}

/**
 * Append a millisecond / numeric discriminator before the extension.
 * @param {string} base
 * @param {number} attempt
 * @param {Date} date
 */
function withSuffix(base, attempt, date) {
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';

  // First collision uses milliseconds (keeps names readable), later ones count up.
  if (attempt === 1) return `${stem}_${pad(date.getMilliseconds(), 3)}${ext}`;
  return `${stem}_${attempt}${ext}`;
}


/**
 * Validate a finished filename before it is handed to Chrome.
 * @param {string} name
 */
export function assertValidFilename(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new ScreenshotError(ErrorCode.INVALID_FILENAME, {
      detail: 'Generated filename was empty.'
    });
  }
  if (name.length > 200) {
    throw new ScreenshotError(ErrorCode.INVALID_FILENAME, {
      detail: `Generated filename exceeded 200 characters (${name.length}).`
    });
  }
  if (/[\\/:*?"<>|]/.test(name)) {
    throw new ScreenshotError(ErrorCode.INVALID_FILENAME, {
      detail: `Generated filename contains illegal characters: ${name}`
    });
  }
  const stem = name.split('.')[0].toLowerCase();
  if (RESERVED_NAMES.has(stem)) {
    throw new ScreenshotError(ErrorCode.INVALID_FILENAME, {
      detail: `Generated filename is a reserved device name: ${name}`
    });
  }
  return name;
}

/**
 * Ask Chrome's download history whether a name is already taken.
 * Only meaningful in DOWNLOADS save mode; the File System Access path checks the
 * directory directly instead (see directory.js).
 *
 * @param {string} filename Path relative to the download directory.
 * @returns {Promise<boolean>}
 */
async function downloadExists(filename) {
  try {
    const results = await chrome.downloads.search({ filename, limit: 1 });
    return Array.isArray(results) && results.length > 0;
  } catch (err) {
    // Download history may be unavailable. Do not fail the capture because of
    // it; the uniquify conflictAction still protects us.
    console.warn('[filename] downloads.search unavailable, relying on uniquify.', err);
    return false;
  }
}

/** Join a relative folder and a filename using Chrome's forward-slash format. */
export function joinPath(folder, filename) {
  const cleanFolder = (folder || '').replace(/^\/+|\/+$/g, '');
  return cleanFolder ? `${cleanFolder}/${filename}` : filename;
}

/**
 * Build a filename that is guaranteed not to overwrite an existing file.
 *
 * @param {object} options
 * @param {string}   options.prefix            Filename prefix, e.g. "photo_".
 * @param {Date}     [options.date]            Defaults to now (local time).
 * @param {string}   [options.folder]          Relative folder inside the download dir.
 * @param {boolean}  [options.checkDownloads]  Consult download history (default true).
 * @param {(name: string) => Promise<boolean>} [options.exists]
 *        Custom existence probe, used by the File System Access writer.
 * @returns {Promise<{filename: string, path: string}>}
 */
export async function createUniqueFilename({
  prefix,
  date = new Date(),
  folder = '',
  checkDownloads = true,
  exists
} = {}) {
  const base = buildBaseFilename({ prefix, date });
  const probe = exists || (checkDownloads ? downloadExists : null);

  // Fast path: the common case is a free name, so avoid extra round-trips.
  if (!probe || !(await probe(base))) {
    return { filename: base, path: joinPath(folder, base) };
  }

  // Slow path: only reached when the name is genuinely taken.
  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const candidate = withSuffix(base, attempt, date);
    if (candidate.length > MAX_BASE_LENGTH) {
      throw new ScreenshotError(ErrorCode.INVALID_FILENAME, {
        detail: `Could not derive a unique filename from "${base}".`
      });
    }
    if (!(await probe(candidate))) {
      return { filename: candidate, path: joinPath(folder, candidate) };
    }
  }

  throw new ScreenshotError(ErrorCode.INVALID_FILENAME, {
    detail: `Exhausted filename variants for "${base}".`
  });
}

