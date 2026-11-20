// Headless browser integration using generated test credentials and mocked Google APIs.
// No real service-account files, server plugins or Google accounts are used.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prefix = '/scripts/extensions/third-party/ST-Vertex-Usage/';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
const credential = { type: 'service_account', project_id: 'demo-project', client_email: 'demo@demo-project.iam.gserviceaccount.com',
    private_key: privateKey, token_uri: 'https://not-allowed.invalid/token' };
const modules = ['index.js', 'standalone-ui.mjs', 'monitoring.mjs', 'monitoring-cost.mjs', 'pricing.mjs', 'vault.mjs', 'local-usage.mjs', 'credit-period.mjs', 'floating-ui.mjs', 'prices.json', 'style.css'];
let pluginRequests = 0;
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/plugins')) { pluginRequests++; res.writeHead(404); res.end(); return; }
    if (url.pathname === '/scripts/user.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('export const getCurrentUserHandle=()=>"browser-test-user";'); return; }
    if (url.pathname === '/scripts/tokenizers.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('export const getTokenCountAsync=async text=>Math.ceil(text.length/2);'); return; }
    if (url.pathname === '/scripts/secrets.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('export const SECRET_KEYS={VERTEXAI:"express",VERTEXAI_SERVICE_ACCOUNT:"full"};export const secret_state={express:[{id:"express-key",active:true}],full:[{id:"full-key",active:true}]};'); return; }
    if (url.pathname === '/api/backends/chat-completions/generate') {
        let body = ''; for await (const chunk of req) body += chunk;
        if (JSON.parse(body).stream === false) { res.setHeader('Content-Type', 'application/json'); res.end('{"choices":[{"message":{"content":"Plain test response"}}]}'); return; }
        res.setHeader('Content-Type', 'text/event-stream');
        res.end('data: {"candidates":[{"content":{"parts":[{"text":"Test reply"}]}}]}\n\ndata: {"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":10,"candidatesTokenCount":20,"thoughtsTokenCount":30}}\n\ndata: [DONE]\n\n'); return;
    }
    if (url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>*{box-sizing:border-box}body{background:#202328;color:#eee;font:16px system-ui;padding:16px;margin:0;--SmartThemeBorderColor:#51575f;--SmartThemeEmColor:#abb1bc;--SmartThemeQuoteColor:#ebc583}#extensions_settings2{max-width:440px;margin:auto}.inline-drawer-header{display:flex;justify-content:space-between;background:#343943;padding:12px;border-radius:8px}input,select,textarea,button{font:inherit;background:#303640;color:#eee;border:1px solid #58616e;border-radius:5px;padding:7px}summary{list-style-position:inside}</style>
        <link rel="stylesheet" href="${prefix}style.css"><div id="extensions_settings2"></div><script>
        const saved=JSON.parse(localStorage.getItem('mock-settings')||'{}');
        const listeners={};window.__context={extensionSettings:{...saved,connectionManager:{selectedProfile:'full-profile',profiles:[
        {id:'full-profile',name:'Full demo',api:'vertexai',model:'gemini-2.5-flash','secret-id':'full-key'},
        {id:'express-profile',name:'Express demo',api:'vertexai',model:'gemini-2.5-pro','secret-id':'express-key'}]},vertexAuthPerProfile:{profiles:{'express-profile':{mode:'express',expressProjectId:'another-project',secretId:'express-key'}}}},
        chatCompletionSettings:{chat_completion_source:'vertexai',vertexai_auth_mode:'full'},
        saveSettingsDebounced(){localStorage.setItem('mock-settings',JSON.stringify(window.__context.extensionSettings))},
        eventSource:{on(name,fn){(listeners[name]??=[]).push(fn)}},eventTypes:{CONNECTION_PROFILE_LOADED:'profile'}};
        window.SillyTavern={getContext:()=>window.__context};window.jQuery=fn=>{window.__ready=Promise.resolve().then(fn)};
        </script><script type="module" src="${prefix}index.js"></script></html>`); return;
    }
    if (url.pathname.startsWith(prefix)) {
        const filename = url.pathname.slice(prefix.length);
        if (!modules.includes(filename)) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', filename.endsWith('.json') ? 'application/json' : filename.endsWith('.css') ? 'text/css' : 'text/javascript');
        res.end(await fs.readFile(path.join(extension, filename))); return;
    }
    res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let oauthCalls = 0; let metricsCalls = 0; let denied = false;
await page.route('https://oauth2.googleapis.com/token', async route => {
    oauthCalls++;
    const body = new URLSearchParams(route.request().postData());
    const jwt = body.get('assertion'); const [header, payload, signature] = jwt.split('.');
    assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).scope, 'https://www.googleapis.com/auth/monitoring.read');
    await route.fulfill({ json: { access_token: 'mock-only-token', expires_in: 3600 } });
});
await page.route('https://monitoring.googleapis.com/**', async route => {
    metricsCalls++;
    assert.equal(route.request().headers().authorization, 'Bearer mock-only-token');
    if (denied) { await route.fulfill({ status: 403, json: { error: { message: 'Do not forward this raw message', status: 'PERMISSION_DENIED' } } }); return; }
    const params = new URL(route.request().url()).searchParams;
    assert.ok(params.getAll('aggregation.groupByFields').includes('metric.labels.shared_request_type'));
    const finish = Math.floor(Date.now() / 3600000) * 3600000;
    const point = count => ({ interval: { startTime: new Date(finish - 3600000).toISOString(), endTime: new Date(finish).toISOString() }, value: { int64Value: String(count) } });
    const series = (model, direction, value, tier) => ({ resource: { labels: { model_user_id: model, location: 'us-central1' } },
        metric: { labels: { type: direction, shared_request_type: tier, source: 'global', modality: 'text', max_token_size: '0-200k' } }, points: [point(value)] });
    await route.fulfill({ json: { timeSeries: [series('gemini-2.5-flash', 'input', 1000000, 'standard'), series('gemini-2.5-flash', 'output', 200000, 'standard'),
        series('gemini-2.5-pro', 'input', 100000, 'flex'), series('gemini-2.5-pro', 'output', 10000, 'flex')] } });
});
try {
    await page.goto(origin); await page.evaluate(() => window.__ready);
    assert.equal(await page.locator('#vu-profile').inputValue(), 'full-profile');
    assert.equal(pluginRequests, 0);
    assert.equal(await page.locator('#vu-source').inputValue(), 'local');
    await page.selectOption('#vu-source', 'monitoring');
    await page.setInputFiles('#vu-json-file', { name: 'generated-test-account.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(credential)) });
    await page.check('#vu-remember'); await page.click('#vu-register');
    await page.waitForFunction(() => document.querySelector('#vu-status').textContent.includes('갱신 완료'));
    assert.equal(oauthCalls, 1); assert.equal(metricsCalls, 1);
    assert.ok((await page.locator('#vu-summary').innerText()).includes('0.9125'));
    assert.ok((await page.locator('#vu-summary').innerText()).includes('gemini-2.5-pro'));
    assert.ok((await page.locator('#vu-summary').innerText()).includes('flex'));
    assert.equal(await page.locator('#vu-json-text').inputValue(), '');
    assert.equal(await page.locator('#vu-json-file').inputValue(), '');
    assert.ok(!await page.evaluate(() => localStorage.getItem('mock-settings').includes('PRIVATE KEY')));
    assert.ok(!await page.evaluate(() => localStorage.getItem('mock-settings').includes('mock-only-token')));
    const stored = await page.evaluate(async () => {
        const db = await new Promise(resolve => { const request = indexedDB.open('st-vertex-usage-v3:browser-test-user', 2); request.onsuccess = () => resolve(request.result); });
        const accounts = await new Promise(resolve => { const request = db.transaction('accounts').objectStore('accounts').getAll(); request.onsuccess = () => resolve(request.result); });
        db.close();
        return { length: accounts.length, extractable: accounts[0].signingKey.extractable, text: JSON.stringify(accounts) };
    });
    assert.equal(stored.length, 1); assert.equal(stored.extractable, false); assert.ok(!stored.text.includes('PRIVATE KEY'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await fs.mkdir(path.join(extension, 'outputs'), { recursive: true });
    await page.screenshot({ path: path.join(extension, 'outputs', 'standalone-mobile.png'), fullPage: true });
    // Reload uses the remembered non-extractable key and cached result, no JSON re-entry.
    await page.reload(); await page.evaluate(() => window.__ready);
    await page.waitForFunction(() => document.querySelector('#vu-summary').textContent.includes('0.9125'));
    assert.equal(metricsCalls, 1);
    await page.click('#vu-refresh'); await page.waitForFunction(() => document.querySelector('#vu-status').textContent.includes('갱신 완료'));
    assert.equal(oauthCalls, 2); assert.equal(metricsCalls, 2);
    await page.selectOption('#vu-profile', 'express-profile');
    await page.selectOption('#vu-source', 'monitoring');
    await page.waitForFunction(() => document.querySelector('#vu-summary').textContent.includes('another-project'));
    await page.waitForFunction(() => document.querySelector('#vu-status').textContent.includes('갱신 완료'));
    assert.equal(await page.evaluate(() => window.__context.extensionSettings.connectionManager.selectedProfile), 'full-profile');
    // A denied read preserves the last good snapshot and shows the single-role setup hint.
    denied = true;
    await page.click('#vu-refresh'); await page.waitForFunction(() => document.querySelector('#vu-status').textContent.includes('Monitoring 뷰어'));
    assert.ok((await page.locator('#vu-summary').innerText()).includes('0.9125'));
    assert.ok(!(await page.locator('#vu-status').innerText()).includes('Do not forward'));
    assert.ok((await page.locator('#vu-iam-link').getAttribute('href')).includes('another-project'));
    // Express key-only mode observes real response tokens, with no JSON or Monitoring dependency.
    await page.selectOption('#vu-source', 'local');
    const callsBeforeLocal = metricsCalls;
    const generate = async () => page.evaluate(async () => (await fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({
        chat_completion_source: 'vertexai', model: 'gemini-2.5-flash', vertexai_auth_mode: 'express', secret_id: 'express-key', vertexai_region: 'global', stream: true,
        messages: [{ role: 'user', content: 'PRIVATE LOCAL PROMPT' }] }) })).text());
    assert.ok((await generate()).includes('usageMetadata'));
    await page.waitForFunction(() => document.querySelector('#vu-summary').textContent.includes('1회'));
    assert.ok((await page.locator('#vu-summary').innerText()).includes('0.00015'));
    assert.equal(metricsCalls, callsBeforeLocal);
    await page.locator('#vu-credit-settings > summary').click();
    const dateValue = offset => { const d = new Date(Date.now() + offset * 86400000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
    await page.fill('#vu-credit-start', dateValue(-10));
    await page.fill('#vu-credit-expires', dateValue(40));
    await page.fill('#vu-credit-calibrate', '125.42');
    await page.locator('#vu-credit-form button').click();
    await page.waitForFunction(() => document.querySelector('#vu-credit-summary').textContent.includes('125.42'));
    await new Promise(resolve => setTimeout(resolve, 20));
    await generate();
    await page.waitForFunction(() => document.querySelector('#vu-credit-summary').innerHTML.includes('125.419'));
    assert.ok((await page.locator('#vu-credit-summary').innerText()).includes('300.00'));
    assert.equal(metricsCalls, callsBeforeLocal);
    assert.ok(!(await page.locator('#vu-credit-summary').innerText()).includes('잔액 맞추기 필요'));
    assert.equal(await page.locator('#vertex-usage-floating').isVisible(), true);
    assert.equal(await page.locator('#vertex-usage-floating').getAttribute('data-layout'), 'pill');
    assert.equal(await page.locator('#vertex-usage-floating .vu-fl-percent').innerText(), '42%');
    assert.match(await page.locator('#vertex-usage-floating .vu-fl-note').innerText(), /^· \d+일$/);
    assert.ok((await page.locator('#vertex-usage-floating').getAttribute('aria-label')).includes('41.8%'));
    await page.locator('#vu-floating-settings > summary').click();
    await page.selectOption('#vu-floating-metric', 'used');
    assert.equal(await page.locator('.vu-fl-percent').innerText(), '58%');
    await page.selectOption('#vu-floating-metric', 'remaining');
    for (const layout of ['pill', 'bar', 'edge', 'ring', 'dot']) {
        await page.selectOption('#vu-floating-layout', layout);
        assert.equal(await page.locator('#vertex-usage-floating').getAttribute('data-layout'), layout);
        if (layout !== 'dot') assert.equal(await page.locator('.vu-fl-percent').innerText(), layout === 'edge' ? '42' : '42%');
        await page.locator('#vertex-usage-floating').screenshot({ path: path.join(extension, 'outputs', `floating-${layout}.png`) });
        if (layout === 'edge') {
            const tab = await page.locator('#vertex-usage-floating').boundingBox();
            assert.ok(Math.abs(tab.x + tab.width - 390) < 1.5, 'edge tab sits flush against the right side');
        }
    }
    await page.selectOption('#vu-floating-layout', 'pill');
    await page.uncheck('#vu-floating-enabled');
    assert.equal(await page.locator('#vertex-usage-floating').isVisible(), false);
    await page.check('#vu-floating-enabled');
    // A failed Google source in the group must not discard the entered balance.
    await page.evaluate(() => { window.__context.extensionSettings.vertexUsage.standalone.links['full-profile'].projectId = 'missing-project'; });
    await page.check('input[name="creditProfile"][value="full-profile"]');
    const anchorBeforeEdit = await page.evaluate(() => window.__context.extensionSettings.vertexUsage.standalone.credit.calibration.at);
    await page.fill('#vu-credit-expires', dateValue(41));
    await page.locator('#vu-credit-form button').click();
    await page.waitForFunction(() => document.querySelector('#vertex-usage-floating').getAttribute('aria-label').includes('미반영'));
    assert.equal(await page.evaluate(() => window.__context.extensionSettings.vertexUsage.standalone.credit.calibration.at), anchorBeforeEdit);
    assert.ok((await page.locator('#vu-credit-summary').innerHTML()).includes('125.419'));
    assert.ok(!(await page.locator('#vu-credit-summary').innerText()).includes('잔액 맞추기 필요'));
    assert.ok((await page.locator('.vu-fl-percent').innerText()).startsWith('≈'));
    await page.uncheck('input[name="creditProfile"][value="full-profile"]');
    await page.locator('#vu-credit-form button').click();
    await page.locator('#vu-floating-settings > summary').click();
    await page.locator('#vu-credit-settings > summary').click();
    // Drag placement is saved on this device and clamped on viewport changes.
    const box = await page.locator('#vertex-usage-floating').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
    await page.mouse.move(30, 80, { steps: 6 }); await page.mouse.up();
    assert.equal(await page.locator('#vertex-usage-detail').isVisible(), false);
    assert.ok(await page.evaluate(() => localStorage.getItem('vertex-usage-position:browser-test-user')));
    await page.locator('#vertex-usage-floating').click();
    assert.equal(await page.locator('#vertex-usage-detail').isVisible(), true);
    assert.ok((await page.locator('#vertex-usage-detail').innerHTML()).includes('125.419'));
    await page.keyboard.press('Escape');
    await page.uncheck('#vu-follow');
    await page.reload(); await page.evaluate(() => window.__ready);
    await page.waitForFunction(() => document.querySelector('.vu-fl-percent').textContent === '42%');
    assert.equal(await page.locator('#vertex-usage-floating').getAttribute('data-layout'), 'pill');
    const moved = await page.locator('#vertex-usage-floating').boundingBox();
    assert.ok(moved.x >= 8 && moved.x < 25 && moved.y >= 8 && moved.y < 90);
    await page.setViewportSize({ width: 320, height: 568 });
    const small = await page.locator('#vertex-usage-floating').boundingBox();
    assert.ok(small.x >= 8 && small.x + small.width <= 312 && small.y + small.height <= 560);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#vu-floating-settings > summary').click(); await page.click('#vu-floating-reset');
    await page.locator('#vu-floating-settings > summary').click();
    await page.screenshot({ path: path.join(extension, 'outputs', 'express-key-only-mobile.png'), fullPage: true });
    assert.equal(pluginRequests, 0);
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.screenshot({ path: path.join(extension, 'outputs', 'standalone-desktop.png'), fullPage: true });
    // Fresh browser context: there is no JSON credential at all, yet Express tracking works.
    const keyOnly = await browser.newPage({ viewport: { width: 390, height: 844 } });
    keyOnly.setDefaultTimeout(15000);
    let unexpectedGoogle = 0;
    await keyOnly.route('https://**', async route => { unexpectedGoogle++; await route.abort(); });
    await keyOnly.goto(origin); await keyOnly.evaluate(() => window.__ready);
    await keyOnly.uncheck('#vu-follow');
    await keyOnly.selectOption('#vu-profile', 'express-profile');
    assert.equal(await keyOnly.locator('#vu-source').inputValue(), 'local');
    assert.equal(await keyOnly.locator('#vu-import').isVisible(), false);
    for (const stream of [true, false]) await keyOnly.evaluate(async stream => {
        const result = await fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({
            chat_completion_source: 'vertexai', model: 'gemini-2.5-flash', vertexai_auth_mode: 'express', secret_id: 'express-key', vertexai_region: 'global', stream,
            messages: [{ role: 'user', content: 'PRIVATE NEVER STORE' }] }) });
        return result.text();
    }, stream);
    await keyOnly.waitForFunction(() => document.querySelector('#vu-summary').textContent.includes('2회'));
    const storedLocal = await keyOnly.evaluate(async () => {
        const db = await new Promise(resolve => { const request = indexedDB.open('st-vertex-usage-v3:browser-test-user', 2); request.onsuccess = () => resolve(request.result); });
        const read = name => new Promise(resolve => { const request = db.transaction(name).objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); });
        const accounts = await read('accounts'); const observations = await read('observations'); db.close();
        return { accounts: accounts.length, rows: observations.length, serialized: JSON.stringify(observations), estimated: observations.some(row => row.estimated) };
    });
    assert.equal(storedLocal.accounts, 0); assert.equal(storedLocal.rows, 2); assert.equal(storedLocal.estimated, true);
    assert.ok(!storedLocal.serialized.includes('PRIVATE NEVER STORE'));
    assert.ok(!storedLocal.serialized.includes('express-key'));
    assert.equal(unexpectedGoogle, 0);
    await keyOnly.reload(); await keyOnly.evaluate(() => window.__ready);
    await keyOnly.waitForFunction(() => document.querySelector('#vu-summary').textContent.includes('2회'));
    assert.equal(await keyOnly.locator('#vertex-usage-floating').isVisible(), false);
    await keyOnly.locator('#vu-credit-settings > summary').click();
    await keyOnly.fill('#vu-credit-start', dateValue(-10)); await keyOnly.fill('#vu-credit-expires', dateValue(40));
    await keyOnly.locator('#vu-credit-form button').click();
    assert.equal(await keyOnly.locator('.vu-fl-percent').innerText(), '—');
    assert.ok((await keyOnly.locator('#vertex-usage-floating').getAttribute('aria-label')).includes('현재 Google 잔액 입력 필요'));
    await keyOnly.fill('#vu-credit-calibrate', '0'); await keyOnly.locator('#vu-credit-form button').click();
    assert.equal(await keyOnly.locator('.vu-fl-percent').innerText(), '0%');
    await keyOnly.locator('#vu-floating-settings > summary').click();
    await keyOnly.selectOption('#vu-floating-metric', 'used');
    assert.equal(await keyOnly.locator('.vu-fl-percent').innerText(), '100%');
    assert.equal(unexpectedGoogle, 0);
    await keyOnly.close();
    console.log('Browser-only UI passed: OAuth/Monitoring, JSON-free capture, partial balance preservation, ring/number and used/remaining views, live credit deduction, drag/reload placement, mobile bounds, detail dialog, unknown/zero balances; server-plugin calls = 0.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
