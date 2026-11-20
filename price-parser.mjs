// Optional development helper: parses the public Google price page.
const SOURCE = 'https://cloud.google.com/model-garden/pricing';
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const price = value => /^\$\s*[\d,.]+$/.test(value) ? Number(value.replace(/[^\d.]/g, '')) : null;

export function parsePricing(html, fetchedAt = Date.now()) {
    const tabs = new Map();
    for (const match of html.matchAll(/<button\b([^>]+)>/gi)) {
        const id = /\bid="([^"]+)"/.exec(match[1])?.[1];
        const label = /track-metadata-eventdetail="([^"]+)"/.exec(match[1])?.[1];
        if (id && label) tabs.set(id, label);
    }
    const rates = [];
    for (const match of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
        const table = match[0];
        const head = /<tr\b[\s\S]*?<\/tr>/i.exec(table)?.[0] || '';
        const columns = [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(cell => text(cell[1]));
        if (columns[0] !== 'Model' || columns[1] !== 'Type' || !columns.some(c => /(?:1M|200K).*tokens/i.test(c))) continue;
        const before = html.slice(0, match.index);
        const panel = [...before.matchAll(/<div\b[^>]*role="tabpanel"[^>]*aria-labelledby="([^"]+)"[^>]*>/gi)].at(-1)?.[1];
        const label = tabs.get(panel) || '';
        if (/priority/i.test(label + columns.join(' ')) || (/^Batch$/i.test(label))) continue;
        const tier = /flex/i.test(label + columns.join(' ')) ? 'flex' : 'standard';
        const footer = text(html.slice(match.index + table.length, match.index + table.length + 1800));
        const creditBack = /([\d.]+)%\s+credits back on net spend/i.exec(footer);
        const regionIndex = columns.findIndex(c => c === 'Region');
        const normal = columns.findIndex(c => /price/i.test(c) && !/cached|>\s*200/i.test(c) && (tier === 'flex' || !/batch/i.test(c)));
        if (normal < 0) continue;
        const long = columns.findIndex(c => /price/i.test(c) && />\s*200/i.test(c) && !/cached/i.test(c));
        const cached = columns.findIndex(c => /cached/i.test(c) && !/>\s*200/i.test(c));
        const longCached = columns.findIndex(c => /cached/i.test(c) && />\s*200/i.test(c));
        let models = []; let type = ''; let region = 'any'; let from = 0; let until = null;
        for (const row of table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
            const cells = [...row[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => text(cell[1]));
            if (!cells.length) continue;
            if (cells[0]) {
                const modelText = cells[0];
                from = 0; until = null;
                const start = /starting\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i.exec(modelText);
                const end = /through\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i.exec(modelText);
                if (start) from = Date.parse(start[1] + ' 00:00:00 GMT');
                if (end) until = Date.parse(end[1] + ' 00:00:00 GMT') + 86400000;
                // Multiple aliases with different effective dates are intentionally not guessed.
                const name = modelText.split(/\*|\(|through|starting/i)[0].trim();
                models = /^Gemini\s+[\d.]+\s+/i.test(name) && !/image|live|audio|embedding|tts|tuned/i.test(name)
                    ? [name.toLowerCase().replace(/\s+/g, '-')] : [];
                type = ''; region = 'any';
            }
            if (cells[1]) type = cells[1];
            if (regionIndex >= 0 && cells[regionIndex]) region = /non.global/i.test(cells[regionIndex]) ? 'regional' : /^global/i.test(cells[regionIndex]) ? 'global' : 'unknown';
            if (!models.length || region === 'unknown' || /audio|video|image/i.test(type) && !/text/i.test(type) || /char/i.test(type)) continue;
            const direction = /input/i.test(type) ? 'input' : /output/i.test(type) && /text|response|reasoning/i.test(type) ? 'output' : '';
            if (!direction) continue;
            const amount = price(cells[normal] || '');
            if (amount === null) continue;
            for (const model of models) {
                let rate = rates.find(r => r.model === model && r.tier === tier && r.region === region && r.from === from && r.until === until);
                if (!rate) { rate = { model, tier, region, from, until,
                    ...(until && creditBack ? { creditsBack: Number(creditBack[1]) / 100 } : {}) }; rates.push(rate); }
                rate[direction] = amount;
                if (long >= 0) { rate.threshold = 200000; rate[direction === 'input' ? 'longInput' : 'longOutput'] = price(cells[long] || ''); }
                if (direction === 'input' && cached >= 0) rate.cached = price(cells[cached] || '');
                if (direction === 'input' && longCached >= 0) rate.longCached = price(cells[longCached] || '');
            }
        }
    }
    const complete = rates.filter(rate => typeof rate.input === 'number' && typeof rate.output === 'number'
        && Number.isFinite(rate.from) && (rate.until === null || Number.isFinite(rate.until)));
    // The page sometimes advertises a net price after promotional credits back. Use
    // the pre-credit price for gross usage estimates, keeping credit application separate.
    for (const rate of complete) if (rate.creditsBack > 0 && rate.creditsBack < 1) {
        rate.advertisedInput = rate.input; rate.advertisedOutput = rate.output;
        for (const field of ['input', 'output', 'cached', 'longInput', 'longOutput', 'longCached']) {
            if (typeof rate[field] === 'number') rate[field] /= 1 - rate.creditsBack;
        }
    }
    if (new Set(complete.map(rate => rate.model)).size < 3) throw new Error('공식 단가표 형식을 확인하지 못했습니다. 마지막으로 확인한 단가를 사용합니다.');
    return { version: 1, currency: 'USD', source: SOURCE, fetchedAt, rates: complete };
}

export { SOURCE };
