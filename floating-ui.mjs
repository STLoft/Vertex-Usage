// Compact, theme-aware floating credit view. It only renders existing data.
import { balanceView } from './credit-period.mjs';

export const balanceMessages = {
    ready: '수집된 사용량 기준 추정', expired: '설정한 크레딧 기간 만료',
    unanchored: '현재 Google 잔액 입력 필요', price: '단가 미확인 · 일부 사용분 미반영',
    missing: 'Google 조회 기록 부족 · 일부 사용분 미반영',
};
export const LAYOUTS = ['pill', 'bar', 'edge', 'ring', 'dot'];
const money = n => `US$ ${n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = n => n.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const bound = (n, max) => Math.min(Math.max(8, n), Math.max(8, max));
const ring = (stroke, inner = '') => `<span class="vu-fl-ring" aria-hidden="true"><svg viewBox="0 0 40 40"><circle class="vu-fl-track" cx="20" cy="20" r="${20 - stroke}" stroke-width="${stroke}"/><circle class="vu-fl-progress" cx="20" cy="20" r="${20 - stroke}" stroke-width="${stroke}" pathLength="100"/></svg>${inner}</span>`;
const templates = {
    pill: () => '<span class="vu-fl-dot" aria-hidden="true"></span><strong class="vu-fl-percent"></strong><span class="vu-fl-note"></span>',
    bar: () => '<span class="vu-fl-row"><strong class="vu-fl-percent"></strong><span class="vu-fl-note"></span></span><span class="vu-fl-bar" aria-hidden="true"><span class="vu-fl-fill"></span></span>',
    ring: () => ring(3, '<span class="vu-fl-inner"><strong class="vu-fl-percent"></strong><span class="vu-fl-note"></span></span>'),
    edge: () => '<span class="vu-fl-bar" aria-hidden="true"><span class="vu-fl-fill"></span></span><strong class="vu-fl-percent"></strong><span class="vu-fl-note"></span>',
    dot: () => ring(4),
};

export function createFloating({ getOptions, onOpen, storageKey }) {
    const element = document.createElement('button');
    element.id = 'vertex-usage-floating'; element.type = 'button'; element.hidden = true;
    document.body.append(element);
    const find = selector => element.querySelector(selector);
    let position = { corner: 'rb', x: 16, y: 115 };
    try {
        const stored = JSON.parse(localStorage.getItem(storageKey));
        if (['rb', 'lb', 'rt', 'lt'].includes(stored?.corner) && Number.isFinite(stored.x) && Number.isFinite(stored.y)) position = stored;
    } catch { /* Device-local placement is optional. */ }
    const edge = () => element.dataset.layout === 'edge';
    function place() {
        if (element.hidden) return;
        const r = element.getBoundingClientRect();
        const right = position.corner.includes('r');
        element.dataset.side = right ? 'right' : 'left';
        element.style.right = element.style.bottom = 'auto';
        // The edge tab always sits flush against the nearest screen side.
        element.style.left = edge() ? `${right ? innerWidth - r.width : 0}px`
            : `${bound(right ? innerWidth - r.width - position.x : position.x, innerWidth - r.width - 8)}px`;
        element.style.top = `${bound(position.corner.includes('b') ? innerHeight - r.height - position.y : position.y, innerHeight - r.height - 8)}px`;
    }
    let drag = null; let dragged = false;
    element.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        const rect = element.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        dragged = false; element.setPointerCapture(event.pointerId);
    });
    element.addEventListener('pointermove', event => {
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
        if (!dragged && Math.hypot(dx, dy) < 5) return;
        dragged = true; element.classList.add('vu-fl-dragging');
        const rect = element.getBoundingClientRect();
        element.style.left = `${bound(drag.left + dx, innerWidth - rect.width - 8)}px`;
        element.style.top = `${bound(drag.top + dy, innerHeight - rect.height - 8)}px`;
    });
    function endDrag() {
        if (!drag) return;
        if (dragged) {
            const rect = element.getBoundingClientRect();
            const right = rect.left + rect.width / 2 > innerWidth / 2;
            const bottom = rect.top + rect.height / 2 > innerHeight / 2;
            position = { corner: `${right ? 'r' : 'l'}${bottom ? 'b' : 't'}`,
                x: right ? innerWidth - rect.right : rect.left, y: bottom ? innerHeight - rect.bottom : rect.top };
            try { localStorage.setItem(storageKey, JSON.stringify(position)); } catch { /* Keep in memory. */ }
            place();
        }
        drag = null; element.classList.remove('vu-fl-dragging');
    }
    element.addEventListener('pointerup', endDrag);
    element.addEventListener('pointercancel', endDrag);
    element.addEventListener('lostpointercapture', endDrag);
    element.addEventListener('click', event => {
        if (dragged && event.detail !== 0) { dragged = false; return; }
        onOpen();
    });
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return {
        isVisible: () => !element.hidden,
        render(sum) {
            const options = getOptions();
            element.hidden = !options.enabled || !sum;
            if (element.hidden) return;
            const layout = LAYOUTS.includes(options.layout) ? options.layout : 'pill';
            if (element.dataset.layout !== layout) { element.dataset.layout = layout; element.innerHTML = templates[layout](); }
            const view = balanceView(sum);
            const used = options.metric === 'used';
            // Expiration reduces spendable credit, but never invents consumption.
            const low = used ? view.low === null ? null : sum.low : view.low;
            const high = used ? view.high === null ? null : sum.high : view.high;
            const known = low !== null;
            const pctLow = known ? Math.min(100, Math.max(0, low / sum.amount * 100)) : null;
            const pctHigh = known ? Math.min(100, Math.max(0, high / sum.amount * 100)) : null;
            const exact = known ? `${percent(pctLow)}${Math.abs(pctHigh - pctLow) >= .1 ? `–${percent(pctHigh)}` : ''}%` : '—';
            const days = sum.expired ? '만료' : `${sum.daysLeft}일`;
            element.dataset.partial = String(view.partial);
            element.dataset.level = !known || view.partial ? 'pending' : sum.expired || view.low / sum.amount <= .1 ? 'low' : view.low / sum.amount <= .3 ? 'mid' : 'ok';
            const shown = known ? `${view.partial ? '≈' : ''}${Math.round(pctLow)}${layout === 'edge' ? '' : '%'}` : '—';
            if (find('.vu-fl-percent')) find('.vu-fl-percent').textContent = shown;
            if (find('.vu-fl-note')) find('.vu-fl-note').textContent = layout === 'pill' ? `· ${days}` : days;
            if (find('.vu-fl-progress')) find('.vu-fl-progress').style.strokeDasharray = `${pctLow ?? 0} 100`;
            if (find('.vu-fl-fill')) find('.vu-fl-fill').style.setProperty('--vu-fill', `${pctLow ?? 0}%`);
            const amount = known ? ` · ${money(low)}${Math.abs(high - low) >= .01 ? `–${money(high)}` : ''} / ${money(sum.amount)}` : '';
            const label = `Vertex ${used ? '사용량' : '잔량'} ${exact}${amount} · ${sum.expired ? '크레딧 기간 만료' : `${sum.daysLeft}일 남음`} · ${balanceMessages[view.status]}. 드래그로 이동, 누르면 상세 보기`;
            element.title = label; element.setAttribute('aria-label', label);
            place();
        },
        resetPosition() {
            position = { corner: 'rb', x: 16, y: 115 };
            try { localStorage.removeItem(storageKey); } catch { /* Optional. */ }
            place();
        },
    };
}
