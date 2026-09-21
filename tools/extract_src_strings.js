#!/usr/bin/env node
/*
 * 源码级汉化 —— 候选文案提取 / 覆盖率对比工具
 *
 * 用法：
 *   node tools/extract_src_strings.js <main.js 路径> [--out temps/src_candidates.json] [--tw]
 *
 * 输出：
 *   - 控制台：按上下文类型统计的候选数、已翻译数、未翻译数
 *   - --out 指定的 JSON：所有候选（含上下文样例），未翻译条目 value 为 ""，便于批量补翻
 *
 * 如果没有传路径，会尝试从本机正在运行的 Antigravity（language_server 的本地 HTTPS 端口）自动下载 main.js。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { extract } = require('../src_layer/agy_src_i18n.js');

const args = process.argv.slice(2);
const getOpt = (name, def) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; };
const USE_TW = args.includes('--tw');
const dictDir = path.join(__dirname, '..', USE_TW ? 'dicts_src_tw' : 'dicts_src');
const outPath = getOpt('--out', path.join(__dirname, '..', 'temps', 'src_candidates.json'));
const srcPath = args.find(a => !a.startsWith('--') && a !== getOpt('--out'));

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

async function main() {
    let src;
    if (srcPath) {
        src = fs.readFileSync(srcPath, 'utf8');
    } else {
        src = await fetchLiveBundle();
    }
    const dict = loadDicts(dictDir);
    // 字典里已有的键即使形态上不像文案（如 "${0} tab"）也要参与统计，避免被误报为“源码已不存在”
    const force = new Set(Object.keys(dict).filter(k => typeof dict[k] === 'string'));
    const { items, stats } = extract(src, { force });

    let translated = 0, untranslated = 0, skipped = 0;
    const out = {};
    const byKindMissing = {};
    for (const it of items) {
        const v = dict[it.key];
        if (v === null) { skipped++; }
        else if (typeof v === 'string') { translated++; }
        else { untranslated++; for (const k of it.kinds) byKindMissing[k] = (byKindMissing[k] || 0) + 1; }
        out[it.key] = { zh: v === undefined ? '' : v, kinds: it.kinds, count: it.count, risky: it.risky, samples: it.samples };
    }
    // 字典中已经失效（源码里找不到）的键
    const live = new Set(items.map(i => i.key));
    const dead = Object.keys(dict).filter(k => !live.has(k));

    console.log(`候选字面量节点: ${stats.nodes}  去重后: ${stats.unique}`);
    console.log(`按上下文类型: ${JSON.stringify(stats.byKind)}`);
    console.log(`已翻译: ${translated}  未翻译: ${untranslated}  标记不译(null): ${skipped}`);
    console.log(`未翻译按类型: ${JSON.stringify(byKindMissing)}`);
    console.log(`字典中源码已不存在的键: ${dead.length}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
    fs.writeFileSync(outPath.replace(/\.json$/, '.dead.json'), JSON.stringify(dead, null, 2), 'utf8');
    console.log(`候选已写入: ${outPath}`);
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
            if (body.length > 100000) { console.log(`已从 https://127.0.0.1:${port}/main.js 获取 ${(body.length / 1048576).toFixed(1)} MB`); return body; }
        } catch (e) { /* try next */ }
    }
    throw new Error('无法从本机 language_server 端口下载 main.js，请手动传入路径');
}

main().catch(e => { console.error(e.message); process.exit(1); });
