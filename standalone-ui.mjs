import { getCurrentUserHandle } from '../../../user.js';
import { BrowserVault } from './vault.mjs';
import { importCredential, projectId, queryUsage, clearToken, MAX_LOOKBACK } from './monitoring.mjs?v=0.6.3';
import { summarizeMonitoring } from './monitoring-cost.mjs';
import { secret_state, SECRET_KEYS } from '../../../secrets.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { installLocalObserver, summarizeLocal } from './local-usage.mjs';
import { mergeHistory, hasCoverage, summarizeCredit, retainedCalibration, balanceView } from './credit-period.mjs';
import { createFloating, balanceMessages, LAYOUTS } from './floating-ui.mjs?v=0.6.3';

const VERSION = '0.6.3';
const DAY = 86400000;
const ctx = () => SillyTavern.getContext();
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = value => value ? new Date(value).toLocaleString('ko-KR', { hour12: false }) : '아직 없음';
const count = value => Number(value || 0).toLocaleString('ko-KR');
// Whole-dollar amounts read better at cents; tiny amounts keep enough digits to be visible.
const usd = (value, exact = false) => `US$ ${value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: exact || Math.abs(value) < 1 ? 5 : 2 })}`;
const range = (low, high, exact = false) => Math.abs(high - low) < .000005 ? usd(low, exact) : `${usd(low, exact)} ~ ${usd(high, exact)}`;
const money = (low, high) => `<b title="${escape(range(low, high, true))}">${escape(range(low, high))}</b>`;
const stamp = value => value ? new Date(value).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const option = (value, label, selected) => `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(label)}</option>`;
const state = { accounts: [], snapshots: new Map(), localRows: [], catalog: null, busy: false, message: '', errorCode: '', errorProject: '', generation: 0, controller: null };
let vault;
let root;
let floating;
let detail;

function config() {
    ctx().extensionSettings.vertexUsage ??= {};
    const parent = ctx().extensionSettings.vertexUsage;
    parent.standalone ??= { version: 1, follow: true, selected: '', days: 7, links: {}, balances: {} };
    parent.standalone.modes ??= {};
    parent.standalone.floating ??= { enabled: true, metric: 'remaining' };
    // Earlier 'full'/'simple' layouts were retired; they fall back to the pill.
    if (!LAYOUTS.includes(parent.standalone.floating.layout)) parent.standalone.floating.layout = 'pill';
    delete parent.standalone.floating.style;
    return parent.standalone;
}
const save = () => ctx().saveSettingsDebounced();
const profiles = () => {
    const context = ctx();
    const list = (context.extensionSettings.connectionManager?.profiles || []).filter(p => p.api === 'vertexai'
        || context.extensionSettings.vertexAuthPerProfile?.profiles?.[p.id]);
    if (!list.length && context.chatCompletionSettings?.chat_completion_source === 'vertexai') {
        return [{ id: '__current__', name: '현재 Vertex 연결', api: 'vertexai' }];
    }
    return list;
};
const selected = () => profiles().find(profile => profile.id === config().selected);
const link = () => config().links[config().selected];
const activeProject = () => link()?.projectId || '';
const activeAccount = () => state.accounts.find(account => account.id === link()?.accountId);
const sourceMode = id => config().modes[id] || (config().links[id] ? 'monitoring' : 'local');
const periodStart = () => config().days === 'credit' && config().credit ? config().credit.start : Math.floor(Date.now() / DAY) * DAY - ((Number(config().days) || 7) - 1) * DAY;
const node = selector => root.querySelector(selector);

function suggestedProject(account) {
    const saved = ctx().extensionSettings.vertexAuthPerProfile?.profiles?.[config().selected];
    const current = ctx().extensionSettings.connectionManager?.selectedProfile === config().selected || config().selected === '__current__';
    const settings = ctx().chatCompletionSettings;
    return saved?.mode === 'express' && saved.expressProjectId ? saved.expressProjectId
        : current && settings?.vertexai_auth_mode === 'express' && settings.vertexai_express_project_id ? settings.vertexai_express_project_id
            : account.projectId;
}

const inputDate = value => value ? `${new Date(value).getFullYear()}-${String(new Date(value).getMonth() + 1).padStart(2, '0')}-${String(new Date(value).getDate()).padStart(2, '0')}` : '';

