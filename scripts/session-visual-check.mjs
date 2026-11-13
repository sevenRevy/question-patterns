// Browser visual and interaction check for registerSessionPatterns in a host dialog double.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const edge = process.env.EDGE_BIN ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const workdir = await mkdtemp(join(tmpdir(), 'session-patterns-visual-'));
const screenshotDir = process.env.SESSION_VISUAL_OUTPUT
  ? resolve(process.env.SESSION_VISUAL_OUTPUT)
  : workdir;
await mkdir(screenshotDir, { recursive: true });
await access(edge);
await build({
  entryPoints: ['tests/session-visual.fixture.ts'],
  outfile: join(workdir, 'session-visual.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const css = await readFile('src/styles.css', 'utf8');
await writeFile(join(workdir, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--background:#fafafa;--foreground:#242424;--muted:#f0f0f0;--muted-foreground:#6b6b6b;--border:#dedede;--primary:#343434;--ring:#777;--destructive:#b53e3e;--success:#34845a;color-scheme:light}
:root[data-theme=dark]{--background:#191919;--foreground:#e6e6e6;--muted:#242424;--muted-foreground:#999;--border:#343434;--primary:#e4e4e4;--ring:#aaa;--destructive:#e47b7b;--success:#69bd87;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;min-width:0;background:var(--background);color:var(--foreground);font-family:system-ui,sans-serif}button,input{font:inherit}.host-header{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;border-bottom:1px solid var(--border);background:var(--background)}.host-brand{font-size:14px;font-weight:650;letter-spacing:.01em}.host-context{color:var(--muted-foreground);font-size:12px}.host-toolbar{display:flex;align-items:center;gap:8px}.native-button{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:5px 11px;border:1px solid transparent;border-radius:6px;background:var(--primary);color:var(--background);font-size:12px;font-weight:550;cursor:pointer}.native-button:hover{opacity:.82}.native-button:disabled{opacity:.5;cursor:not-allowed}.native-outline,.native-secondary{border-color:var(--border);background:var(--background);color:var(--foreground)}.native-ghost,.native-link{background:transparent;color:var(--muted-foreground)}.native-settings-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px}.native-switch{width:38px;height:22px;border:1px solid var(--border);border-radius:999px;background:var(--muted);cursor:pointer}.native-switch[aria-checked=true]{background:var(--success)}.host-dialog{width:min(58rem,calc(100vw - 2rem));max-width:none;max-height:90vh;margin:auto;padding:0;overflow:hidden;border:1px solid var(--border);border-radius:12px;background:var(--background);color:var(--foreground);box-shadow:0 24px 80px #0003}.host-dialog::backdrop{background:#10131988;backdrop-filter:blur(2px)}.host-dialog-shell{position:relative;display:flex;flex-direction:column;max-height:90vh;overflow:hidden}.host-dialog-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:26px}.host-dialog-close{position:absolute;z-index:2;top:12px;right:12px;width:34px;min-width:34px;height:34px;padding:0;border-radius:8px;font-size:20px}.host-page{max-width:1040px;margin:36px auto;padding:0 24px;color:var(--muted-foreground);font-size:14px}.host-page h1{margin:0 0 10px;color:var(--foreground);font-size:22px}.host-page p{max-width:60ch;line-height:1.6}dialog{color-scheme:inherit}
${css}</style></head><body>
<header class="host-header"><div><div class="host-brand">LearnHarness</div><div class="host-context">Teaching session · Foundations of reasoning</div></div><nav class="host-toolbar" aria-label="Session toolbar"><button class="native-button native-outline" type="button">Notes</button><button class="native-button native-outline" type="button">Resources</button><button id="session-patterns-action" class="native-button" type="button">Session patterns</button></nav></header>
<main class="host-page"><h1>Foundations of reasoning</h1><p>Work through the next example, then choose the session patterns that should guide this lesson. The host toolbar opens the registered session action.</p></main>
<div id="root"></div><script src="session-visual.js"></script></body></html>`);

const browserProfile = join(workdir, 'browser-profile');
const child = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${browserProfile}`, 'about:blank',
], { stdio: 'ignore' });
let socket;
const screenshotPaths = [];
let failure;
try {
  let port;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      port = (await readFile(join(browserProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      break;
    } catch {
      if (child.exitCode !== null) throw new Error(`Edge exited before starting (code ${child.exitCode}).`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  assert.ok(port, 'Edge did not start its DevTools endpoint');
  let targets;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const page = targets?.find(target => target.type === 'page');
  assert.ok(page, 'Edge did not expose a page target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  const pending = new Map();
  const browserErrors = [];
  let sequence = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') {
      browserErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      browserErrors.push(message.params.args.map(argument => argument.value ?? argument.description ?? '').join(' '));
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      browserErrors.push(message.params.entry.text);
    }
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
  };
  const waitFor = async (expression, label = expression) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const viewport = (width, height = 900) => send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  const screenshot = async name => {
    await new Promise(resolve => setTimeout(resolve, 120));
    const metrics = await send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const width = Math.max(size.width, await evaluate('innerWidth'));
    const height = Math.max(size.height, await evaluate('Math.max(innerHeight,document.documentElement.scrollHeight,document.body.scrollHeight)'));
    const { data } = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const path = join(screenshotDir, `${name}.png`);
    await writeFile(path, Buffer.from(data, 'base64'));
    screenshotPaths.push(path);
  };
  const noOverflow = async label => {
    const state = await evaluate(`(() => {const visible=e=>!e.hidden&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'&&e.getClientRects().length>0;return {viewport:innerWidth,document:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),controls:[...document.querySelectorAll('button,input,textarea,select')].filter(e=>visible(e)&&e.getBoundingClientRect().width>0).filter(e=>{const r=e.getBoundingClientRect();return r.left< -1||r.right>innerWidth+1}).map(e=>e.getAttribute('aria-label')||e.textContent.trim()),cards:[...document.querySelectorAll('.qp-session-template')].filter(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1).map(e=>e.textContent.trim().slice(0,80))}})()`);
    assert.ok(state.document <= state.viewport, `${label}: page scrolls horizontally (${JSON.stringify(state)})`);
    assert.deepEqual(state.controls, [], `${label}: controls extend beyond the viewport`);
    assert.deepEqual(state.cards, [], `${label}: template content overflows its row`);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await viewport(1280);
  await send('Page.navigate', { url: pathToFileURL(resolve(workdir, 'index.html')).href });
  await waitFor(`!!document.querySelector('#session-patterns-action') && window.__sessionVisualReady===true`, 'the registered host session toolbar action');
  await evaluate(`document.querySelector('#session-patterns-action').click()`);
  await waitFor(`!!document.querySelector('.qp-session-patterns .qp-session-template')`, 'the registered session action and its initial templates');
  await waitFor(`document.querySelectorAll('.qp-session-pattern').length>0 || document.querySelectorAll('button[role="switch"]').length>0`, 'session pattern controls');

  // Capture the four requested viewport/theme combinations before behavioral assertions,
  // so a source mismatch still leaves inspectable screenshots behind.
  for (const [width, theme, name] of [
    [1280, 'light', 'session-desktop-light'],
    [1280, 'dark', 'session-desktop-dark'],
    [390, 'dark', 'session-narrow-dark'],
    [390, 'light', 'session-narrow-light'],
  ]) {
    await viewport(width);
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};window.scrollTo(0,0);document.querySelector('[data-plugin-ui-dialog-scroll]')?.scrollTo(0,0)`);
    await noOverflow(name);
    await screenshot(name);
  }
  await viewport(1280);
  await evaluate(`document.documentElement.dataset.theme='light';window.scrollTo(0,0);document.querySelector('[data-plugin-ui-dialog-scroll]')?.scrollTo(0,0)`);

  const surface = await evaluate(`(() => {const search=document.querySelector('[role="dialog"] input[aria-label="Search patterns and templates"]');const templates=[...document.querySelectorAll('.qp-session-template')];const favorites=[...document.querySelectorAll('.qp-favorite')];const switches=[...document.querySelectorAll('[role="switch"]')];return {dialogCount:document.querySelectorAll('[role="dialog"]').length,search:!!search,tabs:document.querySelectorAll('[role="tab"],.qp-view-tabs').length,templateCount:templates.length,checkboxCount:document.querySelectorAll('input[type="checkbox"]').length,switchMarkup:switches.map(button=>({label:button.getAttribute('aria-label'),commonMarkup:button.matches('.qp-pattern-toggle > button.qp-enabled-switch[role="switch"]')})),templateSwitches:templates.map(row=>{const button=row.querySelector('.qp-pattern-toggle > button.qp-enabled-switch[role="switch"]');return {label:button?.getAttribute('aria-label')??'',disabled:button?.disabled??false}}),previews:templates.map(row=>({name:row.querySelector('h2,h3')?.textContent.trim()??'',preview:!!row.querySelector('.qp-template-card-preview'),previewText:row.querySelector('.qp-template-card-preview')?.textContent.trim()??'',metadata:row.querySelector('.qp-meta')?.textContent.trim()??''})),switches:[...document.querySelectorAll('.qp-session-pattern button[role="switch"]')].map(button=>({label:button.getAttribute('aria-label'),checked:button.getAttribute('aria-checked')})),favoriteCount:favorites.length,favoriteFilter:[...document.querySelectorAll('button[aria-pressed]')].some(button=>button.textContent.trim()==='Favorites'),calls:window.__sessionVisualCalls.map(call=>call.name)}})()`);
  assert.equal(surface.dialogCount, 1, 'the host opens one modal dialog');
  assert.equal(surface.search, true, 'the dialog has the labeled pattern/template search input');
  assert.equal(surface.tabs, 0, 'the session dialog has no tabs');
  assert.equal(surface.templateCount, 3, 'all fictional session templates render');
  assert.equal(surface.checkboxCount, 0, 'the session picker contains no checkbox inputs');
  assert.ok(surface.switchMarkup.every(item => item.commonMarkup), 'every role=switch control uses the shared qp-pattern-toggle markup');
  assert.ok(surface.templateSwitches.every((item, index) => item.label === `Select template ${surface.previews[index]?.name}`),
    'every template has its shared boolean switch');
  assert.ok(surface.previews.every(template => template.preview && template.metadata),
    'template rows include preview elements and example metadata');
  assert.ok(surface.previews.filter(template => template.name !== 'Unavailable archive').every(template => template.previewText),
    'available templates preview their eligible members');
  const reasoningPreview = surface.previews.find(template => template.name === 'Reasoning foundations');
  assert.ok(reasoningPreview?.previewText.includes('First-principles decomposition'), 'the template preview names an eligible member');
  assert.match(reasoningPreview?.metadata ?? '', /9 saved examples/, 'template metadata includes saved-example details');
  assert.match(reasoningPreview?.metadata ?? '', /4 expected from eligible patterns/, 'template metadata includes expected-example details');
  assert.deepEqual(surface.switches.map(item => item.label), ['Retrieval pause'],
    'only the one pattern not grouped in a template is initially shown standalone');
  assert.ok(surface.switches.every(item => ['true', 'false'].includes(item.checked)),
    'standalone session patterns use named native button switches');
  assert.equal(surface.favoriteFilter, true, 'the Favorites filter exposes aria-pressed');
  assert.ok(surface.favoriteCount >= 1, 'pattern rows expose favorite controls');

  const expanded = await evaluate(`(() => {const row=[...document.querySelectorAll('.qp-session-template')].find(item=>item.querySelector('h2,h3')?.textContent.trim()==='Reasoning foundations');const button=row?.querySelector('button[aria-expanded]');if(!button)return false;if(button.getAttribute('aria-expanded')!=='true')button.click();return button.getAttribute('aria-expanded')==='true'})()`);
  assert.equal(expanded, true, 'the template disclosure button expands its grouped members');
  await waitFor(`['First-principles decomposition','Counterexample search','Assumption audit'].every(name=>{const rows=[...document.querySelectorAll('.qp-session-pattern')].filter(row=>row.querySelector('[role="switch"]')?.getAttribute('aria-label')===name);return rows.length===1&&rows[0].closest('.qp-session-template')?.querySelector('h2,h3')?.textContent.trim()==='Reasoning foundations'})`,
    'grouped patterns appear once inside their template and are not repeated as standalone rows');
  const rowNames = await evaluate(`[...document.querySelectorAll('.qp-session-pattern')].map(row=>row.querySelector('[role="switch"]')?.getAttribute('aria-label')).filter(Boolean)`);
  assert.equal(new Set(rowNames).size, rowNames.length, 'no session pattern is duplicated between template groups and standalone rows');
  await screenshot('session-expanded-desktop-light');
  await viewport(390);
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await noOverflow(`expanded narrow ${theme} dialog`);
    await screenshot(`session-expanded-narrow-${theme}`);
  }
  await viewport(1280);
  await evaluate(`document.documentElement.dataset.theme='light'`);

  const setSearch = async value => evaluate(`(() => {const input=document.querySelector('[role="dialog"] input[aria-label="Search patterns and templates"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await setSearch('Assumption audit');
  await waitFor(`(() => {const row=[...document.querySelectorAll('.qp-session-pattern')].find(item=>item.querySelector('[role="switch"]')?.getAttribute('aria-label')==='Assumption audit');return !!row&&!row.hidden&&getComputedStyle(row).display!=='none'&&row.getClientRects().length>0})()`, 'search to show the matching session pattern');
  const unrelatedVisible = await evaluate(`(() => {const row=[...document.querySelectorAll('.qp-session-pattern')].find(item=>item.querySelector('[role="switch"]')?.getAttribute('aria-label')==='Transfer check');return !!row&&!row.hidden&&getComputedStyle(row).display!=='none'&&row.getClientRects().length>0})()`);
  assert.equal(unrelatedVisible, false, 'search hides non-matching standalone patterns');
  await setSearch('A longer review template name');
  await waitFor(`(() => {const row=[...document.querySelectorAll('.qp-session-template')].find(item=>item.querySelector('h2,h3')?.textContent.includes('A longer review template name'));return !!row&&!row.hidden&&getComputedStyle(row).display!=='none'&&row.getClientRects().length>0})()`, 'search to show the matching template');
  const unrelatedTemplateVisible = await evaluate(`(() => {const row=[...document.querySelectorAll('.qp-session-template')].find(item=>item.querySelector('h2,h3')?.textContent.trim()==='Reasoning foundations');return !!row&&!row.hidden&&getComputedStyle(row).display!=='none'&&row.getClientRects().length>0})()`);
  assert.equal(unrelatedTemplateVisible, false, 'search hides non-matching templates');
  await setSearch('');

  await evaluate(`document.querySelector('.qp-session-pattern [role="switch"][aria-label="Retrieval pause"]')?.closest('.qp-session-pattern')?.querySelector('.qp-favorite[aria-label="Favorite Retrieval pause"]')?.click()`);
  await waitFor(`!!document.querySelector('.qp-favorite[aria-label="Unfavorite Retrieval pause"][aria-pressed="true"]')`, 'the favorite API update');
  const favoritesFilter = await evaluate(`[...document.querySelectorAll('button[aria-pressed]')].find(button=>button.textContent.trim()==='Favorites')?.getAttribute('aria-pressed')`);
  assert.equal(favoritesFilter, 'false', 'Favorites starts as an inactive filter');
  await evaluate(`[...document.querySelectorAll('button[aria-pressed]')].find(button=>button.textContent.trim()==='Favorites')?.click()`);
  await waitFor(`[...document.querySelectorAll('button[aria-pressed]')].some(button=>button.textContent.trim()==='Favorites'&&button.getAttribute('aria-pressed')==='true')`, 'the Favorites filter to activate');
  const favoriteFilterState = await evaluate(`(() => {const visible=row=>!!row&&!row.hidden&&getComputedStyle(row).display!=='none'&&row.getClientRects().length>0;const rows=[...document.querySelectorAll('.qp-session-pattern')];return {favorite:visible(rows.find(item=>item.querySelector('[role="switch"]')?.getAttribute('aria-label')==='Retrieval pause')),other:visible(rows.find(item=>item.querySelector('[role="switch"]')?.getAttribute('aria-label')==='Counterexample search'))}})()`);
  assert.equal(favoriteFilterState.favorite, true, 'the Favorites filter retains the favorited pattern');
  assert.equal(favoriteFilterState.other, false, 'the Favorites filter hides patterns that are not favorited');
  await evaluate(`[...document.querySelectorAll('button[aria-pressed]')].find(button=>button.textContent.trim()==='Favorites')?.click()`);

  const selectTemplate = `document.querySelector('.qp-session-template .qp-pattern-toggle > button[role="switch"][aria-label="Select template Reasoning foundations"]')`;
  const partialTemplate = await evaluate(`(() => {const row=[...document.querySelectorAll('.qp-session-template')].find(item=>item.querySelector('h2,h3')?.textContent.trim()==='Reasoning foundations');const control=row?.querySelector('.qp-pattern-toggle > button[role="switch"]');return {checked:control?.getAttribute('aria-checked'),title:control?.title,availability:row?.querySelector('.qp-session-availability')?.textContent}})()`);
  assert.equal(partialTemplate.checked, 'false', 'partial template selection exposes boolean false, not a mixed ARIA state');
  assert.equal(partialTemplate.title, 'Select all available patterns in Reasoning foundations', 'partial selection explains that a click selects all');
  assert.ok(partialTemplate.availability.includes('Partially selected'), 'partial selection remains visible in availability text');
  await evaluate(`${selectTemplate}?.click()`);
  await waitFor(`['First-principles decomposition','Counterexample search','Assumption audit'].every(name=>document.querySelector('.qp-session-pattern [role="switch"][aria-label="'+name+'"]').getAttribute('aria-checked')==='true')`,
    'selecting the template to select all eligible member patterns');
  await evaluate(`${selectTemplate}?.click()`);
  await waitFor(`['First-principles decomposition','Counterexample search','Assumption audit'].every(name=>document.querySelector('.qp-session-pattern [role="switch"][aria-label="'+name+'"]').getAttribute('aria-checked')==='false')`,
    'deselecting the template to clear its eligible member patterns');
  const unavailableDisabled = await evaluate(`(() => {const row=[...document.querySelectorAll('.qp-session-template')].find(item=>item.querySelector('h2,h3')?.textContent.trim()==='Unavailable archive');const control=row?.querySelector('.qp-pattern-toggle > button[role="switch"][aria-label="Select template Unavailable archive"]');return !!control&&control.disabled})()`);
  assert.equal(unavailableDisabled, true, 'a template with no available patterns is disabled');

  await evaluate(`document.querySelector('button[aria-label="Close dialog"]')?.click()`);
  await waitFor(`!document.querySelector('[role="dialog"]')`, 'the host dialog to close');
  await evaluate(`document.querySelector('#session-patterns-action')?.click()`);
  await waitFor(`!!document.querySelector('[role="dialog"] .qp-session-pattern')`, 'the session dialog to reopen');
  const persistedFavorite = await evaluate(`!!document.querySelector('.qp-favorite[aria-label="Unfavorite Retrieval pause"][aria-pressed="true"]')`);
  assert.equal(persistedFavorite, true, 'favorites persist after closing and reopening the session dialog');
  const calls = await evaluate(`window.__sessionVisualCalls.map(call=>call.name)`);
  for (const name of ['session-patterns', 'templates-snapshot', 'favorites-snapshot', 'favorite-set']) {
    assert.ok(calls.includes(name), `the fixture exercises the ${name} API`);
  }
  assert.ok(calls.includes('session-template-apply') || calls.includes('session-pattern-set'), 'template selection persists through the session APIs');
  await noOverflow('reopened desktop light dialog');
  assert.deepEqual(browserErrors, [], 'browser console and runtime errors');

  console.log('Session visual check passed: host dialog, search, grouped patterns, template select/deselect, unavailable template, favorites persistence, four viewport/theme screenshots, no horizontal overflow or browser errors.');
} catch (error) {
  failure = error;
} finally {
  console.log(`Screenshots: ${screenshotDir}`);
  for (const path of screenshotPaths) console.log(`  ${path}`);
  try { socket?.close(); } catch {}
  child.kill();
}
if (failure) throw failure;
