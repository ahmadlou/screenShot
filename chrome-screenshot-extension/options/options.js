/**
 * options.js
 * Options page controller.
 *
 * Design rule: never claim something is in effect when it is not. The shortcut
 * shown as "Active" is always read from chrome.commands.getAll(), because that
 * is the only source Chrome treats as authoritative.
 */

import {
  loadSettings,
  saveSettings,
  resetSettings,
  sanitizeDownloadFolder,
  SaveMode
} from '../utils/storage.js';
import { buildBaseFilename, sanitizePrefix } from '../utils/filename.js';
import {
  getDirectoryHandle,
  clearDirectoryHandle,
  requestDirectory,
  isDirectoryPickerSupported,
  hasDirectoryPermission
} from '../utils/directory.js';
import { ensureOffscreenPermission } from '../background/offscreen-client.js';

const SHORTCUTS_URL = 'chrome://extensions/shortcuts';
const COMMAND_NAME = 'capture-screenshot';

const el = (id) => document.getElementById(id);

const ui = {
  shortcutDisplay: el('shortcut-display'),
  shortcutHint: el('shortcut-hint'),
  openShortcuts: el('open-shortcuts'),
  shortcutInput: el('shortcut-input'),
  shortcutValidation: el('shortcut-validation'),
  saveShortcut: el('save-shortcut'),
  clearShortcut: el('clear-shortcut'),
  modeDownloads: el('mode-downloads'),
  modeDirectory: el('mode-directory'),
  downloadFolderField: el('download-folder-field'),
  downloadFolder: el('download-folder'),
  directoryField: el('directory-field'),
  chosenFolder: el('chosen-folder'),
  chooseDirectory: el('choose-directory'),
  forgetDirectory: el('forget-directory'),
  filenamePrefix: el('filename-prefix'),
  filenamePreview: el('filename-preview'),
  jpegQuality: el('jpeg-quality'),
  qualityValue: el('quality-value'),
  notificationsEnabled: el('notifications-enabled'),
  errorNotificationsEnabled: el('error-notifications-enabled'),
  testCapture: el('test-capture'),
  resetSettings: el('reset-settings'),
  status: el('status'),
  version: el('version')
};

/** Preferred shortcut recorded from this page (see note in storage.js). */
let desiredShortcut = '';

function setStatus(message, kind = '') {
  ui.status.textContent = message;
  ui.status.className = `status${kind ? ` status--${kind}` : ''}`;
}

/* ------------------------------------------------------------------ *
 * Shortcut validation
 * ------------------------------------------------------------------ */

/** Chrome's reserved browser shortcuts, which can never be claimed. */
const RESERVED_SHORTCUTS = new Set([
  'ctrl+n', 'ctrl+shift+n', 'ctrl+t', 'ctrl+shift+t', 'ctrl+w', 'ctrl+shift+w',
  'ctrl+tab', 'ctrl+shift+tab', 'ctrl+pageup', 'ctrl+pagedown',
  'ctrl+l', 'ctrl+d', 'ctrl+j', 'ctrl+shift+j', 'ctrl+shift+i', 'ctrl+shift+c',
  'ctrl+shift+delete', 'ctrl+shift+q', 'ctrl+f', 'ctrl+f4', 'alt+f4',
  'command+q', 'command+w', 'command+t', 'command+n', 'command+shift+n',
  'command+space', 'command+tab', 'command+shift+a', 'command+option+i',
  'f5', 'f6', 'f11', 'f12', 'command+r', 'command+shift+r'
]);

/** Keys Chrome accepts in a shortcut. */
const VALID_KEYS = new Set([
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'comma', 'period', 'home', 'end', 'pageup', 'pagedown', 'space',
  'insert', 'delete', 'up', 'down', 'left', 'right',
  'plus', 'minus', 'numlock', 'scrolllock'
]);

const MODIFIERS = ['ctrl', 'alt', 'shift', 'command', 'macctrl', 'search'];

/**
 * Validate a shortcut combination against the rules Chrome enforces.
 * @param {string} combination e.g. "Ctrl+Shift+S"
 * @returns {{valid: boolean, reason?: string}}
 */
