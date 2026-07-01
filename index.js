const EXTENSION_NAME = 'sillytavern-s2t-converter';
const SETTINGS_KEY = 's2tConverter';
const DEFAULT_CDN_URL = 'https://cdn.jsdelivr.net/npm/opencc-js@1.3.2-next.0/dist/esm/full.js';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    convertIncoming: true,
    convertOutgoing: false,
    convertEdits: true,
    convertReasoning: false,
    convertStreaming: true,
    convertDisplayText: true,
    convertQuotes: true,
    preserveMarkdownCode: true,
    writeMode: 'display',
    streamingUpdateInterval: 250,
    target: 'tw',
    cdnUrl: DEFAULT_CDN_URL,
});

const TARGET_LABELS = Object.freeze({
    t: '繁體',
    tw: '台灣繁體',
    twp: '台灣用語',
    hk: '香港繁體',
});

let converterPromise = null;
let converterSignature = '';
let conversionQueue = Promise.resolve();
const streamingState = {
    active: false,
    type: '',
    messageId: null,
    pending: false,
    inFlight: false,
    timer: null,
};

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function getSettings() {
    const context = getContext();
    if (!context?.extensionSettings) {
        return { ...DEFAULT_SETTINGS };
    }

    if (!context.extensionSettings[SETTINGS_KEY]) {
        context.extensionSettings[SETTINGS_KEY] = {};
    }

    const settings = context.extensionSettings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = value;
        }
    }

    return settings;
}

function saveSettings() {
    getContext()?.saveSettingsDebounced?.();
}

function resetConverter() {
    converterPromise = null;
    converterSignature = '';
}

async function getConverter() {
    const settings = getSettings();
    const cdnUrl = String(settings.cdnUrl || DEFAULT_CDN_URL).trim();
    const target = String(settings.target || DEFAULT_SETTINGS.target);
    const signature = `${cdnUrl}|${target}`;

    if (converterPromise && converterSignature === signature) {
        return converterPromise;
    }

    converterSignature = signature;
    converterPromise = import(cdnUrl)
        .then((module) => {
            const OpenCC = module.default || module;
            if (typeof OpenCC?.Converter !== 'function') {
                throw new Error('OpenCC module does not expose Converter().');
            }
            return OpenCC.Converter({ from: 'cn', to: target });
        })
        .catch((error) => {
            resetConverter();
            throw error;
        });

    return converterPromise;
}

function applyQuoteStyle(text) {
    return text
        .replace(/“([^”\n]*)”/g, '「$1」')
        .replace(/‘([^’\n]*)’/g, '『$1』');
}

async function convertPlainText(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return text;
    }

    const converter = await getConverter();
    let converted = converter(text);

    if (getSettings().convertQuotes) {
        converted = applyQuoteStyle(converted);
    }

    return converted;
}

function splitProtectedSegments(segments, pattern) {
    const nextSegments = [];

    for (const segment of segments) {
        if (segment.protected) {
            nextSegments.push(segment);
            continue;
        }

        let lastIndex = 0;
        for (const match of segment.text.matchAll(pattern)) {
            if (match.index > lastIndex) {
                nextSegments.push({ text: segment.text.slice(lastIndex, match.index), protected: false });
            }

            nextSegments.push({ text: match[0], protected: true });
            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < segment.text.length) {
            nextSegments.push({ text: segment.text.slice(lastIndex), protected: false });
        }
    }

    return nextSegments;
}

function getProtectedSegments(text) {
    const settings = getSettings();
    let segments = [{ text, protected: false }];

    if (settings.preserveMarkdownCode) {
        segments = splitProtectedSegments(segments, /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
    }

    segments = splitProtectedSegments(segments, /{{[\s\S]*?}}/g);
    segments = splitProtectedSegments(segments, /^[ \t]*\/[^\r\n]*(?:\r?\n|$)/gm);
    segments = splitProtectedSegments(segments, /<\/?[A-Z][A-Z0-9_:-]*>/g);

    return segments;
}

async function convertMarkdownText(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return text;
    }

    const convertedParts = [];
    for (const part of getProtectedSegments(text)) {
        convertedParts.push(part.protected ? part.text : await convertPlainText(part.text));
    }

    return convertedParts.join('');
}

function shouldConvertMessage(message, mode) {
    const settings = getSettings();
    if (!settings.enabled || !message || message.is_system) {
        return false;
    }

    if (mode === 'incoming') {
        return !message.is_user && settings.convertIncoming;
    }

    if (mode === 'outgoing') {
        return !!message.is_user && settings.convertOutgoing;
    }

    return message.is_user ? settings.convertOutgoing : settings.convertIncoming;
}

