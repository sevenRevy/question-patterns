// Dependency-free Edge/CDP smoke check of the real UI with fictional records and host doubles.
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(), 'question-patterns-visual-'));
const edge = process.env.EDGE_BIN ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
await access(edge);
await build({ entryPoints: ['tests/visual.fixture.tsx'], outfile: join(directory, 'preview.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const css = await readFile('src/styles.css', 'utf8');
await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--background:#fafafa;--foreground:#242424;--muted:#f0f0f0;--muted-foreground:#6b6b6b;--border:#dedede;--primary:#343434;--ring:#777;--destructive:#b53e3e;color-scheme:light}
:root[data-theme=dark]{--background:#191919;--foreground:#e6e6e6;--muted:#242424;--muted-foreground:#999;--border:#343434;--primary:#e4e4e4;--ring:#aaa;--destructive:#e47b7b;color-scheme:dark}
body{margin:0;background:var(--background);color:var(--foreground);font-family:system-ui,sans-serif}button,input,textarea,select{font-family:inherit}.native-button{display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:6px;min-height:34px;padding:5px 11px;font-size:12px;font-weight:500;cursor:pointer;background:var(--primary);color:var(--background)}.native-button:hover{opacity:.8}.native-button:disabled{opacity:.5;cursor:not-allowed}.native-outline{border-color:var(--border);color:var(--foreground);background:var(--background)}.native-ghost,.native-link{color:var(--muted-foreground);background:transparent}.native-settings-toggle{display:inline-flex;align-items:center;gap:5px;color:var(--muted-foreground);font-size:12px;white-space:nowrap}.native-settings-toggle input{margin:0;accent-color:var(--primary)}.native-menu{display:grid;border:1px solid var(--border);background:var(--background);padding:4px;border-radius:6px;z-index:10}dialog{padding:0;border:1px solid var(--border);border-radius:10px;max-width:calc(100vw - 2rem);background:var(--background);color:var(--foreground)}dialog::backdrop{background:#0008}
${css}</style></head><body><div id="root"></div><script src="preview.js"></script></body></html>`);
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'browser')}`, 'about:blank'], { stdio: 'ignore' });
let socket;
try {
  let port;
  for (let i = 0; i < 150; i++) {
    try { port = (await readFile(join(directory, 'browser', 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(port, 'Edge did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(), errors = [];
  let sequence = 0;
  socket.onmessage = ({ data }) => {
    const result = JSON.parse(data);
    if (result.method === 'Runtime.exceptionThrown') errors.push(result.params.exceptionDetails.exception?.description ?? result.params.exceptionDetails.text);
    if (result.id) { const request = pending.get(result.id); pending.delete(result.id); result.error ? request.reject(new Error(result.error.message)) : request.resolve(result.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
  const wait = async expression => { for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(`Timed out: ${expression}`); };
  const screenshot = async name => {
    await new Promise(r => setTimeout(r, 100));
    const { cssContentSize } = await send('Page.getLayoutMetrics');
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } });
    await writeFile(join(directory, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const viewport = (width, height = 900) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const noOverflow = async label => { const measurements = await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth,outside:[...document.querySelectorAll('button,input,textarea,select,[role="radio"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left< -1)}).map(e=>e.textContent),templateOverflow:[...document.querySelectorAll('.qp-template-list.qp-feed > section.qp-template-record.qp-pattern-record')].filter(row=>row.scrollWidth>row.clientWidth+1||[...row.querySelectorAll('h3')].some(heading=>heading.scrollWidth>heading.clientWidth+1)).map(row=>row.getAttribute('aria-label')??row.textContent?.trim())})`); assert.ok(measurements.scroll <= measurements.width, `${label}: horizontal scroll ${JSON.stringify(measurements)}`); assert.deepEqual(measurements.outside, [], `${label}: clipped controls`); assert.deepEqual(measurements.templateOverflow, [], `${label}: template row content overflows horizontally`); };
  const readEnabledSwitch = async () => evaluate(`(() => {const toggle=document.querySelector('button.qp-enabled-switch[role="switch"]');const track=toggle?.querySelector('.qp-switch-track');const thumb=track?.querySelector('.qp-switch-thumb');const check=thumb?.querySelector('svg.qp-switch-check');const toggleStyle=toggle?getComputedStyle(toggle):null;const trackStyle=track?getComputedStyle(track):null;const checkStyle=check?getComputedStyle(check):null;const trackRect=track?.getBoundingClientRect();const thumbRect=thumb?.getBoundingClientRect();const checkRect=check?.getBoundingClientRect();const lampCount=toggle?[...toggle.querySelectorAll('*')].filter(element=>[...element.classList].some(name=>name==='qp-state-light'||name.startsWith('qp-state-light--'))).length:0;return {exists:!!toggle,role:toggle?.getAttribute('role')??null,checked:toggle?.getAttribute('aria-checked')??null,dataEnabled:toggle?.dataset.enabled??null,label:toggle?.getAttribute('aria-label')??null,areaText:toggle?.closest('.qp-pattern-toggle')?.innerText?.trim()??'',lampCount,trackCount:toggle?.querySelectorAll('.qp-switch-track').length??0,trackBackgroundColor:trackStyle?.backgroundColor??null,thumbPosition:trackRect&&thumbRect?{left:thumbRect.left-trackRect.left,top:thumbRect.top-trackRect.top}:null,checkCount:toggle?.querySelectorAll('svg.qp-switch-check').length??0,checkDisplay:checkStyle?.display??null,checkVisible:!!check&&!!checkRect&&checkRect.width>0&&checkRect.height>0&&checkStyle?.display!=='none'&&checkStyle?.visibility!=='hidden'&&Number(checkStyle?.opacity??1)>0,checkSize:checkRect?{width:checkRect.width,height:checkRect.height}:null,buttonBackgroundColor:toggleStyle?.backgroundColor??null,buttonBorderWidths:toggle?['Top','Right','Bottom','Left'].map(side=>toggleStyle['border'+side+'Width']):[]}})()`);
  const assertTemplateGrid = async (label, viewport) => {
    const layout = await evaluate(`(() => {const list=document.querySelector('.qp-template-list.qp-feed');const rows=[...document.querySelectorAll('.qp-template-list.qp-feed > section.qp-template-record.qp-pattern-record')];const listStyle=list?getComputedStyle(list):null;const listRect=list?.getBoundingClientRect();return {exists:!!list,display:listStyle?.display??null,direction:listStyle?.flexDirection??null,cards:rows.map(row=>{const style=getComputedStyle(row),rect=row.getBoundingClientRect(),preview=row.querySelector('.qp-template-preview'),heading=row.querySelector('h3'),icon=heading?.querySelector('svg');return {title:heading?.textContent.trim()??'',label:row.getAttribute('aria-label'),text:row.innerText??'',preview:preview?.textContent.trim().replace(/\\s+/g,' ')??null,previewTag:preview?.tagName??null,previewControls:preview?.querySelectorAll('button,a,input,select,textarea,[role="button"],[role="link"],[tabindex]').length??-1,metadata:[...row.querySelectorAll('.qp-meta')].map(item=>item.textContent.trim()),warnings:[...row.querySelectorAll('.qp-template-limit')].map(item=>item.textContent.trim()),actions:[...row.querySelectorAll('button')].map(button=>({name:button.getAttribute('aria-label')??button.innerText.trim(),title:button.title,pressed:button.getAttribute('aria-pressed'),svgFill:button.querySelector('svg path')?.getAttribute('fill')??null,iconOnly:button.dataset.iconOnly==='true',icons:button.querySelectorAll('svg').length,iconVisible:(button.querySelector('svg')?.getBoundingClientRect().width??0)>=12&&(button.querySelector('svg')?.getBoundingClientRect().height??0)>=12,iconHidden:button.querySelector('svg')?.getAttribute('aria-hidden')??null})),headingIconCount:heading?.querySelectorAll('svg').length??0,headingIconHidden:icon?.getAttribute('aria-hidden')??null,disclosureCount:row.querySelectorAll('details,[aria-expanded]').length,borders:['Top','Right','Bottom','Left'].map(side=>({width:parseFloat(style['border'+side+'Width']),style:style['border'+side+'Style'],color:style['border'+side+'Color']})),background:style.backgroundColor,listBackground:list?getComputedStyle(list).backgroundColor:null,fullWidth:listRect?Math.abs(rect.width-listRect.width)<1:false}})}})()`);
    assert.equal(layout.exists, true, `${label}: template grid is rendered`);
    assert.equal(layout.display, 'flex', `${label}: template list uses one flat column`);
    assert.equal(layout.direction, 'column', `${label}: template list reads top to bottom`);
    assert.ok(layout.cards.length >= 4, `${label}: fictional fixture renders at least four templates`);
    for (const card of layout.cards) {
      assert.equal(card.label, card.title, `${label}: ${card.title} exposes its name as the row label`);
      assert.equal(card.headingIconCount, 1, `${label}: ${card.title} heading has its decorative layers icon`);
      assert.equal(card.headingIconHidden, 'true', `${label}: ${card.title} layers icon is decorative`);
      assert.deepEqual(card.actions.map(action=>action.name).sort(), ['Edit template', `Delete template: ${card.title}`, `Default template: ${card.title}`].sort(), `${label}: ${card.title} exposes default pin, Edit, and trash actions`);
      const pin = card.actions.find(action=>action.name===`Default template: ${card.title}`);
      const isDefault = card.title === 'Core comparison set';
      assert.equal(pin?.pressed, String(isDefault), `${label}: ${card.title} pin exposes its pressed state`);
      assert.equal(pin?.title, isDefault ? 'Selected as default for new sessions only. Click to unset.' : 'Set as default template for new sessions only.', `${label}: ${card.title} pin explains its new-session-only state`);
      assert.equal(pin?.iconOnly, false, `${label}: ${card.title} pin is a plugin-owned native button`);
      assert.equal(pin?.icons, 1, `${label}: ${card.title} pin has one SVG`);
      assert.equal(pin?.iconVisible, true, `${label}: ${card.title} pin icon is visible`);
      assert.equal(pin?.iconHidden, 'true', `${label}: ${card.title} pin SVG is decorative`);
      assert.equal(pin?.svgFill, isDefault ? 'currentColor' : 'none', `${label}: ${card.title} pin fill matches its default state`);
      const trash = card.actions.find(action=>action.name===`Delete template: ${card.title}`);
      assert.equal(trash?.title, `Delete template: ${card.title}`, `${label}: ${card.title} trash button has its accessible title`);
      assert.equal(trash?.iconOnly, true, `${label}: ${card.title} trash button is icon-only`);
      assert.equal(trash?.icons, 1, `${label}: ${card.title} trash button has one SVG`);
      assert.equal(trash?.iconVisible, true, `${label}: ${card.title} trash icon is visible`);
      assert.equal(trash?.iconHidden, 'true', `${label}: ${card.title} trash SVG is decorative`);
      assert.equal(card.disclosureCount, 0, `${label}: ${card.title} row has no expansion/details control`);
      assert.equal(card.fullWidth, true, `${label}: ${card.title} spans the full reading column`);
      assert.ok([card.borders[0], card.borders[1], card.borders[3]].every(border=>border.width===0 || border.style==='none' || border.color==='rgba(0, 0, 0, 0)'), `${label}: ${card.title} has no card border shell`);
      assert.ok(card.background==='rgba(0, 0, 0, 0)' || card.background===card.listBackground, `${label}: ${card.title} has no card background shell`);
    }
    assert.ok(viewport==='desktop' || viewport==='narrow', `${label}: viewport case is identified`);
    return layout.cards;
  };
  const assertTemplatePreviews = cards => {
    const byTitle = title => cards.find(card=>card.title===title);
    const assertPreview = (title, text) => {
      const row = byTitle(title);
      assert.ok(row, `${title} template row is rendered`);
      assert.equal(row.previewTag, 'P', `${title} preview is a paragraph`);
      assert.equal(row.preview, text, `${title} preview is plain text with a compact member summary`);
      assert.equal(row.previewControls, 0, `${title} preview contains no interactive expand/show-all control`);
      return row;
    };
    const core = assertPreview('Core comparison set', 'Direct Question · Multiple Choice');
    assert.match(core.metadata.join(' '), /\b2 patterns\b/i, 'Core comparison set displays its total pattern count');
    assert.match(core.metadata.join(' '), /\b5 saved examples\b/i, 'Core comparison set displays its saved-example count');
    assert.ok(core.warnings.includes('4 forced examples exceed the overall limit of 3.'), 'Core comparison set warns when forced examples exceed the overall limit');
    const math = assertPreview('Math', 'Statement Combination · Problem Solving · Fill in the Blank');
    assert.match(math.metadata.join(' '), /\b3 patterns\b/i, 'Math displays its total pattern count');
    assert.match(math.metadata.join(' '), /\b2 saved examples\b/i, 'Math displays its saved-example count');
    assert.ok(math.warnings.includes('Per-pattern limits reduce the sample.'), 'Math warns when per-pattern limits reduce the sample');
    const portuguese = assertPreview('Portuguese', 'Direct Question · True / False · Scenario-Based +1 more');
    assert.match(portuguese.metadata.join(' '), /\b4 patterns\b/i, 'Portuguese displays its total pattern count');
    assert.match(portuguese.metadata.join(' '), /\b4 saved examples\b/i, 'Portuguese displays its saved-example count');
    assert.ok(portuguese.warnings.includes('Example sample capped at 3 per call.'), 'Portuguese reports the bounded overall sample cap');
    const exam = assertPreview('Exam-style', 'Direct Question · Multiple Choice · Statement Combination +3 more');
    assert.match(exam.metadata.join(' '), /\b6 patterns\b/i, 'Exam-style displays its total pattern count');
    assert.match(exam.metadata.join(' '), /\b13 saved examples\b/i, 'Exam-style displays its saved-example count');
    const long = assertPreview('A very long reusable template name for checking that narrow cards wrap cleanly without causing horizontal overflow', 'Fill in the Blank · Scenario-Based · Error Identification +3 more');
    assert.match(long.metadata.join(' '), /\b6 patterns\b/i, 'long-name row displays all six saved pattern references');
    assert.match(long.metadata.join(' '), /\b1 unavailable\b/i, 'availability is represented only by the unavailable count');
    assert.doesNotMatch(long.metadata.join(' '), /\b\d+ available\b/i, 'row does not add a redundant available count');
    for (const row of cards) {
      assert.doesNotMatch(row.metadata.join(' '), /available in sessions|up to .* examples per call|overall limit override|per-pattern limits apply/i, `${row.title} metadata omits redundant availability and permanent policy/per-call statistics`);
      assert.doesNotMatch(row.text, /Only enabled, non-archived patterns can be applied|Forced examples always bypass both limits/i, `${row.title} omits permanent policy copy`);
    }
  };
  await send('Page.enable'); await send('Runtime.enable'); await viewport(1100);
  await send('Page.navigate', { url: pathToFileURL(resolve(directory, 'index.html')).href });
  await wait(`[...document.querySelectorAll('.qp-pattern-record')].some(row=>row.textContent.includes('Multiple Choice'))`);

  const assertLibrarySurface = async label => {
    const state = await evaluate(`({buttons:[...document.querySelectorAll('button')].map(button=>button.textContent.trim()),tabs:[...document.querySelectorAll('[role="tab"]')].map(tab=>({name:tab.textContent.trim(),selected:tab.getAttribute('aria-selected')})),calls:window.__visualCalls.map(call=>call.name),snapshots:window.__visualCalls.filter(call=>call.name==='patterns-snapshot'||call.name==='templates-snapshot').map(call=>({name:call.name,input:call.input})),records:[...document.querySelectorAll('.qp-pattern-record')].map(row=>({text:row.textContent??'',name:row.querySelector('h2')?.textContent.trim(),buttons:[...row.querySelectorAll('button:not([role="switch"])')].map(button=>button.getAttribute('aria-label')??button.textContent.trim()),accordion:!!row.querySelector('.qp-group-toggle,.qp-group-body,[aria-expanded]'),switches:[...row.querySelectorAll('button.qp-enabled-switch[role="switch"]')].map(toggle=>({label:toggle.getAttribute('aria-label')??'',checked:toggle.getAttribute('aria-checked'),dataEnabled:toggle.dataset.enabled,areaText:toggle.closest('.qp-pattern-toggle')?.innerText?.trim()??'',visibleLabel:toggle.closest('.qp-boolean-field')?.querySelector('span')?.textContent?.trim()??'',text:toggle.innerText?.trim()??'',lampCount:[...toggle.querySelectorAll('*')].filter(element=>[...element.classList].some(name=>name==='qp-state-light'||name.startsWith('qp-state-light--'))).length,trackCount:toggle.querySelectorAll('.qp-switch-track').length,checkCount:toggle.querySelectorAll('.qp-switch-thumb svg.qp-switch-check').length}))}))})`);
    for (const action of ['Analyze', 'Advanced', 'Run analysis', 'Scan history', 'Add sources', 'View source', 'Structure', 'More', 'Clone pattern', 'Approved versions', 'Archive pattern', 'Restore pattern']) {
      assert.equal(state.buttons.includes(action), false, `${label}: removed action ${action}`);
    }
    assert.ok(state.records.length > 0, `${label}: pattern rows are rendered`);
    for (const row of state.records) {
      assert.ok(row.text.trim(), `${label}: row shows pattern name and rule`);
      assert.equal(row.accordion, false, `${label}: row does not expand`);
      assert.deepEqual(row.buttons, ['Edit pattern', `Delete pattern: ${row.name}`], `${label}: Edit and trash actions are visible`);
      assert.equal(row.switches.length, 1, `${label}: row has one plugin-controlled Enabled switch`);
      assert.equal(row.switches[0].label, 'Default for new sessions', `${label}: switch explains default-selection behavior`);
      assert.equal(row.switches[0].visibleLabel, '', `${label}: library rows retain their compact unlabeled presentation`);
      assert.equal(row.switches[0].checked, 'true', `${label}: switch exposes its enabled state`);
      assert.equal(row.switches[0].dataEnabled, 'true', `${label}: data-enabled exposes the styling state`);
      assert.equal(row.switches[0].lampCount, 0, `${label}: switch has no separate status lamp`);
      assert.equal(row.switches[0].trackCount, 1, `${label}: switch has one track`);
      assert.equal(row.switches[0].checkCount, 1, `${label}: switch has one SVG check inside the thumb`);
      assert.doesNotMatch(row.switches[0].areaText, /\bEnabled\b/i, `${label}: no visible Enabled caption accompanies the switch`);
    }
    assert.equal(state.calls.some(name=>['snapshot','import','scan','model-catalog','settings','settings-save','run-detail','run-input'].includes(name)), false, `${label}: no legacy source/history endpoint calls`);
    assert.equal(state.calls.some(name=>['pattern-versions','archive'].includes(name)), false, `${label}: viewing or editing does not call versions or archive APIs`);
    assert.ok(state.calls.every(name=>['patterns-snapshot','pattern-save','pattern-enabled-set','pattern-delete','templates-snapshot','template-save','template-default-set','template-delete'].includes(name)), `${label}: only pattern and template APIs are called`);
    assert.ok(state.snapshots.every(({input})=>Object.keys(input).length===0), `${label}: both snapshots receive {}`);
    assert.deepEqual(state.tabs.map(tab=>tab.name), ['Patterns','Templates'], `${label}: only Patterns and Templates tabs are shown`);
    assert.equal(state.tabs[0].selected, 'true', `${label}: Patterns is selected by default`);
    assert.equal(await evaluate(`!!document.querySelector('input[type="file"]')`), false, `${label}: no source import control`);
  };
  const assertEditor = async (label, expectedFormat) => {
    const state = await evaluate(`(() => {const editor=document.querySelector('dialog,[role="dialog"]');const group=editor?.querySelector('[role="radiogroup"]');const radios=[...(group?.querySelectorAll('[role="radio"],input[type="radio"]')??[])];const name=radio=>radio.getAttribute('aria-label')??radio.closest('label')?.textContent??radio.textContent??'';const value=radio=>radio.getAttribute('value')??radio.getAttribute('data-value')??radio.getAttribute('data-format')??(name(radio).toLowerCase().includes('multiple choice')?'multiple_choice':name(radio).toLowerCase().includes('free recall')?'open_response':name(radio).toLowerCase().includes('any')?'any':null);const selected=radios.find(radio=>radio.getAttribute('aria-checked')==='true'||radio.checked===true);const shell=editor?.querySelector('[data-plugin-ui-dialog]');const scroller=shell?.querySelector('[data-plugin-ui-dialog-scroll]');const close=[...(shell?.querySelectorAll('button[aria-label="Close dialog"]')??[])];const chrome=editor?.querySelector('.qp-dialog-content');return {editor:!!editor,modalCount:document.querySelectorAll('dialog,[role="dialog"]').length,hostShell:!!shell,hostStyles:shell?{position:shell.style.position,maxHeight:shell.style.maxHeight,overflow:shell.style.overflow,display:shell.style.display,flexDirection:shell.style.flexDirection}:null,scrollerStyles:scroller?{minHeight:scroller.style.minHeight,overflowY:scroller.style.overflowY,padding:scroller.style.padding}:null,closeCount:close.length,closePositions:close.map(button=>button.style.position),closeInsideScroll:close.map(button=>!!button.closest('[data-plugin-ui-dialog-scroll]')),pluginClose:!!editor?.querySelector('.qp-dialog-top'),innerPadding:chrome?getComputedStyle(chrome).padding:null,group:!!group,labels:radios.map(name),values:radios.map(value),selected:selected?value(selected):null,details:editor?.querySelectorAll('details').length??-1,fields:editor?.querySelectorAll('input,textarea').length??0,examplesHeading:[...(editor?.querySelectorAll('h2,h3,h4,legend')??[])].some(item=>item.textContent?.trim()==='Examples'),addExample:[...(editor?.querySelectorAll('button')??[])].some(button=>button.textContent.trim()==='Add example'),exampleLimit:[...(editor?.querySelectorAll('label')??[])].some(label=>label.textContent.toLowerCase().includes('example limit per call')&&label.querySelector('input[type="number"]'))}})()`);
    assert.equal(state.editor, true, `${label}: editor is open`);
    assert.equal(state.modalCount, 1, `${label}: a single host-owned modal is open`);
    assert.equal(state.hostShell, true, `${label}: host dialog shell owns the editor`);
    assert.deepEqual(state.hostStyles, { position: 'relative', maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }, `${label}: host shell constrains the dialog`);
    assert.deepEqual(state.scrollerStyles, { minHeight: '0px', overflowY: 'auto', padding: '20px' }, `${label}: host provides the padded scroll region`);
    assert.equal(state.closeCount, 1, `${label}: host owns one accessibly named Close dialog button`);
    assert.deepEqual(state.closePositions, ['absolute'], `${label}: native close control floats instead of taking a flex row`);
    assert.deepEqual(state.closeInsideScroll, [false], `${label}: native close control is outside plugin content`);
    assert.equal(state.pluginClose, false, `${label}: plugin adds no second Close toolbar`);
    assert.ok(state.innerPadding === null || state.innerPadding === '0px', `${label}: plugin adds no padded inner dialog chrome`);
    assert.equal(state.group, true, `${label}: presentation selector is a radiogroup`);
    assert.equal(state.values.length, 3, `${label}: exactly three segmented options`);
    assert.deepEqual([...state.values].sort(), ['any','multiple_choice','open_response'], `${label}: presentation values are current`);
    for (const expected of ['Multiple choice','Free recall','Any']) assert.ok(state.labels.some(name=>name.toLowerCase().includes(expected.toLowerCase())), `${label}: accessible option ${expected}`);
    assert.equal(state.selected, expectedFormat, `${label}: expected format is selected`);
    assert.equal(state.details, 0, `${label}: editor fields are not collapsed in details`);
    assert.ok(state.fields >= 4, `${label}: editor fields are visible`);
    assert.equal(state.examplesHeading, true, `${label}: Examples section is visible`);
    assert.equal(state.addExample, true, `${label}: Add example control is visible`);
    assert.equal(state.exampleLimit, true, `${label}: per-call example limit is a labeled number field`);
    await assertLibrarySurface(label);
  };
  const closeEditor = async () => {
    await evaluate(`document.querySelector('button[aria-label="Close dialog"]').click()`);
    await wait(`!document.querySelector('dialog')`);
  };
  const fillEditor = async () => {
    await evaluate(`(() => {const field=(label,selector)=>[...document.querySelectorAll('label')].find(item=>item.textContent.includes(label))?.querySelector(selector);const set=(element,value)=>{const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}))};set(field('Name','input'),'Scrollable visual pattern');set(field('Reusable rule','textarea'),'Keep the full editor usable when the host dialog is short.');[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Add example').click()})()`);
    await wait(`[...document.querySelectorAll('label')].some(label=>label.textContent.includes('Example 1 — full question'))`);
    await evaluate(`(() => {const set=(element,value)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}))};const example=[...document.querySelectorAll('label')].find(label=>label.textContent.includes('Example 1 — full question'));set(example.querySelector('textarea'),'A visual full-question example?');const force=document.querySelector('button[role="switch"][aria-label="Force inclusion for example 1"]');if(force?.getAttribute('aria-checked')!=='false')throw new Error('Force inclusion switch did not start off');force.click();const limit=[...document.querySelectorAll('label')].find(label=>label.textContent.toLowerCase().includes('example limit per call'))?.querySelector('input[type="number"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(limit,'4');limit.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await wait(`document.querySelector('button[role="switch"][aria-label="Force inclusion for example 1"]')?.getAttribute('aria-checked')==='true'&&![...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Save pattern').disabled`);
  };
  const assertHostScrollReachesSave = async label => {
    const before = await evaluate(`(() => {const scroller=document.querySelector('[data-plugin-ui-dialog-scroll]');scroller.scrollTop=0;const save=[...document.querySelectorAll('.qp-actions button')].find(button=>button.textContent.trim()==='Save pattern');const rect=save.getBoundingClientRect(),clip=scroller.getBoundingClientRect();const scrollables=[...document.querySelectorAll('body *')].filter(element=>element.tagName!=='TEXTAREA'&&['auto','scroll'].includes(getComputedStyle(element).overflowY)&&element.scrollHeight>element.clientHeight+1).map(element=>element===scroller?'host scroller':element.className?.toString()||element.tagName);return {scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight,scrollables,saveInitiallyVisible:rect.top>=clip.top&&rect.bottom<=clip.bottom}})()`);
    assert.ok(before.scrollHeight > before.clientHeight + 1, `${label}: long editor overflows the host scroller`);
    assert.deepEqual(before.scrollables, ['host scroller'], `${label}: only the host dialog scroller scrolls vertically (textareas excluded)`);
    assert.equal(before.saveInitiallyVisible, false, `${label}: Save requires scrolling the host content`);
    await evaluate(`(() => {const scroller=document.querySelector('[data-plugin-ui-dialog-scroll]');scroller.scrollTop=scroller.scrollHeight})()`);
    const after = await evaluate(`(() => {const scroller=document.querySelector('[data-plugin-ui-dialog-scroll]');const save=[...document.querySelectorAll('.qp-actions button')].find(button=>button.textContent.trim()==='Save pattern');const rect=save.getBoundingClientRect(),clip=scroller.getBoundingClientRect();return rect.top>=clip.top&&rect.bottom<=clip.bottom})()`);
    assert.equal(after, true, `${label}: scrolling the host region brings Save fully into view`);
  };

  await assertLibrarySurface('desktop light patterns');
  await noOverflow('desktop light patterns'); await screenshot('desktop-patterns-light');
  await evaluate(`document.documentElement.dataset.theme='dark'`);
  await noOverflow('desktop dark patterns'); await screenshot('desktop-patterns-dark');
  await viewport(390); await noOverflow('narrow dark patterns'); await screenshot('narrow-patterns-dark');
  await evaluate(`document.documentElement.dataset.theme='light'`);
  await noOverflow('narrow light patterns'); await screenshot('narrow-patterns-light');
  await viewport(1100);

  const dispatchTab = async shift => {
    if (shift) await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, ...(shift ? { modifiers: 8 } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, ...(shift ? { modifiers: 8 } : {}) });
    if (shift) await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  };
  const assertVisibleSwitchFocus = async () => {
    await evaluate(`document.querySelector('button.qp-enabled-switch[role="switch"]').focus()`);
    await dispatchTab(true);
    await dispatchTab(false);
    const focus = await evaluate(`(() => {const toggle=document.querySelector('button.qp-enabled-switch[role="switch"]');const style=getComputedStyle(toggle);return {active:document.activeElement===toggle,visible:toggle.matches(':focus-visible'),outlineStyle:style.outlineStyle,outlineWidth:style.outlineWidth,outlineColor:style.outlineColor}})()`);
    assert.equal(focus.active, true, 'keyboard navigation can return focus to the switch');
    assert.equal(focus.visible, true, 'the focused switch matches :focus-visible');
    assert.notEqual(focus.outlineStyle, 'none', 'the switch has a visible focus outline');
    assert.ok(parseFloat(focus.outlineWidth) >= 2, 'the switch focus outline has visible width');
    assert.notEqual(focus.outlineColor, 'rgba(0, 0, 0, 0)', 'the switch focus outline has a visible color');
    await evaluate('document.activeElement.blur()');
  };
  await assertVisibleSwitchFocus();
  const toggleEnabled = async (enabled, count) => {
    await evaluate(`document.querySelector('button.qp-enabled-switch[role="switch"]').click()`);
    await wait(`window.__visualCalls.filter(call=>call.name==='pattern-enabled-set').length===${count}&&document.querySelector('button.qp-enabled-switch[role="switch"]').getAttribute('aria-checked')==='${enabled}'`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const state = await evaluate(`(() => {const call=window.__visualCalls.filter(item=>item.name==='pattern-enabled-set').at(-1);return {enabled:call.input.enabled,checked:document.querySelector('button.qp-enabled-switch[role="switch"]').getAttribute('aria-checked')}})()`);
    const visual = await readEnabledSwitch();
    assert.equal(state.enabled, enabled, 'enabled switch sends the new metadata value');
    assert.equal(state.checked, String(enabled), 'enabled switch reflects the accepted value');
    assert.equal(visual.label, 'Default for new sessions', 'default switch keeps its accessible label');
    assert.equal(visual.dataEnabled, String(enabled), 'enabled switch keeps its data-enabled styling state');
    assert.equal(visual.lampCount, 0, 'switch has no separate status lamp');
    assert.equal(visual.trackCount, 1, 'switch renders exactly one track');
    assert.equal(visual.checkCount, 1, 'switch renders one SVG check inside the thumb');
    assert.equal(visual.checkVisible, enabled, `switch check visibility matches enabled=${enabled}`);
    assert.equal(visual.checkDisplay === 'none', !enabled, `switch check display matches enabled=${enabled}`);
    assert.ok(visual.trackBackgroundColor && visual.trackBackgroundColor !== 'transparent' && visual.trackBackgroundColor !== 'rgba(0, 0, 0, 0)', 'switch track has a computed background color');
    assert.ok(visual.thumbPosition, 'switch thumb has measurable position within its track');
    if (enabled) assert.ok(visual.checkSize?.width > 0 && visual.checkSize?.height > 0 && visual.checkSize.width <= 16 && visual.checkSize.height <= 16, `enabled switch check is a small visible SVG (${JSON.stringify(visual.checkSize)})`);
    assert.equal(visual.buttonBackgroundColor, 'rgba(0, 0, 0, 0)', 'switch button has a transparent background, without an outer capsule');
    assert.deepEqual(visual.buttonBorderWidths, ['0px', '0px', '0px', '0px'], 'switch button has no outer border');
    assert.doesNotMatch(visual.areaText, /\bEnabled\b/i, 'enabled switch has no visible Enabled caption');
    await noOverflow(`desktop light patterns after enabled=${enabled}`);
    return visual;
  };
  const enabledBeforeToggle = await readEnabledSwitch();
  assert.equal(enabledBeforeToggle.checked, 'true', 'fixture starts with an enabled switch');
  const disabledVisual = await toggleEnabled(false, 1);
  const enabledVisual = await toggleEnabled(true, 2);
  assert.notEqual(disabledVisual.trackBackgroundColor, enabledVisual.trackBackgroundColor, 'track background differs between enabled and disabled');
  const rgbChannels = color => color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
  const [offRed, offGreen, offBlue] = rgbChannels(disabledVisual.trackBackgroundColor);
  assert.ok(Math.max(offRed, offGreen, offBlue) - Math.min(offRed, offGreen, offBlue) <= 3, 'disabled track background is gray');
  const enabledOklch = enabledVisual.trackBackgroundColor.match(/oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/i);
  if (enabledOklch) assert.ok(Number(enabledOklch[3]) >= 90 && Number(enabledOklch[3]) <= 170 && Number(enabledOklch[2]) > 0, 'enabled track background is green');
  else {
    const [onRed, onGreen, onBlue] = rgbChannels(enabledVisual.trackBackgroundColor);
    assert.ok(onGreen > onRed && onGreen > onBlue, 'enabled track background is green');
  }
  assert.ok(disabledVisual.thumbPosition.left < enabledVisual.thumbPosition.left, 'thumb slides from off to on');
  await assertLibrarySurface('after plugin switch smoke');

  await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='New pattern').click()`);
  await wait(`!!document.querySelector('dialog')`);
  await assertEditor('desktop dark new editor', 'any');
  await noOverflow('desktop dark new editor'); await screenshot('desktop-new-pattern-dark');
  await viewport(390); await noOverflow('narrow dark new editor'); await screenshot('narrow-new-pattern-dark');
  await evaluate(`document.documentElement.dataset.theme='light'`);
  await noOverflow('narrow light new editor'); await screenshot('narrow-new-pattern-light');
  await closeEditor();

  await viewport(1100, 560);
  await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='New pattern').click()`);
  await wait(`!!document.querySelector('dialog')`);
  await assertEditor('desktop short-height new editor', 'any');
  await fillEditor();
  await assertHostScrollReachesSave('desktop short-height new editor');
  await noOverflow('desktop short-height new editor');
  await viewport(390, 420);
  await assertHostScrollReachesSave('narrow short-height new editor');
  await noOverflow('narrow short-height new editor');
  await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Save pattern').click()`);
  await wait(`window.__visualCalls.some(call=>call.name==='pattern-save')`);
  const savedEditor = await evaluate(`(() => {const call=window.__visualCalls.filter(item=>item.name==='pattern-save').at(-1);return {name:call?.input.content?.name,rule:call?.input.content?.rule,examples:call?.input.examples?.map(example=>({text:example.text,forced:example.forced})),exampleLimit:call?.input.exampleLimit,contentHasExamples:Object.hasOwn(call?.input.content??{},'examples')}})()`);
  assert.deepEqual(savedEditor, { name: 'Scrollable visual pattern', rule: 'Keep the full editor usable when the host dialog is short.', examples: [{ text: 'A visual full-question example?', forced: true }], exampleLimit: 4, contentHasExamples: false }, 'Save round-trips examples separately from structural content after host scrolling');
  await wait(`!document.querySelector('dialog')`);

  await viewport(1100);
  await evaluate(`(() => {const row=[...document.querySelectorAll('.qp-pattern-record')].find(item=>item.textContent.includes('Multiple Choice'));row.querySelector('button').click()})()`);
  await wait(`!!document.querySelector('dialog')`);
  assert.equal(await evaluate(`window.__visualCalls.some(call=>['pattern-versions','archive'].includes(call.name))`), false, 'opening an edit view does not call versions or archive APIs');
  await wait(`!!document.querySelector('dialog')`);
  await assertEditor('desktop light edit editor', 'multiple_choice');
  assert.ok(await evaluate(`[...document.querySelectorAll('label')].some(label=>label.textContent.includes('Example 1 — full question'))`), 'editing a pattern with a bank shows its full-question example field');
  await noOverflow('desktop light edit editor'); await screenshot('desktop-edit-pattern-light');
  await evaluate(`document.documentElement.dataset.theme='dark'`);
  await noOverflow('desktop dark edit editor'); await screenshot('desktop-edit-pattern-dark');
  await viewport(390); await noOverflow('narrow dark edit editor'); await screenshot('narrow-edit-pattern-dark');
  await evaluate(`document.documentElement.dataset.theme='light'`);
  await noOverflow('narrow light edit editor'); await screenshot('narrow-edit-pattern-light');
  await assertLibrarySurface('edit editor');
  await closeEditor();

  await evaluate(`([...document.querySelectorAll('[role="tab"]')].find(tab=>tab.textContent.trim()==='Templates')).click()`);
  await wait(`[...document.querySelectorAll('h2,h3')].some(item=>item.textContent.trim()==='Templates')`);
  await viewport(1100); await noOverflow('desktop light template list'); await screenshot('desktop-template-list-light');
  await evaluate(`document.documentElement.dataset.theme='dark'`);
  await noOverflow('desktop dark template list'); await screenshot('desktop-template-list-dark');
  await viewport(390); await noOverflow('narrow dark template list'); await screenshot('narrow-template-list-dark');
  await evaluate(`document.documentElement.dataset.theme='light'`);
  await noOverflow('narrow light template list'); await screenshot('narrow-template-list-light');
  await viewport(1100);
  const templateList = await evaluate(`(() => {const row=document.querySelector('.qp-template-list.qp-feed > section.qp-template-record.qp-pattern-record[aria-label="Core comparison set"]');return {heading:row?.querySelector('h3')?.textContent.trim(),rowLabel:row?.getAttribute('aria-label'),actions:[...row.querySelectorAll('button')].map(button=>button.getAttribute('aria-label')??button.innerText.trim()),newButton:[...document.querySelectorAll('button')].some(button=>button.innerText.trim()==='New template'),tabs:[...document.querySelectorAll('[role="tab"]')].map(tab=>({name:tab.textContent.trim(),selected:tab.getAttribute('aria-selected')})),calls:window.__visualCalls.filter(call=>call.name==='templates-snapshot'),allCalls:window.__visualCalls.map(call=>call.name)}})()`);
  assert.equal(templateList.heading, 'Core comparison set', 'template name is exposed as a heading');
  assert.equal(templateList.rowLabel, 'Core comparison set', 'template name labels its row');
  assert.deepEqual(templateList.actions.sort(), ['Edit template', 'Delete template: Core comparison set', 'Default template: Core comparison set'].sort(), 'template row exposes default pin, Edit, and a named trash button');
  assert.equal(templateList.newButton, true, 'template list exposes New template');
  assert.deepEqual(templateList.tabs.map(tab=>tab.name), ['Patterns','Templates']);
  assert.equal(templateList.tabs[1].selected, 'true');
  assert.ok(templateList.calls.length >= 1 && templateList.calls.every(call=>Object.keys(call.input).length===0), 'Templates loads templates-snapshot with {}');
  assert.ok(templateList.allCalls.every(name=>['patterns-snapshot','pattern-save','pattern-enabled-set','templates-snapshot','template-save','template-default-set','template-delete'].includes(name)), 'template view stays within the approved pattern/template APIs');
  assert.equal(templateList.allCalls.some(name=>['snapshot','import','source-update','source-revisions','revision-text','original','image-to-text','scan','scan-cancel','model-catalog','settings','settings-save','run-detail','run-input','decide'].includes(name)), false, 'template view never calls source/history APIs');
  const toggleDefault = async (isDefault, expectedRevision, count) => {
    await evaluate(`document.querySelector('button[aria-label="Default template: Core comparison set"]').click()`);
    await wait(`window.__visualCalls.filter(call=>call.name==='template-default-set').length===${count}&&document.querySelector('button[aria-label="Default template: Core comparison set"]')?.getAttribute('aria-pressed')==='${isDefault}'`);
    const state = await evaluate(`(() => {const button=document.querySelector('button[aria-label="Default template: Core comparison set"]');const call=window.__visualCalls.filter(item=>item.name==='template-default-set').at(-1);const row=button.closest('.qp-template-record');return {input:call.input,pressed:button.getAttribute('aria-pressed'),title:button.title,fill:button.querySelector('svg path')?.getAttribute('fill'),preview:row.querySelector('.qp-template-preview')?.textContent.trim(),dialogs:document.querySelectorAll('[role="dialog"]').length,templateSaves:window.__visualCalls.filter(item=>item.name==='template-save').length}})()`);
    assert.deepEqual(state.input, { id: 'visual-core', expectedRevision, isDefault }, 'pin sends the current template revision and requested state');
    assert.equal(state.pressed, String(isDefault), 'pin reflects the refreshed default state');
    assert.equal(state.title, isDefault ? 'Selected as default for new sessions only. Click to unset.' : 'Set as default template for new sessions only.');
    assert.equal(state.fill, isDefault ? 'currentColor' : 'none', 'pin fill matches active state');
    assert.equal(state.preview, 'Direct Question · Multiple Choice', 'default toggle preserves template membership preview');
    assert.equal(state.dialogs, 0, 'default toggle does not open an editor modal');
    assert.equal(state.templateSaves, 0, 'default toggle does not call template-save');
  };
  await toggleDefault(false, 2, 1);
  await toggleDefault(true, 3, 2);
  let templateCards = await assertTemplateGrid('desktop light template list', 'desktop');
  assertTemplatePreviews(templateCards);
  await noOverflow('desktop light template list');
  await evaluate(`document.documentElement.dataset.theme='dark'`);
  templateCards = await assertTemplateGrid('desktop dark template list', 'desktop');
  assertTemplatePreviews(templateCards);
  await noOverflow('desktop dark template list');
  await viewport(390);
  templateCards = await assertTemplateGrid('narrow dark template list', 'narrow');
  assertTemplatePreviews(templateCards);
  await noOverflow('narrow dark template list');
  await evaluate(`document.documentElement.dataset.theme='light'`);
  templateCards = await assertTemplateGrid('narrow light template list', 'narrow');
  assertTemplatePreviews(templateCards);
  await noOverflow('narrow light template list');
  await viewport(1100);
  const staticPreview = await evaluate(`(() => {const row=document.querySelector('.qp-template-list.qp-feed > section.qp-template-record.qp-pattern-record[aria-label="Exam-style"]');const preview=row?.querySelector('.qp-template-preview');preview?.click();return {text:preview?.textContent.trim(),dialog:!!document.querySelector('[role="dialog"]'),expanded:!!row?.querySelector('details,[aria-expanded]')}})()`);
  assert.equal(staticPreview.text, 'Direct Question · Multiple Choice · Statement Combination +3 more', 'clicking the static +N more preview does not reveal additional members');
  assert.equal(staticPreview.dialog, false, 'static preview does not open a dialog');
  assert.equal(staticPreview.expanded, false, 'static preview does not expand its row');
  await evaluate(`document.querySelector('button[aria-label="Delete template: Math"]').click()`);
  await wait(`document.querySelector('.qp-template-list [aria-label="Math"]')?.textContent.includes('Delete template?')`);
  const deleteConfirmation = await evaluate(`(() => {const row=document.querySelector('.qp-template-list.qp-feed > section.qp-template-record.qp-pattern-record[aria-label="Math"]');return {text:row?.innerText??'',buttons:[...row.querySelectorAll('button')].map(button=>button.getAttribute('aria-label')??button.innerText.trim()),deleteCalls:window.__visualCalls.filter(call=>call.name==='template-delete').length}})()`);
  assert.match(deleteConfirmation.text, /Delete template\\?/i, 'trash button opens the inline confirmation');
  assert.ok(deleteConfirmation.buttons.includes('Delete template') && deleteConfirmation.buttons.includes('Cancel'), 'inline confirmation offers confirm and cancel');
  assert.equal(deleteConfirmation.deleteCalls, 0, 'opening confirmation does not delete the fixture template');
  await evaluate(`(() => {const row=document.querySelector('.qp-template-list.qp-feed > section.qp-template-record.qp-pattern-record[aria-label="Math"]');[...row.querySelectorAll('button')].find(button=>button.innerText.trim()==='Cancel').click()})()`);
  await wait(`!!document.querySelector('.qp-template-list.qp-feed > section.qp-template-record.qp-pattern-record[aria-label="Math"]')&&!document.querySelector('.qp-template-list [aria-label="Math"]')?.textContent.includes('Delete template?')`);
  assert.equal(await evaluate(`window.__visualCalls.filter(call=>call.name==='template-delete').length`), 0, 'cancel preserves the template without a delete API call');
  await evaluate(`document.querySelector('.qp-template-list.qp-feed > section.qp-template-record.qp-pattern-record[aria-label="Exam-style"] button:not([aria-label])').click()`);
  await wait(`document.querySelector('[role="dialog"]')?.getAttribute('aria-label')==='Edit template'`);
  const completeMembership = await evaluate(`(() => {const members=document.querySelector('[role="dialog"] .qp-template-members');return [...(members?.querySelectorAll('button[role="switch"][aria-checked="true"]')??[])].map(toggle=>toggle.getAttribute('aria-label'))})()`);
  assert.deepEqual([...completeMembership].sort(), ['Direct Question','Multiple Choice','Statement Combination','True / False','Matching','Ordering / Sequencing'].sort(), 'Edit template exposes the complete six-pattern membership, beyond its three-name preview');
  await closeEditor();
  await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='New template').click()`);
  await wait(`!!document.querySelector('[role="dialog"]')`);
  const templateEditor = await evaluate(`(() => {const editor=document.querySelector('[role="dialog"]');const shell=editor?.querySelector('[data-plugin-ui-dialog]');const scroller=shell?.querySelector('[data-plugin-ui-dialog-scroll]');const name=[...editor.querySelectorAll('label')].some(label=>label.textContent.toLowerCase().includes('name')&&label.querySelector('input'));const searchInput=editor?.querySelector('.qp-template-picker input[type="search"]');const searchLabel=searchInput?.closest('label');const members=searchLabel?.nextElementSibling;const picker=searchInput?.closest('.qp-template-picker');const searchRect=searchLabel?.getBoundingClientRect();const membersRect=members?.getBoundingClientRect();const searchGap=searchRect&&membersRect?membersRect.top-searchRect.bottom:null;const search=!!searchInput&&!!searchLabel?.textContent.toLowerCase().includes('search patterns');const searchStructure=!!picker&&members?.tagName==='FIELDSET'&&members.classList.contains('qp-template-members')&&picker.contains(members);const bypass=[...editor.querySelectorAll('button[role="switch"]')].find(toggle=>toggle.getAttribute('aria-label')==='Bypass overall example limit');const member=[...members.querySelectorAll('button[role="switch"]')].find(toggle=>toggle.getAttribute('aria-label')==='Direct Question');const scrollables=[...editor.querySelectorAll('*')].filter(element=>['auto','scroll'].includes(getComputedStyle(element).overflowY)).map(element=>element===scroller?'host scroller':element.className?.toString()||element.tagName);return {title:editor?.getAttribute('aria-label'),modalCount:document.querySelectorAll('[role="dialog"]').length,nested:editor?.querySelectorAll('[role="dialog"]').length??-1,hostScrollerCount:editor?.querySelectorAll('[data-plugin-ui-dialog-scroll]').length??0,name,search,picker:!!picker,searchStructure,searchGap,initialMemberCount:members?.querySelectorAll('.qp-boolean-field').length??0,bypassLabel:bypass?.getAttribute('aria-label')??null,bypassDefault:bypass?.getAttribute('aria-checked')??null,memberLabel:member?.getAttribute('aria-label')??null,switches:editor?.querySelectorAll('button[role="switch"]').length??0,scrollables,save:[...editor.querySelectorAll('button')].some(button=>button.textContent.trim()==='Save template')}})()`);
  assert.equal(templateEditor.title, 'New template', 'template editor has an accessible New template title');
  assert.equal(templateEditor.modalCount, 1, 'template editor uses one host modal');
  assert.equal(templateEditor.nested, 0, 'template editor has no nested modal');
  assert.equal(templateEditor.hostScrollerCount, 1, 'template editor has only the host scroll container');
  assert.equal(templateEditor.name, true, 'template editor has a labeled Name input');
  assert.equal(templateEditor.search, true, 'template editor has a labeled Search patterns searchbox');
  assert.equal(templateEditor.picker, true, 'template Search patterns belongs to the picker group');
  assert.equal(templateEditor.searchStructure, true, 'Search patterns label directly precedes the membership fieldset in its picker');
  assert.ok(templateEditor.searchGap >= 0 && templateEditor.searchGap < 24, `Search patterns has a bounded vertical gap before members (${templateEditor.searchGap}px)`);
  assert.ok(templateEditor.initialMemberCount > 1, 'template picker starts with multiple patterns to filter');
  assert.equal(templateEditor.bypassLabel, 'Bypass overall example limit', 'overall-limit switch has its descriptive accessible name');
  assert.equal(templateEditor.bypassDefault, 'true', 'template editor defaults to bypassing the overall example limit');
  assert.equal(templateEditor.memberLabel, 'Direct Question', 'pattern membership switch uses the pattern name as its accessible name');
  assert.ok(templateEditor.switches > 1, 'template editor exposes the overall-limit and pattern membership switches');
  assert.ok(templateEditor.save, 'template editor exposes Save template');
  assert.deepEqual(templateEditor.scrollables, ['host scroller'], 'template editor has no nested scroll region');
  const filterTemplateMembers = async value => {
    await evaluate(`(() => {const input=document.querySelector('[role="dialog"] .qp-template-picker input[type="search"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  };
  await filterTemplateMembers('Multiple Choice');
  await wait(`document.querySelectorAll('[role="dialog"] .qp-template-picker .qp-template-members > .qp-boolean-field').length===1`);
  const matchingMembers = await evaluate(`[...document.querySelectorAll('[role="dialog"] .qp-template-picker .qp-template-members > .qp-boolean-field')].map(field=>field.innerText.trim())`);
  assert.equal(matchingMembers.length, 1, 'template search filters the membership choices');
  assert.match(matchingMembers[0], /Multiple Choice/, 'template search leaves the matching pattern visible');
  await filterTemplateMembers('visual-no-matching-pattern');
  await wait(`document.querySelector('[role="dialog"] .qp-template-picker .qp-template-members .qp-muted')?.textContent.includes('No matching patterns')`);
  await filterTemplateMembers('');
  await wait(`document.querySelectorAll('[role="dialog"] .qp-template-picker .qp-template-members > .qp-boolean-field').length===${templateEditor.initialMemberCount}`);
  await evaluate(`document.querySelector('button[role="switch"][aria-label="Bypass overall example limit"]').click()`);
  await wait(`document.querySelector('button[role="switch"][aria-label="Bypass overall example limit"]')?.getAttribute('aria-checked')==='false'`);
  await evaluate(`document.querySelector('button[role="switch"][aria-label="Direct Question"]').click()`);
  await wait(`document.querySelector('button[role="switch"][aria-label="Direct Question"]')?.getAttribute('aria-checked')==='true'`);
  await noOverflow('narrow light template editor'); await screenshot('narrow-template-editor-light');
  await evaluate(`document.documentElement.dataset.theme='dark'`);
  await noOverflow('narrow dark template editor'); await screenshot('narrow-template-editor-dark');
  await viewport(390, 420);
  const templateScroll = await evaluate(`(() => {const editor=document.querySelector('[role="dialog"]'),scroller=editor.querySelector('[data-plugin-ui-dialog-scroll]');return [...editor.querySelectorAll('*')].filter(element=>['auto','scroll'].includes(getComputedStyle(element).overflowY)).map(element=>element===scroller?'host scroller':element.className?.toString()||element.tagName)})()`);
  assert.deepEqual(templateScroll, ['host scroller'], 'short narrow template editor keeps one host-owned vertical scroller');
  await noOverflow('short narrow template editor');
  await evaluate(`document.querySelector('button[aria-label="Close dialog"]').click()`);
  await wait(`!document.querySelector('[role="dialog"]')`);
  const templateSnapshots = await evaluate(`window.__visualCalls.filter(call=>call.name==='templates-snapshot').map(call=>call.input)`);
  assert.ok(templateSnapshots.every(input=>Object.keys(input).length===0), 'all templates-snapshot calls use {}');
  await evaluate(`document.querySelector('button[aria-label="Delete template: Math"]').click()`);
  await wait(`!!document.querySelector('.qp-template-confirm')`);
  await evaluate(`[...document.querySelectorAll('.qp-template-confirm button')].find(button=>button.textContent.trim()==='Delete template').click()`);
  await wait(`!document.querySelector('.qp-template-record[aria-label="Math"]')`);
  await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(tab=>tab.textContent==='Patterns').click()`);
  await wait(`!!document.querySelector('button[aria-label="Delete pattern: Direct Question"]')`);
  const trashIcon = await evaluate(`(() => {const button=document.querySelector('button[aria-label="Delete pattern: Direct Question"]');const rect=button.querySelector('svg').getBoundingClientRect();return {title:button.title,text:button.textContent,visible:rect.width>=12&&rect.height>=12}})()`);
  assert.deepEqual(trashIcon, { title: 'Delete pattern: Direct Question', text: '', visible: true });
  await evaluate(`document.querySelector('button[aria-label="Delete pattern: Direct Question"]').click()`);
  await wait(`!!document.querySelector('.qp-delete-confirm')`);
  await noOverflow('narrow pattern delete confirmation'); await screenshot('narrow-pattern-delete-dark');
  assert.equal(await evaluate(`window.__visualCalls.some(call=>call.name==='pattern-delete')`), false, 'trash click alone does not delete');
  await evaluate(`[...document.querySelectorAll('.qp-delete-confirm button')].find(button=>button.textContent.trim()==='Cancel').click()`);
  await wait(`!document.querySelector('.qp-delete-confirm')`);
  await evaluate(`document.querySelector('button[aria-label="Delete pattern: Direct Question"]').click()`);
  await wait(`!!document.querySelector('.qp-delete-confirm')`);
  await evaluate(`[...document.querySelectorAll('.qp-delete-confirm button')].find(button=>button.textContent.trim()==='Delete pattern').click()`);
  await wait(`!document.querySelector('button[aria-label="Delete pattern: Direct Question"]')`);
  const deletion = await evaluate(`window.__visualCalls.filter(call=>call.name==='pattern-delete')`);
  assert.equal(deletion.length, 1);
  assert.ok(Number.isInteger(deletion[0].input.expectedRevision), 'pattern deletion sends expected revision');
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('Visual smoke passed: Patterns and Templates lists/editors, default pins, search and trash confirmations; desktop + narrow, light + dark, no overflow or nested template scrolling, no runtime errors.');
  console.log(`Screenshots (fictional fixture, not native-host verification): ${directory}`);
  await send('Browser.close');
} finally { socket?.close(); child.kill(); }