function renderCredit() {
    const credit = config().credit;
    const target = node('#vu-credit-summary');
    if (!credit) { target.innerHTML = ''; floating?.render(null); return; }
    const sum = summarizeCredit(credit, { snapshots: state.snapshots, localRows: state.localRows,
        modes: config().modes, links: config().links, catalog: state.catalog });
    const view = balanceView(sum);
    const balance = view.low === null ? `<b>${escape(balanceMessages[view.status])}</b>` : `${view.partial ? '<span class="vu-approx">≈</span>' : ''}${money(view.low, view.high)}`;
    const warnings = [
        sum.missing.length && `Google 기록이 부족한 대상 ${sum.missing.length}개 · ${credit.calibration ? '실제 잔액보다 높게 보일 수 있습니다.' : '현재 잔액을 한 번 입력하세요.'}`,
        sum.unknown.length && `단가 미확인: ${sum.unknown.map(escape).join(', ')}`,
        sum.localUnanchored && '이전 사용분은 알 수 없습니다. 크레딧 설정에서 현재 잔액을 입력하세요.',
    ].filter(Boolean);
    target.innerHTML = `<div class="vu-credit-heading"><b>크레딧</b><small>${escape(usd(sum.amount))} · ${escape(inputDate(credit.start))} ~ ${escape(inputDate(credit.expires))} · ${sum.expired ? '기간 만료' : `${sum.daysLeft}일 남음`}</small></div>
        <div class="vu-cards"><div class="vu-card"><small>사용 추정</small>${sum.unknown.length ? '<b>단가 확인 중</b>' : money(sum.low, sum.high)}</div>
        <div class="vu-card"><small>잔액 추정</small><span>${balance}</span></div></div>
        ${warnings.map(text => `<p class="vu-note vu-warn">${text}</p>`).join('')}`;
    node('#vu-credit-anchor').textContent = credit.calibration ? `저장된 기준 ${usd(credit.calibration.remaining)} · ${stamp(credit.calibration.at)} · 비워 두면 유지` : '';
    floating?.render(sum);
    detail.querySelector('.vu-detail-content').innerHTML = target.innerHTML;
}

function localIdentity(data) {
    const mode = data.vertexai_auth_mode === 'full' ? 'full' : 'express';
    const secretKey = mode === 'full' ? SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT : SECRET_KEYS.VERTEXAI;
    const secretId = data.secret_id || secret_state[secretKey]?.find(secret => secret.active)?.id;
    const candidates = profiles().filter(profile => {
        const saved = ctx().extensionSettings.vertexAuthPerProfile?.profiles?.[profile.id];
        return (!saved?.mode || saved.mode === mode) && secretId && (saved?.secretId || profile['secret-id']) === secretId;
    });
    const currentId = ctx().extensionSettings.connectionManager?.selectedProfile || '__current__';
    const current = profiles().find(profile => profile.id === currentId);
    const profile = candidates.length === 1 ? candidates[0] : !secretId ? current : null;
    const saved = ctx().extensionSettings.vertexAuthPerProfile?.profiles?.[profile?.id];
    return { profileId: profile?.id || '', projectId: mode === 'express'
        ? data.vertexai_express_project_id || saved?.expressProjectId || config().links[profile?.id]?.projectId || ''
        : config().links[profile?.id]?.projectId || '', mode };
}

function renderControls() {
    const settings = config();
    node('#vu-profile').innerHTML = option('', '조회할 Vertex 프로필 선택', settings.selected)
        + profiles().map(profile => option(profile.id, profile.name || profile.id, settings.selected)).join('');
    node('#vu-follow').checked = settings.follow;
    node('#vu-days').value = String(settings.days);
    node('#vu-source').value = sourceMode(settings.selected);
    node('#vu-project').value = activeProject();
    const accountId = activeAccount()?.id || (state.accounts.length === 1 ? state.accounts[0].id : '');
    node('#vu-account').innerHTML = option('', '등록된 인증 선택', accountId)
        + state.accounts.map(account => option(account.id, `${account.projectId}${account.remembered ? '' : ' · 현재 탭'}`, accountId)).join('');
    node('#vu-account-list').innerHTML = state.accounts.map(account => `<div class="vu-auth-row"><span>${escape(account.projectId)}<small>${escape(account.email)}${account.remembered ? ' · 브라우저 기억됨' : ' · 현재 탭만'}</small></span><button type="button" class="menu_button" data-remove-account="${escape(account.id)}">삭제</button></div>`).join('') || '<p class="vu-note">등록한 JSON이 없습니다.</p>';
    node('#vu-account-row').hidden = !state.accounts.length;
    node('#vu-import').hidden = sourceMode(settings.selected) === 'local';
    node('#vu-import').open = Boolean(selected() && sourceMode(settings.selected) === 'monitoring' && !activeAccount());
    const credit = config().credit;
    node('#vu-credit-profiles').innerHTML = profiles().map(profile => `<label class="vu-check"><input type="checkbox" name="creditProfile" value="${escape(profile.id)}"${(credit?.profiles || [settings.selected]).includes(profile.id) ? ' checked' : ''}>${escape(profile.name || profile.id)}</label>`).join('');
    const balance = config().balances[activeProject()];
    node('#vu-balance-form').closest('details').hidden = sourceMode(settings.selected) === 'local' || Boolean(credit);
    node('#vu-baseline-current').textContent = balance ? `기준 ${date(balance.at)} · ${usd(balance.amount)}` : '입력하지 않아도 사용량은 조회됩니다.';
}

