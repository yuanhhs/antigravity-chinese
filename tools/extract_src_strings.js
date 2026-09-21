#!/usr/bin/env node
/*
 * 源码级汉化 —— 候选文案提取 / 覆盖率对比 / 新版本待翻清单
 *
 * 用法：
 *   node tools/extract_src_strings.js                       # 从本机正在运行的 Antigravity 抓取 main.js（推荐）
 *   node tools/extract_src_strings.js path/to/main.js       # 或手动指定 bundle 文件
 *   选项：
 *     --out <file>      候选全量 JSON 输出位置（默认 temps/src_candidates.json）
 *     --pending <file>  待翻清单输出位置（默认 temps/pending_<版本>.json）
 *     --tw              对比 dicts_src_tw/ 而不是 dicts_src/
 *
 * 输出：
 *   - 控制台：候选数、已翻译 / 未翻译 / 标记不译、失效键、scope:"all" 键的整包改名冲突提示、
 *             渲染库保护区（KaTeX / react-dom / remark …）列表及区内被拦下的字典命中
 *   - 候选全量 JSON（含上下文样例，便于核对语境）
 *   - 待翻清单 JSON：只包含新版本里字典还没有的原文，值预填为“建议译文”或英文原文；
 *     翻好后整份文件放进 dicts_src/（例如 dicts_src/70_v2.16.json）重新安装即可
 *   - <out>.dead.json：字典里有、但当前 bundle 已不存在的键（可清理，也可保留）
 *   - <out>.zone_only.json：字典里有、但只出现在渲染库保护区内的键（永远不会被翻译，可清理）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { extract, normalizeDict } = require('../src_layer/agy_src_i18n.js');

const args = process.argv.slice(2);
const getOpt = (name, def) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; };
const USE_TW = args.includes('--tw');
const root = path.join(__dirname, '..');
const dictDir = path.join(root, USE_TW ? 'dicts_src_tw' : 'dicts_src');
const outPath = getOpt('--out', path.join(root, 'temps', 'src_candidates.json'));
const optValues = new Set(['--out', '--pending'].map(o => getOpt(o)).filter(Boolean));
const srcPath = args.find(a => !a.startsWith('--') && !optValues.has(a));

function loadDicts(dir) {
    const all = {};
    if (!fs.existsSync(dir)) return all;
    for (const f of fs.readdirSync(dir).sort()) {
        if (!f.endsWith('.json')) continue;
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const [k, v] of Object.entries(data)) all[k] = v;
    }
    return all;
}

/** 从已翻译条目里为新原文找“相近旧原文”，预填建议译文（大小写 / 标点 / 复数 / 尾部省略号差异） */
function buildSuggester(lookup) {
    const norm = s => s.toLowerCase().replace(/\$\{\d+\}/g, ' ').replace(/[\s\p{P}]+/gu, ' ').trim();
    const byNorm = new Map();
    for (const [k, v] of lookup) if (typeof v.zh === 'string' && v.zh !== k) { const n = norm(k); if (n && !byNorm.has(n)) byNorm.set(n, { key: k, zh: v.zh }); }
    const singular = s => s.replace(/(es|s)$/, '');
    return (key) => {
        const n = norm(key);
        if (!n) return null;
        const direct = byNorm.get(n);
        if (direct) return { ...direct, how: 'exact-ignoring-case-punct' };
        const s = singular(n);
        for (const [nk, hit] of byNorm) if (singular(nk) === s) return { ...hit, how: 'plural-form' };
        // 长句：按词集合相似度找最接近的旧句（Jaccard >= 0.8）
        const words = n.split(' ');
        if (words.length >= 4) {
            const set = new Set(words); let best = null, bestScore = 0;
            for (const [nk, hit] of byNorm) {
                const w2 = nk.split(' '); if (Math.abs(w2.length - words.length) > 3) continue;
                let inter = 0; for (const w of w2) if (set.has(w)) inter++;
                const score = inter / (set.size + w2.length - inter);
                if (score > bestScore) { bestScore = score; best = hit; }
            }
            if (best && bestScore >= 0.8) return { ...best, how: `similar(${bestScore.toFixed(2)})` };
        }
        return null;
    };
}

