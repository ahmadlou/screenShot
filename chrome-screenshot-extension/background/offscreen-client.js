/**
 * offscreen-client.js
 * Creates and tears down the offscreen document used for File System Access
 * writes. Chrome allows only one offscreen document at a time, so every call
 * must go through the guarded path below.
 *
 * The "offscreen" permission is optional and is only requested when the user
 * actually selects directory save mode.
 */

const OFFSCREEN_PATH = 'background/offscreen.html';
/** BLOBS is the documented reason for a document that needs DOM access for blob work. */
const REASON = 'BLOBS';
const JUSTIFICATION =
  'Writes the captured screenshot into the folder the user granted access to.';

/** Serialises create/write/close so concurrent captures cannot race the document. */
let queue = Promise.resolve();

/** True when an offscreen document is currently alive. */
async function hasDocument() {
  // getContexts() only exists from Chrome 116. On older builds we cannot query,
  // so report "no" and let ensureDocument() tolerate an already-open document.
  if (typeof chrome.runtime?.getContexts !== 'function') return false;
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

/**
 * Open the offscreen document if it is not already open.
 * Chrome allows only one at a time, so a "single offscreen document" error is
 * treated as success rather than a failure.
 */
async function ensureDocument() {
  if (await hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [REASON],
      justification: JUSTIFICATION
    });
  } catch (error) {
    const message = String(error?.message || error);
    if (!message.includes('single offscreen document') && !message.includes('Only a single')) {
      throw error;
    }
    // Already open (e.g. a previous write's closeDocument() had not settled).
    console.warn('[offscreen] Document was already open; reusing it.');
  }
}

/** Ensure the offscreen permission is granted, asking the user if necessary. */
export async function ensureOffscreenPermission() {
  if (typeof chrome.permissions?.contains !== 'function') return true;
  const already = await chrome.permissions.contains({
    permissions: ['offscreen'],
    origins: []
  });
  if (already) return true;
  // Must be called from a user gesture (options page button).
  return chrome.permissions.request({ permissions: ['offscreen'] });
}

/**
 * Run a task inside the offscreen document and always close it afterwards.
 * @template T
 * @param {(send: (message: object) => Promise<any>) => Promise<T>} task
 * @returns {Promise<T>}
 */
export function withOffscreenDocument(task) {
  const run = async () => {
    if (!(await ensureOffscreenPermission())) {
      throw new Error('The "offscreen" permission was not granted.');
    }

    await ensureDocument();

    /** Send a message to the offscreen document and await its reply. */
    const send = (message) =>
      chrome.runtime.sendMessage({ target: 'offscreen-writer', ...message });

    try {
      return await task(send);
    } finally {
      // Closing keeps the browser from holding a hidden document open forever.
      try {
        if (await hasDocument()) {
          await chrome.offscreen.closeDocument();
        }
      } catch (error) {
        console.warn('[offscreen] Could not close the offscreen document.', error);
      }
    }
  };

  // Chain onto the queue so callers are serialised.
  const result = queue.then(run, run);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