function getMessageSourceText(message) {
    if (!message) {
        return '';
    }

    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && typeof message.swipes[message.swipe_id] === 'string') {
        return message.swipes[message.swipe_id];
    }

    return typeof message.mes === 'string' ? message.mes : '';
}

function ensureMessageExtra(message) {
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }

    return message.extra;
}

async function setDisplayTextFromSource(message, sourceText, targetKey) {
    const extra = ensureMessageExtra(message);

    if (typeof sourceText !== 'string' || sourceText.length === 0) {
        if (Object.hasOwn(extra, targetKey)) {
            delete extra[targetKey];
            return true;
        }

        return false;
    }

    const converted = await convertMarkdownText(sourceText);

    if (converted === sourceText) {
        if (Object.hasOwn(extra, targetKey)) {
            delete extra[targetKey];
            return true;
        }

        return false;
    }

    if (extra[targetKey] === converted) {
        return false;
    }

    extra[targetKey] = converted;
    return true;
}

async function convertMessage(message) {
    const settings = getSettings();
    let changed = false;

    changed = await setDisplayTextFromSource(message, getMessageSourceText(message), 'display_text') || changed;

    if (settings.convertReasoning) {
        const reasoning = typeof message.extra?.reasoning === 'string' ? message.extra.reasoning : '';
        if (reasoning) {
            changed = await setDisplayTextFromSource(message, reasoning, 'reasoning_display_text') || changed;
        }
    }

    return changed;
}

function updateRenderedMessage(context, id, message) {
    if (typeof document === 'undefined' || typeof context.updateMessageBlock !== 'function') {
        return;
    }

    const messageElement = document.querySelector(`.mes[mesid="${id}"]`);
    if (!messageElement) {
        return;
    }

    try {
        context.updateMessageBlock(id, message);
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] failed to update rendered message`, error);
    }
}

function clearStreamingTimer() {
    if (streamingState.timer) {
        clearTimeout(streamingState.timer);
        streamingState.timer = null;
    }
}

function startStreamingPreview(type) {
    const settings = getSettings();
    clearStreamingTimer();
    streamingState.active = settings.enabled && settings.convertStreaming && type !== 'quiet' && type !== 'impersonate';
    streamingState.type = String(type || '');
    streamingState.messageId = null;
    streamingState.pending = false;
    streamingState.inFlight = false;
}

function stopStreamingPreview() {
    clearStreamingTimer();
    streamingState.active = false;
    streamingState.type = '';
    streamingState.messageId = null;
    streamingState.pending = false;
    streamingState.inFlight = false;
}

function findStreamingMessageId(context) {
    if (!context?.chat?.length) {
        return null;
    }

    if (Number.isInteger(streamingState.messageId)) {
        const message = context.chat[streamingState.messageId];
        if (message && !message.is_user && !message.is_system) {
            return streamingState.messageId;
        }
    }

    for (let index = context.chat.length - 1; index >= 0; index -= 1) {
        const message = context.chat[index];
        if (message && !message.is_user && !message.is_system) {
            streamingState.messageId = index;
            return index;
        }
    }

    return null;
}

async function renderStreamingPreview() {
    const context = getContext();
    const id = findStreamingMessageId(context);
    if (!Number.isInteger(id)) {
        return false;
    }

    const message = context.chat[id];
    if (!shouldConvertMessage(message, 'incoming')) {
        return false;
    }

    const changed = await convertMessage(message);
    updateRenderedMessage(context, id, message);
    return changed;
}

function scheduleStreamingPreview(delay = Number(getSettings().streamingUpdateInterval) || 250) {
    if (!streamingState.active || !getSettings().enabled || !getSettings().convertStreaming) {
        return;
    }

    streamingState.pending = true;
    if (streamingState.timer || streamingState.inFlight) {
        return;
    }

    const interval = Math.max(80, Number(delay) || 250);
    streamingState.timer = setTimeout(async () => {
        streamingState.timer = null;
        if (!streamingState.active) {
            streamingState.pending = false;
            return;
        }

        streamingState.inFlight = true;
        streamingState.pending = false;
        try {
            await renderStreamingPreview();
        } catch (error) {
            console.warn(`[${EXTENSION_NAME}] streaming preview failed`, error);
        } finally {
            streamingState.inFlight = false;
            if (streamingState.pending && streamingState.active) {
                scheduleStreamingPreview();
            }
        }
    }, interval);
}

async function flushStreamingPreview() {
    if (!streamingState.active) {
        return;
    }

    clearStreamingTimer();
    try {
        await renderStreamingPreview();
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] streaming preview flush failed`, error);
    } finally {
        stopStreamingPreview();
    }
}

