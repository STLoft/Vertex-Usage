export function resolvePrice(catalog, model, tier = 'standard', region = 'global', at = Date.now()) {
    if (!catalog || catalog.currency !== 'USD' || !Array.isArray(catalog.rates)) return null;
    const id = String(model || '').toLowerCase().replace(/^.*\//, '');
    const candidates = catalog.rates.filter(rate => {
        const sameModel = rate.model === id || (id.startsWith(rate.model + '-')
            && /^(?:\d{3}|\d{2}-\d{2}|\d{8}|latest)$/.test(id.slice(rate.model.length + 1)));
        return sameModel && rate.tier === tier && rate.from <= at && (rate.until === null || at < rate.until)
            && (rate.region === 'any' || rate.region === (region === 'global' ? 'global' : 'regional'));
    }).sort((a, b) => b.model.length - a.model.length || b.from - a.from);
    return candidates[0] || null;
}
