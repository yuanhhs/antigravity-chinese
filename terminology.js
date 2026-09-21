'use strict';

// Git / 版本控制术语保留英文；普通说明文字仍继续汉化。
// 仅当英文原文包含对应术语时才替换译文，避免误伤普通中文词语。
const TERM_RULES = [
    { source: /\bpull requests?\b/i, translated: /拉取请求|合并请求/g },
    { source: /\bmerge requests?\b/i, translated: /合并请求/g },
    { source: /\bmerge conflicts?\b/i, translated: /合并冲突/g },
    { source: /\bworktrees?\b/i, translated: /工作区树|工作树/g },
    { source: /\brepositor(?:y|ies)\b/i, translated: /仓库/g },
    { source: /\bcheckpoints?\b/i, translated: /检查点/g },
    { source: /\bsnapshots?\b/i, translated: /快照/g },
    { source: /\bunstaged\b/i, translated: /未暂存/g },
    { source: /\bunstage\b/i, translated: /取消暂存/g },
    { source: /\bstaged\b/i, translated: /已暂存/g },
    { source: /\bstage\b/i, translated: /暂存/g },
    { source: /\bamend(?:s|ed|ing)?\b/i, translated: /修补提交|修补/g },
    { source: /\bpush(?:es|ed|ing)?\b/i, translated: /推送/g },
    { source: /\bcommit(?:s|ted|ting)?\b/i, translated: /提交/g },
    { source: /\bbranch(?:es)?\b/i, translated: /分支/g },
    { source: /\brefs?\b/i, translated: /引用/g },
    { source: /\bdiffs?\b/i, translated: /差异/g },
    { source: /\bforks?\b/i, translated: /分叉/g },
    { source: /\bclone(?:s|d|ing)?\b/i, translated: /克隆/g },
];

const ISSUE_LABEL_RE = /^(?:\+\s*Add\s+|Delete\s+)?issues?(?:\s+(?:actions|creation|numbers|policy))?$/i;
const CJK_RE = /[\u3400-\u9fff]/;
const REVIEW_RE = /\breview(?:s|ed|ing)?\b/i;
const REVIEW_TRANSLATIONS_RE = /评审|审查|审核|检视|查看|检查/g;

function replaceWithEnglish(text, translatedPattern, english) {
    return text.replace(translatedPattern, (...args) => {
        const offset = args[args.length - 2];
        const input = args[args.length - 1];
        const matched = args[0];
        const leftSpace = offset > 0 && CJK_RE.test(input[offset - 1]) ? ' ' : '';
        const rightIndex = offset + matched.length;
        const rightSpace = rightIndex < input.length && CJK_RE.test(input[rightIndex]) ? ' ' : '';
        return leftSpace + english + rightSpace;
    });
}

function applyTerminologyPolicy(source, translation) {
    if (typeof source !== 'string' || typeof translation !== 'string') return translation;

    // Review 属于可翻译界面词，但所有语境统一使用“审核”。
    let result = REVIEW_RE.test(source)
        ? translation.replace(REVIEW_TRANSLATIONS_RE, '审核')
        : translation;
    for (const rule of TERM_RULES) {
        const match = source.match(rule.source);
        if (match) result = replaceWithEnglish(result, rule.translated, match[0]);
    }

    // “issue” 只有在 GitHub/策略等技术语境中保留英文，普通的“问题”仍翻译。
    const issueMatch = source.match(/\bissues?\b/i);
    if (issueMatch && (ISSUE_LABEL_RE.test(source) || /\bGitHub\b/i.test(source))) {
        result = replaceWithEnglish(result, /议题/g, issueMatch[0]);
    }

    return result;
}

module.exports = { applyTerminologyPolicy };
