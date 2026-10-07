'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');
const { loadDictionary } = require('../dictionary');
const { translateSource } = require('../src_layer/agy_src_i18n');
const dict = loadDictionary(path.join(__dirname, '..', 'dicts_src'));

test('2.21 Chief of Staff 文案及麦克风提示正确翻译', () => {
    const source = 'function render(React, notify) {'
        + 'const welcome = React.createElement("h2", null, "Welcome to your Chief of Staff");'
        + 'const button = React.createElement("div", { tooltip: "Turn on the Chief of Staff mic (always-on listener). Ctrl+Shift+M — hold for push-to-talk" });'
        + 'const toast = { title: "Chief of Staff voice mode is active", message: "Voice recording is unavailable while the Chief of Staff mic is on" };'
        + 'const sent = { title: "Sent to Chief of Staff" };'
        + 'return { welcome, button, toast, sent }; }';
    const result = translateSource(source, dict);
    assert.equal(result.rejected.size, 0);
    const context = { React: { createElement: (tag, props, ...children) => children.length ? children.join('') : (props?.tooltip || '') } };
    const fn = vm.runInNewContext('(' + result.code + ')', context);
    const res = fn(context.React);
    assert.equal(res.welcome, '欢迎使用 Chief of Staff');
    assert.equal(res.button, '开启 Chief of Staff 麦克风（常驻监听）。Ctrl+Shift+M —— 按住即可对讲');
    assert.equal(res.toast.title, 'Chief of Staff 语音模式已激活');
    assert.equal(res.toast.message, 'Chief of Staff 麦克风开启期间无法录音');
    assert.equal(res.sent.title, '已发送给 Chief of Staff');
});

test('2.21 动态模板文案参数插值与分段展示正确', () => {
    const source = 'function test(project, type, summary, cmd, count, name) {'
        + 'const manage = `Manage ${project} ${type}, agent settings, and permissions.`;'
        + 'const ran = summary && cmd ? `Ran command: ${summary} (\\`${cmd}\\`)` : "";'
        + 'const more = count > 1 ? `+${count} more (Show all)` : "";'
        + 'const accounts = count > 1 ? `${count} accounts` : "";'
        + 'const archived = `${name} (Archived)`;'
        + 'return { manage, ran, more, accounts, archived }; }';
    const result = translateSource(source, dict);
    assert.equal(result.rejected.size, 0);
    const fn = vm.runInNewContext('(' + result.code + ')', {});
    const res = fn('my-proj', 'folders', 'Git status', 'git status', 5, 'Main');
    assert.equal(res.manage, '管理 my-proj 的 folders、智能体设置和权限。');
    assert.equal(res.ran, '已运行命令：Git status (`git status`)');
    assert.equal(res.more, '还有 5 项（显示全部）');
    assert.equal(res.accounts, '5 个账号');
    assert.equal(res.archived, 'Main（已归档）');
});

test('2.21 自动化提示与未找到前缀分段正确渲染', () => {
    const source = 'globalThis.result = ['
        + 'React.createElement("p", null, "Automation \\"", name, "\\" not found."),'
        + 'React.createElement("button", null, "Add Automation")];';
    const result = translateSource(source, dict);
    assert.equal(result.rejected.size, 0);
    const context = { name: 'daily-report', React: { createElement: (tag, props, ...children) => children.join('') } };
    vm.runInNewContext(result.code, context);
    assert.equal(context.result[0], '自动化“daily-report”。');
    assert.equal(context.result[1], '添加自动化');
});
