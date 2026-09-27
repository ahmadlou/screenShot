/**
 * directory.js
 * File System Access API support for saving to an absolute folder the user picks.
 *
 * WHY THIS EXISTS
 * chrome.downloads cannot write to an arbitrary absolute path: its "filename"
 * option is always resolved relative to the browser's download directory and
 * rejects absolute paths. The only Chrome-native way to target a real folder
 * such as C:\Screenshots is the File System Access API, which requires the user
 * to grant a directory handle explicitly.
 *
 * WHY AN OFFSCREEN DOCUMENT
 * showDirectoryPicker() must be called from a user gesture, so it runs on the
 * options page. The handle is then stored in IndexedDB (FileSystemDirectoryHandle
 * is structured-cloneable and cannot be serialized into chrome.storage).
 * The resulting handle is used from a DOM context - the offscreen document -
 * to create the writable file stream, keeping the service worker free of DOM
 * assumptions.
 */

import { ErrorCode, ScreenshotError } from './errors.js';

const DB_NAME = 'quick-screenshot';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const DIRECTORY_KEY = 'save-directory';

/**
 * Open (and lazily create) the IndexedDB database used for the directory handle.
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new ScreenshotError(ErrorCode.DIRECTORY_UNAVAILABLE, {
          detail: `Could not open IndexedDB: ${request.error?.message}`,
          cause: request.error
        })
      );
  });
}

/**
 * Run one IndexedDB request while its transaction is still active.
 *
 * An IDBObjectStore is usable only for the lifetime of its transaction. The
 * previous helper returned it *after* `oncomplete`, making every later
 * get/put/delete throw TransactionInactiveError (a DOMException).
 *
 * @template T
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} createRequest
 * @returns {Promise<T>}
 */
async function runStoreRequest(mode, createRequest) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let result;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      db.close();
      callback();
    };

    try {
      const tx = db.transaction(STORE_NAME, mode);
      tx.oncomplete = () => finish(() => resolve(result));
      tx.onerror = () => finish(() => reject(new ScreenshotError(ErrorCode.DIRECTORY_UNAVAILABLE, {
        detail: `IndexedDB transaction failed: ${tx.error?.message}`,
        cause: tx.error
      })));
      tx.onabort = () => finish(() => reject(new ScreenshotError(ErrorCode.DIRECTORY_UNAVAILABLE, {
        detail: `IndexedDB transaction aborted: ${tx.error?.message}`,
        cause: tx.error
      })));

      const request = createRequest(tx.objectStore(STORE_NAME));
      request.onsuccess = () => { result = request.result; };
      // Do not prevent the default request-error action: it aborts the
      // transaction and is then reported consistently by the handlers above.
      request.onerror = () => {};
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/** Persist the directory handle chosen by the user. */
export async function setDirectoryHandle(handle) {
  await runStoreRequest('readwrite', (store) => store.put(handle, DIRECTORY_KEY));
}

/** @returns {Promise<FileSystemDirectoryHandle|null>} */
export async function getDirectoryHandle() {
  try {
    return (await runStoreRequest('readonly', (store) => store.get(DIRECTORY_KEY))) || null;
  } catch (error) {
    console.warn('[directory] Could not read the stored directory handle.', error);
    return null;
  }
}

/** Forget the stored handle (used when the user clears the folder). */
export async function clearDirectoryHandle() {
  try {
    await runStoreRequest('readwrite', (store) => store.delete(DIRECTORY_KEY));
    return true;
  } catch (error) {
    console.warn('[directory] Could not clear the stored handle.', error);
    return false;
  }
}

/**
 * Re-check that a stored handle is still usable.
 *
 * Handles survive browser restarts, but the underlying grant can be revoked by
 * the user, or reset when Chrome clears extension site data - so the grant must
 * be verified before relying on it.
 *
 * @param {FileSystemDirectoryHandle} directory
 * @returns {Promise<boolean>}
 */
export async function hasDirectoryPermission(directory) {
  if (!directory) return false;
  if (typeof directory.queryPermission !== 'function') return true;
  try {
    const state = await directory.queryPermission({ mode: 'readwrite' });
    return state === 'granted';
  } catch (error) {
    console.warn('[directory] queryPermission failed.', error);
    return false;
  }
}

/**
 * Ask Chrome to re-grant access. Like showDirectoryPicker(), this requires a
 * user gesture, so it is only callable from the options page.
 *
 * @param {FileSystemDirectoryHandle} directory
 * @returns {Promise<boolean>}
 */
export async function requestDirectoryPermission(directory) {
  if (!directory || typeof directory.requestPermission !== 'function') return false;
  try {
    const state = await directory.requestPermission({ mode: 'readwrite' });
    return state === 'granted';
  } catch (error) {
    console.warn('[directory] requestPermission failed.', error);
    return false;
  }
}

/** True when this browser exposes the File System Access picker. */
export function isDirectoryPickerSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/**
 * Prompt the user for a folder. MUST be called synchronously from a user
 * gesture (a click handler), otherwise Chrome rejects it.
 * @returns {Promise<FileSystemDirectoryHandle|null>} null when the user cancels.
 */
export async function requestDirectory() {
  if (!isDirectoryPickerSupported()) {
    throw new ScreenshotError(ErrorCode.DIRECTORY_UNAVAILABLE, {
      detail: 'window.showDirectoryPicker is not available in this browser.'
    });
  }
  try {
    const handle = await window.showDirectoryPicker({
      id: 'quick-screenshot-save-directory',
      mode: 'readwrite',
      startIn: 'pictures'
    });
    await setDirectoryHandle(handle);
    return handle;
  } catch (error) {
    // AbortError simply means the user dismissed the dialog.
    if (error?.name === 'AbortError') return null;
    throw new ScreenshotError(ErrorCode.DIRECTORY_PERMISSION_DENIED, {
      detail: `Directory picker failed: ${error?.message || error}`,
      cause: error
    });
  }
}
