/**
 * popup.js
 * Toolbar popup: shows the real shortcut, the current save destination and a
 * manual capture button (useful for testing and for pages where the hotkey is
 * inconvenient to reach).
 */

import { loadSettings, SaveMode } from '../utils/storage.js';
import { buildBaseFilename } from '../utils/filename.js';

const el = (id) => document.getElementById(id);

const ui = {
  shortcut: el('shortcut'),
  capture: el('capture'),
  status: el('status'),
  destination: el('destination'),
  filenamePattern: el('filename-pattern'),
  quality: el('quality'),
  openOptions: el('open-options')
};

function setStatus(message, kind = '') {
  ui.status.textContent = message;
  ui.status.className = `status${kind ? ` status--${kind}` : ''}`;
}

/** Read the shortcut Chrome actually has bound, so we never show a stale value. */
async function showShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const command = commands.find((item) => item.name === 'capture-screenshot');
    if (command?.shortcut) {
      ui.shortcut.textContent = command.shortcut;
    } else {
      ui.shortcut.textContent = 'No shortcut assigned — set one in Settings';
      ui.shortcut.classList.add('popup__shortcut--unset');
    }
  } catch (error) {
    console.error('[popup] Could not read the shortcut.', error);
    ui.shortcut.textContent = 'Shortcut unavailable';
  }
}

/** Summarise where screenshots will end up. */
async function showSettings() {
  const settings = await loadSettings();

  if (settings.saveMode === SaveMode.DIRECTORY) {
    ui.destination.textContent =
      settings.selectedDirectoryName || 'Chosen folder (not set)';
  } else {
    ui.destination.textContent = settings.downloadFolder
      ? `Downloads/${settings.downloadFolder}`
      : 'Downloads folder';
  }

  ui.filenamePattern.textContent = buildBaseFilename({
    prefix: settings.filenamePrefix,
    date: new Date()
  });
  ui.quality.textContent = `${settings.jpegQuality}%`;
}

ui.capture.addEventListener('click', async () => {
  ui.capture.disabled = true;
  setStatus('Capturing…', 'busy');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'capture-now' });
    if (response?.ok) {
      setStatus(`Saved ${response.filename}`, 'ok');
    } else {
      setStatus(response?.error?.message || 'The screenshot failed.', 'error');
    }
  } catch (error) {
    console.error('[popup] Capture failed.', error);
    setStatus('The screenshot failed. See the console for details.', 'error');
  } finally {
    ui.capture.disabled = false;
  }
});

ui.openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

Promise.all([showShortcut(), showSettings()]).catch((error) => {
  console.error('[popup] Failed to initialise.', error);
  setStatus('Could not load settings.', 'error');
});
