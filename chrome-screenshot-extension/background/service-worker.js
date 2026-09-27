/**
 * service-worker.js
 * Background orchestrator for Quick Screenshot.
 *
 * Chrome MV3 note: the service worker is event-driven and is suspended after ~30s
 * of inactivity, so there is no long-lived state here. Everything needed to take
 * a screenshot (settings, directory handle) is re-read on each capture, which is
 * why the extension keeps working across suspensions and restarts.
 */

import { ErrorCode, ScreenshotError, toScreenshotError, isRestrictedPageError } from '../utils/errors.js';
import { loadSettings, SaveMode } from '../utils/storage.js';
import { captureAsJpeg } from '../utils/screenshot.js';
import { createUniqueFilename, assertValidFilename, joinPath } from '../utils/filename.js';
import { getDirectoryHandle } from '../utils/directory.js';
import {
  saveWithDownloads,
  confirmDownload,
  createDirectoryProbe,
  hasDirectoryPermission
} from '../utils/saver.js';
import { notifySuccess, notifyError } from '../utils/notifications.js';
import { withOffscreenDocument } from './offscreen-client.js';

const LOG = '[quick-screenshot]';
const FLOATING_BUTTON_SCRIPT_ID = 'floating-screenshot-button';
const FLOATING_BUTTON_ORIGINS = ['http://*/*', 'https://*/*'];

/**
 * Captures are serialised through this promise chain. Without it, two fast
 * presses of the hotkey could both pick the same filename and race the save.
 */
let captureQueue = Promise.resolve();

/**
 * Save a JPEG data URL through the Downloads API.
 * @returns {Promise<{path: string}>}
 */
async function saveViaDownloads({ dataUrl, folder, filename }) {
  const path = joinPath(folder, filename);
  const { downloadId } = await saveWithDownloads({ dataUrl, path });
  const { path: finalPath } = await confirmDownload(downloadId);
  return { path: finalPath || path };
}

/**
 * Save a JPEG data URL directly into the user-granted folder.
 * @returns {Promise<{path: string}>}
 */
async function saveViaDirectory({ dataUrl, filename }) {
  const response = await withOffscreenDocument((send) =>
    send({ type: 'write-file', filename, dataUrl })
  );

  if (!response?.ok) {
    const code = response?.code || ErrorCode.FILE_WRITE_FAILED;
    console.error(`${LOG} Directory write rejected:`, response?.detail || response);
    throw new ScreenshotError(code, { detail: response?.detail || 'Unknown directory write error.' });
  }
  return { path: response.path };
}

/**
 * Determine the destination folder and, in directory mode, the uniqueness probe.
 * @returns {Promise<{folder: string, exists?: (name: string) => Promise<boolean>}>}
 */
async function resolveDestination(settings) {
  if (settings.saveMode === SaveMode.DIRECTORY) {
    const directory = await getDirectoryHandle();
    if (!directory) {
      throw new ScreenshotError(ErrorCode.DIRECTORY_UNAVAILABLE, {
        detail: 'Directory mode is selected but no folder has been granted.'
      });
    }
    if (!(await hasDirectoryPermission(directory))) {
      throw new ScreenshotError(ErrorCode.DIRECTORY_PERMISSION_DENIED, {
        detail: 'The granted folder is no longer writable.' });
    }
    // Writes go directly to the folder root; no sub-path is supported here.
    return { folder: '', exists: createDirectoryProbe(directory) };
  }
  return { folder: settings.downloadFolder };
}


/**
 * The raw capture pipeline. Never throws: failures are converted into a result
 * object so no listener ever rejects and kills the event handler.
 *
 * Callers should use performCapture(), which serialises concurrent requests.
 *
 * @param {object} [options]
 * @param {number} [options.windowId] Window to capture; defaults to the active one.
 * @returns {Promise<{ok: boolean, filename?: string, path?: string, error?: object}>}
 */
async function runCapture({ windowId } = {}) {
  let settings;
  try {
    settings = await loadSettings();
  } catch (error) {
    console.error(`${LOG} Could not load settings.`, error);
    return failure(new ScreenshotError(ErrorCode.SETTINGS_FAILED, {
      detail: `loadSettings threw: ${error?.message || error}`,
      cause: error
    }));
  }

  const targetWindow = windowId ?? chrome.windows.WINDOW_ID_CURRENT;

  try {
    // 1. Capture + PNG->JPEG conversion.
    const image = await captureAsJpeg({ quality: settings.jpegQuality, windowId: targetWindow });
    console.log(`${LOG} Captured ${image.width}x${image.height} (${image.bytes} bytes JPEG).`);

    // 2. Work out where it goes.
    const { folder, exists } = await resolveDestination(settings);

    // 3. Build a name that cannot overwrite anything.
    const { filename } = await createUniqueFilename({
      prefix: settings.filenamePrefix,
      date: new Date(),
      folder,
      exists,
      // In directory mode `exists` already covers collisions.
      checkDownloads: !exists
    });
    assertValidFilename(filename);

    // 4. Persist it.
    const saved =
      settings.saveMode === SaveMode.DIRECTORY
        ? await saveViaDirectory({ dataUrl: image.dataUrl, filename })
        : await saveViaDownloads({ dataUrl: image.dataUrl, folder, filename });

    console.log(`${LOG} Saved ${saved.path}`);

    // 5. Optional, off by default.
    if (settings.notificationsEnabled) {
      await notifySuccess('Screenshot saved', filename);
    }

    return { ok: true, filename, path: saved.path };
  } catch (error) {
    const screenshotError = toScreenshotError(error);

    // Refine a generic capture failure into the restricted-page case.
    if (screenshotError.code === ErrorCode.CAPTURE_FAILED &&
        isRestrictedPageError(screenshotError.cause)) {
      return failure(new ScreenshotError(ErrorCode.RESTRICTED_PAGE, {
        detail: screenshotError.detail,
        cause: screenshotError.cause
      }));
    }
    return failure(screenshotError, settings);
  }
}

