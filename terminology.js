'use strict';

// 参考 Codex 中文界面：普通 Git 概念保留中文，品牌、命令和标识符由词库决定。
// 只统一明确同义词；Review 按具体场景在词库中选择审查、审阅、审核、查看或检查。
function applyTerminologyPolicy(source, translation) {
    if (typeof source !== 'string' || typeof translation !== 'string' || source === translation) return translation;
    let result = translation;
    if (/\bsubagents?\b/i.test(source)) result = result.replace(/子代理/g, '子智能体');
    if (/\bworktrees?\b/i.test(source)) result = result.replace(/工作区树/g, '工作树');
    return result;
}

module.exports = { applyTerminologyPolicy };
