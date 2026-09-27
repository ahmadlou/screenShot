# Quick Screenshot

A Chrome extension (Manifest V3) that captures a screenshot of the visible tab
whenever you press a keyboard shortcut, converts it to JPG and saves it
automatically. No dialogs, no new tabs, no interruption.

Everything runs locally. There is no server, no telemetry and no network access
of any kind.

---

## Installation

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `chrome-screenshot-extension` directory (the folder containing
   `manifest.json`)
5. The options page opens automatically on first install. If it does not, click
   the extension's **Details → Extension options**
6. Configure the shortcut (see below)
7. Configure the download folder
8. Press the hotkey to test

> Loading a different folder, or moving the folder on disk, requires removing
> and re-adding the extension.

---

## Default configuration

| Setting          | Default                      |
| ---------------- | ---------------------------- |
| Shortcut         | `Ctrl+Shift+S`               |
| Filename prefix  | `photo_`                     |
| Format           | JPG                          |
| JPEG quality     | 92%                          |
| Notifications    | Disabled                     |
| Save location    | `Downloads/Screenshots`      |

Saving is **always silent**: the extension always writes straight to the folder
configured below, with no Save As dialog and no confirmation step. There is no
setting to turn a dialog on.

Resulting filename: `photo_2026-09-26_19-58-32.jpg`

---

## Two things Chrome does not allow

These are real platform limits, not shortcuts taken in this implementation. The
options page states both of them in plain language.

### 1. An extension cannot set its own keyboard shortcut

`chrome.commands` exposes exactly two things: `getAll()` (read the binding) and
`onCommand` (receive the keystroke). There is **no** `update()`, `set()` or
equivalent method — by design, so an extension can never silently claim a
combination the user is relying on.

**What this extension does instead:**

- Declares `capture-screenshot` with `Ctrl+Shift+S` as the suggested key
  (`manifest.json`). Chrome registers this automatically on install.
- The options page reads the **real** binding from `chrome.commands.getAll()`
  and labels it "Active shortcut". It never shows a value from its own storage,
  so it cannot drift out of sync with what Chrome will actually do.
- A recorder lets you press a combination and validates it against Chrome's
  actual rules (modifier required, one non-modifier key, no duplicates, not a
  browser-reserved shortcut such as `Ctrl+T` or `Command+Q`).
- "Change in Chrome" copies `chrome://extensions/shortcuts` to the clipboard,
  because an extension cannot open or script a `chrome://` page itself. Applying
  the change there is a two-click operation.

The stored `shortcut` preference is used only to show a recommendation and to
detect drift. It is never what makes the hotkey fire.

### 2. An extension cannot silently write to an arbitrary absolute path

`chrome.downloads.download({filename})` resolves `filename` **relative to the
browser's download directory** and rejects absolute paths and `..` traversal.
There is no supported way to write silently to `C:\Screenshots` through it.

**The two supported save modes:**

| Mode                 | Mechanism                        | Can it target `C:\Screenshots`? |
| -------------------- | -------------------------------- | ------------------------------ |
| **Downloads folder** | `chrome.downloads`, `saveAs:false` | No — relative sub-folder only |
| **Folder you choose** | File System Access API           | **Yes**                         |

**Downloads-folder mode** (default) is fully automatic. The sub-folder you
configure is created under the browser's download directory. The base directory
itself is controlled by Chrome at `chrome://settings/downloads` and cannot be
changed by an extension.

**Folder-you-choose mode** uses `showDirectoryPicker()` to obtain a
`FileSystemDirectoryHandle` for a real folder. Chrome shows a one-time grant
prompt; after that, saving is automatic with no further prompts. The handle is
stored in IndexedDB (a `FileSystemDirectoryHandle` cannot be serialized into
`chrome.storage`), and the write is performed from a short-lived **offscreen
document**, because `showDirectoryPicker` needs a user gesture (so the picker
runs on the options page) while `FileSystemWritableFileStream` needs a DOM
context.

The grant survives browser restarts, but the user can revoke it at any time, and
clearing Chrome's site data removes it. If saves start failing with a permission
error, choose the folder again. If the grant is in a `prompt` state, it cannot be
silently upgraded, because `requestPermission()` also requires a gesture.


---

## How a capture works

```
Press hotkey
  ↓
chrome.commands.onCommand  →  activeTab granted for the active tab
  ↓
chrome.tabs.captureVisibleTab()   → PNG data URL of the page viewport only
  ↓
OffscreenCanvas  →  re-encode to JPEG at the configured quality
  ↓
Unique filename  →  photo_YYYY-MM-DD_HH-mm-ss.jpg
  ↓
chrome.downloads.download({saveAs:false})  |  File System Access write
  ↓
Done — no dialog, no tab switch, no focus change
```

Only the page's visible area is captured. Browser UI (tabs, toolbar, omnibox)
is never included, and neither is anything scrolled outside the viewport.

### Why the PNG → JPEG step

`captureVisibleTab()` only produces PNG, and the required output is `.jpg`. The
extension re-encodes through `OffscreenCanvas.convertToBlob({type:'image/jpeg'})`
in the service worker. The canvas is first filled with opaque white, because JPEG
has no alpha channel and transparent regions would otherwise come out black.