// Setup help only for Google setup errors, pointing at the project that actually failed.
function renderHelp() {
    const box = node('#vu-permission');
    const project = state.errorProject || activeProject();
    const code = state.errorCode;
    box.hidden = !project || !['PERMISSION', 'API_DISABLED', 'NOT_FOUND'].includes(code);
    if (box.hidden) return;
    const iam = `https://console.cloud.google.com/iam-admin/iam?project=${encodeURIComponent(project)}`;
    const api = `https://console.cloud.google.com/apis/library/monitoring.googleapis.com?project=${encodeURIComponent(project)}`;
    const tip = code === 'PERMISSION'
        ? `역할은 <b>${escape(project)}</b> 프로젝트에서, 등록한 JSON의 서비스 계정 이메일(client_email)에 줘야 합니다. 추가 후 몇 분 뒤 새로고침하세요.`
        : `<b>${escape(project)}</b> 프로젝트에서 Cloud Monitoring API를 사용 설정하세요.`;
    box.innerHTML = `${tip} <a id="vu-iam-link" href="${escape(iam)}" target="_blank" rel="noopener noreferrer">IAM 열기</a> · <a id="vu-monitoring-link" href="${escape(api)}" target="_blank" rel="noopener noreferrer">Monitoring API</a>`;
}

