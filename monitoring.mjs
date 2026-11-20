// Browser-only OAuth and Monitoring. Fixed Google endpoints; no keys are sent to ST.
export const METRIC = 'aiplatform.googleapis.com/publisher/online_serving/token_count';
export const MAX_LOOKBACK = 40 * 86400000;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const tokens = new Map();
const inflight = new Map();

export class MonitoringError extends Error {
    constructor(code, message) { super(message); this.name = 'MonitoringError'; this.code = code; }
}

export function projectId(value) {
    const id = String(value || '').trim();
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(id)) throw new MonitoringError('PROJECT', '프로젝트 이름이나 번호 대신 프로젝트 ID를 확인하세요.');
    return id;
}

export function parseServiceAccount(raw) {
    let json;
    try { json = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { throw new MonitoringError('JSON', '서비스 계정 JSON 파일 형식을 확인하세요.'); }
    if (json?.type !== 'service_account' || typeof json.client_email !== 'string'
        || !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(json.client_email)
        || typeof json.private_key !== 'string') {
        throw new MonitoringError('JSON', 'project_id·client_email·private_key가 있는 서비스 계정 JSON이 필요합니다. Express API 키 문자열은 사용할 수 없습니다.');
    }
    return { projectId: projectId(json.project_id), email: json.client_email, privateKey: json.private_key.replace(/\\n/g, '\n') };
}

export async function importCredential(raw, cryptoAPI = globalThis.crypto) {
    if (!cryptoAPI?.subtle) throw new MonitoringError('HTTPS', 'HTTPS 또는 localhost 주소에서 접속한 뒤 JSON을 등록하세요.');
    const parsed = parseServiceAccount(raw);
    let signingKey;
    try {
        const bytes = Uint8Array.from(atob(parsed.privateKey.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), c => c.charCodeAt(0));
        signingKey = await cryptoAPI.subtle.importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    } catch { throw new MonitoringError('KEY', 'JSON의 서비스 계정 개인키를 읽지 못했습니다. 원본 JSON 파일을 다시 선택하세요.'); }
    const digest = await cryptoAPI.subtle.digest('SHA-256', new TextEncoder().encode(parsed.email + parsed.privateKey));
    const id = Array.from(new Uint8Array(digest).slice(0, 16), n => n.toString(16).padStart(2, '0')).join('');
    // Raw JSON/private-key text is intentionally not returned or persisted.
    return { id, projectId: parsed.projectId, email: parsed.email, signingKey, addedAt: Date.now() };
}

function encode(value) {
    return btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), n => String.fromCharCode(n)).join(''))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function requestJson(url, options = {}, fetcher = globalThis.fetch) {
    for (let attempt = 0; attempt < 3; attempt++) {
        let response;
        try {
            response = await fetcher(url, { ...options, mode: 'cors', credentials: 'omit',
                signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
        } catch (error) {
            if (options.signal?.aborted) throw error;
            throw new MonitoringError('NETWORK', 'Google에 직접 연결하지 못했습니다. 인터넷 연결·브라우저 차단 설정을 확인하세요.');
        }
        let data = null;
        try { data = await response.json(); } catch { /* No raw response text is propagated. */ }
        if (response.ok) {
            if (!data || typeof data !== 'object') throw new MonitoringError('RESPONSE', 'Google 응답 형식을 확인하지 못했습니다.');
            return data;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 350 * 2 ** attempt));
            options.signal?.throwIfAborted();
            continue;
        }
        const reasons = Array.isArray(data?.error?.details) ? data.error.details.map(d => d.reason) : [];
        // Only Google's enum codes are shown, never the raw error text.
        const safe = value => typeof value === 'string' && /^[A-Za-z_]{2,40}$/.test(value) ? value : '';
        const code = ` [${[response.status, safe(data?.error?.status), ...reasons.map(safe), safe(typeof data?.error === 'string' ? data.error : '')].filter(Boolean).join(' · ')}]`;
        if (reasons.includes('SERVICE_DISABLED') || reasons.includes('API_DISABLED')) {
            throw new MonitoringError('API_DISABLED', `이 프로젝트의 Cloud Monitoring API를 사용 설정하세요.${code}`);
        }
        if (response.status === 403) throw new MonitoringError('PERMISSION', `조회할 프로젝트의 IAM에서 이 JSON 계정에 Monitoring 뷰어(roles/monitoring.viewer)를 추가하세요.${code}`);
        if (response.status === 401 || data?.error === 'invalid_grant' || data?.error === 'invalid_client') {
            throw new MonitoringError('AUTH', `Google 인증이 거부되었습니다. JSON 키 상태와 기기 날짜·시간을 확인하세요.${code}`);
        }
        if (response.status === 429) throw new MonitoringError('QUOTA', '조회 요청이 많습니다. 잠시 후 다시 조회하세요.');
        if (response.status === 404) throw new MonitoringError('NOT_FOUND', `프로젝트 ID와 Monitoring API 설정을 확인하세요.${code}`);
        throw new MonitoringError('GOOGLE', `Google 조회에 실패했습니다. 설정을 확인한 뒤 다시 시도하세요.${code}`);
    }
}

export function clearToken(id) { tokens.delete(id); }