### Why filenames can never collide

`createUniqueFilename()` first checks whether the timestamped name is already
taken and, if so, appends milliseconds, then an incrementing counter
(`photo_2026-09-26_19-58-32_417.jpg`, `..._2.jpg`). `chrome.downloads` is also
called with `conflictAction: 'uniquify'` as a final safety net, and the
File System Access writer probes the real directory with `getFileHandle()`. There
is no code path that overwrites an existing file.

Captures are serialised through a promise queue, so pressing the hotkey several
times quickly produces several correctly-named files rather than a race on one
name.

---

## Permissions

| Permission                 | Why it is needed |
| -------------------------- | ---------------- |
| `activeTab`                | `captureVisibleTab()` for the tab the user is on. Granted by the hotkey or toolbar click, so **no** `<all_urls>` host permission is requested. |
| `downloads`                | Saving the file without a dialog. |
| `storage`                  | `chrome.storage.local` for your settings. |
| `scripting`                | Registers the optional floating capture button after the user enables it. |
| `notifications` (optional) | Only requested if you turn notifications on. |
| `offscreen` (optional)     | Only requested if you choose the folder-you-choose mode. |
| Website access (optional)  | Requested only when you enable the floating capture button; removed again when it is disabled. |

Not requested: `<all_urls>` as a required permission, `tabs`, `webRequest`,
`cookies`, `history`, `debugger`.

### Floating capture button

In **Options → Notifications & behaviour**, enable **Show a floating screenshot
button on websites**. Chrome then asks for website access, and a low-opacity
camera button appears at the lower-right of normal HTTP(S) pages. It becomes
nearly opaque on hover or keyboard focus. The control hides for two rendered
frames before the capture begins, so it is not present in the saved JPG.

This feature cannot run on Chrome internal pages, the Chrome Web Store,
DevTools, other extensions, or other pages Chrome restricts. Switching the
setting off removes both the controls in open pages and the optional website
permission.

---

## Privacy

- Screenshots are never uploaded, and never leave the machine.
- No analytics, no external APIs, no fonts or scripts loaded from the network.
- No browsing history, page content or tab URLs are collected or stored.
- `chrome.storage.local` holds only the settings shown in the options page.

---

## Project structure

```
chrome-screenshot-extension/
├── manifest.json
├── background/
│   ├── service-worker.js      capture pipeline, command + message listeners
│   ├── offscreen-client.js    creates/tears down the offscreen document
│   ├── offscreen.html         hidden document (DOM context for file writes)
│   └── offscreen.js           File System Access write handler
├── options/
│   ├── options.html
│   ├── options.css
│   └── options.js
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── utils/
│   ├── screenshot.js          captureVisibleTab + PNG→JPEG
│   ├── filename.js            timestamp naming + uniqueness
│   ├── storage.js             settings, defaults, normalisation
│   ├── directory.js           File System Access handles (IndexedDB)
│   ├── saver.js               Downloads API + directory probe
│   ├── notifications.js       optional notifications
│   └── errors.js              typed error codes and messages
├── scripts/
│   ├── make-icons.mjs         regenerates the PNG icons
│   ├── run-tests.mjs          runs every suite below
│   ├── test-units.mjs         filename, settings and error-classification logic
│   ├── test-imports.mjs       import / manifest / element-id wiring
│   ├── test-pipeline.mjs      end-to-end capture against a mock chrome.* API
│   └── lib/canvas-shim.mjs    createImageBitmap/OffscreenCanvas test double
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

Requires Chrome 109 or newer (MV3 service worker with `OffscreenCanvas`).

---

## Development

The extension itself is plain ES modules with **no build step** — the directory
you load unpacked is the shipped code. The scripts below are development-only
and are not part of the extension.

```bash
node scripts/run-tests.mjs     # run all suites
node scripts/make-icons.mjs    # regenerate icons
```

Three suites, 48 assertions, all passing:

| Suite               | Covers |
| ------------------- | ------ |
| `test-units.mjs`    | Filename generation, uniqueness, collision suffixes, settings normalisation, error classification. |
| `test-imports.mjs`  | Every relative import resolves to a real export, manifest paths exist, and each `getElementById()` in the options/popup JS has a matching `id` in its HTML. |
| `test-pipeline.mjs` | The whole capture pipeline against a mock `chrome.*`: capture → JPEG encode → unique filename → save, plus repeated captures, concurrency, settings handling and failure paths. |

`test-pipeline.mjs` genuinely encodes a PNG to JPEG (through a test double for
`createImageBitmap`/`OffscreenCanvas`, which Node does not provide) and asserts
the output carries valid JPEG SOI/EOI markers and a JFIF header.

**Not covered by the automated tests:** anything that only exists inside Chrome
— real `chrome.commands` dispatch, the `activeTab` grant, genuine restricted-page
refusals, the real Downloads API, the File System Access folder grant, and
service-worker suspension. Those are what the manual checklist below is for; run
it after loading the extension.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Hotkey does nothing | The shortcut shows **Not assigned** on the options page. Assign it at `chrome://extensions/shortcuts`. This also happens if another extension claimed the same combination. |
| "This page cannot be captured" | Chrome blocks capture on `chrome://` pages, the Web Store, other extensions' pages and `devtools://`. This is a hard platform restriction. |
| File went somewhere unexpected | Check `chrome://settings/downloads` for the real base directory, and the sub-folder in the options page. |
| Save fails with a permission error | The folder grant was revoked. Re-select the folder in the options page. |
| A Save As dialog appears | Not caused by this extension — it always passes `saveAs: false`. Check Chrome's own **Ask where to save each file** setting at `chrome://settings/downloads`, which overrides extensions. |
| Nothing happens after a Chrome restart | Nothing is lost: settings live in `chrome.storage.local` and the directory handle in IndexedDB. The next hotkey press wakes the service worker. |
| Want technical detail | Right-click the extension → **Service worker** → Console. Every capture and every failure is logged with a `[quick-screenshot]` prefix. |

