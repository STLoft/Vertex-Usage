import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePricing } from '../price-parser.mjs';
import { resolvePrice } from '../pricing.mjs';

test('official snapshot is public-only and has usable Standard and Flex token prices', () => {
    const catalog = JSON.parse(fs.readFileSync(new URL('../prices.json', import.meta.url)));
    assert.equal(catalog.currency, 'USD');
    assert.ok(catalog.source.startsWith('https://cloud.google.com/'));
    assert.ok(catalog.rates.length > 10);
    assert.ok(catalog.rates.some(rate => rate.tier === 'standard'));
    assert.ok(catalog.rates.some(rate => rate.tier === 'flex'));
    assert.ok(!JSON.stringify(catalog).includes('private_key'));
    assert.ok(catalog.rates.every(rate => Number.isFinite(rate.input) && Number.isFinite(rate.output)));
});

test('price matching requires model, tier, region and effective date; unknown models stay unknown', () => {
    const catalog = { currency: 'USD', rates: [
        { model: 'gemini-2.5-pro', tier: 'standard', region: 'any', from: 0, until: 100, input: 1, output: 2 },
        { model: 'gemini-2.5-pro', tier: 'standard', region: 'any', from: 100, until: null, input: 3, output: 4 },
        { model: 'gemini-2.5-pro', tier: 'flex', region: 'global', from: 0, until: null, input: .5, output: 1 },
    ] };
    assert.equal(resolvePrice(catalog, 'gemini-2.5-pro', 'standard', 'us-central1', 99).input, 1);
    assert.equal(resolvePrice(catalog, 'gemini-2.5-pro-001', 'standard', 'us-central1', 100).input, 3);
    assert.equal(resolvePrice(catalog, 'gemini-2.5-pro', 'flex', 'global', 200).input, .5);
    assert.equal(resolvePrice(catalog, 'gemini-2.5-pro', 'flex', 'us-central1', 200), null);
    assert.equal(resolvePrice(catalog, 'gemini-2.5-pro-cyber', 'standard', 'global', 200), null);
    assert.equal(resolvePrice({ currency: 'USD' }, 'gemini-2.5-pro'), null);
});

test('official parser excludes audio-only rows and fails closed on layout changes', () => {
    const head = '<tr><th>Model</th><th>Type</th><th>Price (/1M tokens)</th></tr>';
    const rows = ['Gemini 2.5 Pro', 'Gemini 2.5 Flash', 'Gemini 2.5 Flash Lite'].map(name =>
        `<tr><td>${name}</td><td>Input text</td><td>$1.00</td></tr><tr><td></td><td>Input audio</td><td>$99.00</td></tr><tr><td></td><td>Output text</td><td>$2.00</td></tr>`).join('');
    const catalog = parsePricing(`<table>${head}${rows}</table>`, 123);
    assert.equal(catalog.rates.length, 3);
    assert.equal(catalog.rates[0].input, 1);
    assert.equal(catalog.rates[0].output, 2);
    assert.throws(() => parsePricing('<h1>Pricing page changed</h1>'));
});
