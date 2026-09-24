#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadDictionary } = require('../dictionary');

const EXTENSION_ID = 'google.google-antigravity';
const HOOK = "const serverUrl = this.delegate.validateServerUrl(serverInfo.effectiveUrl);";
const PATCH = "const serverUrl = await require('./agy_zh_vscode/proxy.js').startProxy(this.delegate.validateServerUrl(serverInfo.effectiveUrl)); /* agy-zh-vscode */";
const BACKUP = 'extension.js.agy-zh.bak';
const MANIFEST_BACKUP = 'package.json.agy-zh.bak';
const LABELS = {
    'Bring Google\'s agent-first development platform to Visual Studio Code.': '在 Visual Studio Code 中使用 Google 的智能体开发平台。',
    'Antigravity Artifact Viewer': 'Antigravity 产物查看器',
    'Antigravity Settings Viewer': 'Antigravity 设置查看器',
    'Show Third Party Notices': '显示第三方声明',
    'Reset Conversation State': '重置对话状态',
    'Add Selection to Chat': '将选中内容添加到对话',
    'Focus Antigravity Panel': '聚焦 Antigravity 面板',
    'Accept All Changes': '接受所有更改',
    'Reject All Changes': '拒绝所有更改',
    'Toggle Inline Diff': '切换行内差异',
    'Open Antigravity Settings': '打开 Antigravity 设置',
    'Provide Feedback': '提供反馈',
    'Port for the Antigravity background server (`agy --hub`). Leave at 0 to allocate an ephemeral port automatically.': 'Antigravity 后台服务器（`agy --hub`）的端口。设为 0 时自动分配临时端口。',
    'Enable sending client-side product telemetry and usage metrics to Google Cloudmill to help improve Antigravity.': '向 Google Cloudmill 发送客户端产品遥测和使用指标，以帮助改进 Antigravity。',
    'Enable inline diff decorations and CodeLenses. When disabled, falls back to opening changes in a side-by-side diff tab.': '启用行内差异标记和 CodeLens。关闭后将在并排差异标签页中打开更改。',
    'Automatically open files in the editor when the agent proposes edits.': '智能体提出修改时，自动在编辑器中打开文件。',
    'The release channel for this extension build': '此扩展构建的发布渠道',
    'Internal channel setting': '内部渠道设置',
};

function translateManifest(value) {
    if (typeof value === 'string') return LABELS[value] || value;
    if (Array.isArray(value)) return value.map(translateManifest);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translateManifest(item)]));
    }
    return value;
}

function args(argv) {
    const out = { action: 'install' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--uninstall') out.action = 'uninstall';
        else if (argv[i] === '--install') out.action = 'install';
        else if (argv[i] === '--extension-dir') out.extensionDir = argv[++i];
        else throw new Error(`未知参数: ${argv[i]}`);
    }
    if (out.extensionDir === undefined && argv.includes('--extension-dir')) throw new Error('--extension-dir 缺少路径');
    return out;
}

function findExtension() {
    const root = path.join(process.env.USERPROFILE || process.env.HOME || '', '.vscode', 'extensions');
    if (!fs.existsSync(root)) throw new Error(`未找到 VS Code 扩展目录: ${root}`);
    const candidates = fs.readdirSync(root)
        .filter(name => name.startsWith(`${EXTENSION_ID}-`))
        .map(name => ({ name, dir: path.join(root, name), version: name.slice(EXTENSION_ID.length + 1) }))
        .filter(item => fs.existsSync(path.join(item.dir, 'package.json')));
    candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    if (!candidates.length) throw new Error(`未安装 ${EXTENSION_ID} 扩展；可用 --extension-dir 指定其目录`);
    return candidates[0].dir;
}

function checkExtension(dir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (`${manifest.publisher}.${manifest.name}` !== EXTENSION_ID) throw new Error(`目录不是 ${EXTENSION_ID}: ${dir}`);
    const entry = path.join(dir, manifest.main || 'extension.js');
    if (!fs.existsSync(entry)) throw new Error(`缺少扩展入口: ${entry}`);
    return entry;
}

function install(dir) {
    const entry = checkExtension(dir);
    const backup = path.join(dir, BACKUP);
    const manifestPath = path.join(dir, 'package.json');
    const manifestBackup = path.join(dir, MANIFEST_BACKUP);
    const current = fs.readFileSync(entry, 'utf8');
    const original = current.includes('/* agy-zh-vscode */') && fs.existsSync(backup)
        ? fs.readFileSync(backup, 'utf8') : current;
    const hits = original.split(HOOK).length - 1;
    if (hits !== 1) throw new Error(`未找到唯一的 VS Code iframe 入口（匹配 ${hits} 处），此版本需要重新适配`);
    const dict = loadDictionary(path.join(__dirname, '..', 'dicts_src'));
    const sourceDir = path.join(__dirname, '..');
    const layer = path.join(dir, 'agy_zh_vscode');
    fs.mkdirSync(layer, { recursive: true });
    for (const [from, to] of [
        ['vscode_layer/proxy.js', 'proxy.js'],
        ['src_layer/agy_src_i18n.js', 'agy_src_i18n.js'],
        ['src_layer/acorn.js', 'acorn.js'],
        ['src_layer/acorn.LICENSE', 'acorn.LICENSE'],
    ]) fs.copyFileSync(path.join(sourceDir, from), path.join(layer, to));
    fs.writeFileSync(path.join(layer, 'dict.json'), JSON.stringify(dict), 'utf8');
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, 'utf8');
    if (!fs.existsSync(manifestBackup)) fs.copyFileSync(manifestPath, manifestBackup);
    const manifest = JSON.parse(fs.readFileSync(manifestBackup, 'utf8'));
    manifest.description = translateManifest(manifest.description);
    manifest.contributes = translateManifest(manifest.contributes);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n', 'utf8');
    fs.writeFileSync(entry, original.replace(HOOK, PATCH), 'utf8');
    console.log(`已汉化 VS Code 扩展: ${dir}`);
    console.log(`词条 ${Object.keys(dict).length} 条；请执行“Developer: Reload Window”重新加载 VS Code。`);
}

function uninstall(dir) {
    const entry = checkExtension(dir);
    const backup = path.join(dir, BACKUP);
    const manifestPath = path.join(dir, 'package.json');
    const manifestBackup = path.join(dir, MANIFEST_BACKUP);
    const layer = path.join(dir, 'agy_zh_vscode');
    if (!fs.existsSync(backup)) throw new Error(`未找到原始扩展备份: ${backup}`);
    if (!fs.existsSync(manifestBackup)) throw new Error(`未找到原始清单备份: ${manifestBackup}`);
    if (!path.resolve(layer).startsWith(path.resolve(dir) + path.sep)) throw new Error(`无效汉化目录: ${layer}`);
    const current = fs.readFileSync(entry, 'utf8');
    if (!current.includes('/* agy-zh-vscode */')) throw new Error('扩展入口已由其他程序改动，未自动覆盖');
    fs.copyFileSync(backup, entry);
    fs.copyFileSync(manifestBackup, manifestPath);
    fs.unlinkSync(backup);
    fs.unlinkSync(manifestBackup);
    fs.rmSync(layer, { recursive: true, force: true });
    console.log(`已还原 VS Code 扩展: ${dir}`);
}

function main() {
    const opts = args(process.argv.slice(2));
    const dir = path.resolve(opts.extensionDir || findExtension());
    if (opts.action === 'uninstall') uninstall(dir); else install(dir);
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[错误] ${error.message}`); process.exitCode = 1; }
}

module.exports = { args, findExtension, checkExtension, install, uninstall };