export async function accessToken(account, fetcher = globalThis.fetch, now = Date.now()) {
    const cached = tokens.get(account.id);
    if (cached && cached.expires > now + 60000) return cached.value;
    if (!inflight.has(account.id)) {
        const job = (async () => {
            const seconds = Math.floor(now / 1000);
            const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.email,
                scope: 'https://www.googleapis.com/auth/monitoring.read', aud: TOKEN_URL, iat: seconds, exp: seconds + 3600 })}`;
            let signature;
            try { signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', account.signingKey, new TextEncoder().encode(unsigned)); }
            catch { throw new MonitoringError('KEY', '브라우저의 인증 키를 사용할 수 없습니다. JSON을 다시 등록하세요.'); }
            const encoded = btoa(Array.from(new Uint8Array(signature), n => String.fromCharCode(n)).join(''))
                .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
            const data = await requestJson(TOKEN_URL, { method: 'POST',
                body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${encoded}` }) }, fetcher);
            if (typeof data.access_token !== 'string' || !data.access_token) throw new MonitoringError('AUTH', 'Google 인증 토큰을 받지 못했습니다.');
            const value = { value: data.access_token, expires: now + Math.min(3600, Math.max(60, Number(data.expires_in) || 3600)) * 1000 };
            if (tokens.size > 30) tokens.clear();
            tokens.set(account.id, value);
            return value.value;
        })().finally(() => inflight.delete(account.id));
        inflight.set(account.id, job);
    }
    return inflight.get(account.id);
}

export function buildQuery(project, start, end) {
    projectId(project);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > MAX_LOOKBACK + 60000) {
        throw new MonitoringError('INTERVAL', '조회 범위는 최대 40일입니다.');
    }
    const params = new URLSearchParams({
        filter: `metric.type="${METRIC}" AND resource.type="aiplatform.googleapis.com/PublisherModel" AND resource.labels.project_id="${project}"`,
        'interval.startTime': new Date(start).toISOString(), 'interval.endTime': new Date(end).toISOString(),
        'aggregation.alignmentPeriod': '3600s', 'aggregation.perSeriesAligner': 'ALIGN_SUM',
        'aggregation.crossSeriesReducer': 'REDUCE_SUM', pageSize: '10000', view: 'FULL',
    });
    for (const field of ['resource.labels.model_user_id', 'resource.labels.location', 'metric.labels.type',
        'metric.labels.shared_request_type', 'metric.labels.request_type', 'metric.labels.explicit_caching',
        'metric.labels.modality', 'metric.labels.source', 'metric.labels.max_token_size']) params.append('aggregation.groupByFields', field);
    return params;
}

export function decodeSeries(data) {
    const rows = [];
    for (const series of data.timeSeries || []) {
        const labels = series.metric?.labels || {};
        const resource = series.resource?.labels || {};
        const model = resource.model_user_id;
        const direction = String(labels.type || '').toLowerCase();
        if (typeof model !== 'string' || !['input', 'output'].includes(direction)) continue;
        const requestedTier = String(labels.shared_request_type || '').toLowerCase();
        const tier = labels.request_type === 'dedicated' ? 'dedicated'
            : /^(flex|flex_paygo)$/.test(requestedTier) ? 'flex'
                : /^(priority|batch)$/.test(requestedTier) ? requestedTier
                    : !requestedTier || requestedTier === 'standard' ? 'standard' : 'unknown';
        const source = String(labels.source || '').toLowerCase();
        const region = source === 'global' ? 'global' : source || resource.location || 'unknown';
        for (const point of series.points || []) {
            const count = Number(point.value?.int64Value);
            const start = Date.parse(point.interval?.startTime);
            const end = Date.parse(point.interval?.endTime);
            if (!Number.isSafeInteger(count) || count <= 0 || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) continue;
            rows.push({ model, direction, count, start, end, tier, region,
                context: String(labels.max_token_size || ''), cached: labels.explicit_caching === 'true',
                modality: String(labels.modality || '').toLowerCase(), assumedTier: !requestedTier });
        }
    }
    return rows;
}

export async function queryUsage(account, project, start, end, { signal, fetcher = globalThis.fetch } = {}) {
    const params = buildQuery(project, start, end);
    let token = await accessToken(account, fetcher);
    signal?.throwIfAborted();
    const rows = [];
    const pages = new Set();
    let renewed = false;
    while (true) {
        let data;
        try {
            data = await requestJson(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries?${params}`, {
                headers: { Authorization: `Bearer ${token}` }, signal,
            }, fetcher);
        } catch (error) {
            if (error.code === 'AUTH' && !renewed) { clearToken(account.id); token = await accessToken(account, fetcher); renewed = true; continue; }
            throw error;
        }
        rows.push(...decodeSeries(data));
        const next = data.nextPageToken;
        if (!next) break;
        if (pages.has(next) || pages.size >= 50 || rows.length > 500000) throw new MonitoringError('TOO_LARGE', '조회 결과가 너무 많습니다. 조회 기간을 줄여 주세요.');
        pages.add(next); params.set('pageToken', next);
    }
    return { version: 1, projectId: project, queryStart: start, queryEnd: end, fetchedAt: Date.now(),
        latestUsageEnd: rows.length ? rows.reduce((latest, row) => Math.max(latest, row.end), 0) : null, rows };
}
