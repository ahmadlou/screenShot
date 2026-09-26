/**
 * notifications.js
 * Non-blocking user feedback.
 *
 * The "notifications" permission is declared as OPTIONAL in the manifest, so this
 * module degrades gracefully: if the permission was never granted every function
 * becomes a no-op instead of throwing.
 */

/** Notification ids are timestamped so repeats never overwrite one another. */
let counter = 0;

function nextId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

/** True when the optional notifications permission is currently granted. */
export function notificationsAvailable() {
  return typeof chrome !== 'undefined' && !!chrome.notifications?.create;
}

/**
 * Show a transient success message.
 * @param {string} title
 * @param {string} message
 */
export async function notifySuccess(title, message) {
  if (!notificationsAvailable()) return;
  try {
    const id = nextId('qs-success');
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 0
    });
    // Auto-dismiss so the desktop is not left cluttered.
    setTimeout(() => {
      chrome.notifications.clear(id).catch(() => {});
    }, 2500);
  } catch (error) {
    console.warn('[notifications] Could not show the success notification.', error);
  }
}

/**
 * Show a transient, non-blocking error message. This is the only user-facing
 * surface used on failure - no dialogs, ever.
 * @param {string} title
 * @param {string} message
 */
export async function notifyError(title, message) {
  if (!notificationsAvailable()) return;
  try {
    const id = nextId('qs-error');
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 1
    });
    setTimeout(() => {
      chrome.notifications.clear(id).catch(() => {});
    }, 6000);
  } catch (error) {
    console.warn('[notifications] Could not show the error notification.', error);
  }
}
