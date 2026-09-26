/**
 * errors.js
 * Typed error codes so every failure mode has a clear, user-facing message and
 * a distinct technical detail for the console. Nothing here ever throws an
 * unhandled value at Chrome's event plumbing.
 */

export const ErrorCode = Object.freeze({
  NO_ACTIVE_TAB: 'NO_ACTIVE_TAB',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  RESTRICTED_PAGE: 'RESTRICTED_PAGE',
  JPEG_CONVERSION_FAILED: 'JPEG_CONVERSION_FAILED',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  INVALID_FILENAME: 'INVALID_FILENAME',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  DIRECTORY_PERMISSION_DENIED: 'DIRECTORY_PERMISSION_DENIED',
  DIRECTORY_UNAVAILABLE: 'DIRECTORY_UNAVAILABLE',
  FILE_WRITE_FAILED: 'FILE_WRITE_FAILED',
  SETTINGS_FAILED: 'SETTINGS_FAILED',
  BUSY: 'BUSY',
  UNKNOWN: 'UNKNOWN'
});

/** Human readable, non-blocking messages. Kept short so notifications stay small. */
const MESSAGES = {
  [ErrorCode.NO_ACTIVE_TAB]: 'No active tab to capture.',
  [ErrorCode.CAPTURE_FAILED]: 'Could not capture the current tab.',
  [ErrorCode.RESTRICTED_PAGE]:
    'This page cannot be captured. Chrome blocks extensions on internal pages such as chrome://, the Web Store and other extensions.',
  [ErrorCode.JPEG_CONVERSION_FAILED]: 'Could not convert the captured image to JPG.',
  [ErrorCode.IMAGE_TOO_LARGE]: 'The captured image is too large to process safely.',
  [ErrorCode.INVALID_FILENAME]: 'Could not build a valid file name.',
  [ErrorCode.DOWNLOAD_FAILED]: 'Chrome refused to save the file.',
  [ErrorCode.DIRECTORY_PERMISSION_DENIED]:
    'Access to the chosen folder was not granted. Re-select it in the options page.',
  [ErrorCode.DIRECTORY_UNAVAILABLE]: 'No save folder has been configured yet.',
  [ErrorCode.FILE_WRITE_FAILED]: 'Could not write the file to the chosen folder.',
  [ErrorCode.SETTINGS_FAILED]: 'Could not read or write the extension settings.',
  [ErrorCode.BUSY]: 'A screenshot is already being saved. Please try again.',
  [ErrorCode.UNKNOWN]: 'The screenshot could not be saved.'
};

export class ScreenshotError extends Error {
  /**
   * @param {string} code One of ErrorCode.
   * @param {object} [options]
   * @param {string} [options.detail] Technical detail for the console only.
   * @param {Error}  [options.cause]  Original error, preserved for diagnostics.
   * @param {boolean}[options.recoverable] Whether re-trying later could succeed.
   */
  constructor(code, { detail = '', cause = null, recoverable = true } = {}) {
    super(MESSAGES[code] || MESSAGES[ErrorCode.UNKNOWN]);
    this.name = 'ScreenshotError';
    this.code = code;
    this.detail = detail;
    this.cause = cause;
    this.recoverable = recoverable;
  }

  get userMessage() {
    return MESSAGES[this.code] || MESSAGES[ErrorCode.UNKNOWN];
  }
}

/** Normalise anything thrown into a ScreenshotError so callers can rely on .code. */
export function toScreenshotError(error, fallbackCode = ErrorCode.UNKNOWN) {
  if (error instanceof ScreenshotError) return error;
  const detail = error?.message || String(error);
  return new ScreenshotError(fallbackCode, { detail, cause: error });
}

/**
 * Chrome throws opaque strings for protected pages. Detect them so the user gets
 * an accurate explanation instead of a generic failure.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRestrictedPageError(error) {
  const text = `${error?.message || ''} ${error || ''}`.toLowerCase();
  if (!text) return false;
  return (
    text.includes('cannot access') ||
    text.includes('chrome://') ||
    text.includes('chrome-extension://') ||
    text.includes('extension manifest must request permission') ||
    text.includes('active tab') ||
    text.includes('the tab was closed')
  );
}
