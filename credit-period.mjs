import { summarizeMonitoring } from './monitoring-cost.mjs';
import { summarizeLocal } from './local-usage.mjs';

export function mergeHistory(previous, next) {
    if (!previous || previous.projectId !== next.projectId) return { ...next, coverage: [[next.queryStart, next.queryEnd]] };
    const keepAfter = next.queryEnd - 180 * 86400000;
    const rows = [...previous.rows.filter(row => row.end > keepAfter && (row.end <= next.queryStart || row.start >= next.queryEnd)), ...next.rows];
    const coverage = [...(previous.coverage || [[previous.queryStart, previous.queryEnd]]), [next.queryStart, next.queryEnd]]
        .map(([start, end]) => [Math.max(start, keepAfter), end]).filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const segment of coverage) {
        const last = merged.at(-1);
        if (last && segment[0] <= last[1]) last[1] = Math.max(last[1], segment[1]); else merged.push([...segment]);
    }
    return { ...next, rows, coverage: merged };
}

export function hasCoverage(snapshot, start, end, tolerance = 300000) {
    if (start >= end) return true;
    let cursor = start;
    for (const [from, to] of snapshot?.coverage || (snapshot ? [[snapshot.queryStart, snapshot.queryEnd]] : [])) {
        if (from > cursor) return false;
        if (to > cursor) cursor = to;
        if (cursor >= end - tolerance) return true;
    }
    return false;
}

// A balance is a point-in-time anchor, not a property of the display settings.
// Keep it when editing dates, amount or included profiles within the same period.
export function retainedCalibration(previous, next) {
    const anchor = previous?.calibration;
    return anchor && anchor.at >= next.start && anchor.at < next.expires
        && anchor.remaining >= 0 && anchor.remaining <= next.amount ? { ...anchor } : undefined;
}

export function balanceView(sum) {
    const status = sum.expired ? 'expired' : sum.localUnanchored ? 'unanchored'
        : sum.unknown.length ? 'price' : sum.missing.length ? 'missing' : 'ready';
    return { low: sum.remainingLow ?? (sum.calibrated ? sum.observedRemainingLow : null),
        high: sum.remainingHigh ?? (sum.calibrated ? sum.observedRemainingHigh : null),
        partial: !sum.expired && !sum.ready, status };
}

export function summarizeCredit(credit, { snapshots, localRows, modes, links, catalog, now = Date.now() }) {
    if (!credit) return null;
    const from = Math.max(credit.start, credit.calibration?.at || credit.start);
    const end = Math.min(now, credit.expires);
    const priorUsed = credit.calibration ? credit.amount - credit.calibration.remaining : 0;
    let low = priorUsed; let high = priorUsed;
    const missing = []; const unknown = new Set(); const projects = new Set(); const localProfiles = new Set();
    for (const profile of new Set(credit.profiles)) {
        if ((modes[profile] || (links[profile] ? 'monitoring' : 'local')) === 'monitoring') {
            if (links[profile]?.projectId) projects.add(links[profile].projectId); else missing.push(profile);
        } else localProfiles.add(profile);
    }
    for (const project of projects) {
        const snapshot = snapshots.get(project);
        if (!hasCoverage(snapshot, from, end)) missing.push(project);
        const sum = summarizeMonitoring(snapshot, catalog, from, end);
        low += sum.low; high += sum.high; sum.unpriced.forEach(name => unknown.add(name));
    }
    const local = localRows.filter(row => localProfiles.has(row.profileId) && !projects.has(row.projectId || links[row.profileId]?.projectId));
    const sum = summarizeLocal(local, catalog, from, end);
    low += sum.low; high += sum.high; sum.unpriced.forEach(name => unknown.add(name));
    const localUnanchored = localProfiles.size > 0 && !credit.calibration;
    const ready = !missing.length && !unknown.size && !localUnanchored;
    const expired = now >= credit.expires;
    return { amount: credit.amount, low: Math.min(credit.amount, Math.max(0, low)), high: Math.min(credit.amount, Math.max(0, high)),
        calibrated: Boolean(credit.calibration),
        observedRemainingLow: Math.max(0, credit.amount - high), observedRemainingHigh: Math.max(0, credit.amount - low),
        remainingLow: expired ? 0 : ready ? Math.max(0, credit.amount - high) : null,
        remainingHigh: expired ? 0 : ready ? Math.max(0, credit.amount - low) : null,
        ready, missing, unknown: [...unknown], localUnanchored, expired,
        daysLeft: Math.max(0, Math.ceil((credit.expires - now) / 86400000)), localOnly: localProfiles.size > 0 };
}
