/* --- ANTIGRAVITY CHINESE LOCALIZATION SRC START --- */
/*
 * 源码级汉化运行时（Electron 主进程）
 *
 * 前端 bundle (main.js) 由 language_server 通过本地 HTTPS 动态下发，不在 app.asar 内，
 * 因此在主进程用 Chrome DevTools Protocol 的 Fetch 域拦截窗口对 /main.js 的请求：
 * 拿到原始响应 → 用 AST 把处于展示位置的字符串字面量替换为中文 → 以改写后的内容完成请求。
 * 其他所有请求不经过本模块（Fetch 只对匹配 pattern 的 URL 暂停）。
 *
 * 翻译结果按 (ETag + 字典哈希 + 核心模块哈希) 缓存到 userData/zh-cn-src-cache/，同一版本只翻译一次；
 * 升级汉化包（字典或核心模块任一变化）后缓存自动失效。
 */
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TAG = '[agy-zh]';
const log = (...a) => { try { console.log(TAG, ...a); } catch (e) { /* ignore */ } };
const MAIN_JS_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/main\.js(\?.*)?$/i;
const PATTERNS = [
    { urlPattern: '*://127.0.0.1*/main.js*', requestStage: 'Response' },
    { urlPattern: '*://localhost*/main.js*', requestStage: 'Response' },
];

let i18n = null;
let dict = null;
let dictHash = '';

function loadDict() {
    if (i18n) return;
    i18n = require('./agy_src_i18n.js');
    const raw = fs.readFileSync(path.join(__dirname, 'dict.json'), 'utf8');
    dict = JSON.parse(raw);
    let core = '';
    try { core = fs.readFileSync(path.join(__dirname, 'agy_src_i18n.js'), 'utf8'); } catch (e) { /* ignore */ }
    dictHash = crypto.createHash('sha1').update(raw).update('|').update(core).digest('hex').slice(0, 12);
}

function cacheDir() {
    const d = path.join(app.getPath('userData'), 'zh-cn-src-cache');
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
    return d;
}

function pruneCache(keep) {
    try {
        const dir = cacheDir();
        for (const f of fs.readdirSync(dir)) {
            if (f !== keep && f.endsWith('.js')) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ } }
        }
    } catch (e) { /* ignore */ }
}

function cacheKeyFor(srcId) {
    loadDict();
    return crypto.createHash('sha1').update(srcId + '|' + dictHash).digest('hex').slice(0, 16) + '.js';
}

// 命中缓存时直接返回译文，避免再从 CDP 拉取 9MB 的原始包体
function readCache(srcId) {
    try {
        const file = path.join(cacheDir(), cacheKeyFor(srcId));
        if (fs.existsSync(file)) {
            const cached = fs.readFileSync(file, 'utf8');
            if (cached.length > 1000) { log('cache hit', path.basename(file)); return cached; }
        }
    } catch (e) { /* ignore */ }
    return null;
}

function translate(src, etag) {
    loadDict();
    const srcId = etag || crypto.createHash('sha1').update(src).digest('hex');
    const cached = readCache(srcId);
    if (cached) return cached;
    const key = cacheKeyFor(srcId);
    const file = path.join(cacheDir(), key);
    const t0 = Date.now();
    const r = i18n.translateSource(src, dict);
    log(`translated main.js: ${r.replaced} literals, ${r.matchedKeys.size} keys, ${r.zones} protected zones, ${Date.now() - t0}ms`);
    try { fs.writeFileSync(file, r.code, 'utf8'); pruneCache(key); } catch (e) { log('cache write failed', e && e.message); }
    return r.code;
}

function headerValue(headers, name) {
    if (!Array.isArray(headers)) return undefined;
    const h = headers.find(x => x && typeof x.name === 'string' && x.name.toLowerCase() === name);
    return h ? h.value : undefined;
}

const hooked = new WeakSet();

function attach(wc) {
    if (!wc || hooked.has(wc)) return;
    hooked.add(wc);
    const dbg = wc.debugger;
    let attempts = 0;

    const onMessage = async (_event, method, params) => {
        if (method !== 'Fetch.requestPaused') return;
        const { requestId, request, responseStatusCode, responseHeaders } = params || {};
        const cont = () => dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => { });
        try {
            if (!request || !MAIN_JS_RE.test(request.url) || (responseStatusCode && responseStatusCode !== 200)) {
                await cont();
                return;
            }
            const etag = headerValue(responseHeaders, 'etag');
            let out = etag ? readCache(etag) : null;
            if (!out) {
                const body = await dbg.sendCommand('Fetch.getResponseBody', { requestId });
                const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
                if (!text || text.length < 1000) { await cont(); return; }
                out = translate(text, etag);
            }
            await dbg.sendCommand('Fetch.fulfillRequest', {
                requestId,
                responseCode: 200,
                responseHeaders: [
                    { name: 'Content-Type', value: headerValue(responseHeaders, 'content-type') || 'application/javascript; charset=utf-8' },
                    { name: 'Cache-Control', value: 'no-cache' },
                ],
                body: Buffer.from(out, 'utf8').toString('base64'),
            });
        } catch (e) {
            log('intercept failed, passing through:', e && e.message);
            await cont();
        }
    };

    const enable = () => {
        try {
            if (!dbg.isAttached()) dbg.attach('1.3');
        } catch (e) {
            log('debugger attach failed:', e && e.message);
            return Promise.resolve(false);
        }
        return dbg.sendCommand('Fetch.enable', { patterns: PATTERNS })
            .then(() => true)
            .catch(e => { log('Fetch.enable failed:', e && e.message); return false; });
    };

    dbg.on('message', onMessage);
    dbg.on('detach', (_event, reason) => {
        log('debugger detached:', reason);
        if (wc.isDestroyed() || attempts++ > 5) return;
        setTimeout(() => { if (!wc.isDestroyed()) enable(); }, 500);
    });

    // 首次 loadURL 必须等拦截就绪，否则 main.js 可能在 Fetch.enable 生效前就已下发
    const ready = enable();
    const origLoadURL = wc.loadURL.bind(wc);
    wc.loadURL = function (...args) {
        return Promise.resolve(ready).then(() => origLoadURL(...args));
    };
}

try {
    app.on('web-contents-created', (_event, wc) => {
        try {
            if (wc.getType && wc.getType() === 'window') attach(wc);
        } catch (e) { log('hook failed:', e && e.message); }
    });
    log('source-level localization layer armed');
} catch (e) {
    log('bootstrap failed:', e && e.message);
}

module.exports = { translate, attach };
/* --- ANTIGRAVITY CHINESE LOCALIZATION SRC END --- */