/**
 * Log, notify (respecting the user's preference) and shape an error result.
 * @param {ScreenshotError} error
 * @param {object} [settings]
 */
function failure(error, settings) {
  console.error(`${LOG} ${error.code}: ${error.detail || error.message}`, error.cause || '');

  // Errors are worth surfacing by default; success is silent by default.
  if (!settings || settings.errorNotificationsEnabled !== false) {
    void notifyError('Screenshot failed', error.userMessage);
  }
  return {
    ok: false,
    error: { code: error.code, message: error.userMessage, detail: error.detail }
  };
}

/**
 * Public entry point for taking a screenshot.
 *
 * Captures are serialised through a promise queue so that repeated hotkey
 * presses are handled one after another. Without this, two rapid presses could
 * both observe the same filename as free and race each other on the write.
 * Serialising here rather than in the event listeners means no caller can
 * accidentally bypass it.
 *
 * @param {object} [options]
 * @param {number} [options.windowId]
 * @returns {Promise<object>} Always resolves with a result object.
 */
export function performCapture(options) {
  const result = captureQueue.then(() => runCapture(options), () => runCapture(options));
  // Swallow rejections on the chain itself so one failure cannot poison the queue.
  captureQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Keep the optional site-wide button registered only while it is enabled. */
async function syncFloatingButton() {
  const settings = await loadSettings();
  const granted = await chrome.permissions.contains({ origins: FLOATING_BUTTON_ORIGINS });
  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [FLOATING_BUTTON_SCRIPT_ID]
  });

  if (!settings.floatingButtonEnabled || !granted) {
    if (registered.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [FLOATING_BUTTON_SCRIPT_ID] });
    }
    return;
  }

  if (!registered.length) {
    await chrome.scripting.registerContentScripts([{
      id: FLOATING_BUTTON_SCRIPT_ID,
      matches: FLOATING_BUTTON_ORIGINS,
      js: ['content/floating-button.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true
    }]);
  }

  // Dynamic registration affects future documents. Inject once into already
  // open permitted tabs too; the content script is deliberately idempotent.
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((tab) => chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/floating-button.js']
  })));
}

/** Ask every live in-page control to disappear immediately. */
async function hideFloatingButtons() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, {
    type: 'floating-button-disable'
  })));
}

/* ------------------------------------------------------------------ *
 * Event listeners.
 * These MUST be registered synchronously at the top level of the module
 * so Chrome can wake the service worker to deliver the events.
 * ------------------------------------------------------------------ */

// The configurable keyboard shortcut. Chrome grants activeTab as part of this
// gesture, which is what allows captureVisibleTab() without host permissions.
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'capture-screenshot') return;
  console.log(`${LOG} Hotkey received.`);
  void performCapture();
});

// Popup / options page can trigger a capture on demand.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'capture-now') {
    performCapture({ windowId: message.windowId ?? sender?.tab?.windowId })
      .then(sendResponse)
      .catch((error) => {
        console.error(`${LOG} Manual capture failed.`, error);
        sendResponse({
          ok: false,
          error: { code: ErrorCode.UNKNOWN, message: 'Capture failed.', detail: String(error) }
        });
      });
    return true; // Respond asynchronously.
  }

  // Report the shortcut Chrome actually has bound (the only authoritative source).
  if (message?.type === 'get-shortcut-info') {
    chrome.commands.getAll()
      .then((commands) => sendResponse({ ok: true, commands }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === 'sync-floating-button') {
    syncFloatingButton()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error(`${LOG} Could not sync floating button.`, error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (message?.type === 'hide-floating-button') {
    hideFloatingButtons()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`${LOG} Installed/updated (${details.reason}).`);
  // Open options on first install so the user can set the folder immediately.
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.runtime.openOptionsPage();
  }
  void syncFloatingButton();
});

chrome.runtime.onStartup.addListener(() => {
  void syncFloatingButton();
});
