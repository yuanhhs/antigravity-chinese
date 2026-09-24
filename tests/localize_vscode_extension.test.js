'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, uninstall } = require('../tools/localize_vscode_extension');

test('VS Code 扩展安装、更新与卸载均保留原始入口和清单', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-vscode-test-'));
    const source = `async function render() { const serverUrl = this.delegate.validateServerUrl(serverInfo.effectiveUrl); return serverUrl; }\n`;
    const manifest = JSON.stringify({
        publisher: 'google', name: 'google-antigravity', main: './extension.js',
        contributes: { commands: [{ command: 'antigravity.feedback', title: 'Provide Feedback' }] },
    }, null, 2);
    try {
        fs.writeFileSync(path.join(dir, 'extension.js'), source);
        fs.writeFileSync(path.join(dir, 'package.json'), manifest);
        install(dir);
        let patched = fs.readFileSync(path.join(dir, 'extension.js'), 'utf8');
        assert.match(patched, /agy_zh_vscode\/proxy\.js/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).contributes.commands[0].title, '提供反馈');
        assert.ok(fs.existsSync(path.join(dir, 'agy_zh_vscode', 'dict.json')));
        install(dir);
        assert.equal(fs.readFileSync(path.join(dir, 'extension.js'), 'utf8'), patched);
        uninstall(dir);
        assert.equal(fs.readFileSync(path.join(dir, 'extension.js'), 'utf8'), source);
        assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), manifest);
    } finally {
        assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
