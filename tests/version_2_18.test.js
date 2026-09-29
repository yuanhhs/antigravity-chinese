'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');
const { loadDictionary } = require('../dictionary');
const { translateSource, validateTranslation } = require('../src_layer/agy_src_i18n');
const dict = loadDictionary(path.join(__dirname, '..', 'dicts_src'));

test('预算提示的动态计数、单复数词与语法助词均正确显示', () => {
    const source = 'globalThis.result = {'
        + 'description: `${count} ${count===1?"item":"items"} in ${category} exceeded the customization budget and ${count===1?"was":"were"} excluded from context.`, '
        + 'tooltip: `${count} ${count===1?"rule":"rules"} exceeded the rules budget and ${count===1?"was":"were"} demoted from full inline content to a file-path pointer.`, '
        + 'label: `${count} ${count===1?"tool":"tools"} excluded`, '
        + 'message: `${count} ${count===1?"tool":"tools"} in this MCP server (${tokens} tokens) exceeded the customization budget and were excluded from context.`};'
        + 'globalThis.protocol = count===1?"tool":"tools";';
    const result = translateSource(source, dict);
    assert.equal(result.rejected.size, 0);
    for (const count of [1, 2]) {
        const context = { count, category: '技能', tokens: 1800 };
        vm.runInNewContext(result.code, context);
        assert.equal(context.result.description, `技能 中的 ${count} 项超出自定义内容预算，已从上下文中排除。`);
        assert.equal(context.result.tooltip, `${count} 条规则超出规则预算，已由完整内联内容改为文件路径引用。`);
        assert.equal(context.result.label, `已排除 ${count} 个工具`);
        assert.equal(context.result.message, `此 MCP 服务器中的 ${count} 个工具（1800 token）超出自定义内容预算，已从上下文中排除。`);
        assert.equal(context.protocol, count === 1 ? 'tool' : 'tools');
    }
});

test('templateValues 保留条件求值，未知分支或动态表达式回退原文', () => {
    const key = '${0} ${1} excluded';
    const entry = dict[key];
    const source = 'globalThis.result = {label: `${count} ${next()?"tool":"tools"} excluded`};';
    const result = translateSource(source, { [key]: entry });
    let calls = 0;
    const context = { count: 2, next: () => { calls++; return false; } };
    vm.runInNewContext(result.code, context);
    assert.equal(context.result.label, '已排除 2 个工具');
    assert.equal(calls, 1);
    for (const expression of ['next()?"tool":"unknown"', 'next()', 'name']) {
        const input = 'globalThis.result = {label: `${count} ${' + expression + '} excluded`};';
        const translated = translateSource(input, { [key]: entry });
        assert.equal(translated.code, input);
        assert.equal(translated.rejected.size, 1);
    }
    for (const templateValues of [null, [], { 2: { tool: '工具' } }, { 1: {} }, { 1: { tool: 2 } }]) {
        assert.ok(validateTranslation(key, entry.zh, { templateValues }).length);
    }
});

test('新版分段文案保留成对括号，命令和浏览器标识保持原样', () => {
    const source = 'globalThis.result = ['
        + 'React.createElement("span",null,"Show submitted (",3,")"),'
        + 'React.createElement("span",null,"tokens (",25,"%)"),'
        + 'React.createElement("code",null,"plan")];'
        + 'globalThis.browser = `builtin-browser:${workspace}:${tab}`;';
    const result = translateSource(source, dict);
    const context = { workspace: 'global', tab: 'default', React: { createElement: (tag, props, ...children) => children.join('') } };
    vm.runInNewContext(result.code, context);
    assert.deepEqual(Array.from(context.result), ['显示已提交 (3)', 'token (25%)', 'plan']);
    assert.equal(context.browser, 'builtin-browser:global:default');
});

test('计费选项数组中的 desc 说明可以翻译，计费标识符保持原样', () => {
    const source = 'globalThis.options = [{id:"enterprise",title:"Gemini Enterprise",'
        + 'desc:"Draws from your organization\'s pooled Gemini Enterprise usage."},'
        + '{id:"paygo",title:"Pay as you go",'
        + 'desc:"Pay only for the tokens you use, billed through Agent Platform (formerly Vertex AI)."}]'
        + '.map(({id,title,desc})=>({id,title,description:desc}));';
    const result = translateSource(source, dict);
    const context = {};
    vm.runInNewContext(result.code, context);
    assert.equal(context.options[0].id, 'enterprise');
    assert.equal(context.options[0].title, 'Gemini Enterprise');
    assert.equal(context.options[0].description, '使用你所在组织共享的 Gemini Enterprise 用量额度。');
    assert.equal(context.options[1].id, 'paygo');
    assert.equal(context.options[1].title, '按量付费');
    assert.equal(context.options[1].description, '仅为实际使用的 token 付费，通过 Agent Platform（原 Vertex AI）计费。');
});