function readInstalledVersion() {
    const candidates = [];
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'app.asar'));
    if (process.platform === 'darwin') candidates.push('/Applications/Antigravity.app/Contents/Resources/app.asar');
    for (const asar of candidates) {
        try {
            for (const file of [asar + '.bak', asar]) {
                if (!fs.existsSync(file)) continue;
                const fd = fs.openSync(file, 'r');
                const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
                const headerSize = head.readUInt32LE(4); const jsonSize = head.readUInt32LE(12);
                const hb = Buffer.alloc(jsonSize); fs.readSync(fd, hb, 0, jsonSize, 16);
                const header = JSON.parse(hb.toString('utf8').replace(/\0+$/, ''));
                const pkg = header.files['package.json'];
                if (!pkg) { fs.closeSync(fd); continue; }
                const buf = Buffer.alloc(pkg.size); fs.readSync(fd, buf, 0, pkg.size, 8 + headerSize + Number(pkg.offset));
                fs.closeSync(fd);
                const v = JSON.parse(buf.toString('utf8')).version;
                if (v) return String(v);
            }
        } catch (e) { /* try next */ }
    }
    return null;
}

async function main() {
    let src;
    if (srcPath) {
        src = fs.readFileSync(srcPath, 'utf8');
    } else {
        src = await fetchLiveBundle();
    }
    const dict = loadDicts(dictDir);
    const lookup = normalizeDict(dict);
    // 字典里已有的键即使形态上不像文案（如 "${0} tab"）也要参与统计，避免被误报为“源码已不存在”
    const force = new Set([...lookup].filter(([k, v]) => typeof v.zh === 'string').map(([k]) => k));
    const { items, stats, conflicts, blocked, zones, zoneKeys } = extract(src, { force, dict });

    let translated = 0, untranslated = 0, skipped = 0;
    const out = {};
    const byKindMissing = {};
    const pending = {};
    const suggest = buildSuggester(lookup);
    let suggested = 0;
    for (const it of items) {
        const v = lookup.get(it.key);
        if (v && v.zh === null) { skipped++; }
        else if (v && typeof v.zh === 'string' && v.zh !== it.key) { translated++; }
        else if (v && v.zh === it.key) { skipped++; }
        else {
            untranslated++;
            for (const k of it.kinds) byKindMissing[k] = (byKindMissing[k] || 0) + 1;
            const s = suggest(it.key);
            if (s) { pending[it.key] = s.zh; suggested++; }
            else pending[it.key] = it.key; // 值 = 原文 表示“待翻”，运行时会原样跳过，不会误伤
        }
        out[it.key] = { zh: v === undefined ? '' : (v.scope ? { zh: v.zh, scope: v.scope } : v.zh), kinds: it.kinds, count: it.count, risky: it.risky, samples: it.samples };
    }
    // 字典中已经失效（源码里找不到）的键
    const live = new Set(items.map(i => i.key));
    // 值为 null（保留英文）的键不一定是候选（可能因标识符冲突被过滤），只要 bundle 里还有这个字面量就不算失效
    const dead = Object.keys(dict).filter(k => !live.has(k) && !zoneKeys.has(k) && !(dict[k] === null && src.includes(JSON.stringify(k))));
    // 只出现在渲染库保护区内的键：运行时不会被翻译（保护区内一律不动），留在字典里也无害，但可以清理
    const zoneOnly = Object.keys(dict).filter(k => !live.has(k) && zoneKeys.has(k) && !(dict[k] === null && src.includes(JSON.stringify(k))));

    console.log(`候选字面量节点: ${stats.nodes}  去重后: ${stats.unique}`);
    console.log(`按上下文类型: ${JSON.stringify(stats.byKind)}`);
    console.log(`已翻译: ${translated}  未翻译: ${untranslated}  标记不译(null / 原文): ${skipped}`);
    if (untranslated) console.log(`未翻译按类型: ${JSON.stringify(byKindMissing)}`);
    console.log(`字典中源码已不存在的键: ${dead.length}`);
    if (zones && zones.length) {
        const total = zones.reduce((a, z) => a + z.size, 0);
        const suppressedTotal = zones.reduce((a, z) => a + Object.values(z.suppressed).reduce((x, y) => x + y, 0), 0);
        console.log(`\n渲染库保护区（会话框保护，区内不提取也不翻译）: ${zones.length} 段，共 ${(total / 1048576).toFixed(2)} MB，区内被拦下的字典命中 ${suppressedTotal} 处`);
        for (const z of zones) {
            const n = Object.values(z.suppressed).reduce((x, y) => x + y, 0);
            const sup = n ? `  拦下: ${Object.entries(z.suppressed).map(([k, c]) => `${JSON.stringify(k.length > 40 ? k.slice(0, 37) + '…' : k)}x${c}`).join(' ')}` : '';
            console.log(`  ${String(Math.round(z.size / 1024)).padStart(4)} KB  ${z.label}${sup}`);
        }
        if (zoneOnly.length) console.log(`字典里只出现在保护区内的键（不会被翻译，可清理）: ${zoneOnly.length}，见 ${path.basename(outPath).replace(/\.json$/, '.zone_only.json')}`);
    }
    if (conflicts && conflicts.size) {
        console.log(`\nscope:"all" 整包改名提示（以下位置不会被改名，请确认它们不与被改名的字符串值做比较）:`);
        for (const [k, where] of conflicts) console.log(`  ${JSON.stringify(k)}: ${where.join(' | ')}`);
    }
    // 字典里有译文、也出现在展示位置，但因为同一字符串在别处被当作标识符（比较 / 键名 / 查找实参）而未译的键：
    // 需要维护者确认后在 dicts_src 里改成 {"zh": "...", "scope": "display"}（只译展示位置）或 "all"（整包一致改名）
    const blockedList = [];
    for (const [k, kinds] of blocked || []) {
        const v = lookup.get(k);
        if (v && typeof v.zh === 'string' && v.zh !== k && !v.scope) blockedList.push([k, [...kinds]]);
    }
    if (blockedList.length) {
        console.log(`\n有译文但被“标识符安全阀”拦下的键（${blockedList.length} 个，可在字典里加 scope 放行）:`);
        for (const [k, kinds] of blockedList) console.log(`  ${JSON.stringify(k)}  [${kinds.join(',')}]`);
        fs.writeFileSync(outPath.replace(/\.json$/, '.blocked.json'), JSON.stringify(Object.fromEntries(blockedList), null, 2), 'utf8');
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
    fs.writeFileSync(outPath.replace(/\.json$/, '.dead.json'), JSON.stringify(dead, null, 2), 'utf8');
    fs.writeFileSync(outPath.replace(/\.json$/, '.zone_only.json'), JSON.stringify(zoneOnly, null, 2), 'utf8');
    console.log(`候选已写入: ${outPath}`);

    const version = readInstalledVersion() || 'unknown';
    const pendingPath = getOpt('--pending', path.join(root, 'temps', `pending_${version}.json`));
    if (untranslated) {
        const sorted = Object.fromEntries(Object.keys(pending).sort((a, b) => a.localeCompare(b)).map(k => [k, pending[k]]));
        fs.writeFileSync(pendingPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
        console.log(`\n待翻清单已写入: ${pendingPath}（${untranslated} 条，其中 ${suggested} 条已按旧译文预填建议）`);
        console.log(`下一步：把清单里“值仍为英文原文”的条目翻译成中文（专有名词写 null），`);
        console.log(`        另存为 dicts_src/70_v${version}.json，再运行 双击运行中文汉化工具 重新安装。`);
    } else {
        if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
        console.log(`\n当前版本（${version}）的界面文案已全部覆盖，无需补翻。`);
    }
}

async function fetchLiveBundle() {
    const { execSync } = require('child_process');
    const https = require('https');
    let pids = [];
    try {
        const out = execSync(process.platform === 'win32'
            ? 'tasklist /FI "IMAGENAME eq language_server.exe" /FO CSV /NH'
            : 'pgrep -f language_server', { encoding: 'utf8' });
        pids = process.platform === 'win32'
            ? out.split('\n').map(l => l.split('","')[1]).filter(Boolean).map(Number)
            : out.split('\n').filter(Boolean).map(Number);
    } catch (e) { /* ignore */ }
    if (!pids.length) throw new Error('未检测到正在运行的 language_server，请先启动 Antigravity 或手动传入 main.js 路径');
    let ports = [];
    try {
        const ns = execSync(process.platform === 'win32' ? 'netstat -ano -p tcp' : 'lsof -nP -iTCP -sTCP:LISTEN', { encoding: 'utf8' });
        for (const line of ns.split('\n')) {
            const m = process.platform === 'win32'
                ? /127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line)
                : /^\S+\s+(\d+).*?127\.0\.0\.1:(\d+)/.exec(line);
            if (!m) continue;
            const port = Number(process.platform === 'win32' ? m[1] : m[2]);
            const pid = Number(process.platform === 'win32' ? m[2] : m[1]);
            if (pids.includes(pid)) ports.push(port);
        }
    } catch (e) { /* ignore */ }
    for (const port of ports) {
        try {
            const body = await new Promise((resolve, reject) => {
                https.get({ host: '127.0.0.1', port, path: '/main.js', rejectUnauthorized: false, timeout: 15000 }, res => {
                    if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
                    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                }).on('error', reject);
            });
            if (body.length > 100000) {
                console.log(`已从 https://127.0.0.1:${port}/main.js 获取 ${(body.length / 1048576).toFixed(1)} MB`);
                try { fs.mkdirSync(path.join(root, 'temps'), { recursive: true }); fs.writeFileSync(path.join(root, 'temps', 'live_main.js'), body, 'utf8'); } catch (e) { /* ignore */ }
                return body;
            }
        } catch (e) { /* try next */ }
    }
    throw new Error('无法从本机 language_server 端口下载 main.js，请手动传入路径');
}

main().catch(e => { console.error(e.message); process.exit(1); });
