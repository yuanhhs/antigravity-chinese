#!/usr/bin/env node
// 把 temps/src_candidates.json 中未翻译的候选按主题分组，输出到 temps/groups/*.json（值为空串，待填）
// 同时把能从 DOM 字典复用的译文写入 dicts_src/00_reuse_dom.json
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const cands = JSON.parse(fs.readFileSync(path.join(root, 'temps/src_candidates.json'), 'utf8'));
const dom = {}; for (const f of fs.readdirSync(path.join(root, 'dicts'))) if (f.endsWith('.json')) Object.assign(dom, JSON.parse(fs.readFileSync(path.join(root, 'dicts', f), 'utf8')));
const norm = t => t.replace(/\s+/g, ' ').trim();
const domNorm = {}; for (const [k, v] of Object.entries(dom)) domNorm[norm(k)] = v;

const existing = {};
const dsDir = path.join(root, 'dicts_src'); fs.mkdirSync(dsDir, { recursive: true });
for (const f of fs.readdirSync(dsDir)) if (f.endsWith('.json') && f !== '00_reuse_dom.json') Object.assign(existing, JSON.parse(fs.readFileSync(path.join(dsDir, f), 'utf8')));

const SKIP = /^(F\d{1,2}|CapsLock|NumLock|Insert|Pause|Caret|Ink|Movie|PolyLine|Popup|PrinterMark|Redact|Screen|Sound|Stamp|TrapNet|Watermark|FileAttachment|X-Frame-Options|Microsoft Edge|E-|I-|eu|us|bash|url|Google3|Jetski|Antigravity|Gemini|Google|CitC|Cider|Piper|Fig|JJ|Cog|ABFS|GoB|Gerrit|Buganizer|Critique|Chromium|MacOS|Linux|Windows|MCP|Tab|OR|OK|PID |CSP|PII|Inv|o\+rx|gcert|esc|\\angl|\\fbox|`Hello, \$\{name\}!`|[^A-Za-z]*\$\{\d\}[^A-Za-z]*|Ctrl\+\.|Alt\+←|Alt\+→|Shift|@@redux.*|\/static.*|&tkn.*|;ws=.*|path=.*|mcp:.*|browser__.*|e\$\{0\}_internal|GoogleSymbolIcon.*|SidecarTabIcon.*|ReflectList.*|ReflectMap.*|ReflectMessage.*|Uint8Array.*|Array\(.*|URI\(.*|LazyDerived.*|M\$\{0\}.*|min-width:.*|\[plugin\].*|Invalid state transition.*|Minified React error #|The plugin for '.*|Cannot use a proxy.*|Sets the `workspaceUri`.*|If non-zero.*|Specifies a minimum thickness.*|\n\nBase the commit message.*|Generate a commit message for the following.*|This is a side question.*)$/;

const reuse = {}; const todo = {};
for (const [k, v] of Object.entries(cands)) {
    if (existing[k] !== undefined) continue;
    if (SKIP.test(k) || /^\s*[{@.:#]/.test(k) && /[{}]/.test(k)) continue;
    const r = domNorm[norm(k)];
    if (r !== undefined && typeof r === 'string') { reuse[k] = r; continue; }
    todo[k] = v;
}
fs.writeFileSync(path.join(dsDir, '00_reuse_dom.json'), JSON.stringify(Object.fromEntries(Object.entries(reuse).sort((a, b) => a[0].localeCompare(b[0]))), null, 2) + '\n');

const groups = [
    ['settings_permissions', /\b(setting|permission|preset|policy|allow|deny|approve|approval|strict mode|security|sandbox|access|rule|hook|trust|grant|scope)/i],
    ['workspace_project_vcs', /\b(workspace|worktree|project|repositor|branch|commit|push|pull request|merge|amend|stash|diff|checkout|clone|git|vcs|jj\b|piper|fig\b|citc|cog\b|abfs|gerrit|remote|origin|snapshot|checkpoint|revert|restore)/i],
    ['mcp_plugins_skills', /\b(mcp|plugin|skill|marketplace|extension|tool call|tools?\b|server|install|uninstall|automation|schedule|cron|custom agent|agent script|sdk)/i],
    ['browser_terminal_files', /\b(browser|url|tab|page|devtools|chrome|terminal|command|shell|file|folder|director|path|editor|diff|search|find|open in|download|upload|attachment|image|video|audio|pdf|screenshot|record)/i],
    ['agent_conversation', /\b(agent|conversation|chat|message|thinking|task|step|plan|subagent|sidecar|session|prompt|model|token|context|compact|queue|artifact|review|comment|fork|best of n|turn|run|stop|cancel|retry|response)/i],
    ['account_usage_misc', /./],
];
const outDir = path.join(root, 'temps', 'groups'); fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
const assigned = {}; for (const [name] of groups) assigned[name] = {};
for (const [k, v] of Object.entries(todo)) {
    for (const [name, re] of groups) { if (re.test(k)) { assigned[name][k] = ''; break; } }
}
let total = 0;
for (const [name] of groups) {
    const keys = Object.keys(assigned[name]).sort((a, b) => a.localeCompare(b));
    total += keys.length;
    // 每 170 条一个文件，便于分批填写
    for (let i = 0; i < keys.length; i += 170) {
        const chunk = {}; for (const k of keys.slice(i, i + 170)) chunk[k] = '';
        fs.writeFileSync(path.join(outDir, `${name}_${String(i / 170 + 1).padStart(2, '0')}.json`), JSON.stringify(chunk, null, 2) + '\n');
    }
    console.log(name.padEnd(26), keys.length);
}
console.log('reuse from DOM dict:', Object.keys(reuse).length, ' already in dicts_src:', Object.keys(existing).length, ' to translate:', total);
