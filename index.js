/**
 * Message Actions Manager
 * 메시지 헤더의 액션 아이콘(기본 + 다른 확장이 추가한 것 포함)을
 * 그룹1(항상 표시) / 그룹2(… 더보기 안)로 나눠 순서·표시 여부를 관리하는 확장.
 */
(() => {
    'use strict';

    const MODULE = 'message_actions_manager';
    const TITLE = 'Message Actions Manager';
    const SCHEMA_VERSION = 3;
    const MAX_KNOWN = 300; // 메시지마다 클래스명이 달라지는 확장이 있어도 설정이 무한히 불어나지 않게 하는 상한

    // saved: Save 버튼으로 저장한 배치 { g1, g2, hidden } (없으면 null). Reset 시 이 상태로 복원.
    // known[key]: { label, html }
    const DEFAULTS = { g1: [], g2: [], hidden: [], known: {}, native: [], noShadow: true, scrollActions: true, moreRight: true, editExtract: {}, saved: null, version: 0 };

    // 같은 자리를 번갈아 쓰는 고정 버튼 쌍 (대표키 -> 멤버). 그룹 목록/숨김 목록에는 대표키만 들어간다.
    const PAIRS = {
        mes_hide: ['mes_hide', 'mes_unhide'],
        mes_create_bookmark: ['mes_create_bookmark', 'mes_bookmark'],
        mes_fold: ['mes_fold', 'mes_unfold'],
    };
    const LEADER = {};
    for (const [lead, members] of Object.entries(PAIRS)) for (const m of members) LEADER[m] = lead;
    const leaderOf = (k) => LEADER[k] || k;
    const isPaired = (k) => k in LEADER;

    const IGNORE_CLASSES = new Set([
        'mes_button', 'interactable', 'list-group-item', 'hidden', 'displayNone',
        'menu_button', 'right_menu_button',
    ]);
    const FA_GENERIC = new Set(['fa-solid', 'fa-regular', 'fa-brands', 'fa-fw']);

    const liveKeys = new Set(); // 이번 세션에 실제로 감지된 버튼
    let uiDirty = false;
    let capWarned = false;
    const ctx = () => SillyTavern.getContext();

    function settings() {
        const { extensionSettings } = ctx();
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(DEFAULTS);
        const s = extensionSettings[MODULE];
        for (const k of Object.keys(DEFAULTS)) {
            if (s[k] === undefined) s[k] = structuredClone(DEFAULTS[k]);
        }
        // 어느 그룹에도 없는 버튼은 그룹1로 (저장 이후 새로 설치된 확장의 버튼도 여기서 그룹1 맨 뒤로 들어감)
        // 옛 버전(sets 보유)은 migrate()가 변환하기 전까지 건드리지 않는다
        if (!s.sets) {
            const placed = new Set([...s.g1, ...s.g2]);
            for (const k of Object.keys(s.known)) {
                const lead = leaderOf(k);
                if (!placed.has(lead)) { s.g1.push(lead); placed.add(lead); }
            }
        }
        return s;
    }

    // 설정 스키마 업그레이드 (시작할 때 한 번만)
    function migrate() {
        const s = settings();
        if (s.version >= SCHEMA_VERSION) return;
        if (s.version < 2) {
            // 옛 개발 버전의 잔여 필드 정리
            delete s.order;
            delete s.extractEdit;
            delete s.ignored;
            for (const k of ['mes_ext_edit_copy', 'mes_ext_edit_delete']) removeKey(s, k);
        }
        // v3: 범용 sets 저장 → 고정 PAIRS. 대표키가 달랐던 기록은 새 대표키로 바꿔 준다
        const fix = (a) => [...new Set((a || []).map(leaderOf))];
        s.g1 = fix(s.g1);
        s.g2 = fix(s.g2);
        s.hidden = fix(s.hidden);
        if (s.saved) s.saved = { g1: fix(s.saved.g1), g2: fix(s.saved.g2), hidden: fix(s.saved.hidden) };
        delete s.sets;
        for (const rec of Object.values(s.known)) if (rec) delete rec.seen;
        settings(); // sets가 사라진 상태에서 미배치 버튼 정리
        s.version = SCHEMA_VERSION;
        save();
    }

    const save = () => ctx().saveSettingsDebounced();

    // 그림자 제거 / 가로 스크롤 / More(…) 그룹 위치 — 모두 body 클래스로 처리 (CSS)
    function applyBodyFlags() {
        const s = settings();
        const cl = document.body.classList;
        cl.toggle('mam-no-shadow', !!s.noShadow);
        cl.toggle('mam-scroll', !!s.scrollActions);
        cl.toggle('mam-more-left', !s.moreRight);
    }

    /* ---------- 편집 메뉴(.mes_edit_buttons)의 버튼을 독립 아이콘으로 빼기 ----------
     * ST 원본 .mes_edit_* 핸들러는 '편집 중인 메시지'(this_edit_mes_id)를 전제로 동작한다.
     * 그래서 클릭하면 → 편집 모드 진입 → 원본 버튼 클릭(ST 확인 팝업 그대로) → 아직 편집 중이면 취소 로 처리한다.
     * (keepEditing: 편집 모드가 계속 필요한 버튼은 취소하지 않음)
     */
    const EDIT_DEFS = {
        mes_edit_copy: { icon: 'fa-clone', title: 'Copy this message' },
        mes_edit_add_reasoning: { icon: 'fa-lightbulb', title: 'Add reasoning block', keepEditing: true },
        mes_edit_delete: { icon: 'fa-trash-can', title: 'Delete this message' },
        mes_edit_up: { icon: 'fa-chevron-up', title: 'Move message up' },
        mes_edit_down: { icon: 'fa-chevron-down', title: 'Move message down' },
    };
    const extKeyOf = (nk) => 'mes_x_' + nk.replace(/^mes_/, ''); // mes_edit_copy -> mes_x_edit_copy
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let busy = false; // 편집 모드 흉내 작업은 한 번에 하나만 (ST의 편집 상태와 quietEdit의 body 클래스가 전역이라서)
    const isEditing = (mes) => !!mes.querySelector('.edit_textarea');

    const editingMes = () => document.querySelector('#chat .edit_textarea')?.closest('.mes') || null;

    async function exitEditMode() {
        for (let i = 0; i < 16; i++) {
            const m = editingMes();
            if (!m) {
                await sleep(300); // ST가 뒤늦게 편집 상태를 되살리는 경우 대비해 한 번 더 확인
                if (!editingMes()) return true;
                continue;
            }
            m.querySelector('.mes_edit_cancel')?.click();
            await sleep(150);
        }
        toastr.warning('Could not close edit mode automatically. Please close it manually.', TITLE);
        return false;
    }

    // 위/아래 이동: ST가 메시지 번호를 바꾸고 저장을 끝낼 때까지 대기 (여기서부터 약간 동작상 귀찮지만 눈으로는 편안한짓 함)
    async function waitMoveDone(mes, idBefore) {
        for (let i = 0; i < 30 && mes.getAttribute('mesid') === idBefore; i++) await sleep(50);
        await sleep(500);
    }

    // 편집 모드를 몰래 열고 닫는 동안 편집 UI가 번쩍이지 않게 가린다.
    // 편집창/편집 버튼은 CSS(body.mam-quiet-edit)로 숨기고, 본문은 열기 전 HTML 사본으로 덮어 둔다.
    // 사용: const q = quietEdit(mes) → 편집 모드가 열린 뒤 q.cover() → 끝나면 q.end()
    function quietEdit(mes) {
        const mt = mes.querySelector('.mes_text');
        const html = mt ? mt.innerHTML : null;
        const cls = mt ? mt.className : '';
        document.body.classList.add('mam-quiet-edit');
        return {
            cover() {
                const real = mes.querySelector('.edit_textarea')?.closest('.mes_text');
                if (!real || html === null) return;
                const g = document.createElement('div');
                g.className = cls + ' mam-ghost-text';
                g.innerHTML = html;
                g.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
                g.querySelectorAll('video, audio, iframe, script').forEach((n) => n.remove());
                real.after(g);
                real.dataset.mamLock = '1';
            },
            end() {
                document.querySelectorAll('#chat .mam-ghost-text').forEach((g) => g.remove());
                document.querySelectorAll('#chat .mes_text[data-mam-lock]').forEach((el) => delete el.dataset.mamLock);
                document.body.classList.remove('mam-quiet-edit');
            },
        };
    }

    const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // ST 확인 팝업. 기본 선택은 항상 취소.
    async function askConfirm(title, detail, okText) {
        const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
        const r = await callGenericPopup(
            `<h3>${esc(title)}</h3><div style="white-space:pre-wrap">${esc(detail || '')}</div>`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: okText, cancelButton: 'Cancel', defaultResult: POPUP_RESULT.NEGATIVE },
        );
        return r === POPUP_RESULT.AFFIRMATIVE;
    }

    // 응답 생성 중(중지 버튼이 보이는 동안)에는 메시지 배열을 건드리지 않는다
    function isGenerating() {
        const stop = document.getElementById('mes_stop');
        return !!stop && getComputedStyle(stop).display !== 'none';
    }

    async function runEditAction(mes, nk) {
        if (busy) return;
        if (isGenerating()) { toastr.warning('Wait for the reply to finish generating.', TITLE); return; }
        const other = editingMes();
        if (other && other !== mes) { toastr.warning('Finish editing the other message first.', TITLE); return; }

        busy = true;
        let quiet = null;
        try {
            const def = EDIT_DEFS[nk] || {};
            const wasEditing = isEditing(mes);
            if (!wasEditing && !def.keepEditing) quiet = quietEdit(mes);
            if (!wasEditing) {
                mes.querySelector('.mes_edit')?.click();
                for (let i = 0; i < 100 && !isEditing(mes); i++) await sleep(10);
                if (!isEditing(mes)) { toastr.error('Could not enter edit mode.', TITLE); return; }
                quiet?.cover();
            }
            const btn = mes.querySelector('.' + nk);
            if (!btn) {
                toastr.error('Original edit button not found.', TITLE);
                if (!wasEditing) mes.querySelector('.mes_edit_cancel')?.click();
                return;
            }
            const idBefore = mes.getAttribute('mesid');
            btn.click();
            // ST 확인 팝업이 닫힐 때까지 대기 (최대 60초)
            await sleep(150);
            for (let i = 0; i < 600 && document.querySelector('dialog.popup[open]'); i++) await sleep(100);
            if (nk === 'mes_edit_up' || nk === 'mes_edit_down') await waitMoveDone(mes, idBefore);
            else await sleep(150);
            // 우리가 연 편집 모드가 남아 있으면(복제/이동 후 등) 취소로 원래 상태로 되돌림
            if (!wasEditing && !def.keepEditing) await exitEditMode();
        } finally {
            quiet?.end();
            busy = false;
        }
    }

    function makeExtButton(nk, def) {
        const el = document.createElement('div');
        el.className = `mes_button ${extKeyOf(nk)} mam-x fa-solid ${def.icon} interactable`;
        el.title = def.title;
        el.dataset.mamNative = nk;
        el.tabIndex = 0;
        return el;
    }

    // 켜진 버튼만 각 메시지에 삽입 / 꺼진 버튼은 제거
    function syncExtButtons(mb, g1, s) {
        for (const [nk, def] of Object.entries(EDIT_DEFS)) {
            const exist = mb.querySelector(`.${extKeyOf(nk)}`);
            const on = !!s.editExtract[nk];
            if (on && !exist) g1.appendChild(makeExtButton(nk, def));
            else if (!on && exist) exist.remove();
        }
    }

    function setExtract(nk, on) {
        const s = settings();
        s.editExtract[nk] = on;
        if (!on) {
            const ek = extKeyOf(nk);
            liveKeys.delete(ek);
            refreshedKeys.delete(ek);
            removeKey(s, ek);
        }
        save();
        applyAll();
        renderManager();
    }

    function renderEditOptions() {
        const box = $('#mam_edit_opts');
        if (!box.length) return;
        const s = settings();
        box.empty();
        for (const [nk, d] of Object.entries(EDIT_DEFS)) {
            const id = 'mam_ex_' + nk;
            const cb = $('<input type="checkbox">').attr('id', id).prop('checked', !!s.editExtract[nk]);
            cb.on('change', function () { setExtract(nk, this.checked); });
            const label = $('<label class="mam-opt mam-edit-opt">').attr('for', id).append(
                $('<span class="mam-opt-title">').append(
                    $('<i class="fa-solid mam-edit-ico">').addClass(d.icon),
                    $('<span class="mam-opt-text">').append($('<span>').text(d.title), $('<small>').text(nk)),
                ),
                $('<span class="mam-switch">').append(cb, $('<span class="mam-slider">')),
            );
            box.append($('<div class="mam-item">').append(label));
        }
    }

    /* ---------- 기록 관리 ---------- */

    // 화면(프리뷰/목록)에 안 보이는 키(숨김 등)를 새 순서 목록에 원래 자리 근처로 다시 끼워 넣는다.
    function mergeKeep(oldList, newVisible, shouldKeep) {
        const out = [...newVisible];
        for (const h of oldList.filter(shouldKeep)) {
            if (out.includes(h)) continue;
            const idx = oldList.indexOf(h);
            let anchor = null;
            for (let i = idx - 1; i >= 0; i--) {
                if (out.includes(oldList[i])) { anchor = oldList[i]; break; }
            }
            out.splice(anchor === null ? 0 : out.indexOf(anchor) + 1, 0, h);
        }
        return out;
    }

    // 목록/설정에서 버튼 기록을 완전히 제거 (고정 쌍은 건드리지 않음). 저장된 배치(saved)에서도 함께 제거.
    function removeKey(s, k) {
        if (isPaired(k)) return;
        s.g1 = s.g1.filter((x) => x !== k);
        s.g2 = s.g2.filter((x) => x !== k);
        s.hidden = s.hidden.filter((x) => x !== k);
        s.native = s.native.filter((x) => x !== k);
        if (s.saved) {
            s.saved.g1 = s.saved.g1.filter((x) => x !== k);
            s.saved.g2 = s.saved.g2.filter((x) => x !== k);
            s.saved.hidden = s.saved.hidden.filter((x) => x !== k);
        }
        delete s.known[k];
    }

    // 현재 배치를 저장용 스냅샷으로
    function layoutSnapshot(s) {
        return structuredClone({ g1: s.g1, g2: s.g2, hidden: s.hidden });
    }

    // '편집 메뉴에서 뺀 아이콘'으로 켜져 있는 키인가? (챗이 열려 있지 않아도 Clean Up 대상이 되지 않게)
    const extKeyOn = (s, k) => Object.keys(EDIT_DEFS).some((nk) => s.editExtract[nk] && extKeyOf(nk) === k);

    // 이번 세션에서 실제로 감지된 버튼인가? (삭제/비활성화된 확장의 버튼은 false → 패널에서 숨김)
    // 쌍은 멤버 중 하나라도 감지되면 true. 편집 메뉴에서 빼낸 아이콘은 켜져 있으면 항상 true.
    const isLive = (s, k) => (PAIRS[k] || [k]).some((m) => liveKeys.has(m)) || extKeyOn(s, k);

    // 지금 챗에서 감지되지 않은 버튼 키 — Clean Up 대상 (삭제/비활성화된 확장의 버튼 등)
    function staleKeys(s) {
        return Object.keys(s.known).filter((k) => !isPaired(k) && !liveKeys.has(k) && !extKeyOn(s, k));
    }

    /* ---------- 버튼 탐색 / 식별 ---------- */

    // 액션 아이콘 후보: 표준 .mes_button + 'mes_button' 클래스 없이 직접 만든 아이콘(예: mes_feedback)도 포함.
    // 후자는 .extraMesButtons 안이나 .mes_buttons 바로 아래에 들어간다.
    // (.mes_buttons 안에서만 탐색하므로 ':scope' 기준. 메시지 본문 DOM을 훑지 않는다)
    const CANDIDATES = [
        '.mes_button',
        ':scope > *',
        ':scope > .extraMesButtons > *',
        ':scope > .mam-group > *',
    ].join(',');
    const NOT_BUTTON = '.extraMesButtons, .extraMesButtonsHint, .mes_edit_buttons, .mam-group, .mam-more-toggle';

    function getButtons(root) {
        if (!root) return [];
        const mb = root.matches && root.matches('.mes_buttons') ? root : root.querySelector('.mes_buttons');
        if (!mb) return [];
        const out = [];
        for (const el of mb.querySelectorAll(CANDIDATES)) {
            if (el.matches(NOT_BUTTON) || el.closest('.mes_edit_buttons')) continue;
            if (!el.classList.contains('mes_button')) {
                // 아이콘처럼 보이는 것만 (fa-* 클래스 또는 title 보유)
                const iconLike = [...el.classList].some((c) => c.startsWith('fa-')) || el.hasAttribute('title');
                if (!iconLike) continue;
                // ST 기본 버튼과 같은 모양/호버 스타일을 받도록 클래스 부여 (getKey는 mes_button을 무시하므로 키는 그대로)
                el.classList.add('mes_button');
            }
            out.push(el);
        }
        return out;
    }

    function getKey(el) {
        const classes = [...el.classList];
        const own = classes.find(
            (c) => !IGNORE_CLASSES.has(c) && !c.startsWith('fa-') && !c.startsWith('mam-'),
        );
        if (own) return own;
        const icon = classes.find((c) => c.startsWith('fa-') && !FA_GENERIC.has(c));
        if (icon) return 'icon:' + icon;
        // id/title은 메시지마다 달라질 수 있으므로(번호, 시각 등) 숫자를 뭉개서 키가 무한히 늘지 않게 한다
        if (el.id) return 'id:' + el.id.replace(/\d+/g, '#');
        return 'title:' + (el.getAttribute('title') || el.textContent.trim()).replace(/\d+/g, '#');
    }

    // 같은 키라도 아이콘/제목/data-* 가 다르면 서로 다른 버튼으로 본다
    // (한 확장이 같은 클래스로 여러 버튼을 만들어도 중복으로 오인해 숨기지 않도록)
    function sigOf(el, key) {
        const icon = [...el.classList].find((c) => c.startsWith('fa-') && !FA_GENERIC.has(c)) || '';
        let data = '';
        for (const a of el.attributes) if (a.name.startsWith('data-')) data += `${a.name}=${a.value};`;
        return `${key}|${icon}|${el.getAttribute('title') || ''}|${data}`;
    }

    const getLabel = (el, key) => el.getAttribute('title') || el.getAttribute('data-title') || key;

    // 설정에 저장할 아이콘 HTML (화면에 넣을 때 iconHtml에서 sanitize)
    function snapshot(el) {
        const c = el.cloneNode(true);
        c.classList.remove('mam-hidden', 'mam-dup', 'mam-keep', 'displayNone', 'hidden');
        c.removeAttribute('style');
        c.removeAttribute('id');
        c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
        return c.outerHTML;
    }

    // 다른 확장의 DOM이 담긴 저장값이므로 화면에 넣을 때 반드시 sanitize (settings.json이 변조/공유돼도 안전하도록)
    function iconHtml(html) {
        const DP = SillyTavern.libs && SillyTavern.libs.DOMPurify;
        return html && DP ? DP.sanitize(html) : '';
    }

    // 새로 감지된 버튼: 처음 본 순서를 native에 누적(Reset 기본 순서용)하고, 그룹1 맨 뒤로 보낸다.
    // 다른 확장이 DOM 앞쪽에 끼워 넣거나 더보기 쪽 이웃 옆에 있어도 영향받지 않는다.
    function placeKey(s, key) {
        if (!s.native.includes(key)) s.native.push(key);
        const lead = leaderOf(key);
        if (!s.g1.includes(lead) && !s.g2.includes(lead)) s.g1.push(lead);
    }

    // 실리태번 원래 순서(템플릿 DOM 순서) 목록
    function originalOrder(s) {
        const ordered = s.native.filter((k) => s.known[k]);
        const rest = Object.keys(s.known).filter((k) => !ordered.includes(k));
        return [...ordered, ...rest];
    }

    // 이번 세션에서 이미 스냅샷을 최신화한 키 (같은 키가 상태에 따라 아이콘을 바꾸는 경우(접기/펼치기 등)
    // 메시지마다 계속 덮어써서 저장이 반복되는 것을 막기 위해 세션당 한 번만 갱신)
    const refreshedKeys = new Set();

    function register(els) {
        const s = settings();
        let changed = false;
        for (const el of els) {
            const key = getKey(el);
            if (!liveKeys.has(key)) { liveKeys.add(key); uiDirty = true; }
            const rec = s.known[key];
            if (!rec) {
                if (capWarned) continue; // 상한 도달: 기록은 안 하지만 버튼은 그대로 보임(그룹1 맨 뒤)
                if (Object.keys(s.known).length >= MAX_KNOWN) {
                    capWarned = true;
                    console.warn(`[${TITLE}] Too many distinct icons (>${MAX_KNOWN}); new ones are shown but not recorded.`);
                    continue;
                }
                s.known[key] = { label: getLabel(el, key), html: snapshot(el) };
                placeKey(s, key);
                refreshedKeys.add(key);
                changed = true;
            } else if (!refreshedKeys.has(key)) {
                // 이미 저장된 버튼도, 지금 실제로 보이는 아이콘으로 한 번 갱신
                // (다른 확장이 아이콘을 바꿨을 때 설정 화면에 옛 아이콘이 남는 문제 방지)
                refreshedKeys.add(key);
                const html = snapshot(el);
                const label = getLabel(el, key);
                if (rec.html !== html || rec.label !== label) {
                    rec.html = html;
                    rec.label = label;
                    uiDirty = true;
                    changed = true;
                }
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
            mb.classList.add('mam-ready');
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
        toggle.title = 'More';
        toggle.tabIndex = 0;
        toggle.setAttribute('role', 'button');
        mb.prepend(g1, toggle, g2); // … 버튼과 펼쳐진 그룹2 모두 맨 오른쪽에 위치
        mb.classList.add('mam-ready');
        return { g1, g2, toggle };
    }

    function applyTo(mes, s, hiddenSet) {
        const mb = mes.querySelector('.mes_buttons');
        if (!mb) return;
        const { g1, g2, toggle } = ensureGroups(mb);
        syncExtButtons(mb, g1, s);

        const byKey = new Map();
        const seen = new Set();
        for (const b of getButtons(mes)) {
            const k = getKey(b);
            b.classList.toggle('mam-hidden', hiddenSet.has(leaderOf(k)));
            // 다른 확장이 같은 버튼을 두 번 넣은 경우(템플릿 복제 + 직접 추가 등): 첫 번째만 남기고 숨김
            const sig = sigOf(b, k);
            b.classList.toggle('mam-dup', seen.has(sig));
            seen.add(sig);
            if (!byKey.has(k)) byKey.set(k, []);
            byKey.get(k).push(b);
        }

        // 아이콘이 아닌 직계 자식(카운터 등 다른 확장의 요소)은 숨기지 않고 제자리에 둔다
        for (const c of mb.children) {
            if (!c.classList.contains('mes_button') && !c.matches(NOT_BUTTON)) c.classList.add('mam-keep');
        }

        const take = (keys) => {
            const out = [];
            for (const lead of keys) {
                for (const k of PAIRS[lead] || [lead]) {
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

        const any2 = d2.some((b) => !b.classList.contains('mam-hidden') && !b.classList.contains('mam-dup'));
        toggle.classList.toggle('mam-hidden', !any2);
        if (!any2) mb.classList.remove('mam-more-open');
    }

    function applyAll() {
        const s = settings();
        const hidden = new Set(s.hidden);
        document.querySelectorAll('#chat .mes').forEach((mes) => applyTo(mes, s, hidden));
    }

    /* ---------- 변경 감시 ---------- */

    const pending = new Set();
    let raf = 0;

    // rAF로 미루면 브라우저가 한 번 화면을 그린 뒤에야 정리되어, 다른 확장이 끼워 넣은
    // 중복 아이콘이 한 프레임 보이는 깜빡임이 생긴다. 마이크로태스크는 페인트 전에 실행되므로
    // 변경 직후, 화면에 그려지기 전에 바로 정리한다.
    // 다른 확장의 MutationObserver와 서로 mutation을 주고받으면 마이크로태스크가 끝없이 이어져
    // 페인트가 막힐 수 있으므로, 같은 태스크 안에서 연속 20회를 넘으면 rAF로 한 번 쉬어 간다.
    let streak = 0;
    let streakTimer = 0;
    let tplDirty = true; // 템플릿(#message_template)은 바뀌었을 때만 다시 읽는다

    function schedule() {
        if (raf) return;
        raf = 1;
        if (!streakTimer) streakTimer = setTimeout(() => { streakTimer = 0; streak = 0; });
        if (++streak > 20) {
            requestAnimationFrame(() => { raf = 0; flush(); });
            return;
        }
        queueMicrotask(() => { raf = 0; flush(); });
    }

    // 시작 실패 시: 이 확장이 건 숨김 규칙을 풀어서 ST 기본 버튼이 그대로 보이게 되돌린다
    function rollback() {
        observer.disconnect();
        document.querySelectorAll('.mes_buttons.mam-ready').forEach((el) => el.classList.remove('mam-ready'));
    }

    function flush() {
        try { flushInner(); } catch (err) { console.error(`[${TITLE}] flush failed`, err); }
    }

    function flushInner() {
        const nodes = [...pending];
        pending.clear();

        let changed = false;
        // 템플릿은 바뀌었을 때만 읽는다 (원래 순서 수집 겸 버튼 등록)
        if (tplDirty) {
            tplDirty = false;
            changed = register(getButtons(document.getElementById('message_template'))) || changed;
        }
        for (const n of nodes) changed = register(getButtons(n)) || changed;

        const s = settings();
        const hidden = new Set(s.hidden);
        for (const n of nodes) {
            try {
                applyTo(n, s, hidden);
            } catch (err) {
                console.error(`[${TITLE}] applyTo failed`, err);
                n.querySelector('.mes_buttons')?.classList.remove('mam-ready'); // 이 메시지는 ST 기본 표시로 되돌림
            }
        }

        if (changed) save();
        if (changed || uiDirty) {
            uiDirty = false;
            renderManager();
        }
    }

    // 이 확장이 관심 있는 변화: 새 .mes 추가, 메시지 헤더(.mes_buttons 등) 변경, 템플릿 변경.
    // 스트리밍 중 .mes_text가 계속 바뀌는 것은 무시한다.
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            const t = m.target;
            if (!(t instanceof Element)) continue;
            if (t.closest('.mes_text')) continue;
            if (t.id === 'message_template' || t.closest('#message_template')) { tplDirty = true; continue; }
            if (t.id === 'chat') {
                m.addedNodes.forEach((n) => { if (n.nodeType === 1 && n.matches('.mes')) pending.add(n); });
                continue;
            }
            const mes = t.closest('#chat .mes');
            if (mes) pending.add(mes);
            m.addedNodes.forEach((n) => { if (n.nodeType === 1 && n.matches('.mes')) pending.add(n); });
        }
        if (pending.size || tplDirty) schedule();
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
                        <div class="menu_button menu_button_icon interactable" id="mam_show_all" role="button" tabindex="0" title="Show all icons"><i class="fa-solid fa-eye"></i><span>Show All</span></div>
                        <div class="menu_button menu_button_icon interactable" id="mam_hide_all" role="button" tabindex="0" title="Hide all icons"><i class="fa-solid fa-eye-slash"></i><span>Hide All</span></div>
                        <div class="menu_button menu_button_icon interactable" id="mam_cleanup" role="button" tabindex="0" title="Remove records of icons not present in the current chat (e.g. from uninstalled extensions)"><i class="fa-solid fa-broom"></i><span>Clean Up</span></div>
                        <div class="menu_button menu_button_icon interactable" id="mam_save" role="button" tabindex="0" title="Save the current layout. Reset will return to this layout."><i class="fa-solid fa-floppy-disk"></i><span>Save</span></div>
                        <div class="menu_button menu_button_icon interactable" id="mam_reset" role="button" tabindex="0" title="Reset to the saved layout (or the default)"><i class="fa-solid fa-rotate-left"></i><span>Reset</span></div>
                    </div>

                    <small id="mam_dormant" class="mam-desc" style="display:none"></small>

                    <fieldset class="mam-box">
                        <legend><i class="fa-solid fa-grip"></i>Preview</legend>
                        <div class="mam-item">
                            <small class="mam-desc">Drag icons to reorder. A vertical line marks the drop position.</small>
                            <div id="mam_preview" class="mam-preview"></div>
                        </div>
                    </fieldset>

                    <fieldset class="mam-box">
                        <legend><i class="fa-solid fa-thumbtack"></i>Always Display Group</legend>
                        <div class="mam-item">
                            <small class="mam-desc">Icons always shown in the message header. Drag the handle to reorder.</small>
                            <div id="mam_g1" class="mam-list"></div>
                        </div>
                    </fieldset>

                    <fieldset class="mam-box">
                        <legend><i class="fa-solid fa-ellipsis"></i>More Group</legend>
                        <div class="mam-item">
                            <small class="mam-desc">Icons revealed by the … button. Drag the handle to move them between groups.</small>
                            <div id="mam_g2" class="mam-list"></div>
                        </div>
                    </fieldset>

                    <fieldset class="mam-box mam-collapsible mam-collapsed">
                        <legend class="mam-toggle" tabindex="0" role="button" aria-expanded="false"><i class="fa-solid fa-pen-to-square"></i>Show Edit Buttons (Experimental)<i class="fa-solid fa-chevron-right mam-chevron"></i></legend>
                        <div class="mam-item">
                            <small class="mam-desc">Show buttons from the Edit menu as their own message icons.</small>
                        </div>
                        <div id="mam_edit_opts"></div>
                        <small class="mam-desc mam-hint">Click to expand: show Edit menu buttons as message icons.</small>
                    </fieldset>

                    <fieldset class="mam-box mam-collapsible mam-collapsed">
                        <legend class="mam-toggle" tabindex="0" role="button" aria-expanded="false"><i class="fa-solid fa-sliders"></i>Other Settings<i class="fa-solid fa-chevron-right mam-chevron"></i></legend>
                        <div class="mam-item">
                            <label class="mam-opt" for="mam_no_shadow">
                                <span class="mam-opt-title">Remove shadows</span>
                                <span class="mam-switch"><input type="checkbox" id="mam_no_shadow"><span class="mam-slider"></span></span>
                            </label>
                            <small class="mam-desc">Removes shadows from all message action icons.</small>
                        </div>
                        <div class="mam-item">
                            <label class="mam-opt" for="mam_scroll">
                                <span class="mam-opt-title">Scroll icons sideways</span>
                                <span class="mam-switch"><input type="checkbox" id="mam_scroll"><span class="mam-slider"></span></span>
                            </label>
                            <small class="mam-desc">When there are too many icons, scroll sideways instead of wrapping to the next line.</small>
                        </div>
                        <div class="mam-item">
                            <label class="mam-opt" for="mam_more_right">
                                <span class="mam-opt-title">Show More group on the right</span>
                                <span class="mam-switch"><input type="checkbox" id="mam_more_right"><span class="mam-slider"></span></span>
                            </label>
                            <small class="mam-desc">Turn off to show the … button and More icons on the left instead.</small>
                        </div>
                        <small class="mam-desc mam-hint">Click to expand: shadows, icon overflow behavior, and More group position.</small>
                    </fieldset>
                </div>
            </div>
        </div>`;
        $('#extensions_settings2').append(html);
        initPreviewDrag();
        renderEditOptions();

        // 접이식 박스: 제목 또는 안내 문구를 누르면 펼침/접힘 (Enter / Space 도 지원)
        $('.mam-settings .mam-collapsible').each(function () {
            const box = this;
            const head = box.querySelector('.mam-toggle');
            const toggle = () => {
                const collapsed = box.classList.toggle('mam-collapsed');
                head.setAttribute('aria-expanded', String(!collapsed));
            };
            head.addEventListener('click', toggle);
            head.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                toggle();
            });
            box.querySelector('.mam-hint')?.addEventListener('click', toggle);
        });

        const bindFlag = (sel, field) => {
            $(sel)
                .prop('checked', !!settings()[field])
                .on('change', function () {
                    settings()[field] = this.checked;
                    applyBodyFlags();
                    save();
                });
        };
        bindFlag('#mam_no_shadow', 'noShadow');
        bindFlag('#mam_scroll', 'scrollActions');
        bindFlag('#mam_more_right', 'moreRight');

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

        $('#mam_cleanup').on('click', async () => {
            const s = settings();
            const stale = staleKeys(s);
            if (!stale.length) { toastr.info('Nothing to clean up.'); return; }
            const names = stale.map((k) => s.known[k].label || k).join(', ');
            if (!(await askConfirm(`Remove ${stale.length} icon record(s)?`, `${names}\n\n(They are detected again if they show up in a chat.)`, 'Remove'))) return;
            stale.forEach((k) => removeKey(s, k));
            capWarned = false;
            save();
            applyAll();
            renderManager();
        });

        // 현재 배치(그룹1/2 순서, 숨김)를 Reset 기준점으로 저장
        $('#mam_save').on('click', () => {
            const s = settings();
            s.saved = layoutSnapshot(s);
            save();
            renderManager();
            toastr.success('Layout saved. Reset will return to this layout.');
        });

        // 저장본이 있으면 저장 상태로, 없으면 실리태번 기본 순서로 복원 (현재 배치가 사라지므로 확인)
        $('#mam_reset').on('click', async () => {
            const s = settings();
            if (!(await askConfirm('Reset layout?', s.saved ? 'Return to the saved layout.' : 'Return to the default layout.', 'Reset'))) return;
            if (s.saved) {
                s.g1 = [...s.saved.g1];
                s.g2 = [...s.saved.g2];
                s.hidden = [...s.saved.hidden];
                settings(); // 저장 이후 새로 설치된 확장의 버튼은 그룹1 맨 뒤에 자동 배치
            } else {
                s.g1 = [...new Set(originalOrder(s).map(leaderOf))];
                s.g2 = [];
                s.hidden = [];
            }
            save();
            applyAll();
            renderManager();
            toastr.info(s.saved ? 'Restored the saved layout.' : 'Restored the default layout.');
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
                if (!s.known[key] || hidden.has(key) || !isLive(s, key)) continue;
                pv.append(
                    $('<span class="mam-pv-item">')
                        .attr('data-key', key)
                        .attr('title', (PAIRS[key] || [key]).map((m) => (s.known[m] ? s.known[m].label : m)).join(' / '))
                        .append($('<span>').html(iconHtml(s.known[key].html))),
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

    // 드래그 시작 시 한 번만 레이아웃을 읽어 캐시 (드래그 중엔 DOM이 안 바뀌므로 안전)
    function cacheDragRects(box, dragEl) {
        return {
            box: box.getBoundingClientRect(),
            zones: [...box.querySelectorAll('.mam-pv')].map((z) => ({
                z,
                r: z.getBoundingClientRect(),
                items: [...z.querySelectorAll('.mam-pv-item')]
                    .filter((i) => i !== dragEl)
                    .map((i) => ({ el: i, r: i.getBoundingClientRect() })),
            })),
        };
    }

    // 캐시된 rect만 사용 (레이아웃 읽기 없음)
    function pvDropTarget(x, y, cache) {
        let zone = null;
        let zd = Infinity;
        for (const z of cache.zones) {
            const d = rectDist(z.r, x, y);
            if (d < zd) { zd = d; zone = z; }
        }
        if (!zone) return null;

        let ref = null;
        let rd = Infinity;
        for (const it of zone.items) {
            const d = rectDist(it.r, x, y);
            if (d < rd) { rd = d; ref = it; }
        }
        if (!ref) return { zone: zone.z, zoneRect: zone.r, ref: null, refRect: null, after: false };
        return { zone: zone.z, zoneRect: zone.r, ref: ref.el, refRect: ref.r, after: x > ref.r.left + ref.r.width / 2 };
    }

    function placeCaret(caret, b, t) {
        let left, top, height;
        if (t.ref) {
            const r = t.refRect;
            left = t.after ? r.right : r.left - 2; // 아이콘 사이 gap(2px)에 맞춤
            top = r.top;
            height = r.height;
        } else {
            const r = t.zoneRect;
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
        let rafId = 0;

        // 스크롤되면 캐시한 rect가 어긋나므로 표시만 해 두고 다음 프레임에 한 번 다시 읽는다
        const getRects = () => {
            if (!st.rects || st.stale) { st.rects = cacheDragRects(box, st.el); st.stale = false; }
            return st.rects;
        };
        const onScroll = () => { if (st) st.stale = true; };

        const cleanup = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onCancel);
            document.removeEventListener('scroll', onScroll, true);
            if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
            if (st) {
                if (st.ghost) st.ghost.remove();
                if (st.caret) st.caret.remove();
                st.el.classList.remove('mam-drag-src');
            }
            document.documentElement.classList.remove('mam-grabbing');
            st = null;
        };

        const startDrag = () => {
            const rect = st.el.getBoundingClientRect();
            st.offX = st.sx - rect.left;
            st.offY = st.sy - rect.top;
            st.before = snap();
            st.rects = cacheDragRects(box, st.el); // ghost/caret을 붙이기 전에 읽기

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
            document.documentElement.classList.add('mam-grabbing');
            document.addEventListener('scroll', onScroll, true);
        };

        // 프레임당 한 번만: 읽기(캐시 갱신이 필요할 때만) → 쓰기 순서
        const tick = () => {
            rafId = 0;
            if (!st || !st.dragging) return;
            const rects = getRects();
            st.ghost.style.transform = `translate(${st.px - st.offX}px, ${st.py - st.offY}px)`;
            st.target = pvDropTarget(st.px, st.py, rects);
            if (st.target) placeCaret(st.caret, rects.box, st.target);
        };

        function onMove(e) {
            if (!st || e.pointerId !== st.id) return;
            if (!st.dragging) {
                if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < 4) return;
                startDrag();
            }
            st.px = e.clientX;
            st.py = e.clientY;
            if (!rafId) rafId = requestAnimationFrame(tick);
        }

        function onUp(e) {
            if (!st || e.pointerId !== st.id) return;
            const { el, dragging, before } = st;
            let changed = false;
            if (dragging && el.isConnected) {
                const target = pvDropTarget(e.clientX, e.clientY, getRects());
                if (target) {
                    const { zone, ref, after } = target;
                    if (!ref) zone.appendChild(el);
                    else if (after) ref.after(el);
                    else ref.before(el);
                    changed = snap() !== before;
                }
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
            st = { el, id: e.pointerId, sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY, dragging: false, ghost: null, caret: null, target: null, rects: null, stale: false };
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

        const keep = (k) => hidden.has(k) || !isLive(s, k);

        const oldG1 = [...s.g1];
        const oldG2 = [...s.g2];
        s.g1 = mergeKeep(oldG1, read('#mam_pv1'), keep);
        s.g2 = mergeKeep(oldG2, read('#mam_pv2'), keep);
        save();
        applyAll();
        // 프리뷰는 이미 사용자가 놓은 상태 그대로라서 다시 그리지 않고(끊김 방지), 아래 목록만 갱신
        setTimeout(renderLists, 0);
    }

    function commitOrder() {
        const s = settings();
        const rows = (sel) => $(`${sel} .mam-row`).map((_, el) => $(el).attr('data-key')).get();
        const dormant = (k) => !isLive(s, k);
        s.g1 = mergeKeep(s.g1, rows('#mam_g1'), dormant);
        s.g2 = mergeKeep(s.g2, rows('#mam_g2'), dormant);
        save();
        applyAll();
        renderPreview();
    }

    function makeRow(key, info, hidden, s) {
        const row = $('<div class="mam-row">').attr('data-key', key);
        row.toggleClass('mam-off', hidden.has(key));

        // 쌍(hide/unhide 등)이면 멤버 아이콘을 모두 표시
        const members = (PAIRS[key] || []).filter((m) => s.known[m]);
        const isSet = members.length > 1;

        const handle = $('<i class="fa-solid fa-grip-vertical mam-handle"></i>');
        const icon = $('<span class="mam-icon">');
        const name = $('<span class="mam-name">');
        if (isSet) {
            icon.addClass('mam-icon-set').html(members.map((m) => iconHtml(s.known[m].html)).join(''));
            name.append($('<span>').text(members.map((m) => s.known[m].label).join(' / ')));
            name.append($('<small>').text(members.join(' + ')));
        } else {
            icon.html(iconHtml(info.html));
            name.append($('<span>').text(info.label));
            name.append($('<small>').text(key));
        }

        const toggle = $('<label class="mam-switch" title="Show">');
        const cb = $('<input type="checkbox" aria-label="Show">').prop('checked', !hidden.has(key));
        toggle.append(cb, $('<span class="mam-slider">'));

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

        row.append(handle, icon, name, toggle);

        return row;
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
                if (s.known[key] && isLive(s, key)) list.append(makeRow(key, s.known[key], hidden, s));
            }
        }

        // 삭제·비활성화된 확장의 버튼은 목록에서 자동으로 숨김 (기록은 유지 → 다시 켜면 원래 자리로 복귀)
        const dormant = [...s.g1, ...s.g2].filter((k) => s.known[k] && !isLive(s, k));
        $('#mam_dormant')
            .toggle(dormant.length > 0)
            .text(`${dormant.length} undetected item(s) (uninstalled/disabled extensions) hidden. They return to their original spot when the extension is re-enabled. Use 'Clean Up' to delete their records.`);

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

    function init() {
        migrate();
        applyBodyFlags();
        buildUI();

        // 편집 메뉴에서 빼낸 독립 아이콘
        const runExt = (el) => {
            const mes = el.closest('.mes');
            if (mes && el.dataset.mamNative) runEditAction(mes, el.dataset.mamNative);
        };
        $(document).on('click', '.mes_buttons .mam-x', function (e) { e.stopPropagation(); runExt(this); });
        $(document).on('keydown', '.mes_buttons .mam-x', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            runExt(this);
        });

        // 헤더의 … 버튼: 그룹2 펼치기 (클릭 / Enter / Space)
        const openMore = (el) => $(el).closest('.mes_buttons').addClass('mam-more-open');
        $(document).on('click', '.mam-more-toggle', function () { openMore(this); });
        $(document).on('keydown', '.mam-more-toggle', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            openMore(this);
        });

        // 메시지 액션 영역 밖을 클릭하면 펼친 그룹2를 다시 닫기
        $(document).on('click', (e) => {
            $('#chat .mes_buttons.mam-more-open').each(function () {
                if (!this.contains(e.target)) this.classList.remove('mam-more-open');
            });
        });

        const chat = document.getElementById('chat');
        const tpl = document.getElementById('message_template');
        if (chat) observer.observe(chat, { childList: true, subtree: true });
        if (tpl) observer.observe(tpl, { childList: true, subtree: true });

        document.querySelectorAll('#chat .mes').forEach((m) => pending.add(m));
        flush();
    }

    jQuery(() => {
        try {
            init();
        } catch (err) {
            console.error(`[${TITLE}] failed to start`, err);
            rollback();
            toastr.error('Failed to start. Message icons were left as they are. See the browser console.', TITLE);
        }
    });
})();
