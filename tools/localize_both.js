#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
    const appArgs = [];
    const vscodeArgs = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--install-dir' || arg === '--extension-dir') {
            const value = argv[++i];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少路径`);
            (arg === '--install-dir' ? appArgs : vscodeArgs).push(arg, value);
        } else if (arg === '--no-kill') {
            appArgs.push(arg);
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }
    return { appArgs, vscodeArgs };
}

function runCombined(argv, options = {}) {
    const platform = options.platform || process.platform;
    const node = options.node || process.execPath;
    const spawn = options.spawn || spawnSync;
    const isRoot = options.isRoot === undefined ? (process.getuid && process.getuid() === 0) : options.isRoot;
    const { appArgs, vscodeArgs } = parseArgs(argv);
    if (platform === 'darwin' && !appArgs.includes('--install-dir')) {
        appArgs.unshift('--install-dir', '/Applications/Antigravity.app');
    }

    const appScript = path.join(__dirname, '..', 'localization_engine.js');
    const vscodeScript = path.join(__dirname, 'localize_vscode_extension.js');
    const useSudo = platform === 'darwin' && !isRoot;

    console.log('====== 正在安装 Antigravity 桌面版汉化 ======');
    if (useSudo) console.log('修改 Antigravity 应用需要管理员密码。');
    const appResult = spawn(useSudo ? 'sudo' : node,
        useSudo ? [node, appScript, ...appArgs] : [appScript, ...appArgs], { stdio: 'inherit' });
    if (appResult.error) console.error(`[错误] 桌面版汉化启动失败: ${appResult.error.message}`);

    console.log('\n====== 正在安装 VS Code 插件汉化 ======');
    const vscodeResult = spawn(node, [vscodeScript, ...vscodeArgs], { stdio: 'inherit' });
    if (vscodeResult.error) console.error(`[错误] VS Code 插件汉化启动失败: ${vscodeResult.error.message}`);

    const appSuccess = !appResult.error && appResult.status === 0;
    const vscodeSuccess = !vscodeResult.error && vscodeResult.status === 0;
    console.log(`\n桌面版汉化：${appSuccess ? '成功' : '失败'}；VS Code 插件汉化：${vscodeSuccess ? '成功' : '失败'}。`);
    if (vscodeSuccess) console.log('请在 VS Code 中执行 Developer: Reload Window。');
    return appSuccess && vscodeSuccess ? 0 : 1;
}

if (require.main === module) {
    try { process.exitCode = runCombined(process.argv.slice(2)); }
    catch (error) { console.error(`[错误] ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, runCombined };
