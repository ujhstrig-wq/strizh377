// Chat Folders by Persona — расширение для SillyTavern
// Структура: Папка бота -> Папки персон -> Чаты этой персоны с этим ботом.

const MODULE = 'chatFoldersByPersona';
const NO_PERSONA = '__none__';
const NO_PERSONA_LABEL = 'Без персоны';
const POOL_SIZE = 4;

const DEFAULTS = Object.freeze({
    switchPersona: true,
    cache: {},
});

const getContext = () => SillyTavern.getContext();

/* ───────────────────────── Настройки ───────────────────────── */

function getSettings() {
    const { extensionSettings } = getContext();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(DEFAULTS);
    }
    for (const key of Object.keys(DEFAULTS)) {
        if (!(key in extensionSettings[MODULE])) {
            extensionSettings[MODULE][key] = structuredClone(DEFAULTS[key]);
        }
    }
    return extensionSettings[MODULE];
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

/* ───────────────────────── Состояние ───────────────────────── */

const state = {
    open: false,
    query: '',
    expandedChars: new Set(),
    expandedPersonas: new Set(),
    data: new Map(),      // avatar -> { status, chats, done, total, error }
    inflight: new Map(),  // avatar -> Promise
};

/* ───────────────────────── Утилиты ───────────────────────── */

function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === false || v == null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c != null && c !== false) el.append(c);
    }
    return el;
}

const stripExt = (name) => String(name).replace(/\.jsonl$/i, '');

function toTs(v) {
    if (typeof v === 'number') return v;
    if (v == null || v === '') return 0;
    const n = Number(v);
    if (!Number.isNaN(n) && String(v).trim() !== '') return n;
    const p = Date.parse(v);
    if (!Number.isNaN(p)) return p;
    try {
        const m = getContext().timestampToMoment?.(v);
        if (m?.isValid()) return m.valueOf();
    } catch { /* ignore */ }
    return 0;
}

function formatDate(ts, raw) {
    if (ts) {
        try {
            return new Date(ts).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
        } catch { /* ignore */ }
    }
    return raw ? String(raw) : '';
}

/** Берёт функцию из контекста ST, а если её там нет — из script.js */
async function getStFn(name) {
    const ctx = getContext();
    if (typeof ctx[name] === 'function') return ctx[name];
    try {
        const mod = await import('../../../../script.js');
        if (typeof mod[name] === 'function') return mod[name];
    } catch (e) {
        console.warn(`[${MODULE}] не удалось импортировать ${name}`, e);
    }
    return null;
}

function currentCharacter() {
    const ctx = getContext();
    if (ctx.groupId) return null;
    const id = ctx.characterId;
    if (id === undefined || id === null) return null;
    return ctx.characters[id] ?? null;
}

function personaAvatarMap() {
    return getContext().powerUserSettings?.personas ?? {};
}

function personaAvatarUrl(name) {
    const personas = personaAvatarMap();
    const id = Object.keys(personas).find((k) => personas[k] === name);
    return id ? `/thumbnail?type=persona&file=${encodeURIComponent(id)}` : null;
}

/* ───────────────────────── Определение персоны ───────────────────────── */

/**
 * Читает чат и определяет, какая персона в нём писала.
 * Берётся имя, которое встречается чаще всего среди сообщений пользователя.
 */
async function detectPersona(character, chat) {
    const ctx = getContext();
    const res = await fetch('/api/chats/get', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
            ch_name: character.name,
            file_name: chat.title,
            avatar_url: character.avatar,
        }),
        cache: 'no-cache',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data)) return '';

    const counts = new Map();
    for (const msg of data) {
        if (msg && msg.is_user === true && typeof msg.name === 'string' && msg.name.trim()) {
            counts.set(msg.name, (counts.get(msg.name) ?? 0) + 1);
        }
    }

    if (counts.size) {
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }

    const headerName = data[0]?.user_name;
    if (typeof headerName === 'string' && headerName && headerName !== 'unused') {
        return headerName;
    }
    return '';
}

/* ───────────────────────── Загрузка чатов бота ───────────────────────── */