export function validateShortcut(combination) {
  if (!combination) return { valid: false, reason: 'Press a key combination first.' };

  const parts = combination.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return {
      valid: false,
      reason: 'Include at least one modifier (Ctrl, Alt, Shift or Command) plus a key.'
    };
  }

  const normalized = parts.map((part) => part.toLowerCase());
  const modifiers = normalized.filter((part) => MODIFIERS.includes(part));
  const keys = normalized.filter((part) => !MODIFIERS.includes(part));

  if (keys.length === 0) {
    return { valid: false, reason: 'Add a non-modifier key, for example "S".' };
  }
  if (keys.length > 1) {
    return { valid: false, reason: 'Use exactly one non-modifier key.' };
  }
  if (modifiers.length === 0) {
    return { valid: false, reason: 'A shortcut must include Ctrl, Alt, Shift or Command.' };
  }
  if (new Set(modifiers).size !== modifiers.length) {
    return { valid: false, reason: 'The same modifier is listed more than once.' };
  }
  if (!VALID_KEYS.has(keys[0])) {
    return { valid: false, reason: `"${keys[0].toUpperCase()}" is not a key Chrome accepts.` };
  }
  if (RESERVED_SHORTCUTS.has(normalized.join('+'))) {
    return { valid: false, reason: 'That combination is reserved by Chrome itself.' };
  }
  return { valid: true };
}

/** Build a Chrome-style shortcut string from a keyboard event. */
function combinationFromEvent(event) {
  const parts = [];
  const isMac = navigator.platform.toLowerCase().includes('mac');

  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push(isMac ? 'Command' : 'Ctrl');

  // Ignore modifier-only presses, Escape and Tab so the user can still leave.
  if (['Control', 'Alt', 'Shift', 'Meta', 'Escape', 'Tab'].includes(event.key)) return null;

  const named = {
    ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    '+': 'Plus', '-': 'Minus', ',': 'Comma', '.': 'Period'
  };
  parts.push(named[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : event.key));
  return parts.join('+');
}

/* ------------------------------------------------------------------ *
 * Loading & rendering
 * ------------------------------------------------------------------ */

/** Read the shortcut Chrome really has bound, and reflect it in the UI. */
async function refreshActiveShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const command = commands.find((item) => item.name === COMMAND_NAME);
    // An empty string means the user has not assigned (or has cleared) it.
    const active = command?.shortcut || '';

    if (active) {
      ui.shortcutDisplay.textContent = active;
      ui.shortcutDisplay.classList.remove('shortcut-display--unset');
      ui.shortcutHint.textContent =
        'This is the shortcut Chrome has registered. Pressing it captures the current tab.';
      ui.shortcutHint.classList.remove('hint--error');
    } else {
      ui.shortcutDisplay.textContent = 'Not assigned';
      ui.shortcutDisplay.classList.add('shortcut-display--unset');
      ui.shortcutHint.textContent =
        'No shortcut is currently assigned, so the hotkey will not fire. Use "Change in Chrome" to set one.';
      ui.shortcutHint.classList.add('hint--error');
    }
  } catch (error) {
    console.error('[options] chrome.commands.getAll failed.', error);
    ui.shortcutDisplay.textContent = 'Unavailable';
    ui.shortcutHint.textContent = 'Chrome would not report the shortcut. Try reloading the extension.';
  }
}

/** Reflect the stored directory handle in the UI. */
async function refreshDirectoryStatus() {
  const handle = await getDirectoryHandle();
  if (!handle) {
    ui.chosenFolder.textContent = 'No folder chosen yet.';
    return;
  }
  const granted = await hasDirectoryPermission(handle);
  ui.chosenFolder.textContent = granted
    ? handle.name
    : `${handle.name} (permission needs to be granted again)`;
}

/** Update the filename preview from the current prefix. */
function renderFilenamePreview() {
  const prefix = sanitizePrefix(ui.filenamePrefix.value) || 'photo_';
  ui.filenamePreview.textContent = buildBaseFilename({ prefix, date: new Date() });
}

