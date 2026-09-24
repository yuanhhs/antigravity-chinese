'use strict';

const assert = require('assert');
const vm = require('vm');
const { translateQuotaText, translateSource } = require('../src_layer/agy_src_i18n.js');

assert.strictEqual(
    translateQuotaText('You have used some of your weekly limit, it will fully refresh in 3 days, 14 hours.'),
    '你已使用部分每周限额，将在3 天 14 小时后完全恢复。'
);
assert.strictEqual(
    translateQuotaText('You have used all of your daily limit, it will fully refresh in less than a minute.'),
    '你已使用全部每日限额，将在不到 1 分钟后完全恢复。'
);
assert.strictEqual(
    translateQuotaText('You have used some of your 5-hour limit, it will fully refresh in 4 hours, 39 minutes.'),
    '你已使用部分五小时限额，将在4 小时 39 分钟后完全恢复。'
);
assert.strictEqual(translateQuotaText('Server-provided text'), 'Server-provided text');
assert.strictEqual(translateQuotaText('Gemini Models'), 'Gemini 模型');
assert.strictEqual(translateQuotaText('Weekly Limit Remaining'), '每周剩余限额');
assert.strictEqual(translateQuotaText('Five Hour Limit Remaining'), '五小时剩余限额');
assert.strictEqual(translateQuotaText('Claude and GPT models'), 'Claude 和 GPT 模型');

const source = `
const quota = {
    remaining: { case: 'remainingFraction', value: 0.5 },
    description: 'You have used some of your weekly limit, it will fully refresh in 3 days, 14 hours.',
    disabled: false
};
globalThis.result = {
    remainingFraction: quota.remaining.value,
    refreshText: quota.description || '',
    subtext: undefined,
    disabled: quota.disabled ?? true
};
`;
const translated = translateSource(source, {});
const context = {};
vm.runInNewContext(translated.code, context);
assert.strictEqual(context.result.refreshText, '你已使用部分每周限额，将在3 天 14 小时后完全恢复。');

const unrelated = 'globalThis.result={refreshText:value,disabled:false};';
assert.strictEqual(translateSource(unrelated, {}).code, unrelated);

const agentToolSummary = `
function summarize(active, kind) {
    if (kind === 'edit') return active ? 'Editing' : 'Edited';
    if (kind === 'explore') return active ? 'Exploring' : 'Explored';
    if (kind === 'run') return active ? 'Running' : 'Ran';
    return active ? 'Working' : 'Done';
}
React.createElement('span', null, 'Edited');
`;
const summaryTranslation = translateSource(agentToolSummary, {
    Editing: '正在编辑', Edited: '已编辑', Exploring: '正在探索', Explored: '已探索',
    Running: '正在运行', Ran: '已运行', Working: '正在处理', Done: '已完成'
}).code;
assert.ok(summaryTranslation.includes("active ? 'Editing' : 'Edited'"));
assert.ok(summaryTranslation.includes("active ? 'Working' : 'Done'"));
assert.ok(summaryTranslation.includes('"已编辑"'));

const promptPlaceholder = 'const placeholder = "Ask anything, @ to mention" + (supportsActions ? ", / for actions" : "");';
const translatedPlaceholder = translateSource(promptPlaceholder, {
    'Ask anything, @ to mention': '询问任何内容，@ 提及',
    ', / for actions': { zh: '，/ 执行操作', scope: 'all' }
}).code;
assert.ok(translatedPlaceholder.includes('"询问任何内容，@ 提及"'));
assert.ok(translatedPlaceholder.includes('"，/ 执行操作"'));

const quotaDisplayNames = `
function QuotaView(group) {
    return React.createElement('section', null,
        React.createElement('h2', null, group.displayName),
        group.buckets.map(bucket => React.createElement(Row, {
            label: bucket.displayName,
            remainingFraction: 1,
            refreshText: '',
            disabled: false
        }))
    );
}
globalThis.result = QuotaView({
    displayName: 'Gemini Models',
    buckets: [{ displayName: 'Weekly Limit Remaining' }]
});
`;
const quotaContext = {
    Row: 'row',
    React: { createElement: (type, props, ...children) => ({ type, props, children }) }
};
vm.runInNewContext(translateSource(quotaDisplayNames, {}).code, quotaContext);
assert.strictEqual(quotaContext.result.children[0].children[0], 'Gemini 模型');
assert.strictEqual(quotaContext.result.children[1][0].props.label, '每周剩余限额');

const selectedPermissionValue = 'const selected={value:turbo?"Always Proceed":"Always Ask"};';
const translatedPermissionValue = translateSource(selectedPermissionValue, {
    'Always Proceed': { zh: '始终继续', scope: 'all' },
    'Always Ask': { zh: '总是询问', scope: 'all' }
}).code;
assert.ok(translatedPermissionValue.includes('turbo?"始终继续":"总是询问"'));

console.log('agy_src_i18n tests passed');
