/**
 * saver.js
 * The two supported ways to persist a captured screenshot, plus the shared
 * existence probe used for filename uniqueness in directory mode.
 *
 * MODE 1 - chrome.downloads (default)
 *   Saves silently (saveAs:false) into the browser's download directory, using a
 *   RELATIVE path. This is the only universally supported, fully automatic
 *   option. An absolute path such as C:\Screenshots cannot be honoured here.
 *
 * MODE 2 - File System Access API
 *   Writes to a real folder the user granted access to, which does allow an
 *   absolute path. Requires the one-time folder grant in the options page and is
 *   executed from an offscreen document.
 */

import { ErrorCode, ScreenshotError } from './errors.js';
import { SaveMode } from './storage.js';
import { hasDirectoryPermission } from './directory.js';

/**
 * Save via the Downloads API.
 *
 * @param {object} options
 * @param {string} options.dataUrl  JPEG data URL.
 * @param {string} options.path     Path relative to the download directory.
 * @returns {Promise<{downloadId: number, path: string}>}
 */
export async function saveWithDownloads({ dataUrl, path }) {
  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: path,
      // Always false: screenshots are written straight to the configured
      // folder, with no Save As dialog and no user interaction.
      saveAs: false,
      // Final safety net: even if our own existence probe races, Chrome will
      // uniquify rather than overwrite an existing file.
      conflictAction: 'uniquify'
    });
    return { downloadId, path };
  } catch (error) {
    throw new ScreenshotError(ErrorCode.DOWNLOAD_FAILED, {
      detail: `chrome.downloads.download failed for "${path}": ${error?.message || error}`,
      cause: error
    });
  }
}

/**
 * Confirm a download actually started, and report its final on-disk path.
 * @param {number} downloadId
 * @returns {Promise<{path: string, state: string}>}
 */
export async function confirmDownload(downloadId) {
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) {
      throw new ScreenshotError(ErrorCode.DOWNLOAD_FAILED, {
        detail: `Download ${downloadId} disappeared before it could be verified.`
      });
    }
    if (item.state === 'interrupted') {
      throw new ScreenshotError(ErrorCode.DOWNLOAD_FAILED, {
        detail: `Download ${downloadId} was interrupted: ${item.error || 'unknown reason'}.`
      });
    }
    return { path: item.filename || '', state: item.state };
  } catch (error) {
    if (error instanceof ScreenshotError) throw error;
    throw new ScreenshotError(ErrorCode.DOWNLOAD_FAILED, {
      detail: `Could not verify download ${downloadId}: ${error?.message || error}`,
      cause: error
    });
  }
}

/**
 * Existence probe for a filename inside a File System Access directory.
 * Exposed so filename.js can reuse the exact same uniqueness rules for both
 * save modes.
 *
 * @param {FileSystemDirectoryHandle} directory
 * @returns {(name: string) => Promise<boolean>}
 */
export function createDirectoryProbe(directory) {
  return async (name) => {
    try {
      await directory.getFileHandle(name);
      return true;
    } catch (error) {
      // NotFoundError means the name is free; anything else is unexpected but we
      // treat it as "not taken" and let createWritable() be the final authority.
      if (error?.name === 'NotFoundError') return false;
      console.warn('[saver] Unexpected error while probing for an existing file.', error);
      return false;
    }
  };
}

// hasDirectoryPermission() lives in directory.js next to the handle storage it
// validates; re-exported here so the service worker has one import site.
export { hasDirectoryPermission, SaveMode };