/** Show only the fields relevant to the selected save mode. */
function renderSaveMode(mode) {
  const isDirectory = mode === SaveMode.DIRECTORY;
  ui.directoryField.hidden = !isDirectory;
  ui.downloadFolderField.hidden = isDirectory;
}

/** Load settings into the form. */
async function hydrate() {
  const settings = await loadSettings();

  desiredShortcut = settings.shortcut;
  ui.modeDownloads.checked = settings.saveMode !== SaveMode.DIRECTORY;
  ui.modeDirectory.checked = settings.saveMode === SaveMode.DIRECTORY;
  ui.downloadFolder.value = settings.downloadFolder;
  ui.filenamePrefix.value = settings.filenamePrefix;
  ui.jpegQuality.value = String(settings.jpegQuality);
  ui.qualityValue.textContent = `${settings.jpegQuality}%`;
  ui.notificationsEnabled.checked = settings.notificationsEnabled;
  ui.errorNotificationsEnabled.checked = settings.errorNotificationsEnabled;

  renderSaveMode(settings.saveMode);
  renderFilenamePreview();
  await refreshActiveShortcut();
  await refreshDirectoryStatus();

  if (!isDirectoryPickerSupported()) {
    ui.chooseDirectory.disabled = true;
    ui.chooseDirectory.title = 'This browser does not support the File System Access API.';
  }
}

/* ------------------------------------------------------------------ *
 * Saving
 * ------------------------------------------------------------------ */

/**
 * Persist every field currently in the form.
 * @param {object} [extra] Values stored verbatim rather than read from a field.
 */
async function persist(extra = {}) {
  const saveMode = ui.modeDirectory.checked ? SaveMode.DIRECTORY : SaveMode.DOWNLOADS;
  return saveSettings({
    shortcut: desiredShortcut,
    saveMode,
    downloadFolder: sanitizeDownloadFolder(ui.downloadFolder.value),
    filenamePrefix: sanitizePrefix(ui.filenamePrefix.value) || 'photo_',
    jpegQuality: Number(ui.jpegQuality.value),
    notificationsEnabled: ui.notificationsEnabled.checked,
    errorNotificationsEnabled: ui.errorNotificationsEnabled.checked,
    ...extra
  });
}

/* ------------------------------------------------------------------ *
 * Event wiring
 * ------------------------------------------------------------------ */

/** Debounce so typing does not trigger a storage write per keystroke. */
function debounce(fn, delay = 400) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const persistDebounced = debounce(async () => {
  try {
    await persist();
  } catch (error) {
    console.error('[options] Failed to save settings.', error);
    setStatus('Could not save your settings. See the console for details.', 'error');
  }
});