async function convertMessageById(messageId, mode, { updateBlock = false } = {}) {
    const context = getContext();
    const id = Number(messageId);
    const message = context?.chat?.[id];

    if (!shouldConvertMessage(message, mode)) {
        return false;
    }

    const changed = await convertMessage(message);
    if (!changed) {
        return false;
    }

    await context.saveChat?.();
    if (updateBlock) {
        updateRenderedMessage(context, id, message);
    }

    return true;
}

function enqueueConversion(task) {
    conversionQueue = conversionQueue
        .then(task)
        .catch((error) => {
            console.error(`[${EXTENSION_NAME}] conversion failed`, error);
            globalThis.toastr?.error(error.message || String(error), '簡體轉繁體失敗');
        });

    return conversionQueue;
}

async function convertCurrentChat() {
    const context = getContext();
    if (!context?.chat) {
        return;
    }

    setBusy(true);
    try {
        let changedCount = 0;
        for (const message of context.chat) {
            if (!shouldConvertMessage(message, 'any')) {
                continue;
            }
            if (await convertMessage(message)) {
                changedCount += 1;
            }
        }

        if (changedCount > 0) {
            await context.saveChat?.();
            await context.reloadCurrentChat?.();
        }

        globalThis.toastr?.success(`已轉換 ${changedCount} 則訊息。`, '簡體轉繁體');
    } finally {
        setBusy(false);
    }
}