---

## Testing checklist

### Capture

- [ ] Press the hotkey on an ordinary `https://` page → a JPG is saved.
- [ ] The saved image matches the viewport, at the same zoom level.
- [ ] The image contains **no** tab bar, address bar, bookmarks bar or window buttons.
- [ ] The image is a valid JPG (extension `.jpg`, opens in an image viewer).
- [ ] Nothing steals focus, no tab opens, no dialog appears.
- [ ] The file is written straight to the configured folder, with no Save As dialog.
- [ ] The options page has no "Ask where to save each file" option at all.
- [ ] Capture works while scrolled part-way down a page (only the viewport is saved).

### Repeated captures

- [ ] Press the hotkey 5 times with ~1s gaps → 5 files.
- [ ] Press the hotkey 5 times rapidly (<1s apart) → 5 distinct files, none overwritten.
- [ ] The extension keeps working after several minutes idle (service worker suspension).

### Filenames and duplicates

- [ ] A fresh capture is named `photo_YYYY-MM-DD_HH-mm-ss.jpg` in **local** time.
- [ ] The date/time matches the system clock.
- [ ] Two captures in the same second produce `..._HH-mm-ss_417.jpg` or `..._2.jpg`.
- [ ] An existing file is never modified (check the file's modified time).
- [ ] Setting the prefix to `screenshot_` yields `screenshot_YYYY-MM-DD_HH-mm-ss.jpg`.
- [ ] An illegal prefix such as `a/b:c*` is cleaned up rather than breaking the save.

### JPG quality

- [ ] Quality 70% produces a visibly smaller file than 100%.
- [ ] At 100% the text on screen is still legible.
- [ ] A page with a transparent background saves with white, not black, areas.

### Shortcut

- [ ] The options page shows the shortcut Chrome actually has bound.
- [ ] Pressing a modifier-only key or `Tab` in the recorder does nothing (the page stays navigable).
- [ ] `Ctrl+Shift+S` is accepted.
- [ ] A bare letter with no modifier is rejected with a clear reason.
- [ ] `Ctrl+T` and `Command+Q` are rejected as reserved.
- [ ] After changing the shortcut at `chrome://extensions/shortcuts` and returning to the options tab, the displayed value updates.
- [ ] Clearing the shortcut in Chrome makes the options page show "Not assigned".

### Save location

- [ ] Default mode saves to `Downloads/Screenshots/`.
- [ ] A nested sub-folder such as `Photos/2026` is created correctly.
- [ ] Choosing a custom folder, then capturing, writes into that exact folder.
- [ ] Cancelling the folder picker changes nothing.
- [ ] "Forget folder" reverts to the Downloads folder.
- [ ] The popup shows the correct destination.

### Chrome restart & persistence

- [ ] Close and reopen Chrome → settings, prefix, quality and save mode are all retained.
- [ ] After a restart, the custom folder grant still works without re-prompting.
- [ ] `chrome://extensions` → **Service worker → Stop** → the next hotkey press still works.
- [ ] Reloading the extension does not lose settings.

### Restricted pages

- [ ] Hotkey on `chrome://extensions` → clear "cannot be captured" message, no crash.
- [ ] Hotkey on the Chrome Web Store → same.
- [ ] Hotkey on a `devtools://` window → same.
- [ ] After a failed attempt, an ordinary page still captures normally.
- [ ] No unhandled error appears in the service worker console.

### Error handling

- [ ] With the download directory made read-only, a capture fails with a message and the extension keeps working.
- [ ] Revoking the folder permission and capturing → a clear re-grant message.
- [ ] Any failure produces a non-blocking notification (when enabled) and a console entry — never a modal dialog.
- [ ] Service worker console shows `[quick-screenshot]` diagnostics for successes and failures.

### Options page

- [ ] All settings persist after closing and reopening the options page.
- [ ] "Restore defaults" resets every field and clears the chosen folder.
- [ ] "Take a test screenshot" saves a file and shows its name.
- [ ] The filename preview matches the configured prefix.
- [ ] Toggling a switch takes effect on the next capture.


