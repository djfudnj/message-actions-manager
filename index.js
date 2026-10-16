/**
 * Message Actions Manager
 * 메시지 헤더의 액션 아이콘(기본 + 다른 확장이 추가한 것 포함)을
 * 그룹1(항상 표시) / 그룹2(… 더보기 안)로 나눠 순서·표시 여부를 관리하는 확장.
 */
(() => {
    'use strict';

    const MODULE = 'message_actions_manager';
    // sets: { 대표키: [멤버키...] } — 같은 자리를 번갈아 쓰는 버튼 묶음. 그룹 목록/숨김 목록에는 대표키만 들어간다.
    const DEFAULTS = { g1: [], g2: [], hidden: [], known: {}, native: [], sets: {} };

    // 항상 세트로 묶여 있는 쌍 (사용자가 풀 수 없음)
    const DEFAULT_SETS = [
        ['mes_hide', 'mes_unhide'],
        ['mes_create_bookmark', 'mes_bookmark'],
    ];

    const IGNORE_CLASSES = new Set([
        'mes_button', 'interactable', 'list-group-item', 'hidden', 'displayNone',
        'menu_button', 'right_menu_button',
    ]);

    const liveKeys = new Set();
    let uiDirty = false;
    const ctx = () => SillyTavern.getContext();

    function settings() {
        const { extensionSettings } = ctx();
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(DEFAULTS);
        const s = extensionSettings[MODULE];
        for (const k of Object.keys(DEFAULTS)) {
            if (s[k] === undefined) s[k] = structuredClone(DEFAULTS[k]);
        }
        // v1.0 -> v1.1 마이그레이션
        if (Array.isArray(s.order)) {
            if (!s.g1.length && !s.g2.length) s.g1 = s.order.filter((k) => s.known[k]);
            delete s.order;
        }
        // 어느 그룹에도 없는 버튼은 그룹1로
        const placed = new Set([...s.g1, ...s.g2, ...nonLeaderMembers(s)]);
        for (const k of Object.keys(s.known)) if (!placed.has(k)) s.g1.push(k);
        // 예전 버전의 '묶음 풀기' 기록은 더 이상 쓰지 않음
        if (s.ignored !== undefined) delete s.ignored;
        return s;
    }

    const save = () => ctx().saveSettingsDebounced();

    /* ---------- 세트(번갈아 보이는 버튼 묶음) ---------- */

    function leaderOf(s, k) {
        for (const l of Object.keys(s.sets)) if (s.sets[l].includes(k)) return l;
        return k;
    }

    function nonLeaderMembers(s) {
        const out = new Set();
        for (const l of Object.keys(s.sets)) for (const m of s.sets[l]) if (m !== l) out.add(m);
        return out;
    }

    function makeSet(s, keys) {
        const union = new Set();
        for (const k of keys) (s.sets[leaderOf(s, k)] || [k]).forEach((m) => union.add(m));
        const rank = (k) => { const i = s.native.indexOf(k); return i < 0 ? 1e9 : i; };
        const members = [...union].sort((a, b) => rank(a) - rank(b));
        if (members.length < 2) return false;

        // 대표키: 현재 목록에서 가장 앞에 있는 것
        const leaders = [...new Set(members.map((m) => leaderOf(s, m)))];
        const pos = (k) => {
            const i1 = s.g1.indexOf(k);
            if (i1 >= 0) return i1;
            const i2 = s.g2.indexOf(k);
            return i2 >= 0 ? s.g1.length + i2 : 1e9;
        };
        leaders.sort((a, b) => pos(a) - pos(b));
        const lead = leaders[0];

        const anyHidden = leaders.some((l) => s.hidden.includes(l));
        for (const l of leaders) {
            delete s.sets[l];
            if (l === lead) continue;
            s.g1 = s.g1.filter((k) => k !== l);
            s.g2 = s.g2.filter((k) => k !== l);
        }
        s.hidden = s.hidden.filter((k) => !members.includes(k));
        if (anyHidden) s.hidden.push(lead);
        if (!s.g1.includes(lead) && !s.g2.includes(lead)) s.g1.push(lead);

        s.sets[lead] = members;
        return true;
    }

    function seedSets(s) {
        let changed = false;
        for (const [a, b] of DEFAULT_SETS) {
            if (!s.known[a] || !s.known[b]) continue;
            if (leaderOf(s, a) === leaderOf(s, b)) continue;
            changed = makeSet(s, [a, b]) || changed;
        }
        return changed;
    }

    /* ---------- 버튼 탐색 / 식별 ---------- */

    function getButtons(root) {
        if (!root) return [];
        return [...root.querySelectorAll('.mes_buttons .mes_button')].filter(
            (el) =>
                !el.classList.contains('extraMesButtonsHint') &&
                !el.classList.contains('mam-more-toggle') &&
                !el.closest('.mes_edit_buttons'),
        );
    }

    function getKey(el) {
        const classes = [...el.classList];
        const own = classes.find(
            (c) => !IGNORE_CLASSES.has(c) && !c.startsWith('fa-') && !c.startsWith('mam-'),
        );
        if (own) return own;
        const icon = classes.find((c) => c.startsWith('fa-') && !['fa-solid', 'fa-regular', 'fa-brands', 'fa-fw'].includes(c));
        if (icon) return 'icon:' + icon;
        if (el.id) return 'id:' + el.id;
        return 'title:' + (el.getAttribute('title') || el.textContent.trim());
    }

    const getLabel = (el, key) => el.getAttribute('title') || el.getAttribute('data-title') || key;

    function snapshot(el) {
        const c = el.cloneNode(true);
        c.classList.remove('mam-hidden', 'displayNone', 'hidden');
        c.removeAttribute('style');
        c.removeAttribute('id');
        c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
        for (const node of [c, ...c.querySelectorAll('*')]) {
            for (const a of [...node.attributes]) {
                if (/^on/i.test(a.name)) node.removeAttribute(a.name);
            }
        }
        const html = c.outerHTML;
        const DP = SillyTavern.libs && SillyTavern.libs.DOMPurify;
        return DP ? DP.sanitize(html) : html;
    }

    // 템플릿(원래 DOM 순서) 기준으로 새 버튼을 이웃 버튼 옆에 끼워 넣는다.
    // 다른 확장이 나중에 버튼을 추가해도 원래 위치에 들어가고, 사용자가 옮긴 순서는 건드리지 않는다.
    // 실제 메시지(아직 이 확장이 재배치하지 않은 원본 DOM)에서 본 순서를 s.native에 누적한다.
    function mergeNative(s, rawKeys) {
        const keys = [...new Set(rawKeys)];
        let changed = false;
        for (let i = 0; i < keys.length; i++) {
            if (s.native.includes(keys[i])) continue;
            let at = -1;
            for (let j = i - 1; j >= 0 && at < 0; j--) {
                const p = s.native.indexOf(keys[j]);
                if (p >= 0) at = p + 1;
            }
            for (let j = i + 1; j < keys.length && at < 0; j++) {
                const n = s.native.indexOf(keys[j]);
                if (n >= 0) at = n;
            }
            if (at < 0) at = s.native.length;
            s.native.splice(at, 0, keys[i]);
            changed = true;
        }
        return changed;
    }

    function placeKey(s, key) {
        mergeNative(s, [key]);
        const all = s.native;
        const idx = all.indexOf(key);

        const insertAt = (k, offset) => {
            const lk = leaderOf(s, k);
            for (const g of ['g1', 'g2']) {
                const i = s[g].indexOf(lk);
                if (i >= 0) { s[g].splice(i + offset, 0, key); return true; }
            }
            return false;
        };
        for (let i = idx - 1; i >= 0; i--) if (all[i] !== key && insertAt(all[i], 1)) return;
        for (let i = idx + 1; i < all.length; i++) if (all[i] !== key && insertAt(all[i], 0)) return;
        s.g1.push(key);
    }

    // 실리태번 원래 순서(템플릿 DOM 순서) 목록
    function originalOrder(s) {
        const ordered = s.native.filter((k) => s.known[k]);
        const rest = Object.keys(s.known).filter((k) => !ordered.includes(k));
        return [...ordered, ...rest];
    }

    function register(els) {
        const s = settings();
        let changed = false;
        for (const el of els) {
            const key = getKey(el);
            if (!liveKeys.has(key)) { liveKeys.add(key); uiDirty = true; }
            if (!s.known[key]) {
                s.known[key] = { label: getLabel(el, key), html: snapshot(el) };
                placeKey(s, key); // 새 버튼은 원래 순서 위치의 그룹1/2 이웃 옆으로
                changed = true;
            }
        }
        return changed;
    }

    /* ---------- 적용 ---------- */

    function syncChildren(container, desired) {
        const cur = [...container.children].filter((c) => c.classList.contains('mes_button'));
        if (cur.length === desired.length && cur.every((c, i) => c === desired[i])) return;
        desired.forEach((b) => container.appendChild(b));
    }

    function ensureGroups(mb) {
        let g1 = mb.querySelector(':scope > .mam-group1');
        if (g1) {
            return {
                g1,
                g2: mb.querySelector(':scope > .mam-group2'),
                toggle: mb.querySelector(':scope > .mam-more-toggle'),
            };
        }
        g1 = document.createElement('div');
        g1.className = 'mam-group mam-group1';
        const g2 = document.createElement('div');
        g2.className = 'mam-group mam-group2';
        const toggle = document.createElement('div');
        toggle.className = 'mes_button mam-more-toggle fa-solid fa-ellipsis interactable';
        toggle.title = '더보기';
        toggle.tabIndex = 0;
        mb.prepend(g1, toggle, g2); // … 버튼과 펼쳐진 그룹2 모두 맨 오른쪽에 위치
        return { g1, g2, toggle };
    }

    function applyTo(mes, s, hiddenSet) {
        const mb = mes.querySelector('.mes_buttons');
        if (!mb) return;
        const { g1, g2, toggle } = ensureGroups(mb);

        const byKey = new Map();
        for (const b of getButtons(mes)) {
            const k = getKey(b);
            b.classList.toggle('mam-hidden', hiddenSet.has(leaderOf(s, k)));
            if (!byKey.has(k)) byKey.set(k, []);
            byKey.get(k).push(b);
        }

        const take = (keys) => {
            const out = [];
            for (const lead of keys) {
                for (const k of s.sets[lead] || [lead]) {
                    const arr = byKey.get(k);
                    if (arr) { out.push(...arr); byKey.delete(k); }
                }
            }
            return out;
        };
        const d1 = take(s.g1);
        const d2 = take(s.g2);
        for (const arr of byKey.values()) d1.push(...arr);

        syncChildren(g1, d1);
        syncChildren(g2, d2);

        const any2 = d2.some((b) => !b.classList.contains('mam-hidden'));
        toggle.classList.toggle('mam-hidden', !any2);
        if (!any2) mes.classList.remove('mam-more-open');
    }

    function applyAll() {
        const s = settings();
        const hidden = new Set(s.hidden);
        document.querySelectorAll('#chat .mes').forEach((mes) => applyTo(mes, s, hidden));
    }

    /* ---------- 변경 감시 ---------- */

    const pending = new Set();
    let raf = 0;

    function schedule() {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; flush(); });
    }

    function flush() {
        const nodes = [...pending];
        pending.clear();

        const s0 = settings();
        let changed = false;

        // 원본 순서 수집: 템플릿과, 아직 재배치되지 않은 메시지의 DOM 순서
        const tplEl = document.getElementById('message_template');
        if (tplEl) changed = mergeNative(s0, getButtons(tplEl).map(getKey)) || changed;
        for (const n of nodes) {
            const mb = n.querySelector('.mes_buttons');
            if (mb && !mb.querySelector(':scope > .mam-group1')) {
                changed = mergeNative(s0, getButtons(n).map(getKey)) || changed;
            }
        }

        changed = register(getButtons(tplEl)) || changed;
        for (const n of nodes) changed = register(getButtons(n)) || changed;

        const s = settings();
        if (seedSets(s)) changed = true;

        const hidden = new Set(s.hidden);
        nodes.forEach((n) => applyTo(n, s, hidden));

        if (changed) save();
        if (changed || uiDirty) {
            uiDirty = false;
            renderManager();
        }
    }

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            const t = m.target;
            if (!(t instanceof Element)) continue;
            const mes = t.closest('#chat .mes');
            if (mes) pending.add(mes);
            m.addedNodes.forEach((n) => {
                if (n.nodeType !== 1) return;
                if (n.matches('.mes')) pending.add(n);
                else n.querySelectorAll('.mes').forEach((x) => pending.add(x));
            });
        }
        schedule();
    });

    /* ---------- 설정 UI ---------- */

    function buildUI() {
        const html = `
        <div class="mam-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Message Actions Manager</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="mam-toolbar">
                        <div id="mam_show_all" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-eye"></i><span>모두 표시</span>
                        </div>
                        <div id="mam_hide_all" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-eye-slash"></i><span>모두 해제</span>
                        </div>
                        <div id="mam_reset" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-rotate-left"></i><span>초기화</span>
                        </div>
                    </div>

                    <fieldset class="mam-box">
                        <legend>Preview</legend>
                        <small class="mam-desc">프리뷰의 아이콘을 잡고 드래그하면 순서를 바꿀 수 있어요. 놓일 위치는 세로선으로 표시돼요.</small>
                        <div id="mam_preview" class="mam-preview"></div>
                    </fieldset>

                    <fieldset class="mam-box">
                        <legend>Always Display</legend>
                        <small class="mam-desc">메시지 헤더에 항상 보이는 아이콘이에요. 왼쪽 핸들을 잡고 순서를 바꿀 수 있어요.</small>
                        <div id="mam_g1" class="mam-list"></div>
                    </fieldset>

                    <fieldset class="mam-box">
                        <legend>더보기</legend>
                        <small class="mam-desc">… 버튼을 눌러야 펼쳐지는 아이콘이에요. 핸들을 잡고 그룹 사이로 드래그해서 옮길 수 있어요.</small>
                        <div id="mam_g2" class="mam-list"></div>
                    </fieldset>

                </div>
            </div>
        </div>`;
        $('#extensions_settings2').append(html);
        initPreviewDrag();

        $('#mam_show_all').on('click', () => {
            settings().hidden = [];
            save();
            applyAll();
            renderManager();
        });

        $('#mam_hide_all').on('click', () => {
            const s = settings();
            s.hidden = [...s.g1, ...s.g2];
            save();
            applyAll();
            renderManager();
        });

        $('#mam_reset').on('click', () => {
            const s = settings();
            const members = nonLeaderMembers(s);
            s.g1 = originalOrder(s).filter((k) => !members.has(k));
            s.g2 = [];
            s.hidden = [];
            save();
            applyAll();
            renderManager();
        });

        renderManager();
    }

    function renderPreview() {
        const s = settings();
        const hidden = new Set(s.hidden);
        const box = $('#mam_preview').empty();
        const pv1 = $('<div id="mam_pv1" class="mam-pv">');
        const pv2 = $('<div id="mam_pv2" class="mam-pv">');

        const fill = (pv, keys) => {
            for (const key of keys) {
                if (!s.known[key] || hidden.has(key)) continue;
                pv.append(
                    $('<span class="mam-pv-item">')
                        .attr('data-key', key)
                        .attr('title', (s.sets[key] || [key]).map((m) => (s.known[m] ? s.known[m].label : m)).join(' / '))
                        .append($('<span>').html(s.known[key].html)),
                );
            }
        };
        fill(pv1, s.g1);
        fill(pv2, s.g2);
        box.append(pv1, $('<i class="fa-solid fa-ellipsis mam-sep"></i>'), pv2);
    }

    /* ---------- 프리뷰 드래그 (세로선 캐럿) ----------
     * 드래그 중에는 DOM을 전혀 건드리지 않고(아이콘이 밀리지 않음 → 떨림 없음),
     * 포인터 위치만으로 놓을 자리를 계산해 세로선만 옮긴다. 놓는 순간에만 한 번 이동.
     */

    function rectDist(r, x, y) {
        const dx = Math.max(r.left - x, 0, x - r.right);
        const dy = Math.max(r.top - y, 0, y - r.bottom);
        return Math.hypot(dx, dy);
    }

    function pvDropTarget(x, y, dragEl) {
        let zone = null;
        let zd = Infinity;
        for (const z of document.querySelectorAll('#mam_preview .mam-pv')) {
            const d = rectDist(z.getBoundingClientRect(), x, y);
            if (d < zd) { zd = d; zone = z; }
        }
        if (!zone) return null;

        let ref = null;
        let rd = Infinity;
        for (const it of zone.querySelectorAll('.mam-pv-item')) {
            if (it === dragEl) continue;
            const d = rectDist(it.getBoundingClientRect(), x, y);
            if (d < rd) { rd = d; ref = it; }
        }
        if (!ref) return { zone, ref: null, after: false };
        const r = ref.getBoundingClientRect();
        return { zone, ref, after: x > r.left + r.width / 2 };
    }

    function placeCaret(box, caret, t) {
        const b = box.getBoundingClientRect();
        let left, top, height;
        if (t.ref) {
            const r = t.ref.getBoundingClientRect();
            left = t.after ? r.right : r.left - 2; // 아이콘 사이 gap(2px)에 맞춤
            top = r.top;
            height = r.height;
        } else {
            const r = t.zone.getBoundingClientRect();
            height = 28;
            left = r.left + 4;
            top = r.top + (r.height - height) / 2;
        }
        caret.style.height = height + 'px';
        caret.style.transform = `translate(${left - b.left}px, ${top - b.top}px)`;
    }

    function initPreviewDrag() {
        const box = document.getElementById('mam_preview');
        if (!box) return;

        const keysOf = (sel) => [...box.querySelectorAll(`${sel} .mam-pv-item`)].map((el) => el.dataset.key);
        const snap = () => JSON.stringify([keysOf('#mam_pv1'), keysOf('#mam_pv2')]);
        let st = null;

        const cleanup = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onCancel);
            if (st) {
                if (st.ghost) st.ghost.remove();
                if (st.caret) st.caret.remove();
                st.el.classList.remove('mam-drag-src');
            }
            box.classList.remove('mam-dragging');
            document.documentElement.classList.remove('mam-grabbing');
            st = null;
        };

        const startDrag = () => {
            const rect = st.el.getBoundingClientRect();
            st.offX = st.sx - rect.left;
            st.offY = st.sy - rect.top;
            st.before = snap();

            const ghost = st.el.cloneNode(true);
            ghost.classList.remove('mam-pv-item');
            ghost.classList.add('mam-ghost');
            ghost.style.width = rect.width + 'px';
            ghost.style.height = rect.height + 'px';
            document.body.appendChild(ghost);

            const caret = document.createElement('div');
            caret.className = 'mam-caret';
            box.appendChild(caret);

            st.ghost = ghost;
            st.caret = caret;
            st.dragging = true;
            st.el.classList.add('mam-drag-src');
            box.classList.add('mam-dragging');
            document.documentElement.classList.add('mam-grabbing');
        };

        function onMove(e) {
            if (!st || e.pointerId !== st.id) return;
            if (!st.dragging) {
                if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < 4) return;
                startDrag();
            }
            st.ghost.style.transform = `translate(${e.clientX - st.offX}px, ${e.clientY - st.offY}px)`;
            st.target = pvDropTarget(e.clientX, e.clientY, st.el);
            if (st.target) placeCaret(box, st.caret, st.target);
        }

        function onUp(e) {
            if (!st || e.pointerId !== st.id) return;
            const { el, dragging, target, before } = st;
            let changed = false;
            if (dragging && target && el.isConnected) {
                const { zone, ref, after } = target;
                if (!ref) zone.appendChild(el);
                else if (after) ref.after(el);
                else ref.before(el);
                changed = snap() !== before;
            }
            cleanup();
            if (changed) commitPreview();
        }

        function onCancel(e) {
            if (!st || e.pointerId !== st.id) return;
            cleanup();
        }

        box.addEventListener('pointerdown', (e) => {
            if (st) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            const el = e.target.closest ? e.target.closest('.mam-pv-item') : null;
            if (!el) return;
            e.preventDefault();
            st = { el, id: e.pointerId, sx: e.clientX, sy: e.clientY, dragging: false, ghost: null, caret: null, target: null };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onCancel);
        });
    }

    // 프리뷰에서 드래그한 결과 반영 (숨겨진 버튼은 원래 자리 근처에 유지)
    function commitPreview() {
        const s = settings();
        const hidden = new Set(s.hidden);
        const read = (sel) => $(`${sel} .mam-pv-item`).map((_, el) => $(el).attr('data-key')).get();

        const merge = (oldList, newVisible) => {
            const out = [...newVisible];
            for (const h of oldList.filter((k) => hidden.has(k))) {
                const idx = oldList.indexOf(h);
                let anchor = null;
                for (let i = idx - 1; i >= 0; i--) {
                    if (out.includes(oldList[i])) { anchor = oldList[i]; break; }
                }
                out.splice(anchor === null ? 0 : out.indexOf(anchor) + 1, 0, h);
            }
            return out;
        };

        const oldG1 = [...s.g1];
        const oldG2 = [...s.g2];
        s.g1 = merge(oldG1, read('#mam_pv1'));
        s.g2 = merge(oldG2, read('#mam_pv2'));
        save();
        applyAll();
        // 프리뷰는 이미 사용자가 놓은 상태 그대로라서 다시 그리지 않고(끊김 방지), 아래 목록만 갱신
        setTimeout(renderLists, 0);
    }

    function commitOrder() {
        const s = settings();
        const rows = (sel) => $(`${sel} .mam-row`).map((_, el) => $(el).attr('data-key')).get();
        s.g1 = rows('#mam_g1');
        s.g2 = rows('#mam_g2');
        save();
        applyAll();
        renderPreview();
    }

    function makeRow(key, info, hidden) {
        const row = $('<div class="mam-row">').attr('data-key', key);
        row.toggleClass('mam-off', hidden.has(key));

        const st0 = settings();
        const members = st0.sets[key];

        const handle = $('<i class="fa-solid fa-grip-vertical mam-handle"></i>');
        const icon = $('<span class="mam-icon">');
        const name = $('<span class="mam-name">');
        if (members) {
            icon.addClass('mam-icon-set').html(members.map((m) => (st0.known[m] ? st0.known[m].html : '')).join(''));
            name.append($('<span>').text(members.map((m) => (st0.known[m] ? st0.known[m].label : m)).join(' / ')));
            name.append($('<small>').text(members.join(' + ') + (members.some((m) => liveKeys.has(m)) ? '' : ' · 현재 감지 안 됨')));
        } else {
            icon.html(info.html);
            name.append($('<span>').text(info.label));
            name.append($('<small>').text(key + (liveKeys.has(key) ? '' : ' · 현재 감지 안 됨')));
        }

        const toggle = $('<label class="mam-toggle">');
        const cb = $('<input type="checkbox">').prop('checked', !hidden.has(key));
        toggle.append(cb, $('<span>표시</span>'));

        cb.on('change', () => {
            const st = settings();
            const set = new Set(st.hidden);
            if (cb.prop('checked')) set.delete(key); else set.add(key);
            st.hidden = [...set];
            row.toggleClass('mam-off', !cb.prop('checked'));
            save();
            applyAll();
            renderPreview();
        });

        return row.append(handle, icon, name, toggle);
    }

    function renderManager() {
        if (!$('#mam_g1').length) return;
        renderLists();
        renderPreview();
    }

    function renderLists() {
        if (!$('#mam_g1').length) return;

        const s = settings();
        const hidden = new Set(s.hidden);

        for (const [sel, keys] of [['#mam_g1', s.g1], ['#mam_g2', s.g2]]) {
            const list = $(sel).empty();
            for (const key of keys) {
                if (s.known[key]) list.append(makeRow(key, s.known[key], hidden));
            }
        }

        if ($.fn.sortable) {
            $('#mam_g1, #mam_g2').sortable({
                handle: '.mam-handle',
                connectWith: '.mam-list',
                tolerance: 'pointer',
                placeholder: 'mam-placeholder',
                stop: commitOrder,
            });
        }
    }

    /* ---------- 시작 ---------- */

    jQuery(() => {
        settings();
        buildUI();

        // 헤더의 … 버튼: 그룹2 펼치기/접기
        $(document).on('click', '.mam-more-toggle', function () {
            $(this).closest('.mes').addClass('mam-more-open');
        });

        // 메시지 액션 영역 밖을 클릭하면 펼친 그룹2를 다시 닫기
        $(document).on('click', (e) => {
            $('#chat .mes.mam-more-open').each(function () {
                if (!$(e.target).closest('.mes_buttons', this).length) {
                    $(this).removeClass('mam-more-open');
                }
            });
        });

        const chat = document.getElementById('chat');
        const tpl = document.getElementById('message_template');
        if (chat) observer.observe(chat, { childList: true, subtree: true });
        if (tpl) observer.observe(tpl, { childList: true, subtree: true });

        document.querySelectorAll('#chat .mes').forEach((m) => pending.add(m));
        flush();
    });
})();
