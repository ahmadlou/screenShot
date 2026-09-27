/**
 * test-imports.mjs
 * Static check that every import in the project resolves to a real file and a
 * real exported symbol. Catches typos and renames that a syntax check misses.
 * Run: node scripts/test-imports.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Recursively collect source files. */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.(js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = collect(ROOT);
const problems = [];
let checked = 0;

const IMPORT_RE = /import\s+(?:([\w*\s{},$]+?)\s+from\s+)?['"]([^'"]+)['"]/g;

/**
 * Read the actual export names of a module. Chrome-only globals are stubbed so
 * merely importing a module does not throw at load time.
 */
async function exportsOf(target) {
  const globalKey = '__qsTestStub__';
  if (!globalThis[globalKey]) {
    const noopEvent = { addListener() {}, removeListener() {}, hasListener: () => false };
    const noop = () => {};
    globalThis.chrome = {
      runtime: {
        getURL: (p) => p,
        getManifest: () => ({ version: '0.0.0' }),
        openOptionsPage: noop,
        onMessage: noopEvent,
        onInstalled: noopEvent,
        onStartup: noopEvent,
        sendMessage: async () => ({ ok: true })
      },
      commands: { onCommand: noopEvent, getAll: async () => [] },
      tabs: { captureVisibleTab: async () => '', query: async () => [], sendMessage: async () => {} },
      scripting: {
        getRegisteredContentScripts: async () => [],
        registerContentScripts: async () => {},
        unregisterContentScripts: async () => {},
        executeScript: async () => []
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      downloads: { download: async () => 1, search: async () => [] },
      windows: { WINDOW_ID_CURRENT: -2 },
      offscreen: { createDocument: noop, closeDocument: noop },
      permissions: { contains: async () => false, request: async () => true },
      notifications: { create: noop, clear: async () => {} },
      runtime2: null
    };
    globalThis.indexedDB = undefined;
    globalThis.__qsTestStub__ = true;
  }
  const mod = await import(pathToFileURL(target).href);
  return new Set(Object.keys(mod));
}

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);

  for (const m of source.matchAll(IMPORT_RE)) {
    const [, clause, specifier] = m;
    if (!specifier.startsWith('.')) continue; // bare/URL specifier

    const target = resolve(dirname(file), specifier);
    checked += 1;

    if (!existsSync(target)) {
      problems.push(`${rel}: cannot resolve "${specifier}"`);
      continue;
    }
    if (!clause) continue; // side-effect import

    const names = clause
      .replace(/[{}]/g, ' ')
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
      .filter((name) => name && name !== '*' && !name.startsWith('type '));

    let targetExports;
    try {
      targetExports = await exportsOf(target);
    } catch (error) {
      problems.push(`${rel}: importing ${relative(ROOT, target)} threw: ${error.message}`);
      continue;
    }

    for (const name of names) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (!targetExports.has(name)) {
        problems.push(`${rel}: "${name}" is not exported by ${relative(ROOT, target)}`);
      }
    }
  }
}


// Also confirm the manifest references only files that exist.
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...(manifest.content_scripts || []).flatMap((script) => [...(script.js || []), ...(script.css || [])]),
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {})
].filter(Boolean);

for (const relPath of referenced) {
  if (!existsSync(join(ROOT, relPath))) {
    problems.push(`manifest.json references missing file "${relPath}"`);
  }
}

// Every options/popup element id referenced from JS must exist in the HTML.
for (const page of ['options', 'popup']) {
  const html = readFileSync(join(ROOT, page, `${page}.html`), 'utf8');
  const js = readFileSync(join(ROOT, page, `${page}.js`), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of js.matchAll(/\bel\('([^']+)'\)/g)) {
    if (!ids.has(m[1])) {
      problems.push(`${page}/${page}.js: getElementById('${m[1]}') has no matching id in ${page}.html`);
    }
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s) found:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${checked} relative imports, manifest paths and element ids resolve correctly.\n`);
}