async function convertInputBox() {
    const input = document.querySelector('#send_textarea');
    if (!input || typeof input.value !== 'string' || input.value.length === 0) {
        return;
    }

    setBusy(true);
    try {
        input.value = await convertMarkdownText(input.value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
        setBusy(false);
    }
}

async function testConverter() {
    setBusy(true);
    try {
        const result = await convertMarkdownText('汉语、后台服务器，以及“测试文本”。{{setvar::好感度::喜欢}}');
        globalThis.toastr?.success(result, 'OpenCC 測試');
    } finally {
        setBusy(false);
    }
}

function setBusy(isBusy) {
    document.querySelectorAll('#s2t_converter_settings button, #s2t_converter_settings input, #s2t_converter_settings select')
        .forEach((element) => {
            element.disabled = !!isBusy;
        });
}

function bindCheckbox(id, key) {
    const element = document.getElementById(id);
    if (!element) {
        return;
    }

    element.checked = !!getSettings()[key];
    element.addEventListener('input', () => {
        getSettings()[key] = !!element.checked;
        saveSettings();
    });
}

function bindSelect(id, key) {
    const element = document.getElementById(id);
    if (!element) {
        return;
    }

    element.value = String(getSettings()[key] || DEFAULT_SETTINGS[key]);
    element.addEventListener('change', () => {
        getSettings()[key] = element.value;
        resetConverter();
        saveSettings();
    });
}

function bindTextInput(id, key) {
    const element = document.getElementById(id);
    if (!element) {
        return;
    }

    element.value = String(getSettings()[key] || DEFAULT_SETTINGS[key]);
    element.addEventListener('change', () => {
        getSettings()[key] = String(element.value || DEFAULT_SETTINGS[key]).trim();
        resetConverter();
        saveSettings();
    });
}

function createSettingsPanel() {
    if (document.getElementById('s2t_converter_settings')) {
        return true;
    }

    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!container) {
        return false;
    }

    const panel = document.createElement('div');
    panel.id = 's2t_converter_settings';
    panel.className = 's2t-converter extension_container';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>簡體轉繁體</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="s2t-grid">
                    <label class="checkbox_label" for="s2t_enabled">
                        <input id="s2t_enabled" type="checkbox">
                        <span>啟用自動轉換</span>
                    </label>
                    <label class="checkbox_label" for="s2t_incoming">
                        <input id="s2t_incoming" type="checkbox">
                        <span>轉換角色回覆</span>
                    </label>
                    <label class="checkbox_label" for="s2t_outgoing">
                        <input id="s2t_outgoing" type="checkbox">
                        <span>轉換使用者訊息</span>
                    </label>
                    <label class="checkbox_label" for="s2t_edits">
                        <input id="s2t_edits" type="checkbox">
                        <span>轉換編輯後訊息</span>
                    </label>
                    <label class="checkbox_label" for="s2t_reasoning">
                        <input id="s2t_reasoning" type="checkbox">
                        <span>轉換 reasoning 內容</span>
                    </label>
                    <label class="checkbox_label" for="s2t_streaming">
                        <input id="s2t_streaming" type="checkbox">
                        <span>生成中即時顯示繁體</span>
                    </label>
                    <label class="checkbox_label" for="s2t_quotes">
                        <input id="s2t_quotes" type="checkbox">
                        <span>中文引號</span>
                    </label>
                    <label class="checkbox_label" for="s2t_preserve_code">
                        <input id="s2t_preserve_code" type="checkbox">
                        <span>保留 Markdown 程式碼</span>
                    </label>
                </div>
                <div class="s2t-note">
                    顯示繁體，不改原文。角色卡變量、巨集與指令會保留原樣。
                </div>
                <label class="s2t-field" for="s2t_target">
                    <span>轉換目標</span>
                    <select id="s2t_target" class="text_pole">
                        ${Object.entries(TARGET_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
                    </select>
                </label>
                <label class="s2t-field" for="s2t_cdn_url">
                    <span>OpenCC module URL</span>
                    <input id="s2t_cdn_url" class="text_pole" type="url" spellcheck="false">
                </label>
                <div class="s2t-actions flex-container flexGap5">
                    <button id="s2t_convert_chat" class="menu_button menu_button_icon" type="button" title="轉換目前聊天室">
                        <i class="fa-solid fa-language"></i>
                        <span>轉換目前聊天室</span>
                    </button>
                    <button id="s2t_convert_input" class="menu_button menu_button_icon" type="button" title="轉換輸入框">
                        <i class="fa-solid fa-keyboard"></i>
                        <span>轉換輸入框</span>
                    </button>
                    <button id="s2t_test" class="menu_button menu_button_icon" type="button" title="測試 OpenCC">
                        <i class="fa-solid fa-vial"></i>
                        <span>測試</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    container.append(panel);

    bindCheckbox('s2t_enabled', 'enabled');
    bindCheckbox('s2t_incoming', 'convertIncoming');
    bindCheckbox('s2t_outgoing', 'convertOutgoing');
    bindCheckbox('s2t_edits', 'convertEdits');
    bindCheckbox('s2t_reasoning', 'convertReasoning');
    bindCheckbox('s2t_streaming', 'convertStreaming');
    bindCheckbox('s2t_quotes', 'convertQuotes');
    bindCheckbox('s2t_preserve_code', 'preserveMarkdownCode');
    bindSelect('s2t_target', 'target');
    bindTextInput('s2t_cdn_url', 'cdnUrl');

    document.getElementById('s2t_convert_chat')?.addEventListener('click', () => enqueueConversion(convertCurrentChat));
    document.getElementById('s2t_convert_input')?.addEventListener('click', () => enqueueConversion(convertInputBox));
    document.getElementById('s2t_test')?.addEventListener('click', () => enqueueConversion(testConverter));

    return true;
}

function ensureSettingsPanel() {
    if (createSettingsPanel()) {
        return;
    }

    const retry = setInterval(() => {
        if (createSettingsPanel()) {
            clearInterval(retry);
        }
    }, 500);
}

function attachEvents() {
    const context = getContext();
    const events = context?.eventTypes || context?.event_types;
    const source = context?.eventSource;
    if (!events || !source?.on) {
        throw new Error('SillyTavern event source is not available.');
    }

    source.on(events.GENERATION_STARTED, (type) => startStreamingPreview(type));
    source.on(events.GENERATION_ENDED, () => enqueueConversion(flushStreamingPreview));
    source.on(events.GENERATION_STOPPED, () => enqueueConversion(flushStreamingPreview));
    if (events.STREAM_TOKEN_RECEIVED) {
        source.on(events.STREAM_TOKEN_RECEIVED, () => scheduleStreamingPreview());
    }

    source.on(events.MESSAGE_RECEIVED, (messageId) => enqueueConversion(() => convertMessageById(messageId, 'incoming', { updateBlock: true })));
    source.on(events.MESSAGE_SENT, (messageId) => enqueueConversion(() => convertMessageById(messageId, 'outgoing', { updateBlock: true })));
    source.on(events.MESSAGE_SWIPED, (messageId) => enqueueConversion(() => convertMessageById(messageId, 'incoming', { updateBlock: true })));
    source.on(events.MESSAGE_UPDATED, (messageId) => {
        if (!getSettings().convertEdits) {
            return;
        }
        return enqueueConversion(() => convertMessageById(messageId, 'any', { updateBlock: true }));
    });
}

function init() {
    getSettings();
    ensureSettingsPanel();
    attachEvents();

    globalThis.SillyTavernS2TConverter = {
        convertText: convertMarkdownText,
        convertCurrentChat: () => enqueueConversion(convertCurrentChat),
        convertInputBox: () => enqueueConversion(convertInputBox),
    };

    console.info(`[${EXTENSION_NAME}] loaded`);
}

try {
    init();
} catch (error) {
    console.error(`[${EXTENSION_NAME}] failed to load`, error);
    globalThis.toastr?.error(error.message || String(error), '簡體轉繁體載入失敗');
}
