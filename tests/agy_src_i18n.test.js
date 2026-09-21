'use strict';

const assert = require('assert');
const vm = require('vm');
const { translateQuotaDescription, translateSource } = require('../src_layer/agy_src_i18n.js');

assert.strictEqual(
    translateQuotaDescription('You have used some of your weekly limit, it will fully refresh in 3 days, 14 hours.'),
    '您已使用部分每周限额，将在 3 天 14 小时后完全恢复。'
);
assert.strictEqual(
    translateQuotaDescription('You have used all of your daily limit, it will fully refresh in less than a minute.'),
    '您已使用全部每日限额，将在 不到 1 分钟后完全恢复。'
);
assert.strictEqual(translateQuotaDescription('Server-provided text'), 'Server-provided text');

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
assert.strictEqual(context.result.refreshText, '您已使用部分每周限额，将在 3 天 14 小时后完全恢复。');

const unrelated = 'globalThis.result={refreshText:value,disabled:false};';
assert.strictEqual(translateSource(unrelated, {}).code, unrelated);

console.log('agy_src_i18n tests passed');
