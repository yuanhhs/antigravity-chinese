#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadDictionary, validateNativeMessages } = require('../dictionary');
const { translateSource } = require('../src_layer/agy_src_i18n');
const acorn = require('../src_layer/acorn');

const root = path.join(__dirname, '..');
const dict = loadDictionary(path.join(root, 'dicts_src'));
const native = require('../locales/zh-CN.json');
validateNativeMessages(native);
console.log(`词库校验通过：${Object.keys(dict).length} 条界面词条，${Object.values(native).reduce((n, m) => n + Object.keys(m).length, 0)} 条原生界面词条。`);

if (process.argv[2]) {
    const src = fs.readFileSync(process.argv[2], 'utf8');
    const result = translateSource(src, dict);
    acorn.parse(result.code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    if (result.rejected.size) throw new Error(`源码参数校验失败：${JSON.stringify([...result.rejected])}`);
    console.log(`源码验证通过：替换 ${result.replaced} 处，命中 ${result.matchedKeys.size} 个词条，保护区 ${result.zones} 段。`);
}
