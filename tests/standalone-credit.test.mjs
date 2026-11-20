import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistory, hasCoverage, summarizeCredit, retainedCalibration, balanceView } from '../credit-period.mjs';
import { readTokenUsage, localCost, summarizeLocal } from '../local-usage.mjs';

const hour = 3600000;
const catalog = { currency: 'USD', rates: [{ model: 'gemini-test', tier: 'standard', region: 'any', from: 0, until: null,
    input: 2, cached: .5, output: 8 }] };
const observation = { id: 'request-a', profileId: 'express', projectId: 'express-project', model: 'gemini-test', tier: 'standard', region: 'global',
    at: 10 * hour, input: 1000, cached: 200, output: 100, thinking: 300 };
const baseCredit = { amount: 300, start: 0, expires: 100 * hour, profiles: ['express'] };

test('Express response tokens count cache as input and thinking once, without needing JSON', () => {
    assert.deepEqual(readTokenUsage({ promptTokenCount: 1000, cachedContentTokenCount: 200, candidatesTokenCount: 100, thoughtsTokenCount: 300 }),
        { input: 1000, cached: 200, output: 100, thinking: 300 });
    assert.equal(localCost(observation, catalog), .0049);
    const result = summarizeLocal([observation], catalog, 0, 11 * hour);
    assert.equal(result.requests, 1); assert.equal(result.output, 400); assert.equal(result.high, .0049);
    assert.equal(localCost({ ...observation, model: 'unknown' }, catalog), null);
});

test('calibrated current balance includes earlier spend and subtracts only subsequent local observations', () => {
    const result = summarizeCredit({ ...baseCredit, calibration: { at: 9 * hour, remaining: 120 } }, {
        snapshots: new Map(), localRows: [{ ...observation, at: 8 * hour }, observation], modes: {}, links: {}, catalog, now: 11 * hour });
    assert.equal(result.ready, true);
    assert.ok(Math.abs(result.high - 180.0049) < 1e-9);
    assert.ok(Math.abs(result.remainingLow - 119.9951) < 1e-9);
});

test('key-only mode never invents a complete past credit balance without calibration', () => {
    const result = summarizeCredit(baseCredit, { snapshots: new Map(), localRows: [observation], modes: {}, links: {}, catalog, now: 11 * hour });
    assert.equal(result.ready, false); assert.equal(result.localUnanchored, true); assert.equal(result.remainingLow, null);
});

test('saved balance remains visible with explicit partial status when another profile has missing Google history', () => {
    const result = summarizeCredit({ ...baseCredit, profiles: ['express', 'full'], calibration: { at: 9 * hour, remaining: 127 } }, {
        snapshots: new Map(), localRows: [observation], modes: { full: 'monitoring' }, links: {}, catalog, now: 11 * hour });
    const view = balanceView(result);
    assert.equal(result.ready, false); assert.equal(result.remainingLow, null);
    assert.equal(view.status, 'missing'); assert.equal(view.partial, true);
    assert.ok(Math.abs(view.low - 126.9951) < 1e-9);
    assert.equal(result.calibrated, true);
    const unknown = summarizeCredit({ ...baseCredit, calibration: { at: 9 * hour, remaining: 127 } }, {
        snapshots: new Map(), localRows: [{ ...observation, model: 'unknown' }], modes: {}, links: {}, catalog, now: 11 * hour });
    assert.equal(balanceView(unknown).status, 'price');
    assert.equal(balanceView(unknown).low, 127);
});

test('editing settings preserves a valid balance anchor, while a new credit period cannot reuse an old anchor', () => {
    const old = { ...baseCredit, calibration: { at: 9 * hour, remaining: 127 } };
    assert.deepEqual(retainedCalibration(old, { ...baseCredit, amount: 500, expires: 120 * hour, profiles: ['full', 'express'] }), old.calibration);
    assert.equal(retainedCalibration(old, { ...baseCredit, start: 10 * hour }), undefined);
    assert.equal(retainedCalibration(old, { ...baseCredit, amount: 100 }), undefined);
    assert.equal(retainedCalibration(old, { ...baseCredit, expires: 8 * hour }), undefined);
    const unanchored = summarizeCredit(baseCredit, { snapshots: new Map(), localRows: [], modes: {}, links: {}, catalog, now: 11 * hour });
    assert.equal(balanceView(unanchored).low, null);
    assert.equal(balanceView(unanchored).status, 'unanchored');
});

test('repeated Monitoring refresh replaces overlapping data, preserving older history and coverage', () => {
    const row = { model: 'gemini-test', direction: 'input', count: 1000, start: 0, end: hour, tier: 'standard', region: 'global', context: '', modality: 'text' };
    const old = { projectId: 'project-a', queryStart: 0, queryEnd: 10 * hour, rows: [row] };
    const fresh = { projectId: 'project-a', queryStart: 5 * hour, queryEnd: 20 * hour, rows: [{ ...row, start: 8 * hour, end: 9 * hour }] };
    const result = mergeHistory(mergeHistory(old, fresh), fresh);
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.coverage, [[0, 20 * hour]]);
    assert.equal(hasCoverage(result, 0, 20 * hour), true);
    assert.equal(hasCoverage(result, -hour, 20 * hour), false);
});

test('same project in multiple profiles is counted once; missing old history blocks full remaining estimate', () => {
    const row = { model: 'gemini-test', direction: 'input', count: 1e6, start: 0, end: hour, tier: 'standard', region: 'global', context: '', modality: 'text' };
    const snapshot = { projectId: 'project-a', queryStart: 0, queryEnd: 10 * hour, rows: [row] };
    const options = { snapshots: new Map([['project-a', snapshot]]), localRows: [], modes: {}, links: { a: { projectId: 'project-a' }, b: { projectId: 'project-a' } }, catalog, now: 10 * hour };
    const result = summarizeCredit({ ...baseCredit, profiles: ['a', 'b'] }, options);
    assert.equal(result.high, 2); assert.equal(result.remainingLow, 298);
    const missing = summarizeCredit({ ...baseCredit, start: -hour, profiles: ['a'] }, options);
    assert.equal(missing.ready, false); assert.equal(missing.remainingLow, null);
});

test('expiry disables remaining credit without claiming it was all consumed, and later requests are excluded', () => {
    const result = summarizeCredit({ ...baseCredit, expires: 9 * hour, calibration: { at: 8 * hour, remaining: 120 } }, {
        snapshots: new Map(), localRows: [observation], modes: {}, links: {}, catalog, now: 12 * hour });
    assert.equal(result.expired, true); assert.equal(result.remainingLow, 0); assert.equal(result.high, 180);
    assert.equal(result.daysLeft, 0);
});