function render() {
    if (!root) return;
    node('#vu-status').textContent = state.busy ? 'Google 사용량 조회 중…' : state.message;
    node('#vu-status').classList.toggle('vu-warn', Boolean(state.errorCode));
    renderHelp();
    root.querySelectorAll('[data-busy]').forEach(button => { button.disabled = state.busy; });
    const target = node('#vu-summary');
    const profile = selected();
    renderCredit();
    if (!profile) { target.innerHTML = '<p class="vu-note">조회할 Vertex 프로필을 선택하세요. 채팅 연결은 바뀌지 않습니다.</p>'; return; }
    const project = activeProject();
    const snapshot = state.snapshots.get(project);
    const models = list => list.length ? `<div class="vu-models">${list.map(model => `<div class="vu-model"><span><b>${escape(model.model)}</b><small>${escape(model.tier)} · ${escape(model.region)}</small></span><span class="vu-model-cost">${model.unknown ? '단가 확인 중' : escape(range(model.low, model.high))}</span></div>`).join('')}</div>` : '';
    if (sourceMode(config().selected) === 'local') {
        const rows = state.localRows.filter(row => row.profileId === config().selected);
        const sum = summarizeLocal(rows, state.catalog, periodStart(), Date.now());
        target.innerHTML = `<div class="vu-project">${escape(profile.name || 'Vertex')}<span>이 브라우저의 대화 요청만 집계</span></div>
        <div class="vu-cards"><div class="vu-card"><small>예상 비용</small><b>${sum.unpriced.length ? '단가 확인 중' : escape(range(sum.low, sum.high))}</b></div>
        <div class="vu-card"><small>요청</small><b>${count(sum.requests)}회</b></div></div>
        <p class="vu-meta">입력 ${count(sum.input)} · 출력/사고 ${count(sum.output)} 토큰${sum.approximate ? ` · 추정 포함 ${count(sum.approximate)}회` : ''}</p>
        ${sum.unpriced.length ? `<p class="vu-note vu-warn">단가 미확인: ${sum.unpriced.map(escape).join(', ')}</p>` : ''}
        ${models(sum.models)}`;
        return;
    }
    if (!project) { target.innerHTML = '<p class="vu-note">아래 Google 연결에서 서비스 계정 JSON을 등록하세요.</p>'; return; }
    const summary = snapshot ? summarizeMonitoring(snapshot, state.catalog, periodStart(), snapshot.queryEnd) : null;
    const baseline = config().balances[project];
    let remaining = '';
    if (baseline && snapshot) {
        if (baseline.at < snapshot.queryStart) remaining = '기준 다시 맞추기';
        else {
            const spent = summarizeMonitoring(snapshot, state.catalog, baseline.at, snapshot.queryEnd);
            remaining = spent.unpriced.length ? '단가 확인 중' : range(baseline.amount - spent.high, baseline.amount - spent.low);
        }
    }
    const amount = !summary ? '조회 전' : summary.unpriced.length ? '단가 확인 중' : range(summary.low, summary.high);
    target.innerHTML = `<div class="vu-project">${escape(profile.name || 'Vertex')}<span>${escape(project)}</span></div>
        <div class="vu-cards"><div class="vu-card"><small>기간 내 예상 비용</small><b>${escape(amount)}</b></div>
        ${remaining && !config().credit ? `<div class="vu-card"><small>프로젝트 잔액 추정</small><b>${escape(remaining)}</b></div>` : ''}</div>
        ${summary ? `<p class="vu-meta">입력 ${count(summary.input)} · 출력 ${count(summary.output)} 토큰 · ${escape(stamp(snapshot.fetchedAt))} 조회</p>` : '<p class="vu-note">JSON에 Monitoring 뷰어 권한을 준 뒤 새로고침하세요.</p>'}
        ${!activeAccount() ? '<p class="vu-note vu-warn">이 브라우저에 인증이 없습니다. JSON을 다시 등록하면 이어서 조회합니다.</p>' : ''}
        ${summary?.unpriced.length ? `<p class="vu-note vu-warn">단가 미확인(합산 제외): ${summary.unpriced.map(escape).join(', ')}</p>` : ''}
        ${summary ? models(summary.models) || '<p class="vu-note">이 기간의 토큰 통계가 없습니다. 프로젝트·기간을 확인하거나 반영을 기다리세요.</p>' : ''}
        <details class="vu-about"><summary>집계 기준</summary><div class="vu-note">
        <p>Google 프로젝트 전체의 토큰 통계로 계산한 예상이며 실제 청구액과 다를 수 있습니다. 같은 프로젝트를 쓰는 프로필은 같은 사용량을 봅니다.</p>
        ${summary ? `<p>Monitoring 반영은 늦을 수 있습니다. 최근 구간 끝: ${escape(date(snapshot.latestUsageEnd))}</p>` : ''}
        <p>캐시 할인·추가 요금·프로모션 환급은 제외합니다. 구분이 불명확하면 범위로 표시합니다.</p>
        ${remaining ? '<p>잔액 추정은 이 프로젝트 사용분만 차감합니다.</p>' : ''}
        ${state.catalog ? `<p><a href="${escape(state.catalog.source)}" target="_blank" rel="noopener noreferrer">공식 단가표</a> · ${escape(date(state.catalog.fetchedAt))} 기준</p>` : ''}</div></details>`;
}

async function refresh(force = false) {
    // Group history is still useful after a reload when an optional JSON key
    // was kept for the previous tab only. Load every group's cached project.
    const cachedProjects = new Set((config().credit?.profiles || [])
        .filter(id => sourceMode(id) === 'monitoring').map(id => config().links[id]?.projectId).filter(Boolean));
    await Promise.all([...cachedProjects].filter(project => !state.snapshots.has(project)).map(async project => {
        try { const cached = await vault.snapshot(project); if (cached && !state.snapshots.has(project)) state.snapshots.set(project, cached); } catch { /* Optional cache. */ }
    }));
    const targets = new Map();
    if (sourceMode(config().selected) === 'monitoring' && activeProject() && activeAccount()) targets.set(activeProject(), activeAccount());
    for (const id of config().credit?.profiles || []) {
        const linked = config().links[id];
        const account = state.accounts.find(item => item.id === linked?.accountId);
        if (sourceMode(id) === 'monitoring' && linked?.projectId && account) targets.set(linked.projectId, account);
    }
    if (!targets.size) { state.message = ''; render(); return; }
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const generation = ++state.generation;
    state.busy = true; state.message = ''; state.errorCode = ''; state.errorProject = ''; render();
    try {
        const end = Date.now();
        for (const [project, account] of targets) {
            const baseline = config().balances[project];
            const credit = config().credit;
            const desired = Math.min(periodStart(), baseline?.at || end, credit?.calibration?.at || credit?.start || end);
            const start = Math.max(Math.ceil((end - MAX_LOOKBACK) / 3600000) * 3600000, Math.floor(desired / 3600000) * 3600000);
            if (!state.snapshots.has(project)) { try { const old = await vault.snapshot(project); if (old) state.snapshots.set(project, old); } catch {} }
            const cached = state.snapshots.get(project);
            if (!force && cached && end - cached.fetchedAt < 300000 && hasCoverage(cached, start, end)) continue;
            try {
                const next = await queryUsage(account, project, start, end, { signal: controller.signal });
                if (generation !== state.generation) return;
                const snapshot = mergeHistory(state.snapshots.get(project), next);
                state.snapshots.set(project, snapshot);
                try { await vault.saveSnapshot(snapshot); } catch { /* Current tab still works. */ }
            } catch (error) {
                if (controller.signal.aborted) throw error;
                state.message = `${project}: ${error.message}`; state.errorCode = error.code || 'UNKNOWN'; state.errorProject = project;
            }
        }
        if (!state.errorCode) state.message = 'Google 사용량 갱신 완료';
    } catch (error) {
        if (generation !== state.generation || controller.signal.aborted) return;
        state.message = error.message || '사용량을 조회하지 못했습니다.'; state.errorCode = error.code || 'UNKNOWN';
    } finally {
        if (generation === state.generation) { state.busy = false; state.controller = null; render(); }
    }
}

