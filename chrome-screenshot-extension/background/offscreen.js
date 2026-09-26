/**
 * offscreen.js
 * Runs inside a hidden offscreen document and performs the File System Access
 * write. See background/offscreen.html for why this exists.
 */

import { ErrorCode, ScreenshotError } from '../utils/errors.js';
import { getDirectoryHandle, hasDirectoryPermission } from '../utils/directory.js';

/**
 * Write a JPEG data URL into the user-granted directory.
 * @param {{filename: string, dataUrl: string}} request
 * @returns {Promise<{ok: true, path: string} | {ok: false, code: string, message: string, detail: string}>}
 */
async function writeFile({ filename, dataUrl }) {
  const directory = await getDirectoryHandle();
  if (!directory) {
    throw new ScreenshotError(ErrorCode.DIRECTORY_UNAVAILABLE, {
      detail: 'No directory handle is stored; the user must pick a folder in the options page.'
    });
  }

  if (!(await hasDirectoryPermission(directory))) {
    // requestPermission() also needs a user gesture, so we cannot silently
    // re-grant here. The user is told to re-select the folder in the options.
    throw new ScreenshotError(ErrorCode.DIRECTORY_PERMISSION_DENIED, {
      detail: 'The stored directory handle is no longer granted for writing.'
    });
  }

  const fileHandle = await directory.getFileHandle(filename, { create: true });

  // FileSystemWritableFileStream is available in this DOM context.
  const writable = await fileHandle.createWritable();
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    // Leave no half-written file behind.
    try {
      await writable.abort?.();
    } catch {
      /* the stream may already be closed; nothing else to do */
    }
    throw new ScreenshotError(ErrorCode.FILE_WRITE_FAILED, {
      detail: `Writing "${filename}" failed: ${error?.message || error}`,
      cause: error
    });
  }

  return { ok: true, path: `${directory.name}/${filename}` };
}

// Message channel used by the service worker. Responses are always plain objects
// because the message may cross a context boundary where class identity is lost.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen-writer' || message?.type !== 'write-file') {
    return false;
  }

  writeFile({ filename: message.filename, dataUrl: message.dataUrl })
    .then(sendResponse)
    .catch((error) => {
      const code = error instanceof ScreenshotError ? error.code : ErrorCode.FILE_WRITE_FAILED;
      console.error('[offscreen] write failed:', error);
      sendResponse({
        ok: false,
        code,
        message: error?.userMessage || error?.message || 'Write failed.',
        detail: error?.detail || String(error)
      });
    });

  return true; // Keep the message channel open for the async response.
});
