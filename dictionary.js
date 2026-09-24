'use strict';

const fs = require('fs');
const path = require('path');
const { applyTerminologyPolicy } = require('./terminology');
const { validateTranslation } = require('./src_layer/agy_src_i18n');

function loadDictionary(dir) {
    const merged = {};
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        for (const [key, value] of Object.entries(data)) {
            const zh = value === null ? null : typeof value === 'string' ? value : value?.zh;
            if (zh !== null && typeof zh !== 'string') throw new Error(`${file}: ${key}: 无效词条`);
            if (value && typeof value === 'object' && value.scope !== undefined && !['all', 'display'].includes(value.scope)) {
                throw new Error(`${file}: ${key}: 无效 scope`);
            }
            const errors = validateTranslation(key, zh, value && typeof value === 'object' ? value : {});
            if (errors.length) throw new Error(`${file}: ${key}: ${errors.join('；')}`);
            const translated = applyTerminologyPolicy(key, zh);
            merged[key] = value && typeof value === 'object' ? { ...value, zh: translated } : translated;
        }
    }
    return merged;
}

function validateNativeMessages(native) {
    const required = {
        menu: ['File', 'Edit', 'View', 'Help', 'Version'],
        tray: ['No agents running', 'Open Antigravity', 'Quit'],
        status: ['agentsRunning', 'loading', 'version'],
        updater: ['title', 'message', 'confirm'],
    };
    for (const [group, keys] of Object.entries(required)) {
        if (!native[group] || typeof native[group] !== 'object') throw new Error(`缺少原生词库分组 ${group}`);
        for (const key of keys) if (!Object.hasOwn(native[group], key)) throw new Error(`缺少原生词条 ${group}.${key}`);
        for (const [key, value] of Object.entries(native[group])) {
            if (typeof value !== 'string' || !value.trim()) throw new Error(`${group}.${key}: 无效原生译文`);
            const expected = group === 'status' && key === 'agentsRunning' ? '${0}' : '';
            if (validateTranslation(expected, value).length) throw new Error(`${group}.${key}: 原生文案参数不一致`);
        }
    }
}

module.exports = { loadDictionary, validateNativeMessages };
