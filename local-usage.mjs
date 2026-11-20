import { resolvePrice } from './pricing.mjs';

export function readTokenUsage(raw) {
    const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (!valid(raw?.promptTokenCount) || !valid(raw?.candidatesTokenCount)) return null;
    return { input: raw.promptTokenCount, cached: Math.min(raw.promptTokenCount, valid(raw.cachedContentTokenCount) ? raw.cachedContentTokenCount : 0),
        output: raw.candidatesTokenCount, thinking: valid(raw.thoughtsTokenCount) ? raw.thoughtsTokenCount : 0 };
}

export function localCost(row, catalog) {
    const price = resolvePrice(catalog, row.model, row.tier, row.region, row.at);
    if (!price) return null;
    const long = price.threshold && row.input > price.threshold;
    const input = long ? price.longInput : price.input;
    const output = long ? price.longOutput : price.output;
    const cached = long ? price.longCached : price.cached;
    if (!Number.isFinite(input) || !Number.isFinite(output) || row.cached > 0 && !Number.isFinite(cached)) return null;
    return ((row.input - row.cached) * input + row.cached * (cached || 0) + (row.output + row.thinking) * output) / 1e6;
}

export function summarizeLocal(rows, catalog, start, end) {
    const result = { input: 0, output: 0, low: 0, high: 0, unpriced: new Set(), models: new Map(), approximate: 0, requests: 0 };
    for (const row of rows) {
        if (row.at < start || row.at >= end) continue;
        result.requests++; result.input += row.input; result.output += row.output + row.thinking;
        result.approximate += row.estimated || row.partial ? 1 : 0;
        const amount = localCost(row, catalog);
        const key = JSON.stringify([row.model, row.tier, row.region]);
        const model = result.models.get(key) || { model: row.model, tier: row.tier, region: row.region, input: 0, output: 0, low: 0, high: 0, unknown: false };
        model.input += row.input; model.output += row.output + row.thinking;
        if (amount === null) { result.unpriced.add(`${row.model} (${row.tier})`); model.unknown = true; }
        else { result.low += amount; result.high += amount; model.low += amount; model.high += amount; }
        result.models.set(key, model);
    }
    return { ...result, unpriced: [...result.unpriced], models: [...result.models.values()] };
}

export function installLocalObserver({ identify, record, estimateInput, fetcher = window.fetch }) {
    if (window.__vertexUsageLocalCapture) return;
    window.__vertexUsageLocalCapture = true;
    window.fetch = async function (input, options) {
        let meta;
        try {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
            if (url.origin === location.origin && url.pathname === '/api/backends/chat-completions/generate' && typeof options?.body === 'string') {
                const data = JSON.parse(options.body);
                if (data.chat_completion_source === 'vertexai') meta = { data, identity: identify(data), at: Date.now() };
            }
        } catch { /* Observation cannot block a chat request. */ }
        const response = await fetcher.apply(this, arguments);
        if (meta && response.ok) {
            try { void inspect(response.clone(), meta).catch(() => {}); } catch { /* Leave caller response untouched. */ }
        }
        return response;
    };
    async function inspect(response, { data, identity, at }) {
        let tokens = null; let characters = 0; let partial = false; let error = false;
        const inspectObject = object => {
            if (Array.isArray(object)) { object.forEach(inspectObject); return; }
            error ||= Boolean(object?.error);
            tokens = readTokenUsage(object?.usageMetadata) || tokens;
            const parts = object?.candidates?.[0]?.content?.parts;
            characters += parts ? parts.reduce((n, part) => n + (part.text?.length || 0), 0)
                : String(object?.choices?.[0]?.message?.content || object?.choices?.[0]?.delta?.content || '').length;
        };
        try {
            if (!data.stream) inspectObject(await response.json());
            else {
                const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let oversized = false;
                const parseFrame = frame => {
                    const text = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
                    if (!text || text === '[DONE]') return;
                    try { inspectObject(JSON.parse(text)); } catch { /* Bad event doesn't affect chat. */ }
                };
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
                        let position;
                        while ((position = buffer.indexOf('\n\n')) >= 0) {
                            const frame = buffer.slice(0, position); buffer = buffer.slice(position + 2);
                            if (!oversized && frame.length <= 1048576) parseFrame(frame); oversized = false;
                        }
                        if (buffer.length > 1048576) { buffer = ''; oversized = true; }
                    }
                    buffer += decoder.decode(); if (buffer && !oversized) parseFrame(buffer);
                } finally { reader.releaseLock(); }
            }
        } catch { partial = true; }
        if (error && !tokens && !characters) return;
        const estimated = !tokens;
        if (!tokens) {
            const text = (data.messages || []).map(message => typeof message.content === 'string' ? message.content
                : Array.isArray(message.content) ? message.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n') : '').join('\n');
            let input;
            try { input = await estimateInput(text); } catch { input = Math.ceil(text.length / 2); }
            tokens = { input: Number.isFinite(input) ? input : Math.ceil(text.length / 2), cached: 0, output: Math.ceil(characters / 2), thinking: 0 };
        }
        await record({ id: crypto.randomUUID(), ...identity, at, model: String(data.model || ''), tier: data.vertex_flex ? 'flex' : 'standard',
            region: data.vertexai_region || 'us-central1', ...tokens, estimated, partial });
    }
}