function init() {
  ui.version.textContent = `v${chrome.runtime.getManifest().version}`;

  hydrate().catch((error) => {
    console.error('[options] Failed to initialise.', error);
    setStatus('Could not load your settings. Try reloading the page.', 'error');
  });

  /* ---- Shortcut ---- */

  ui.shortcutInput.addEventListener('keydown', (event) => {
    const combination = combinationFromEvent(event);
    // Modifier-only presses and Tab/Escape are ignored *before* preventDefault,
    // so the user can still tab away or dismiss the field.
    if (!combination) return;
    event.preventDefault();

    desiredShortcut = combination;
    ui.shortcutInput.value = combination;

    const result = validateShortcut(combination);
    ui.shortcutInput.classList.toggle('input--valid', result.valid);
    ui.shortcutInput.classList.toggle('input--invalid', !result.valid);
    ui.shortcutValidation.className = `hint ${result.valid ? 'hint--success' : 'hint--error'}`;
    ui.shortcutValidation.textContent = result.valid
      ? 'Looks valid. Choose "Change in Chrome" to actually apply it.'
      : result.reason;
  });

  ui.saveShortcut.addEventListener('click', async () => {
    const result = validateShortcut(desiredShortcut);
    if (!result.valid) {
      setStatus(result.reason, 'error');
      return;
    }
    await persist();
    setStatus(
      `Saved "${desiredShortcut}" as your preferred shortcut. Apply it with "Change in Chrome" to activate it.`,
      'ok'
    );
  });

  ui.clearShortcut.addEventListener('click', async () => {
    desiredShortcut = '';
    ui.shortcutInput.value = '';
    ui.shortcutInput.classList.remove('input--valid', 'input--invalid');
    ui.shortcutValidation.className = 'hint';
    ui.shortcutValidation.textContent = 'Press a combination such as Ctrl+Shift+S to check it.';
    await persist();
    setStatus('Cleared the stored shortcut preference.', 'ok');
  });

  ui.openShortcuts.addEventListener('click', () => {
    // An extension cannot navigate to or script chrome:// pages, so the URL is
    // handed to the user to paste into the address bar.
    navigator.clipboard
      .writeText(SHORTCUTS_URL)
      .then(() =>
        setStatus(
          `Copied "${SHORTCUTS_URL}" to your clipboard. Paste it in the address bar, find "Quick Screenshot" and set the shortcut there.`,
          'busy'
        )
      )
      .catch(() =>
        setStatus(`Open ${SHORTCUTS_URL} in the address bar and set the shortcut there.`, 'busy')
      );
  });

  /* ---- Save mode ---- */

  const onModeChange = async () => {
    renderSaveMode(ui.modeDirectory.checked ? SaveMode.DIRECTORY : SaveMode.DOWNLOADS);
    await persist();
  };
  ui.modeDownloads.addEventListener('change', onModeChange);
  ui.modeDirectory.addEventListener('change', onModeChange);

  ui.chooseDirectory.addEventListener('click', async () => {
    try {
      // Requested here because this click is the user gesture Chrome requires.
      const granted = await ensureOffscreenPermission();
      if (!granted) {
        setStatus('The permission needed to write to a chosen folder was not granted.', 'error');
        return;
      }

      const handle = await requestDirectory();
      if (!handle) {
        setStatus('Folder selection was cancelled.', '');
        return;
      }
      // Store the display name so the popup can show the destination directly.
      await persist({ selectedDirectoryName: handle.name });
      renderSaveMode(SaveMode.DIRECTORY);
      await refreshDirectoryStatus();
      setStatus(`Screenshots will be saved to "${handle.name}".`, 'ok');
    } catch (error) {
      console.error('[options] Could not select a folder.', error);
      setStatus(
        error?.userMessage || 'Could not open the folder picker. See the console for details.',
        'error'
      );
    }
  });

  ui.forgetDirectory.addEventListener('click', async () => {
    await clearDirectoryHandle();
    renderSaveMode(SaveMode.DOWNLOADS);
    await persist({ selectedDirectoryName: '' });
    await refreshDirectoryStatus();
    setStatus('Folder forgotten. Switched back to the Downloads folder.', 'ok');
  });

  /* ---- Other settings ---- */

  ui.downloadFolder.addEventListener('input', persistDebounced);
  ui.filenamePrefix.addEventListener('input', () => {
    renderFilenamePreview();
    persistDebounced();
  });
  ui.jpegQuality.addEventListener('input', () => {
    ui.qualityValue.textContent = `${ui.jpegQuality.value}%`;
    persistDebounced();
  });
  ui.notificationsEnabled.addEventListener('change', persistDebounced);
  ui.errorNotificationsEnabled.addEventListener('change', persistDebounced);

  /* ---- Test & reset ---- */

  ui.testCapture.addEventListener('click', async () => {
    ui.testCapture.disabled = true;
    setStatus('Capturing…', 'busy');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'capture-now' });
      if (response?.ok) {
        setStatus(`Saved ${response.filename}`, 'ok');
      } else {
        setStatus(response?.error?.message || 'The screenshot failed.', 'error');
      }
    } catch (error) {
      console.error('[options] Test capture failed.', error);
      setStatus('The test capture failed. See the console for details.', 'error');
    } finally {
      ui.testCapture.disabled = false;
    }
  });

  ui.resetSettings.addEventListener('click', async () => {
    await resetSettings();
    await clearDirectoryHandle();
    await hydrate();
    setStatus('Settings restored to their defaults.', 'ok');
  });

  // Keep the "Active shortcut" line honest if it changes in another tab.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshActiveShortcut();
  });
}

init();