function loadCharacterChats(character, force = false) {
    const avatar = character.avatar;
    if (!force && state.inflight.has(avatar)) return state.inflight.get(avatar);

    const p = (async () => {
        const ctx = getContext();
        const entry = { status: 'loading', chats: [], done: 0, total: 0, error: null };
        state.data.set(avatar, entry);
        render();

        try {
            const res = await fetch('/api/characters/chats', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const raw = await res.json();
            const list = Object.values(raw || {}).filter((x) => x && x.file_name);

            const cache = getSettings().cache;
            const keyOf = (c) => `${avatar}/${c.file}`;

            const chats = list.map((c) => ({
                file: c.file_name,
                title: stripExt(c.file_name),
                items: c.chat_items,
                size: c.file_size,
                last: c.last_mes,
                ts: toTs(c.last_mes),
                preview: typeof c.mes === 'string' ? c.mes : '',
                persona: null,
                resolved: false,
            }));

            // Берём персоны из кэша, если чат не менялся
            for (const chat of chats) {
                const hit = cache[keyOf(chat)];
                if (!force && hit && hit.items === chat.items && String(hit.last) === String(chat.last)) {
                    chat.persona = hit.persona || null;
                    chat.resolved = true;
                }
            }

            // Чистим устаревшие записи кэша этого бота
            const alive = new Set(chats.map(keyOf));
            for (const k of Object.keys(cache)) {
                if (k.startsWith(`${avatar}/`) && !alive.has(k)) delete cache[k];
            }

            entry.chats = chats;
            const todo = chats.filter((c) => !c.resolved);
            entry.total = todo.length;
            if (!todo.length) entry.status = 'ready';
            render();

            // Пул параллельных запросов
            let idx = 0;
            const worker = async () => {
                while (idx < todo.length) {
                    const chat = todo[idx++];
                    try {
                        const persona = await detectPersona(character, chat);
                        chat.persona = persona || null;
                        chat.resolved = true;
                        cache[keyOf(chat)] = { persona: persona || '', items: chat.items, last: chat.last };
                    } catch (e) {
                        console.warn(`[${MODULE}] не удалось прочитать чат ${chat.file}`, e);
                    }
                    entry.done++;
                    render();
                }
            };
            await Promise.all(Array.from({ length: Math.min(POOL_SIZE, todo.length) }, worker));

            entry.status = 'ready';
            saveSettings();
        } catch (e) {
            console.error(`[${MODULE}]`, e);
            const entry = state.data.get(avatar);
            if (entry) {
                entry.status = 'error';
                entry.error = String(e?.message ?? e);
            }
        } finally {
            state.inflight.delete(avatar);
            render();
        }
    })();

    state.inflight.set(avatar, p);
    return p;
}

/* ───────────────────────── Открытие чата ───────────────────────── */

async function selectCharacter(chid) {
    const select = await getStFn('selectCharacterById');
    if (select) {
        await select(chid, { switchMenu: false });
        return;
    }
    const node = document.querySelector(`#rm_print_characters_block .character_select[chid="${chid}"]`);
    if (node) {
        node.click();
        await new Promise((r) => setTimeout(r, 800));
        return;
    }
    throw new Error('Не удалось выбрать персонажа');
}

async function switchPersona(name) {
    if (!name) return false;
    const personas = personaAvatarMap();
    const avatarId = Object.keys(personas).find((k) => personas[k] === name);
    if (!avatarId) return false;

    const node = document.querySelector(`#user_avatar_block .avatar-container[imgfile="${CSS.escape(avatarId)}"]`);
    if (node) {
        node.click();
        return true;
    }

    for (const path of ['../../../personas.js', '../../../persona-management.js']) {
        try {
            const mod = await import(path);
            if (typeof mod.setUserAvatar === 'function') {
                await mod.setUserAvatar(avatarId);
                return true;
            }
        } catch { /* пробуем следующий путь */ }
    }
    return false;
}

async function openChat(character, chat) {
    try {
        let ctx = getContext();
        const chid = ctx.characters.findIndex((c) => c.avatar === character.avatar);
        if (chid < 0) throw new Error('Бот не найден');

        const sameCharacter = !ctx.groupId && String(ctx.characterId) === String(chid);

        if (!sameCharacter) {
            await selectCharacter(chid);
        }

        ctx = getContext();
        if (!(sameCharacter && ctx.chatId === chat.title)) {
            const openCharacterChat = await getStFn('openCharacterChat');
            if (!openCharacterChat) throw new Error('Функция openCharacterChat недоступна');
            await openCharacterChat(chat.title);
        }

        closePanel();

        if (getSettings().switchPersona && chat.persona) {
            const ok = await switchPersona(chat.persona);
            if (!ok) toastr.info(`Переключите персону вручную: ${chat.persona}`, 'Папки чатов');
        }
    } catch (e) {
        console.error(`[${MODULE}]`, e);
        toastr.error(String(e?.message ?? e), 'Папки чатов');
    }
}

/* ───────────────────────── Отрисовка ───────────────────────── */

function toggleChar(character) {
    const key = character.avatar;
    if (state.expandedChars.has(key)) {
        state.expandedChars.delete(key);
    } else {
        state.expandedChars.add(key);
        if (!state.data.has(key)) loadCharacterChats(character);
    }
    render();
}

function togglePersona(key) {
    if (state.expandedPersonas.has(key)) state.expandedPersonas.delete(key);
    else state.expandedPersonas.add(key);
    render();
}

function charMatches(ch, q) {
    if (!q) return true;
    if ((ch.name ?? '').toLowerCase().includes(q)) return true;
    const d = state.data.get(ch.avatar);
    return !!d?.chats?.some((c) =>
        (c.persona ?? '').toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
}

function groupByPersona(chats) {
    const groups = new Map();
    for (const chat of chats) {
        const key = chat.persona || NO_PERSONA;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(chat);
    }
    for (const arr of groups.values()) arr.sort((a, b) => b.ts - a.ts);

    return [...groups.entries()].sort((a, b) => {
        if (a[0] === NO_PERSONA) return 1;
        if (b[0] === NO_PERSONA) return -1;
        return Math.max(...b[1].map((c) => c.ts)) - Math.max(...a[1].map((c) => c.ts));
    });
}

function renderChatRow(character, chat) {
    const ctx = getContext();
    const cur = currentCharacter();
    const isCurrent = cur?.avatar === character.avatar && ctx.chatId === chat.title;

    return h('div', {
        class: 'cfp_row cfp_chat' + (isCurrent ? ' current' : ''),
        title: chat.title,
        onclick: () => openChat(character, chat),
    },
        h('i', { class: 'fa-regular fa-comments cfp_chat_icon' }),
        h('div', { class: 'cfp_chat_body' },
            h('div', { class: 'cfp_chat_title', text: chat.title }),
            h('div', {
                class: 'cfp_chat_meta',
                text: [
                    chat.items != null ? `${chat.items} сообщ.` : null,
                    chat.size || null,
                    formatDate(chat.ts, chat.last) || null,
                ].filter(Boolean).join(' · '),
            }),
            chat.preview ? h('div', { class: 'cfp_chat_preview', text: chat.preview }) : null,
        ),
    );
}

function renderPersonaFolder(character, personaKey, chats) {
    const key = `${character.avatar}|${personaKey}`;
    const open = state.expandedPersonas.has(key);
    const isNone = personaKey === NO_PERSONA;
    const label = isNone ? NO_PERSONA_LABEL : personaKey;
    const ava = isNone ? null : personaAvatarUrl(personaKey);

    return h('div', { class: 'cfp_folder cfp_persona' + (open ? ' open' : '') },
        h('div', { class: 'cfp_row cfp_persona_head', onclick: () => togglePersona(key) },
            h('i', { class: 'cfp_caret fa-solid fa-chevron-right' }),
            ava
                ? h('img', { class: 'cfp_ava cfp_ava_small', src: ava, loading: 'lazy', alt: '' })
                : h('i', { class: `cfp_folder_icon fa-solid ${open ? 'fa-folder-open' : 'fa-folder'}` }),
            h('span', { class: 'cfp_name', text: label }),
            h('span', { class: 'cfp_badge', text: String(chats.length) }),
        ),
        open ? h('div', { class: 'cfp_children' }, chats.map((c) => renderChatRow(character, c))) : null,
    );
}

function renderCharacter(character) {
    const open = state.expandedChars.has(character.avatar);
    const d = state.data.get(character.avatar);
    const count = d?.status === 'ready' ? d.chats.length : null;

    let body = null;
    if (open) {
        if (!d || d.status === 'loading') {
            const progress = d?.total ? ` Определяю персоны: ${d.done}/${d.total}` : '';
            body = h('div', { class: 'cfp_info' },
                h('i', { class: 'fa-solid fa-spinner fa-spin' }),
                ` Загрузка…${progress}`,
            );
            // Пока идёт определение персон — показываем уже готовые папки
            if (d?.chats?.some((c) => c.resolved)) {
                const ready = d.chats.filter((c) => c.resolved);
                body = h('div', { class: 'cfp_children' },
                    body,
                    groupByPersona(ready).map(([k, arr]) => renderPersonaFolder(character, k, arr)),
                );
            } else {
                body = h('div', { class: 'cfp_children' }, body);
            }
        } else if (d.status === 'error') {
            body = h('div', { class: 'cfp_children' },
                h('div', { class: 'cfp_info cfp_error', text: `Ошибка: ${d.error}` }));
        } else if (!d.chats.length) {
            body = h('div', { class: 'cfp_children' }, h('div', { class: 'cfp_info', text: 'Чатов нет' }));
        } else {
            body = h('div', { class: 'cfp_children' },
                groupByPersona(d.chats).map(([k, arr]) => renderPersonaFolder(character, k, arr)));
        }
    }

    return h('div', { class: 'cfp_folder cfp_char' + (open ? ' open' : '') },
        h('div', { class: 'cfp_row cfp_char_head', onclick: () => toggleChar(character) },
            h('i', { class: 'cfp_caret fa-solid fa-chevron-right' }),
            h('img', {
                class: 'cfp_ava',
                src: `/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`,
                loading: 'lazy',
                alt: '',
            }),
            h('span', { class: 'cfp_name', text: character.name }),
            count !== null ? h('span', { class: 'cfp_badge', text: String(count) }) : null,
            open
                ? h('i', {
                    class: 'cfp_refresh fa-solid fa-rotate',
                    title: 'Обновить',
                    onclick: (e) => {
                        e.stopPropagation();
                        loadCharacterChats(character, true);
                    },
                })
                : null,
        ),
        body,
    );
}

function render() {
    if (!state.open) return;
    const list = document.getElementById('cfp_list');
    if (!list) return;

    const q = state.query.trim().toLowerCase();
    const ctx = getContext();

    const chars = ctx.characters
        .filter((c) => c && c.avatar && charMatches(c, q))
        .sort((a, b) => (Number(b.date_last_chat) || 0) - (Number(a.date_last_chat) || 0)
            || String(a.name).localeCompare(String(b.name)));

    const scroll = list.scrollTop;
    list.replaceChildren(
        ...(chars.length
            ? chars.map(renderCharacter)
            : [h('div', { class: 'cfp_info', text: 'Ничего не найдено' })]),
    );
    list.scrollTop = scroll;
}

/* ───────────────────────── Панель ───────────────────────── */

function openPanel() {
    if (state.open) return;
    state.open = true;

    const overlay = h('div', {
        id: 'cfp_overlay',
        onclick: (e) => { if (e.target.id === 'cfp_overlay') closePanel(); },
    },
        h('div', { id: 'cfp_panel' },
            h('div', { class: 'cfp_header' },
                h('div', { class: 'cfp_title' },
                    h('i', { class: 'fa-solid fa-folder-tree' }),
                    h('span', { text: ' Папки чатов' }),
                ),
                h('input', {
                    id: 'cfp_search',
                    class: 'text_pole',
                    type: 'search',
                    placeholder: 'Поиск бота, персоны или чата…',
                    oninput: (e) => { state.query = e.target.value; render(); },
                }),
                h('div', {
                    class: 'menu_button cfp_close',
                    title: 'Закрыть',
                    onclick: closePanel,
                }, h('i', { class: 'fa-solid fa-xmark' })),
            ),
            h('div', { id: 'cfp_list' }),
        ),
    );
    document.body.append(overlay);
    document.addEventListener('keydown', onKeyDown);

    // Автоматически раскрываем текущего бота и папку персоны текущего чата
    const cur = currentCharacter();
    if (cur) {
        state.expandedChars.add(cur.avatar);
        loadCharacterChats(cur).then(() => {
            const chatId = getContext().chatId;
            const chat = state.data.get(cur.avatar)?.chats?.find((c) => c.title === chatId);
            if (chat) {
                state.expandedPersonas.add(`${cur.avatar}|${chat.persona || NO_PERSONA}`);
                render();
            }
        });
    }

    render();
    document.getElementById('cfp_search')?.focus();
}

function closePanel() {
    state.open = false;
    state.query = '';
    document.getElementById('cfp_overlay')?.remove();
    document.removeEventListener('keydown', onKeyDown);
}

function onKeyDown(e) {
    if (e.key === 'Escape') closePanel();
}

/* ───────────────────────── Инициализация ───────────────────────── */

function addUi() {
    // Пункт в меню «волшебной палочки»
    if (!document.getElementById('cfp_menu_item') && document.getElementById('extensionsMenu')) {
        $('#extensionsMenu').append(`
            <div id="cfp_menu_item" class="list-group-item flex-container flexGap5" title="Чаты по папкам: бот → персона → чаты">
                <div class="fa-solid fa-folder-tree extensionsMenuExtensionButton"></div>
                Папки чатов
            </div>`);
        $('#cfp_menu_item').on('click', openPanel);
    }

    // Пункт в меню опций (рядом с «Управление файлами чата»)
    if (!document.getElementById('option_chat_folders') && document.getElementById('option_select_chat')) {
        $('#option_select_chat').after(`
            <a id="option_chat_folders">
                <i class="fa-lg fa-solid fa-folder-tree"></i>
                <span>Папки чатов</span>
            </a>`);
        $('#option_chat_folders').on('click', openPanel);
    }

    // Блок настроек в расширениях
    if (!document.getElementById('cfp_settings')) {
        const settings = getSettings();
        $('#extensions_settings2').append(`
            <div id="cfp_settings" class="extension_container">
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>Папки чатов по персонам</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <label class="checkbox_label" for="cfp_switch_persona">
                            <input type="checkbox" id="cfp_switch_persona" ${settings.switchPersona ? 'checked' : ''}>
                            <span>Переключать персону при открытии чата</span>
                        </label>
                        <div class="flex-container">
                            <div id="cfp_open_btn" class="menu_button menu_button_icon">
                                <i class="fa-solid fa-folder-tree"></i><span>Открыть папки</span>
                            </div>
                            <div id="cfp_clear_cache" class="menu_button menu_button_icon">
                                <i class="fa-solid fa-trash-can"></i><span>Сбросить кэш персон</span>
                            </div>
                        </div>
                        <small>Персона чата определяется по именам в ваших сообщениях. Результат кэшируется.</small>
                    </div>
                </div>
            </div>`);

        $('#cfp_switch_persona').on('change', function () {
            getSettings().switchPersona = this.checked;
            saveSettings();
        });
        $('#cfp_open_btn').on('click', openPanel);
        $('#cfp_clear_cache').on('click', () => {
            getSettings().cache = {};
            state.data.clear();
            saveSettings();
            render();
            toastr.success('Кэш персон очищен', 'Папки чатов');
        });
    }
}

jQuery(() => {
    try {
        getSettings();
        addUi();
        console.log(`[${MODULE}] загружено`);
    } catch (e) {
        console.error(`[${MODULE}] ошибка инициализации`, e);
    }
});
