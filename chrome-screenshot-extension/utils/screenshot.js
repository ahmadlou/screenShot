/**
 * screenshot.js
 * Captures the visible viewport of the active tab and converts it to JPEG.
 *
 * Notes on Chrome behaviour:
 *  - chrome.tabs.captureVisibleTab() returns a PNG data URL. JPEG is not a
 *    supported output format for this API, so we re-encode through
 *    OffscreenCanvas (available in MV3 service workers) to meet the .jpg
 *    requirement.
 *  - captureVisibleTab() only returns the page's visible area; browser chrome
 *    (tabs, toolbar, omnibox) is never included.
 *  - activeTab is granted by the invoking gesture (toolbar click or the
 *    chrome.commands shortcut), so no <all_urls> host permission is needed.
 */

import { ErrorCode, ScreenshotError, isRestrictedPageError } from './errors.js';

/**
 * Captures a PNG data URL from the active tab.
 * @param {object} [options]
 * @param {number} [options.windowId] Defaults to the current window.
 * @returns {Promise<string>} PNG data URL.
 */
export async function captureVisiblePng({ windowId } = {}) {
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (error) {
    if (isRestrictedPageError(error)) {
      throw new ScreenshotError(ErrorCode.RESTRICTED_PAGE, {
        detail: `captureVisibleTab rejected by Chrome: ${error?.message || error}`,
        cause: error
      });
    }
    throw new ScreenshotError(ErrorCode.CAPTURE_FAILED, {
      detail: `captureVisibleTab failed: ${error?.message || error}`,
      cause: error
    });
  }

  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new ScreenshotError(ErrorCode.CAPTURE_FAILED, {
      detail: 'captureVisibleTab returned an unexpected payload.'
    });
  }
  return dataUrl;
}

/**
 * Decode a data URL into an ImageBitmap.
 * @param {string} dataUrl
 * @returns {Promise<ImageBitmap>}
 */
async function decode(dataUrl) {
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch (error) {
    throw new ScreenshotError(ErrorCode.CAPTURE_FAILED, {
      detail: `Could not decode the captured image: ${error?.message || error}`,
      cause: error
    });
  }
}

/**
 * Re-encode a captured PNG data URL as JPEG at the requested quality.
 *
 * @param {string} dataUrl PNG data URL from captureVisibleTab().
 * @param {number} quality 70-100.
 * @returns {Promise<{dataUrl: string, width: number, height: number, bytes: number}>}
 */
export async function convertToJpeg(dataUrl, quality) {
  const bitmap = await decode(dataUrl);
  const { width, height } = bitmap;

  if (!width || !height) {
    bitmap.close?.();
    throw new ScreenshotError(ErrorCode.CAPTURE_FAILED, {
      detail: 'Decoded image reported zero dimensions.'
    });
  }

  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });

    if (!context) {
      throw new Error('2D context unavailable for OffscreenCanvas.');
    }

    // JPEG has no alpha channel; painting an opaque white base first prevents
    // transparent regions from turning black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: Math.min(1, Math.max(0.7, quality / 100))
    });

    if (!blob || blob.type !== 'image/jpeg') {
      throw new Error(`Encoder returned unexpected type: ${blob?.type}`);
    }

    const buffer = await blob.arrayBuffer();
    return {
      dataUrl: `data:image/jpeg;base64,${arrayBufferToBase64(buffer)}`,
      width,
      height,
      bytes: blob.size
    };
  } catch (error) {
    throw new ScreenshotError(ErrorCode.JPEG_CONVERSION_FAILED, {
      detail: `PNG->JPEG conversion failed for ${width}x${height}: ${error?.message || error}`,
      cause: error
    });
  } finally {
    bitmap.close?.();
  }
}

/**
 * Base64-encode an ArrayBuffer without blowing the argument limit of
 * String.fromCharCode on large screenshots (4K+ images exceed it).
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32kB, safe for apply() argument limits.
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Full pipeline: capture the active tab and return JPEG bytes.
 * @param {object} options
 * @param {number} options.quality 70-100.
 * @param {number} [options.windowId]
 */
export async function captureAsJpeg({ quality, windowId } = {}) {
  const png = await captureVisiblePng({ windowId });
  return convertToJpeg(png, quality);
}
