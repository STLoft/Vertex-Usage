import { resolvePrice } from './pricing.mjs';

function upperContext(text) {
    const clean = String(text).toLowerCase().replace(/,/g, '');
    if (/[+>≥]|greater|over|above|large/.test(clean)) return null;
    const values = [...clean.matchAll(/(\d+(?:\.\d+)?)\s*([km])?/g)].map(m => Number(m[1]) * (m[2] === 'k' ? 1000 : m[2] === 'm' ? 1000000 : 1));
    return values.length ? Math.max(...values) : null;
}

export function rowCost(row, catalog) {
    if (row.modality && !['text', 'image', 'video', 'unspecified'].includes(row.modality)) return null;
    if (row.direction === 'output' && row.modality && !['text', 'unspecified'].includes(row.modality)) return null;
    const rate = resolvePrice(catalog, row.model, row.tier, row.region, row.start);
    if (!rate) return null;
    const field = row.direction === 'input' ? 'input' : 'output';
    const short = rate[field];
    const long = rate[row.direction === 'input' ? 'longInput' : 'longOutput'];
    if (!Number.isFinite(short)) return null;
    const upper = upperContext(row.context);
    const uncertain = rate.threshold && (upper === null || upper > rate.threshold) && Number.isFinite(long) && long !== short;
    const amounts = uncertain ? [short, long] : [short];
    // Monitoring doesn't report the number of cache-discounted tokens here. Keep
    // cache discounts out rather than treating every request with caching as a cache hit.
    return { low: row.count * Math.min(...amounts) / 1e6, high: row.count * Math.max(...amounts) / 1e6 };
}

export function summarizeMonitoring(snapshot, catalog, start, end) {
    const result = { input: 0, output: 0, low: 0, high: 0, unpriced: new Set(), models: new Map(), rows: 0, boundary: false };
    for (const row of snapshot?.rows || []) {
        if (row.end <= start || row.start >= end) continue;
        const partial = row.start < start || row.end > end;
        const cost = rowCost(row, catalog);
        result.rows++;
        result[row.direction] += row.count;
        const key = JSON.stringify([row.model, row.tier, row.region]);
        const model = result.models.get(key) || { model: row.model, tier: row.tier, region: row.region, input: 0, output: 0, low: 0, high: 0, unknown: false };
        model[row.direction] += row.count;
        if (!cost) { result.unpriced.add(`${row.model} (${row.tier})`); model.unknown = true; }
        else {
            result.low += partial ? 0 : cost.low; result.high += cost.high;
            model.low += partial ? 0 : cost.low; model.high += cost.high;
        }
        result.boundary ||= partial;
        result.models.set(key, model);
    }
    return { ...result, unpriced: [...result.unpriced], models: [...result.models.values()] };
}