async function selectProfile(id) {
    state.controller?.abort(); state.generation++; state.busy = false;
    config().selected = id; state.message = ''; state.errorCode = ''; state.errorProject = ''; save();
    const project = activeProject();
    if (project && !state.snapshots.has(project)) {
        try { const cached = await vault.snapshot(project); if (cached) state.snapshots.set(project, cached); } catch { /* Optional cache. */ }
    }
    if (config().selected !== id) return;
    renderControls(); render();
    void refresh();
}

async function followCurrent() {
    if (!config().follow) return;
    const id = ctx().extensionSettings.connectionManager?.selectedProfile || '__current__';
    if (profiles().some(profile => profile.id === id)) await selectProfile(id);
}

function connect(account) {
    if (!selected()) throw new Error('먼저 연결할 Vertex 프로필을 선택하세요.');
    config().links[config().selected] = { accountId: account.id, projectId: suggestedProject(account) };
    config().modes[config().selected] = 'monitoring';
    save(); renderControls(); render(); void refresh(true);
}

function buildUI() {
    root = document.createElement('div'); root.id = 'vertex-usage'; root.className = 'inline-drawer';
    root.innerHTML = `<div class="inline-drawer-toggle inline-drawer-header"><b>Vertex Usage</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content"><div class="vu-toolbar"><select id="vu-profile" class="text_pole" aria-label="조회할 Vertex 프로필"></select><button id="vu-refresh" class="menu_button" type="button" data-busy>새로고침</button></div>
    <div class="vu-grid"><label><small>확인 방식</small><select id="vu-source" class="text_pole"><option value="local">대화 기록</option><option value="monitoring">Google 프로젝트</option></select></label>
    <label><small>기간</small><select id="vu-days" class="text_pole">${[1, 7, 30].map(days => option(String(days), `${days}일`, String(config().days))).join('')}<option value="credit">크레딧 기간</option></select></label></div>
    <label class="vu-check"><input id="vu-follow" type="checkbox">채팅 프로필 따라가기</label>
    <p id="vu-status" role="status" aria-live="polite"></p>
    <div id="vu-permission" class="vu-note" hidden></div>
    <div id="vu-credit-summary"></div><div id="vu-summary"></div>
    <div class="vu-sections">
    <details id="vu-credit-settings"><summary>크레딧 설정</summary><form id="vu-credit-form">
    <label><small>총 크레딧 (USD)</small><input id="vu-credit-amount" class="text_pole" type="number" min="0.01" step="any" value="${escape(config().credit?.amount || 300)}" required></label>
    <div class="vu-grid"><label><small>활성화</small><input id="vu-credit-start" class="text_pole" type="date" value="${inputDate(config().credit?.start)}" required></label><label><small>만료</small><input id="vu-credit-expires" class="text_pole" type="date" value="${inputDate(config().credit?.expires)}" required></label></div>
    <p class="vu-note">한쪽 날짜만 넣으면 다른 쪽은 90일로 채웁니다.</p>
    <fieldset class="vu-fieldset"><legend>합산할 프로필 · 같은 크레딧을 쓰는 것만</legend><div id="vu-credit-profiles"></div></fieldset>
    <label><small>현재 Google 잔액 (USD · 선택)</small><input id="vu-credit-calibrate" class="text_pole" type="number" min="0" step="any" placeholder="이전 사용분을 반영할 때 입력"></label><p id="vu-credit-anchor" class="vu-note"></p>
    <button type="submit" class="menu_button">저장</button><p id="vu-credit-status" class="vu-note" role="status"></p></form></details>
    <details id="vu-floating-settings"><summary>플로팅 표시</summary>
    <label class="vu-check"><input id="vu-floating-enabled" type="checkbox" ${config().floating.enabled ? 'checked' : ''}>화면에 표시</label>
    <div class="vu-grid"><label><small>모양</small><select id="vu-floating-layout" class="text_pole">${[['pill', '알약 한 줄'], ['bar', '막대 한 줄'], ['edge', '가장자리 탭'], ['ring', '링 안 숫자'], ['dot', '점 링만']].map(([value, label]) => option(value, label, config().floating.layout)).join('')}</select></label>
    <label><small>표시</small><select id="vu-floating-metric" class="text_pole">${option('remaining', '남은 %', config().floating.metric)}${option('used', '사용한 %', config().floating.metric)}</select></label></div>
    <button id="vu-floating-reset" class="menu_button" type="button">위치 초기화</button>
    <p class="vu-note">끌어서 옮기고, 누르면 상세를 봅니다. 점 링만은 숫자가 상세에만 보입니다.</p></details>
    <details><summary>잔액 맞추기</summary><form id="vu-balance-form"><label><small>지금 남은 잔액 (USD)</small><input id="vu-balance" class="text_pole" type="number" min="0" step="any" required placeholder="현재 잔액"></label><p id="vu-baseline-current" class="vu-note"></p><button class="menu_button" type="submit">맞추기</button></form></details>
    <details id="vu-import"><summary>Google 연결 (JSON)</summary>
    <div id="vu-account-row" class="vu-toolbar"><select id="vu-account" class="text_pole" aria-label="등록된 인증"></select><button id="vu-connect" class="menu_button" type="button">이 프로필에 연결</button></div>
    <form id="vu-register-form"><label><small>서비스 계정 JSON 파일</small><input id="vu-json-file" type="file" accept=".json,application/json" class="text_pole"></label>
    <details class="vu-sub"><summary>붙여넣기로 입력</summary><textarea id="vu-json-text" class="text_pole" rows="5" autocomplete="off" spellcheck="false" placeholder="서비스 계정 JSON"></textarea></details>
    <label class="vu-check"><input id="vu-remember" type="checkbox">이 브라우저에 기억하기</label>
    <p class="vu-note">JSON 원문은 서버에 저장하지 않습니다. HTTPS 또는 localhost에서만 동작합니다.</p>
    <button id="vu-register" class="menu_button" type="submit">등록하고 조회</button><p id="vu-import-status" class="vu-note" role="status"></p></form>
    <details class="vu-sub"><summary>다른 프로젝트 조회</summary><form id="vu-project-form"><label><small>프로젝트 ID</small><input id="vu-project" class="text_pole" placeholder="기본: JSON의 프로젝트" required></label><p class="vu-note">대상 프로젝트에도 Monitoring 뷰어 권한이 필요합니다.</p><button class="menu_button" type="submit">변경</button></form></details>
    <details class="vu-sub"><summary>등록된 인증 관리</summary><div id="vu-account-list"></div><p class="vu-note">삭제해도 Google Cloud의 키는 그대로입니다.</p></details></details>
    </div>
    <div class="vu-footer"><span>v${VERSION}</span><button id="vu-export" class="menu_button" type="button">내보내기</button></div></div>`;
    document.querySelector('#extensions_settings2').append(root);
    detail = document.createElement('dialog'); detail.id = 'vertex-usage-detail';
    detail.setAttribute('aria-labelledby', 'vu-detail-title');
    detail.innerHTML = '<header><b id="vu-detail-title">Vertex Usage</b><button type="button" class="menu_button" aria-label="닫기">×</button></header><div class="vu-detail-content"></div><p class="vu-note">설정: 확장 → Vertex Usage</p>';
    document.body.append(detail);
    detail.querySelector('button').addEventListener('click', () => detail.close());
    detail.addEventListener('click', event => { if (event.target === detail) { const r = detail.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) detail.close(); } });
    floating = createFloating({ getOptions: () => config().floating, onOpen: () => { if (!detail.open) detail.showModal(); }, storageKey: `vertex-usage-position:${getCurrentUserHandle() || 'default-user'}` });
    for (const field of ['enabled', 'layout', 'metric']) node(`#vu-floating-${field}`).addEventListener('change', event => {
        config().floating[field] = field === 'enabled' ? event.target.checked : event.target.value; save(); renderCredit();
    });
    node('#vu-floating-reset').addEventListener('click', () => floating.resetPosition());
    node('#vu-profile').addEventListener('change', event => { void selectProfile(event.target.value); });
    node('#vu-source').addEventListener('change', event => {
        state.controller?.abort(); state.generation++; state.busy = false; state.errorCode = ''; state.errorProject = ''; state.message = '';
        config().modes[config().selected] = event.target.value;
        if (event.target.value === 'monitoring' && !link() && state.accounts.length === 1) {
            const account = state.accounts[0]; const target = suggestedProject(account);
            config().links[config().selected] = { accountId: account.id, projectId: target };
        }
        save(); renderControls(); render(); void refresh();
    });
    node('#vu-follow').addEventListener('change', event => { config().follow = event.target.checked; save(); void followCurrent(); });
    node('#vu-days').addEventListener('change', event => {
        if (event.target.value === 'credit' && !config().credit) {
            node('#vu-credit-settings').open = true; node('#vu-credit-status').textContent = '먼저 크레딧 총액과 기간을 설정하세요.';
            event.target.value = String(config().days); return;
        }
        config().days = event.target.value === 'credit' ? 'credit' : Number(event.target.value); save(); render(); void refresh();
    });
    for (const [changed, other, offset] of [['start', 'expires', 90], ['expires', 'start', -90]]) {
        node(`#vu-credit-${changed}`).addEventListener('change', () => {
            const value = node(`#vu-credit-${changed}`).value;
            if (value && !node(`#vu-credit-${other}`).value) node(`#vu-credit-${other}`).value = inputDate(new Date(`${value}T00:00:00`).getTime() + offset * DAY);
        });
    }
    node('#vu-credit-form').addEventListener('submit', event => {
        event.preventDefault();
        const status = node('#vu-credit-status');
        const amount = Number(node('#vu-credit-amount').value);
        const start = new Date(`${node('#vu-credit-start').value}T00:00:00`).getTime();
        const expires = new Date(`${node('#vu-credit-expires').value}T00:00:00`).getTime();
        const selectedProfiles = [...root.querySelectorAll('input[name="creditProfile"]:checked')].map(input => input.value);
        if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(start) || !Number.isFinite(expires) || expires <= start || !selectedProfiles.length) { status.textContent = '총액·시작/만료 날짜·대상 프로필을 확인하세요.'; return; }
        const before = config().credit;
        const next = { amount, start, expires, profiles: selectedProfiles };
        const calibration = node('#vu-credit-calibrate').value;
        if (calibration !== '') {
            const remaining = Number(calibration);
            if (!Number.isFinite(remaining) || remaining < 0 || remaining > amount) { status.textContent = '현재 잔액은 0부터 총 크레딧 사이로 입력하세요.'; return; }
            if (Date.now() >= expires) { status.textContent = '이미 만료된 기간에는 현재 잔액 기준을 새로 만들 수 없습니다.'; return; }
            if (Date.now() < start) { status.textContent = '활성화 날짜 이후에 현재 잔액을 맞춰 주세요.'; return; }
            next.calibration = { at: Date.now(), remaining };
        } else next.calibration = retainedCalibration(before, next);
        config().credit = next; config().days = 'credit'; node('#vu-credit-calibrate').value = '';
        save(); renderControls(); render(); status.textContent = before?.calibration && !next.calibration ? '새 기간에 이전 잔액 기준을 적용할 수 없습니다. 현재 Google 잔액을 입력해 주세요.' : '크레딧 설정과 잔액 기준을 저장했습니다.'; void refresh(true);
    });
    node('#vu-refresh').addEventListener('click', () => { void refresh(true); });
    node('#vu-connect').addEventListener('click', () => {
        try { const account = state.accounts.find(item => item.id === node('#vu-account').value); if (account) connect(account); }
        catch (error) { node('#vu-import-status').textContent = error.message; }
    });
    node('#vu-register-form').addEventListener('submit', async event => {
        event.preventDefault();
        const status = node('#vu-import-status');
        const button = node('#vu-register'); button.disabled = true; status.textContent = '인증 확인 중…';
        let raw = '';
        try {
            if (!selected()) throw new Error('먼저 Vertex 프로필을 선택하세요.');
            const file = node('#vu-json-file').files[0];
            if (file?.size > 262144) throw new Error('JSON 파일이 너무 큽니다. 서비스 계정 JSON 원본을 선택하세요.');
            raw = file ? await file.text() : node('#vu-json-text').value.trim();
            if (!raw || raw.length > 262144) throw new Error('서비스 계정 JSON 파일을 선택하거나 붙여넣으세요.');
            const account = await importCredential(raw);
            const remembered = node('#vu-remember').checked;
            await vault.put(account, remembered);
            state.accounts = await vault.list();
            node('#vu-json-file').value = ''; node('#vu-json-text').value = ''; raw = '';
            status.textContent = remembered ? '이 브라우저에 인증을 등록했습니다.' : '현재 탭에서 사용할 인증을 등록했습니다.';
            connect(account);
        } catch (error) { status.textContent = error.message || '인증을 등록하지 못했습니다.'; }
        finally { raw = ''; button.disabled = false; }
    });
    node('#vu-balance-form').addEventListener('submit', event => {
        event.preventDefault();
        if (!activeProject()) { state.message = '먼저 JSON을 연결하세요.'; render(); return; }
        const amount = Number(node('#vu-balance').value);
        if (!Number.isFinite(amount) || amount < 0) return;
        config().balances[activeProject()] = { amount, at: Date.now() };
        save(); renderControls(); render(); void refresh(true);
    });
    node('#vu-project-form').addEventListener('submit', event => {
        event.preventDefault();
        try {
            if (!link()) throw new Error('먼저 JSON을 연결하세요.');
            link().projectId = projectId(node('#vu-project').value); save(); void selectProfile(config().selected);
        } catch (error) { state.message = error.message; state.errorCode = error.code || 'PROJECT'; render(); }
    });
    node('#vu-account-list').addEventListener('click', async event => {
        const id = event.target.closest('[data-remove-account]')?.dataset.removeAccount;
        if (!id || !window.confirm('이 브라우저에서 해당 인증을 삭제할까요? Google 원본 키는 유지됩니다.')) return;
        try {
            state.controller?.abort(); state.generation++; state.busy = false;
            await vault.remove(id); clearToken(id); state.accounts = await vault.list(); renderControls(); render();
        } catch (error) { state.message = error.message; state.errorCode = 'STORAGE'; render(); }
    });
    node('#vu-export').addEventListener('click', () => {
        const snapshot = state.snapshots.get(activeProject());
        const data = { version: 1, source: sourceMode(config().selected), exportedAt: new Date().toISOString(), snapshot,
            observations: state.localRows.filter(row => row.profileId === config().selected), credit: config().credit };
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'vertex-monitoring-usage.json'; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
}

jQuery(async () => {
    try {
        config();
        vault = new BrowserVault(getCurrentUserHandle() || 'default-user');
        await vault.open(); state.accounts = await vault.list();
        try { state.localRows = await vault.observations(); } catch { state.localRows = []; }
        try { const response = await fetch(new URL('./prices.json', import.meta.url)); if (response.ok) state.catalog = await response.json(); } catch { /* Usage counts still work without prices. */ }
        buildUI(); renderControls(); render();
        installLocalObserver({ identify: localIdentity, estimateInput: getTokenCountAsync, record: async row => {
            state.localRows.push(row);
            try { await vault.saveObservation(row); } catch { state.message = '사용량은 현재 탭에만 보관 중입니다. 브라우저 저장소를 확인하세요.'; }
            render();
        } });
        const { eventSource, eventTypes } = ctx();
        if (eventTypes.CONNECTION_PROFILE_LOADED) eventSource.on(eventTypes.CONNECTION_PROFILE_LOADED, () => { void followCurrent(); });
        for (const event of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
            if (eventTypes[event]) eventSource.on(eventTypes[event], renderControls);
        }
        if (config().follow) await followCurrent(); else await selectProfile(config().selected);
        setInterval(() => { if (!document.hidden && (root.getClientRects().length || floating.isVisible()) && !state.busy) void refresh(); }, 300000);
        window.addEventListener('pagehide', () => { state.controller?.abort(); vault.close(); }, { once: true });
    } catch {
        if (root) node('#vu-status').textContent = '브라우저 저장소 또는 확장 초기화에 실패했습니다. 새로고침 후 다시 확인하세요.';
        else console.error('[Vertex Usage] 브라우저 확장 초기화에 실패했습니다.');
    }
});
