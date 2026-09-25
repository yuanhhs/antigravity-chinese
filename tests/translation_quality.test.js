'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { applyTerminologyPolicy } = require('../terminology');
const { validateTranslation, translateSource, translateQuotaText } = require('../src_layer/agy_src_i18n');
const { loadDictionary, validateNativeMessages } = require('../dictionary');
const path = require('node:path');

test('中文 Git 术语与上下文保留，明确同义词统一', () => {
    assert.equal(applyTerminologyPolicy('Push commits to repository branch', '将提交推送到仓库分支'), '将提交推送到仓库分支');
    assert.equal(applyTerminologyPolicy('Review permissions', '检查权限'), '检查权限');
    assert.equal(applyTerminologyPolicy('Review pending conversations', '查看待处理的会话'), '查看待处理的会话');
    assert.equal(applyTerminologyPolicy('Review changes', '审查更改'), '审查更改');
    assert.equal(applyTerminologyPolicy('Subagents in worktrees', '工作区树中的子代理'), '工作树中的子智能体');
    assert.equal(applyTerminologyPolicy('git push', 'git push'), 'git push');
});

test('参数校验允许调序，拒绝丢失、重复、新增及错误省略声明', () => {
    assert.deepEqual(validateTranslation('${0} to ${1}', '${1}：${0}'), []);
    for (const zh of ['${0}', '${0} ${0} ${1}', '${0} ${2}']) assert.ok(validateTranslation('${0} to ${1}', zh).length);
    assert.ok(validateTranslation('${0}', '', { omitPlaceholders: '0' }).length);
    assert.ok(validateTranslation('${0}', '${0}', { omitPlaceholders: [0] }).length);
    assert.deepEqual(validateTranslation('${0} item${1}', '${0} 项', { omitPlaceholders: [1] }), []);
});

test('不合法模板保留原文和表达式执行，避免静默丢失动态内容', () => {
    const src = 'globalThis.result = `Install ${getName()}`;';
    const result = translateSource(src, { 'Install ${0}': '安装' });
    assert.equal(result.code, src);
    assert.equal(result.rejected.size, 1);
    let calls = 0;
    const ctx = { getName: () => { calls++; return 'Plugin'; } };
    vm.runInNewContext(result.code, ctx);
    assert.equal(ctx.result, 'Install Plugin');
    assert.equal(calls, 1);
});

test('只有经源码验证的纯复数后缀可以省略', () => {
    const dict = { '${0} item${1}': { zh: '${0} 项', omitPlaceholders: [1] } };
    const source = 'globalThis.result = `${count} item${count === 1 ? "" : "s"}`;';
    for (const count of [0, 1, 2]) {
        const ctx = { count };
        const result = translateSource(source, dict);
        assert.equal(result.rejected.size, 0);
        vm.runInNewContext(result.code, ctx);
        assert.equal(ctx.result, `${count} 项`);
    }
    for (const expression of ['name', 'count === 1 ? "special" : "s"', 'getCount() === 1 ? "" : "s"']) {
        const changed = source.replace('count === 1 ? "" : "s"', expression);
        const result = translateSource(changed, dict);
        assert.equal(result.code, changed);
        assert.equal(result.rejected.size, 1);
    }
});

test('配额翻译不匹配对象原型名称，普通消息保持原文', () => {
    for (const value of ['constructor', 'toString', '__proto__', 'Server-provided text', null]) {
        assert.equal(translateQuotaText(value), value);
    }
});

test('完整词库经过同一校验及术语策略', () => {
    const dict = loadDictionary(path.join(__dirname, '..', 'dicts_src'));
    const zh = key => typeof dict[key] === 'object' ? dict[key].zh : dict[key];
    assert.equal(zh('Subagents'), '子智能体');
    assert.equal(zh('Worktree'), '工作树');
    assert.equal(zh('Review Permissions'), '检查权限');
    assert.equal(zh('Dismiss'), '关闭');
    assert.equal(zh('Conversation'), '对话');
    assert.equal(zh('Workspace'), '工作区');
    assert.equal(zh('Review Changes'), '审查更改');
    assert.equal(zh('Clear Search'), '清空搜索');
    assert.equal(zh('No results'), '无匹配项');
});

