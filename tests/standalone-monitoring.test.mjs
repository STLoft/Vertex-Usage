import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { importCredential, parseServiceAccount, accessToken, clearToken, buildQuery, decodeSeries, queryUsage } from '../monitoring.mjs';
import { rowCost, summarizeMonitoring } from '../monitoring-cost.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
const raw = { type: 'service_account', project_id: 'demo-project', client_email: 'demo@demo-project.iam.gserviceaccount.com', private_key: privateKey,
    token_uri: 'https://untrusted.invalid/token' };
const start = Date.UTC(2026, 10, 20, 1);
const end = start + 3600000;
const series = (type, count, tier = 'standard') => ({ resource: { labels: { model_user_id: 'gemini-2.5-flash', location: 'us-central1' } },
    metric: { labels: { type, shared_request_type: tier, source: 'global', modality: 'text', max_token_size: '0-200k', explicit_caching: 'false' } },
    points: [{ interval: { startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() }, value: { int64Value: String(count) } }] });
const catalog = { currency: 'USD', rates: [
    { model: 'gemini-2.5-flash', region: 'any', tier: 'standard', from: 0, until: null, input: .3, output: 2.5 },
    { model: 'gemini-2.5-flash', region: 'any', tier: 'flex', from: 0, until: null, input: .15, output: 1.25 },
] };

test('imports a non-extractable signing key without retaining JSON/private text', async () => {
    const account = await importCredential(JSON.stringify(raw));
    assert.equal(account.projectId, raw.project_id);
    assert.equal(account.signingKey.extractable, false);
    assert.equal(account.signingKey.type, 'private');
    assert.ok(!JSON.stringify(account).includes('PRIVATE KEY'));
    await assert.rejects(() => crypto.subtle.exportKey('pkcs8', account.signingKey));
    assert.throws(() => parseServiceAccount('{broken json'), /JSON/);
    assert.throws(() => parseServiceAccount('"an-express-api-key"'), /서비스 계정/);
});

test('browser JWT is signed correctly, scoped read-only and sent only to fixed Google OAuth', async () => {
    const account = await importCredential(raw); clearToken(account.id);
    let calls = 0;
    const fetcher = async (url, options) => {
        calls++;
        assert.equal(url, 'https://oauth2.googleapis.com/token');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
        const jwt = options.body.get('assertion'); const [header, payload, signature] = jwt.split('.');
        assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
        const data = JSON.parse(Buffer.from(payload, 'base64url'));
        assert.equal(data.scope, 'https://www.googleapis.com/auth/monitoring.read');
        assert.equal(data.iss, raw.client_email);
        assert.equal(data.exp - data.iat, 3600);
        assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
        return Response.json({ access_token: 'mock-token', expires_in: 3600 });
    };
    assert.deepEqual(await Promise.all([accessToken(account, fetcher), accessToken(account, fetcher)]), ['mock-token', 'mock-token']);
    assert.equal(calls, 1); clearToken(account.id);
});

test('Monitoring query isolates the project and retains Flex, region, cache and modality dimensions', () => {
    const params = buildQuery('demo-project', start, end);
    assert.ok(params.get('filter').includes('resource.labels.project_id="demo-project"'));
    assert.ok(params.getAll('aggregation.groupByFields').includes('metric.labels.shared_request_type'));
    assert.ok(params.getAll('aggregation.groupByFields').includes('metric.labels.explicit_caching'));
    assert.throws(() => buildQuery('bad" OR true', start, end));
    assert.throws(() => buildQuery('demo-project', start, start + 45 * 86400000));
});

test('paginates without duplicates and preserves read-only dimensions', async () => {
    const account = await importCredential(raw); clearToken(account.id);
    const urls = [];
    const snapshot = await queryUsage(account, 'demo-project', start, end, { fetcher: async (url, options) => {
        urls.push(String(url));
        if (String(url).includes('oauth2')) return Response.json({ access_token: 'TOKEN', expires_in: 3600 });
        assert.ok(String(url).startsWith('https://monitoring.googleapis.com/v3/projects/demo-project/timeSeries?'));
        assert.equal(options.headers.Authorization, 'Bearer TOKEN');
        return String(url).includes('pageToken=second') ? Response.json({ timeSeries: [series('output', 50, 'flex')] })
            : Response.json({ timeSeries: [series('input', 100, 'flex')], nextPageToken: 'second' });
    } });
    assert.equal(urls.length, 3);
    assert.equal(snapshot.rows.length, 2);
    assert.equal(snapshot.rows[1].tier, 'flex');
    assert.equal(snapshot.rows[1].region, 'global');
    assert.equal(snapshot.latestUsageEnd, end);
    const sum = summarizeMonitoring(snapshot, catalog, start, end);
    assert.equal(sum.input, 100); assert.equal(sum.output, 50);
    assert.equal(sum.low, .0000775); assert.equal(sum.high, .0000775);
    assert.ok(!JSON.stringify(snapshot).includes('TOKEN')); clearToken(account.id);
});

test('empty data is zero; unknown models and non-text output never silently become free', () => {
    assert.equal(summarizeMonitoring({ rows: [] }, catalog, start, end).low, 0);
    const rows = decodeSeries({ timeSeries: [series('input', 10)] });
    const unknown = { ...rows[0], model: 'new-unknown-model' };
    assert.equal(summarizeMonitoring({ rows: [unknown] }, catalog, start, end).unpriced.length, 1);
    assert.equal(rowCost({ ...rows[0], direction: 'output', modality: 'image' }, catalog), null);
    assert.equal(decodeSeries({ timeSeries: [series('input', 0), series('input', -1)] }).length, 0);
});

test('uncertain long context and baseline overlap return ranges instead of a false exact total', () => {
    const longCatalog = { currency: 'USD', rates: [{ ...catalog.rates[0], threshold: 200000, longInput: .6, longOutput: 5 }] };
    const row = { ...decodeSeries({ timeSeries: [series('input', 100)] })[0], context: 'unknown' };
    assert.deepEqual(rowCost(row, longCatalog), { low: .00003, high: .00006 });
    assert.equal(rowCost({ ...row, context: '200k+' }, longCatalog).high, .00006);
    const sum = summarizeMonitoring({ rows: [row] }, longCatalog, start + 1, end);
    assert.equal(sum.low, 0); assert.equal(sum.high, .00006); assert.equal(sum.boundary, true);
});

test('API/network errors are actionable without forwarding credentials or Google error bodies', async () => {
    const account = await importCredential(raw); clearToken(account.id);
    await assert.rejects(() => queryUsage(account, 'demo-project', start, end, { fetcher: async url =>
        String(url).includes('oauth2') ? Response.json({ access_token: 'SECRET_TOKEN', expires_in: 3600 })
            : Response.json({ error: { message: 'SECRET_BODY', details: [] } }, { status: 403 }) }), error => error.code === 'PERMISSION' && !error.message.includes('SECRET'));
    clearToken(account.id);
    await assert.rejects(() => accessToken(account, async () => { throw new TypeError('PRIVATE_KEY SHOULD NOT APPEAR'); }), error => error.code === 'NETWORK' && !error.message.includes('PRIVATE_KEY'));
});
