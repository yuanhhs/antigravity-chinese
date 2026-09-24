'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, runCombined } = require('../tools/localize_both');

test('同时安装将路径参数交给各自的安装器', () => {
    assert.deepEqual(parseArgs([
        '--extension-dir', '/tmp/vscode-extension', '--install-dir', '/tmp/Antigravity.app', '--no-kill',
    ]), {
        appArgs: ['--install-dir', '/tmp/Antigravity.app', '--no-kill'],
        vscodeArgs: ['--extension-dir', '/tmp/vscode-extension'],
    });
    assert.throws(() => parseArgs(['--extension-dir']), /缺少路径/);
});

test('桌面版失败后仍安装 VS Code 扩展，并返回失败状态', () => {
    const calls = [];
    const spawn = (command, args) => {
        calls.push({ command, args });
        return { status: calls.length === 1 ? 1 : 0 };
    };
    const result = runCombined(['--install-dir', '/app', '--extension-dir', '/extension'], {
        platform: 'win32', node: 'node', spawn,
    });
    assert.equal(result, 1);
    assert.equal(calls.length, 2);
    assert.match(calls[0].args[0], /localization_engine\.js$/);
    assert.deepEqual(calls[0].args.slice(1), ['--install-dir', '/app']);
    assert.match(calls[1].args[0], /localize_vscode_extension\.js$/);
    assert.deepEqual(calls[1].args.slice(1), ['--extension-dir', '/extension']);
});

test('macOS 仅对桌面版汉化提权，VS Code 扩展仍按当前用户安装', () => {
    const calls = [];
    const spawn = (command, args) => { calls.push({ command, args }); return { status: 0 }; };
    assert.equal(runCombined([], { platform: 'darwin', node: 'node', isRoot: false, spawn }), 0);
    assert.equal(calls[0].command, 'sudo');
    assert.equal(calls[0].args[0], 'node');
    assert.match(calls[0].args[1], /localization_engine\.js$/);
    assert.deepEqual(calls[0].args.slice(2), ['--install-dir', '/Applications/Antigravity.app']);
    assert.equal(calls[1].command, 'node');
    assert.match(calls[1].args[0], /localize_vscode_extension\.js$/);
});