test('设置标题和禁用提示可翻译，内部状态标识保持原文', () => {
    const dict = loadDictionary(path.join(__dirname, '..', 'dicts_src'));
    const src = 'const routes=[{screen:"Workspace Settings"}], state="Disabled";'
        + 'const view={title:"Workspace Settings",children:"Disabled",tooltip:{title:"Disabled"}};';
    const out = translateSource(src, dict).code;
    assert.ok(out.includes('screen:"Workspace Settings"'));
    assert.ok(out.includes('state="Disabled"'));
    assert.ok(out.includes('title:"工作区设置"'));
    assert.ok(out.includes('title:"已禁用"'));
});

test('推送按钮的禁用原因和进度文案均有中文', () => {
    const dict = loadDictionary(path.join(__dirname, '..', 'dicts_src'));
    const src = 'globalThis.messages=['
        + '"No commits to push","No remote configured","Not on a branch","Pushing..."];';
    const result = translateSource(src, dict);
    const context = {};
    vm.runInNewContext(result.code, context);
    assert.deepEqual(Array.from(context.messages), [
        '没有可推送的提交', '未配置远程仓库', '当前不在任何分支上', '正在推送…',
    ]);
    for (const key of ['No commits to push', 'No remote configured', 'Not on a branch', 'Pushing...']) {
        assert.ok(result.matchedKeys.has(key), `${key} 未命中`);
    }
});

test('计划审阅策略中的 plan 命令名保持原文', () => {
    const dict = loadDictionary(path.join(__dirname, '..', 'dicts_src'));
    const policySource = 'globalThis.policy={'
        + 'title:"Plan Review Policy",'
        + 'command:jsx("code",null,"plan"),'
        + 'help:[jsx("span",null,"and select"),jsx("span",null,"to have the agent generate a plan.")]};';
    const policyContext = { jsx: (_type, _props, child) => child };
    vm.runInNewContext(translateSource(policySource, dict).code, policyContext);
    assert.equal(policyContext.policy.title, '计划审阅策略');
    assert.equal(policyContext.policy.command, 'plan');
    assert.deepEqual(Array.from(policyContext.policy.help), ['并选择', '，让智能体生成计划。']);
});

test('菜单词库缺失及动态计数丢失在安装前被拒绝', () => {
    const native = require('../locales/zh-CN.json');
    assert.doesNotThrow(() => validateNativeMessages(native));
    assert.throws(() => validateNativeMessages({}), /缺少/);
    assert.throws(() => validateNativeMessages({ ...native, status: { ...native.status, agentsRunning: '正在运行' } }), /参数/);
});

test('补翻清单拒绝丢参数的建议，并单独输出语境', () => {
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const root = path.resolve(__dirname, '..', 'temps');
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, 'extraction-test-'));
    try {
        const input = path.join(dir, 'source.js');
        fs.writeFileSync(input, 'const view = {title: `Open full view ${name}`};');
        execFileSync(process.execPath, [path.join(__dirname, '../tools/extract_src_strings.js'), input,
            '--out', path.join(dir, 'nested/candidates.json'), '--pending', path.join(dir, 'nested/pending.json')], { stdio: 'pipe' });
        const pending = JSON.parse(fs.readFileSync(path.join(dir, 'nested/pending.json')));
        const context = JSON.parse(fs.readFileSync(path.join(dir, 'nested/pending.context.json')));
        assert.equal(pending['Open full view ${0}'], 'Open full view ${0}');
        assert.equal(context['Open full view ${0}'].suggestion.safe, false);
        assert.ok(context['Open full view ${0}'].samples[0].includes('title'));
        assert.deepEqual(context['Open full view ${0}'].placeholders, ['${0}']);
    } finally {
        assert.ok(path.resolve(dir).startsWith(root + path.sep));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
