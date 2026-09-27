/**
 * A small control hosted in a shadow root so page CSS cannot restyle it.
 * This script may be registered dynamically and injected again into an already
 * open tab, so the global guard is intentional.
 */
const HOST_ID = '__quick_screenshot_floating_button__';

if (!document.getElementById(HOST_ID)) {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('aria-hidden', 'false');
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('display', 'contents', 'important');
  document.documentElement.append(host);

  const root = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.type = 'button';
  button.title = 'Take screenshot';
  button.setAttribute('aria-label', 'Take screenshot');
  button.textContent = '📷';

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    button {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483647;
      box-sizing: border-box;
      width: 44px;
      height: 44px;
      padding: 0;
      border: 1px solid rgba(255, 255, 255, .8);
      border-radius: 50%;
      color: #fff;
      background: #175cd3;
      box-shadow: 0 3px 12px rgba(0, 0, 0, .28);
      cursor: pointer;
      font: 20px/1 system-ui, sans-serif;
      opacity: .28;
      transition: opacity .15s ease, transform .15s ease, background .15s ease;
    }
    button:hover, button:focus-visible { opacity: .95; outline: none; }
    button:focus-visible { box-shadow: 0 0 0 3px #fff, 0 0 0 6px #175cd3; }
    button:active { transform: scale(.94); }
    button[disabled] { cursor: progress; opacity: .65; }
    button[data-result="error"] { background: #b42318; opacity: .95; }
  `;
  root.append(style, button);

  const nextPaint = () => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;

    button.disabled = true;
    button.style.visibility = 'hidden';
    // Ensure the compositor has removed the control before captureVisibleTab().
    await nextPaint();

    try {
      const result = await chrome.runtime.sendMessage({ type: 'capture-now' });
      button.dataset.result = result?.ok ? 'ok' : 'error';
      button.title = result?.ok ? 'Screenshot saved' : (result?.error?.message || 'Screenshot failed');
    } catch (error) {
      console.error('[quick-screenshot] Floating button capture failed.', error);
      button.dataset.result = 'error';
      button.title = 'Screenshot failed';
    } finally {
      button.style.visibility = '';
      button.disabled = false;
      setTimeout(() => {
        delete button.dataset.result;
        button.title = 'Take screenshot';
      }, 1800);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'floating-button-disable') host.remove();
  });
}
