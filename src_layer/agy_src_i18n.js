/*
 * Antigravity 源码级汉化核心模块（Node / Electron 主进程通用，CommonJS）
 *
 * 作用：
 *   1. extract(src)            —— 从前端 bundle (main.js) 中提取“处于界面展示位置”的字符串字面量候选
 *   2. translateSource(src, d) —— 按字典把这些字面量原位替换为中文，返回新的源码
 *
 * 判定“展示位置”的依据是 AST 语法上下文，而不是全文搜索替换，因此同一个单词
 * 出现在比较、键名、路由、CSS 等位置时不会被误改：
 *   - React.createElement(tag, props, ...children) 的 children 参数（含三元 / 逻辑 / 模板字面量分支）
 *   - createElement props 与任意对象字面量中的展示型键：label / title / description / placeholder / tooltip / aria-label ...
 *   - 带插值的模板字面量（排除 Error / console / 日志 / 比较等非展示上下文）
 *   - 以“句子”形态出现的普通函数实参（toast / confirm 等），排除 console、断言、nls(key, text) 模式
 *   - return / 箭头函数直接返回的句子文本（switch 映射枚举到文案的常见写法）
 *   - “枚举 -> 文案”映射对象（所有值均为 Title-case 文本）
 *   - 对 .title / .textContent / .placeholder 等 DOM 属性的字符串赋值
 *
 * 会话框保护（渲染库保护区）：bundle 里的第三方库（KaTeX、react-dom、remark / micromark / rehype、lodash、diff …）
 * 被打包器包成独立的顶层 IIFE 语句，前面带许可证注释或带 UMD / esbuild 模块标记。它们负责把聊天内容
 * （Markdown、公式、代码块）渲染出来，内部字符串（字体名 "Size"+n+"-Regular"、按键名表、序列化选项）一旦被改
 * 就会破坏渲染，而且其中没有任何界面文案。因此整段划为保护区：既不提取候选，也不做任何替换（含 scope:"all"）。
 * 另外，单个词与变量无空格直接拼接（"Size"+n）一律视为在拼标识符，不当作文案。
 *
 * 安全阀：除 createElement children 之外，任何字符串只要在源码别处被当作“标识符”使用
 * （=== 比较、switch case、对象键、id/type/screen 等代码键的值、Map.get/includes 等查找实参），
 * 默认就不会在源码层翻译。这样避免 title:"General" 这类既做显示又做路由键的字符串被改坏。
 *
 * 字典值除了 "译文" / null（保留英文）/ ""（删除片段）之外，还可以写成对象来放宽安全阀：
 *   { "zh": "通用", "scope": "all" }      —— 整包一致改名：源码里所有等于原文的字符串字面量都替换
 *                                           （含 === 比较、case、Map 键、ER("General") 之类的调用实参），
 *                                           适用于“既是展示文本又是路由键、且只在前端包内流转”的字符串
 *   { "zh": "星期一", "scope": "display" } —— 只替换处于展示位置的字面量，即使它在别处被当作标识符使用；
 *                                           比较 / 键名 / 代码键的值 / 普通调用实参 / 枚举映射表保持英文
 *   可选限定："keys": ["label","text"] 只译这些属性名下的值（"children" 表示 createElement 子节点）；
 *             "notWith": ["prefix"]   所在对象若含有这些兄弟属性则不译（例如既做标题又做查找键的注册表项）
 *
 * 模板字面量的字典键形如 "Allow ${0}?"，数字为插值表达式的序号；译文可重排或省略占位符。
 */
'use strict';

const acorn = require('./acorn.js');

// 强展示键：值几乎总是给用户看的文本（允许单个词）
const STRONG_KEYS = new Set([
    'label', 'title', 'description', 'placeholder', 'tooltip', 'tooltipText', 'tooltipContent',
    'aria-label', 'ariaLabel', 'scopeAriaLabel', 'actionsAriaLabel', 'accessibilityLabel',
    'hint', 'emptyMessage', 'emptyHint', 'emptyText', 'emptyLabel', 'emptyTitle', 'emptyDescription',
    'submitLabel', 'cancelLabel', 'confirmLabel', 'actionLabel', 'buttonLabel', 'linkLabel',
    'editTitle', 'deleteTitle', 'searchPlaceholder', 'promptText', 'subtitle', 'heading', 'subheading',
    'caption', 'helperText', 'helpText', 'errorMessage', 'successMessage', 'loadingText', 'loadingMessage',
    'confirmText', 'cancelText', 'okText', 'buttonText', 'displayName', 'shortDisplayName',
    'shortDescription', 'longDescription', 'detail', 'summary', 'children', 'alt', 'noun', 'header',
    'headerTitle', 'dialogTitle', 'modalTitle', 'sectionTitle_display', 'groupTitle', 'tabTitle', 'pageTitle',
    'shortLabel', 'sidebarLabel', 'groupName', 'emptyMessageSingular', 'emptyMessagePlural', 'paneLabel', 'prefix', 'headerText',
]);

// 形如 xxxLabel / xxxTitle / xxxTooltip / xxxPlaceholder / xxxDescription / xxxHeading / xxxCaption / xxxHint 的键
// 也视为强展示键（renameLabel / deleteTitle / projectSearchPlaceholder ...）；值仍需通过文本形态过滤
const RE_STRONG_KEY_SUFFIX = /^[a-z][A-Za-z0-9]*(Label|Title|Subtitle|Tooltip|Placeholder|Description|Heading|Caption|Hint|Text|Message)$/;
const NOT_STRONG_KEYS = new Set(['xLinkTitle', 'xlinkTitle', 'ariaLabelledBy', 'ariaDescribedBy', 'innerText', 'textContent', 'plainText', 'richText', 'rawText', 'fullText', 'selectedText', 'inputText', 'queryText', 'searchText', 'sourceText', 'originalText', 'currentText', 'previousText', 'newText', 'oldText']);
function isStrongKey(k) {
    if (STRONG_KEYS.has(k)) return true;
    if (NOT_STRONG_KEYS.has(k) || WEAK_KEYS.has(k) || ENTITY_KEYS.has(k)) return false;
    return RE_STRONG_KEY_SUFFIX.test(k);
}

// 实体标签键：值是 "workspace" / "Workspace" 这类单词，运行时拼进句子里，允许全小写
const ENTITY_KEYS = new Set(['lowercase', 'lowercasePlural', 'capitalized', 'capitalizedPlural', 'singular', 'plural', 'workspaces', 'workspace', 'conversations', 'conversation']);

// 即使同一字符串在别处被当作标识符使用，处于这些键下的值也肯定是展示文本
const SAFE_KEYS = new Set([
    'description', 'placeholder', 'tooltip', 'tooltipText', 'tooltipContent', 'aria-label', 'ariaLabel', 'scopeAriaLabel',
    'actionsAriaLabel', 'accessibilityLabel', 'hint', 'emptyMessage', 'emptyHint', 'emptyText', 'emptyLabel', 'emptyTitle',
    'emptyDescription', 'submitLabel', 'cancelLabel', 'confirmLabel', 'actionLabel', 'buttonLabel', 'linkLabel', 'editTitle',
    'deleteTitle', 'searchPlaceholder', 'promptText', 'subtitle', 'heading', 'subheading', 'caption', 'helperText', 'helpText',
    'errorMessage', 'successMessage', 'loadingText', 'loadingMessage', 'confirmText', 'cancelText', 'okText', 'buttonText',
    'shortDescription', 'longDescription', 'detail', 'summary', 'alt', 'noun', 'headerTitle', 'dialogTitle', 'modalTitle',
    'lowercase', 'lowercasePlural', 'capitalized', 'capitalizedPlural', 'singular', 'plural',
]);

// 弱展示键：只有在值看起来是完整句子时才视为展示文本
const WEAK_KEYS = new Set([
    'content', 'text', 'message', 'error', 'body', 'prompt', 'warning', 'info', 'note',
    'one', 'other', 'zero', 'two', 'few', 'many', // date-fns / 复数表
    'name', 'group',
]);

// 这些方法的字符串实参绝不是展示文本
const NON_DISPLAY_METHODS = new Set([
    'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'test', 'match', 'matchAll',
    'replace', 'replaceAll', 'split', 'get', 'has', 'set', 'delete', 'add', 'push', 'unshift',
    'emit', 'on', 'once', 'off', 'addEventListener', 'removeEventListener', 'dispatchEvent',
    'querySelector', 'querySelectorAll', 'closest', 'matches', 'getAttribute', 'setAttribute',
    'removeAttribute', 'hasAttribute', 'getItem', 'setItem', 'removeItem', 'matchMedia',
    'localize', 'define', 'require', 'import', 'fetch', 'open', 'postMessage', 'send', 'invoke',
    'dispatch', 'track', 'log', 'info', 'warn', 'error', 'debug', 'trace', 'assert', 'group',
    'groupEnd', 'time', 'timeEnd', 'count', 'record', 'report', 'capture', 'measure', 'mark',
    'createElement', 'createElementNS', 'createTextNode', 'getElementById', 'getElementsByClassName',
    'getElementsByTagName', 'appendChild', 'insertBefore', 'setProperty', 'getPropertyValue',
    'register', 'registerCommand', 'executeCommand', 'subscribe', 'publish', 'join', 'concat',
    'padStart', 'padEnd', 'localeCompare', 'normalize', 'from', 'of', 'parse', 'stringify',
    'encodeURIComponent', 'decodeURIComponent', 'atob', 'btoa', 'resolve', 'reject', 'then',
    'catch', 'finally', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'bind', 'call', 'apply',
    'headers', 'append', 'toLowerCase', 'toUpperCase', 'trim', 'charAt', 'slice', 'substring',
    'substr', 'at', 'find', 'findIndex', 'filter', 'map', 'forEach', 'some', 'every', 'reduce', 'sort',
    'keys', 'values', 'entries', 'assign', 'freeze', 'defineProperty', 'hasOwnProperty', 'isArray',
    'setRequestHeader', 'getResponseHeader', 'writeText', 'exec', 'spawn', 'execSync', 'readFile',
    'writeFile', 'existsSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'statSync', 'unlinkSync',
]);

const ERROR_CTORS = /^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError|DOMException|AbortError|ConnectError)$/;

const DOM_ASSIGN_PROPS = new Set(['title', 'textContent', 'innerText', 'placeholder', 'ariaLabel', 'label', 'alt', 'tooltip']);
const SAFE_ATTRS = new Set(['aria-label', 'title', 'placeholder', 'alt', 'aria-description']);

const COMPARE_OPS = new Set(['===', '!==', '==', '!=']);

const LOOKUP_METHODS = new Set(['includes', 'has', 'get', 'startsWith', 'endsWith', 'indexOf', 'set', 'delete', 'add', 'getItem', 'setItem', 'removeItem']);

// 允许出现在文案中的驼峰品牌 / 术语，不视为代码标识符
const BRAND_TOKENS = new Set(['GitHub', 'GitLab', 'BigQuery', 'OpenAI', 'JavaScript', 'TypeScript', 'PowerShell', 'YouTube', 'macOS', 'iOS',
    'iPhone', 'iPad', 'WebSocket', 'WebSockets', 'DevTools', 'LaTeX', 'KaTeX', 'MathML', 'JetBrains', 'IntelliJ', 'PyCharm', 'WebStorm',
    'ChatGPT', 'OAuth', 'PostgreSQL', 'MySQL', 'MongoDB', 'GraphQL', 'gRPC', 'OneDrive', 'SharePoint', 'LinkedIn', 'WordPress', 'PayPal',
    'iCloud', 'CitC', 'GoB', 'Gerrit', 'Bitbucket', 'Colab', 'AppEngine', 'CloudRun', 'Firebase', 'ClearCase', 'Perforce', 'Jetski',
    'Antigravity', 'Gemini', 'Google', 'JSON', 'YAML', 'MCPs', 'CLs', 'URLs', 'IDs', 'APIs', 'PRs', 'SDKs', 'IDEs', 'PDFs', 'UIs',
    'eBay', 'iMessage', 'WhatsApp', 'TikTok', 'FaceTime', 'AirDrop', 'QuickTime', 'OpenGL', 'WebGL', 'WebGPU', 'DirectX', 'NodeJS', 'ReactJS',
    'VSCode', 'NPM', 'GCP', 'AWS', 'AzureAD', 'FedRAMP', 'SSO', 'SAML', 'ReadMe', 'README']);

function getKeyName(prop) {
    if (!prop || prop.type !== 'Property') return null;
    if (prop.computed) return null;
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
    return null;
}

function calleeInfo(call) {
    const c = call.callee;
    if (!c) return { name: null, prop: null, obj: null };
    if (c.type === 'Identifier') return { name: c.name, prop: null, obj: null };
    if (c.type === 'MemberExpression' && !c.computed) {
        const prop = c.property.type === 'Identifier' ? c.property.name : (c.property.type === 'Literal' ? String(c.property.value) : null);
        const obj = c.object.type === 'Identifier' ? c.object.name : (c.object.type === 'ThisExpression' ? 'this' : null);
        return { name: null, prop, obj };
    }
    return { name: null, prop: null, obj: null };
}

const CREATE_ELEMENT_ALIASES = new Set(['createElement', 'element', 'jsx', 'jsxs', 'jsxDEV', '_jsx', '_jsxs']);
function isCreateElementCall(node) {
    if (!node || node.type !== 'CallExpression') return false;
    const c = node.callee;
    if (c.type === 'Identifier') {
        // element("div", {className:"loading"}, "Loading...")：以裸函数形式调用的 createElement 别名，要求第二个参数是对象 / null
        if (!CREATE_ELEMENT_ALIASES.has(c.name) || node.arguments.length < 2) return false;
        const a1 = node.arguments[1];
        return a1.type === 'ObjectExpression' || (a1.type === 'Literal' && a1.value === null);
    }
    if (c.type !== 'MemberExpression' || c.computed) return false;
    const p = c.property;
    if (!(p.type === 'Identifier' && (p.name === 'createElement' || p.name === 'jsx' || p.name === 'jsxs' || p.name === 'jsxDEV'))) return false;
    // document.createElement("div") 只有 1 个参数，不会有 children；这里要求至少 2 个参数
    return node.arguments.length >= 2 && !(c.object.type === 'Identifier' && c.object.name === 'document');
}

// ---------------------------------------------------------------------------
// 渲染库保护区（会话框保护）
// ---------------------------------------------------------------------------

const RE_LICENSE_COMMENT = /Package:\s*[@\w./-]+|SPDX-License-Identifier|@license|@preserve|\bLicen[cs]e\b|Copyright/i;
const RE_UMD_HEAD = /typeof exports\s*[!=]==?\s*["']object["']|module\.exports|define\.amd/;
const RE_ESBUILD_TAIL = /globalThis\[["'][@\w./-]+["']\]\s*=|"__esModule"/;
// 没有许可证注释 / 模块标记时，按库内部特征字符串兜底识别（打包器改变输出形态时仍能保护）
const ZONE_FINGERPRINTS = [
    ['katex', /Font metrics not found for font:|KaTeX parse error/],
    ['react-dom', /Minified React error #/],
    ['micromark', /Cannot close `|Expected `jsx` in production options/],
    ['mdast-util-to-markdown', /Cannot serialize \w+ with `/],
    ['lodash', /Unsupported core-js use/],
];

// 会话中的工具执行摘要（"Edited …" / "Explored …" / "Ran …" / "Working"）应保持官方英文。
// 这些短词也用于普通设置与状态界面，不能通过删除全局字典项来排除；改用该摘要函数独有的
// 字面量组合识别其函数体，避免依赖每个版本都会变化的压缩函数名。
const AGENT_TOOL_SUMMARY_LITERALS = ['Editing', 'Edited', 'Exploring', 'Explored', 'Running', 'Ran', 'Working', 'Done'];

function findAgentToolSummaryZones(ast, existingZones) {
    const literalsByFunction = new Map();
    const stack = [{ node: ast, owner: null }];
    while (stack.length) {
        const { node, owner: parentOwner } = stack.pop();
        const isFunction = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
        const owner = isFunction ? node : parentOwner;
        if (isFunction && !literalsByFunction.has(node)) literalsByFunction.set(node, new Set());
        if (owner && isStringLiteral(node)) literalsByFunction.get(owner).add(node.value);
        for (const key in node) {
            if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
            const value = node[key];
            if (Array.isArray(value)) {
                for (const child of value) if (isChildNode(child)) stack.push({ node: child, owner });
            } else if (isChildNode(value)) {
                stack.push({ node: value, owner });
            }
        }
    }

    const zones = [];
    for (const [fn, literals] of literalsByFunction) {
        if (!AGENT_TOOL_SUMMARY_LITERALS.every(text => literals.has(text))) continue;
        if (existingZones.some(zone => fn.start >= zone.start && fn.end <= zone.end)) continue;
        zones.push({ start: fn.start, end: fn.end, label: 'agent-tool-summary' });
    }
    return zones;
}

/** (function(){…})() / (function(){…}).call(this) / !function(){}() / (()=>{…})()：返回被立即调用的函数节点 */
function iifeFunction(expr) {
    let e = expr;
    while (e && e.type === 'UnaryExpression') e = e.argument;
    if (!e || e.type !== 'CallExpression') return null;
    let c = e.callee;
    if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' && (c.property.name === 'call' || c.property.name === 'apply')) c = c.object;
    return (c.type === 'FunctionExpression' || c.type === 'ArrowFunctionExpression') ? c : null;
}

/** 给保护区起一个可读的名字：许可证注释里的 Package 名 / esbuild 全局名 / UMD 全局名 / 版权行 */
function zoneLabel(licenseText, text) {
    const pkgs = [...new Set([...licenseText.matchAll(/Package:\s*([@\w./-]+)/g)].map(m => m[1]))];
    if (pkgs.length) return pkgs.slice(0, 3).join(', ') + (pkgs.length > 3 ? ` …+${pkgs.length - 3}` : '');
    let m = /globalThis\[["']([@\w./-]+)["']\]\s*=/.exec(text.slice(-400));
    if (m) return m[1];
    m = /^\(function\(\)\{\(function\((\w+),(\w+)\)\{\1\.(\w+)=\2\(\)\}\)/.exec(text) || /\(function\((\w+),(\w+)\)\{\1=\1\|\|self;\2\(\1\.(\w+)=\{\}\)\}\)/.exec(text);
    if (m) return m[3];
    const fp = ZONE_FINGERPRINTS.find(([, re]) => re.test(text));
    if (fp) return fp[0];
    m = /Copyright(?:\s*\(c\))?\s*([^\n*<]{0,60})/i.exec(licenseText);
    if (m) return ('Copyright ' + m[1].replace(/\s*(SPDX|Permission|Licensed|All rights).*$/i, '').replace(/[\s,.]+$/, '')).trim();
    return text.slice(0, 40).replace(/\s+/g, ' ');
}

/**
 * 找出 bundle 中的第三方库包装语句：顶层 IIFE（`(function(){…})()` 语句，或紧跟许可证注释的 `const X = function(){…}()`），
 * 且满足其一：前面紧跟许可证注释 / 头部带 UMD 标记 / 尾部带 esbuild 全局赋值 / 含已知库的特征字符串。
 * 应用自身的组件工厂（`const X = function(){…}()`，无许可证注释）不算库，其中的界面文案照常翻译。
 * @returns {Array<{start:number,end:number,label:string}>} 按位置排序
 */
function findProtectedZones(ast, src) {
    const zones = [];
    const body = ast.body || [];
    for (let i = 0; i < body.length; i++) {
        const s = body[i];
        const gap = src.slice(i > 0 ? body[i - 1].end : 0, s.start);
        const licenseText = (gap.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) || []).filter(c => RE_LICENSE_COMMENT.test(c)).join('\n');
        let isIife = false;
        if (s.type === 'ExpressionStatement') isIife = !!iifeFunction(s.expression);
        else if (s.type === 'VariableDeclaration' && s.declarations.length === 1 && s.declarations[0].init) isIife = !!licenseText && !!iifeFunction(s.declarations[0].init);
        if (!isIife) continue;
        const text = src.slice(s.start, s.end);
        let label = null;
        if (licenseText || RE_UMD_HEAD.test(text.slice(0, 400)) || RE_ESBUILD_TAIL.test(text.slice(-400))) label = zoneLabel(licenseText, text);
        else { const fp = ZONE_FINGERPRINTS.find(([, re]) => re.test(text)); if (fp) label = fp[0]; }
        if (label) zones.push({ start: s.start, end: s.end, label });
    }
    zones.push(...findAgentToolSummaryZones(ast, zones));
    zones.sort((a, b) => a.start - b.start || b.end - a.end);
    return zones;
}

/** 返回 pos => 所在保护区下标（-1 表示不在保护区） */
function zoneIndexer(zones) {
    if (!zones || !zones.length) return () => -1;
    return (pos) => {
        let lo = 0, hi = zones.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1; const z = zones[mid];
            if (pos < z.start) hi = mid - 1; else if (pos >= z.end) lo = mid + 1; else return mid;
        }
        return -1;
    };
}

// ---------------------------------------------------------------------------
// 文本形态过滤
// ---------------------------------------------------------------------------

const RE_URL = /^(https?:|mailto:|file:|data:|blob:|ws:|wss:|vscode:|chrome:|about:|\/\/)/i;
const RE_EMAIL = /^[\w.+-]+@[\w.-]+\.\w+$/;
const RE_HEX = /^(#[0-9a-fA-F]{3,8}|[0-9a-f]{3,8}|[0-9A-F]{3,8})$/; // 不带 # 时要求大小写一致，避免把 "Add" / "Dead" 当成颜色值
const RE_CSS_FN = /^(rgb|rgba|hsl|hsla|var|calc|url|translate[XYZ3d]*|scale[XYZ3d]*|rotate[XYZ3d]*|matrix3?d?|cubic-bezier|linear-gradient|radial-gradient|repeat|minmax|clamp|env)\(/i;
const RE_UNIT = /^-?[\d.]+(px|em|rem|%|ms|s|vh|vw|vmin|vmax|deg|fr|ch|ex|pt)?$/;
const RE_SVG_PATH = /^[MmLlHhVvCcSsQqTtAaZz][\d\s.,\-MmLlHhVvCcSsQqTtAaZz]*$/;
const RE_CAMEL_TOKEN = /^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/;
const RE_DOTTED = /^[\w$-]+(\.[\w$-]+)+$/;
const RE_KEBAB_SNAKE = /^[a-z0-9]+([-_][a-z0-9]+)+$/;
const RE_CONST = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
const RE_MIME = /^[a-z]+\/[a-z0-9.+*-]+$/;
const RE_LOWER_IDENT = /^[a-z_$][\w$]*$/;
const RE_TAILWIND_TOKEN = /^!?-?[a-z0-9]+(-[a-z0-9\[\]\/.%#,()!]+|:[a-z0-9\[\]\/.%#,()!:-]+)+$|^\[[^\]]+\]$|^[a-z0-9]+:[a-z0-9\[\]\/.%#,()!:-]+$/;
const RE_PLACEHOLDER = /\$\{\d+\}/g;
const RE_TITLE_WORD = /^[A-Z][a-z]{2,}(?: [a-z]+)?$/; // 单个 Title-case 词（"Ran" / "Projects" / "Stopped after"）

/**
 * 判断一个字符串（模板键已把插值替换为 ${n}）在形态上是否像给用户看的文本。
 * @param {string} s 原文
 * @param {'children'|'prop'|'callarg'|'template'|'assign'} kind 上下文类型
 */
function looksLikeText(s, kind) {
    if (typeof s !== 'string') return false;
    const t = s.replace(RE_PLACEHOLDER, ' ').trim();
    if (!t) return false;
    if (!/[A-Za-z]/.test(t)) return false;
    if (t.length > 600) return false;
    if (RE_URL.test(t) || RE_EMAIL.test(t) || RE_HEX.test(t) || RE_CSS_FN.test(t) || RE_UNIT.test(t) || RE_MIME.test(t)) return false;
    if (t.length > 6 && RE_SVG_PATH.test(t) && /\d/.test(t)) return false;
    if (/^<\/?[a-zA-Z!]/.test(t) || /<\/[a-zA-Z]+>|\/>/.test(t)) return false; // HTML
    if (/=>|==|;\s*$|^\s*(function|return|const|let|var|import|export)\b/.test(t)) return false; // 代码
    if (/^[\/.#?&~][\w\/.@:-]*$/.test(t) && !/\s/.test(t)) return false; // 路径 / 锚点
    if (/^[\w.-]+\.(js|ts|tsx|jsx|json|md|css|html|py|go|java|rs|yaml|yml|toml|txt|png|svg|jpg|gif|webp|wasm|map|lock|sh|bat|ps1)$/i.test(t)) return false; // 文件名
    // CSS / JSON 块、HTML 属性片段、CSS 选择器、LaTeX 命令
    if (/[{}]/.test(t) && /[:;]/.test(t)) return false;
    if (/^\s*[@.#:\[][\w-]/.test(s) && /[{}]/.test(s)) return false;
    if (/\b[\w-]+=["']/.test(t)) return false;
    if (/^\\[a-zA-Z]+$/.test(t)) return false;
    if (/(^|\s)(\.[a-zA-Z_-]|#[a-zA-Z_-]|\[data-|::?[a-z-]+\()/.test(t) && !/[.!?]$/.test(t) && !/^[A-Z]/.test(t)) return false;
    // 键盘快捷键 / 组合键
    if (/^((Ctrl|Cmd|Alt|Shift|Meta|Option|Command|Win)\+)+[\w.←→↑↓]+$/i.test(t)) return false;

    const tokens = t.split(/\s+/);
    const hasUpper = /[A-Z]/.test(t);

    // 去掉占位符后不含空格、且只剩标识符风格字符（synth-split-${0} / mcp:${0} / ${0}-list）；结尾省略号不算
    const core = t.replace(/(\.\.\.|…)$/, '');
    if (!/\s/.test(core) && !hasUpper && /[-_:./]/.test(core)) return false;
    if (!/\s/.test(core) && /^[\w:.-]*_[\w:.-]*$/.test(core)) return false;
    // 库内部消息：printf 占位符、反引号、函数调用、以 $ 开头的标识符
    if (kind === 'callarg' || kind === 'template') {
        if (/%s|`|\(\)|\$[a-zA-Z]/.test(t)) return false;
        if (tokens.some(tok => /^[a-z]+[A-Z][a-zA-Z]*[.:,]?$/.test(tok) && !BRAND_TOKENS.has(tok.replace(/[.:,]$/, '')))) return false;
        if (tokens.some(tok => /^[A-Z][a-z]+[A-Z][a-zA-Z]*[.:,]?$/.test(tok) && !BRAND_TOKENS.has(tok.replace(/[.:,]$/, '')))) return false;
        if (/\b(prop|props|hook|component|render|callback|state|node|nodeMap|key|ref|reducer|selector|mutation|transaction|draft|patch|patches|listener|dispatch|reconcil|hydrat|invariant|expected|received|argument|parameter|instance|constructor|prototype|undefined|null|NaN)\b/i.test(t) && !/^[A-Z][^.!?]*[.!?]?$/.test(t)) return false;
    }

    if (tokens.length === 1) {
        const tok = tokens[0];
        if (RE_CAMEL_TOKEN.test(tok) || RE_DOTTED.test(tok) || RE_KEBAB_SNAKE.test(tok) || RE_CONST.test(tok)) return false;
        if (RE_TAILWIND_TOKEN.test(tok)) return false;
        if (/^[a-z]+[A-Z]/.test(tok)) return false;
        if (RE_LOWER_IDENT.test(tok)) {
            // 单个全小写词：只在 children 位置保留（"or" / "and" / "to" 之类的连接词），其他上下文视为标识符
            if (kind !== 'children') return false;
            if (/[\d_$]/.test(tok)) return false;
        }
        if (/^[A-Za-z]$/.test(tok)) return false; // 单字母
        return true;
    }

    // 多 token：排除 tailwind class 串
    if (!hasUpper && tokens.some(tok => RE_TAILWIND_TOKEN.test(tok))) return false;
    if (tokens.every(tok => RE_TAILWIND_TOKEN.test(tok) || /^[a-z0-9-]+$/.test(tok)) && tokens.some(tok => /-|:|\[/.test(tok)) && !hasUpper) return false;
    // 全是 CSS 属性名 / 关键字之类的列表 "top, height, transform"
    if (/^([a-z-]+,\s*)+[a-z-]+$/.test(t)) return false;
    // 排除 "(prefers-color-scheme: dark)" 这类媒体查询
    if (/^\(.*\)$/.test(t) && /:/.test(t) && !hasUpper) return false;
    // 排除 shell 命令样式 "npm install foo" —— 以常见命令开头且无大写
    if (!hasUpper && /^(npm|npx|pnpm|yarn|git|node|python|pip|go|cargo|brew|apt|curl|wget|cd|ls|rm|mkdir|bash|sh|docker|kubectl|gcloud|blaze|bazel)\s/.test(t)) return false;
    return true;
}

function isSentenceLike(s) {
    const t = s.replace(RE_PLACEHOLDER, 'X').trim();
    if (!/\s/.test(t)) return false;
    return /^[A-Z]/.test(t) || /[.!?…]$/.test(t);
}

// ---------------------------------------------------------------------------
// AST 遍历
// ---------------------------------------------------------------------------

const KIND_PRIORITY = { children: 6, safeprop: 6, entity: 6, prop: 5, assign: 5, enummap: 4, weakprop: 3, callarg: 2, return: 2, template: 1 };

function templateKey(node) {
    let key = '';
    for (let i = 0; i < node.quasis.length; i++) {
        key += node.quasis[i].value.cooked == null ? node.quasis[i].value.raw : node.quasis[i].value.cooked;
        if (i < node.expressions.length) key += '${' + i + '}';
    }
    return key;
}

/**
 * 配额接口的 description 是服务端运行时生成的，不会作为字符串字面量出现在 main.js 中。
 * 这里只翻译已知、结构固定的配额提示，避免把普通服务端内容或会话正文误当成界面文案。
 * 此函数还会被序列化后内联进前端 bundle，因此必须保持完全自包含。
 */
function translateQuotaText(value) {
    if (typeof value !== 'string') return value;
    const labels = {
        'Gemini Models': 'Gemini 模型',
        'Weekly Limit Remaining': '每周剩余限额',
        'Five Hour Limit Remaining': '五小时剩余限额',
        'Claude and GPT models': 'Claude 和 GPT 模型',
    };
    if (Object.prototype.hasOwnProperty.call(labels, value)) return labels[value];

    const match = /^You have used (some|all) of your (weekly|daily|\d+-hour) limit, it will fully refresh in (.+)\.$/i.exec(value.trim());
    if (!match) return value;

    const amount = match[1].toLowerCase() === 'all' ? '全部' : '部分';
    const periodKey = match[2].toLowerCase();
    const hourLimit = /^(\d+)-hour$/.exec(periodKey);
    const period = periodKey === 'daily' ? '每日'
        : periodKey === 'weekly' ? '每周'
            : hourLimit[1] === '5' ? '五小时' : `${hourLimit[1]} 小时`;
    const duration = match[3]
        .replace(/\bless than (?:a|one) minute\b/gi, '不到 1 分钟')
        .replace(/\b(\d+)\s+weeks?\b/gi, '$1 周')
        .replace(/\b(\d+)\s+days?\b/gi, '$1 天')
        .replace(/\b(\d+)\s+hours?\b/gi, '$1 小时')
        .replace(/\b(\d+)\s+minutes?\b/gi, '$1 分钟')
        .replace(/\b(\d+)\s+seconds?\b/gi, '$1 秒')
        .replace(/,\s*/g, ' ');
    return `你已使用${amount}${period}限额，将在${duration}后完全恢复。`;
}

function isStringLiteral(n) {
    return n && n.type === 'Literal' && typeof n.value === 'string';
}

/**
 * 从一个“值表达式”中收集所有可能作为最终展示文本的叶子（字符串 / 模板字面量）。
 */
function collectLeaves(node, out, depth = 0) {
    if (!node || depth > 12) return;
    switch (node.type) {
        case 'Literal':
            if (typeof node.value === 'string') out.push(node);
            return;
        case 'TemplateLiteral':
            out.push(node);
            // `${cond ? "Stopped after" : "Worked for"} ${dur}`：插值里的条件分支文本也是展示文本
            for (const ex of node.expressions) {
                if (ex.type === 'ConditionalExpression' || ex.type === 'LogicalExpression' || ex.type === 'TemplateLiteral') collectLeaves(ex, out, depth + 1);
            }
            return;
        case 'ConditionalExpression':
            collectLeaves(node.consequent, out, depth + 1);
            collectLeaves(node.alternate, out, depth + 1);
            return;
        case 'LogicalExpression':
            if (node.operator === '||' || node.operator === '??') collectLeaves(node.left, out, depth + 1);
            collectLeaves(node.right, out, depth + 1);
            return;
        case 'SequenceExpression':
            collectLeaves(node.expressions[node.expressions.length - 1], out, depth + 1);
            return;
        case 'ArrayExpression':
            for (const el of node.elements) collectLeaves(el, out, depth + 1);
            return;
        case 'BinaryExpression':
            if (node.operator === '+') {
                collectLeaves(node.left, out, depth + 1);
                collectLeaves(node.right, out, depth + 1);
            }
            return;
        case 'ParenthesizedExpression':
            collectLeaves(node.expression, out, depth + 1);
            return;
        case 'ChainExpression':
            collectLeaves(node.expression, out, depth + 1);
            return;
        default:
            return;
    }
}

function isChildNode(v) {
    return v && typeof v === 'object' && typeof v.type === 'string';
}

/**
 * 对 AST 做一次遍历，返回：
 *   marked:        Map<node, {kind, key}>，node 为处于展示位置、通过全部过滤的 Literal / TemplateLiteral
 *   identifierUse: Set<string>，在“标识符位置”出现过的字符串值
 */
function analyze(ast, opts = {}) {
    const force = opts.force || null;
    const displayScope = opts.displayScope || null; // Map<string, {keys:Set|null, notWith:Set|null}>：scope = "display" 的键
    const inZone = opts.inZone || (() => -1);       // pos => 渲染库保护区下标
    const zoneDropped = [];             // 处于展示位置但落在保护区内而被放弃的 { key, kind, zone }
    const marked = new Map();           // node -> kind
    const identifierUse = new Set();
    const parentOf = new Map();
    const childrenLists = [];           // 每个 createElement 调用的 children 参数数组（用于复数后缀 "s" 的联动处理）
    const enumValueNodes = new Set();   // “枚举 -> 文案”映射表中的值节点：不计入标识符使用
    const propInfo = new Map();         // 叶子节点 -> { propKey, siblings }：来自对象属性值的展示文本（供 keys / notWith 限定使用）
    const strictIdentifierUse = new Set(); // 仅由 === / switch / 计算属性 / 查找方法实参 / 对象键 得到的标识符（不含“单 token 实参”启发式）

    const mark = (node, kind) => {
        const prev = marked.get(node);
        if (!prev || KIND_PRIORITY[kind] > KIND_PRIORITY[prev]) marked.set(node, kind);
    };
    const markLeaves = (expr, kind) => {
        const leaves = []; collectLeaves(expr, leaves);
        for (const l of leaves) mark(l, kind);
    };
    // 对象字面量 / createElement props 中的展示型键
    const markObjectProps = (obj) => {
        let sib = null;
        for (const pr of obj.properties) {
            const k = getKeyName(pr);
            if (!k) continue;
            let kind = null;
            if (ENTITY_KEYS.has(k)) kind = 'entity';
            else if (SAFE_KEYS.has(k)) kind = 'safeprop';
            else if (isStrongKey(k)) kind = 'prop';
            else if (WEAK_KEYS.has(k)) kind = 'weakprop';
            if (!kind) continue;
            const leaves = []; collectLeaves(pr.value, leaves);
            if (!leaves.length) continue;
            if (!sib) sib = new Set(obj.properties.map(getKeyName).filter(Boolean));
            for (const l of leaves) { mark(l, kind); if (!propInfo.has(l)) propInfo.set(l, { propKey: k, siblings: sib }); }
        }
    };
    const addIdent = (n) => { if (isStringLiteral(n)) { identifierUse.add(n.value); strictIdentifierUse.add(n.value); } };

    // 判断 node 是否处于非展示上下文：Error / console / 日志 / 比较 / throw / nls(key, text) / 代码键的值
    const inNonDisplayContext = (node) => {
        let cur = node, hops = 0;
        while (cur && hops < 6) {
            const p = parentOf.get(cur);
            if (!p) return false;
            if (p.type === 'BinaryExpression' && COMPARE_OPS.has(p.operator)) return true;
            if (p.type === 'SwitchCase' && p.test === cur) return true;
            if (p.type === 'ThrowStatement') return true;
            if (p.type === 'NewExpression' || p.type === 'CallExpression') {
                const ci = calleeInfo(p);
                if (ci.name && ERROR_CTORS.test(ci.name)) return true;
                if (ci.prop && ERROR_CTORS.test(ci.prop)) return true;
                if (ci.obj === 'console') return true;
                if (ci.prop === 'setAttribute' && p.arguments.length >= 2 && p.arguments[1] === cur && isStringLiteral(p.arguments[0]) && SAFE_ATTRS.has(p.arguments[0].value)) return false;
                if (isCreateElementCall(p)) return false;
                if (ci.prop && NON_DISPLAY_METHODS.has(ci.prop)) return true;
                if (p.type === 'CallExpression' && p.arguments.length >= 2 && isStringLiteral(p.arguments[0]) && p.arguments[0] !== cur && /^[\w.$-]+$/.test(p.arguments[0].value) && p.arguments.indexOf(cur) === 1) return true; // nls(key, text)
            }
            if (p.type === 'Property' && p.key === cur) return true;
            // 代码键（id/type/screen...）的直接值是标识符；但若属性值是函数（resolveOptionToDescription: b => "..."），其返回的文案仍是展示用途
            if (p.type === 'Property' && p.value === cur && !enumValueNodes.has(cur) && cur.type !== 'ArrowFunctionExpression' && cur.type !== 'FunctionExpression') {
                const k = getKeyName(p);
                if (k && !isStrongKey(k) && !WEAK_KEYS.has(k) && !SAFE_KEYS.has(k) && !ENTITY_KEYS.has(k)) return true;
            }
            if (p.type === 'MemberExpression' && p.computed && p.property === cur) return true;
            if (p.type === 'ImportExpression') return true;
            cur = p; hops++;
        }
        return false;
    };

    const isTitleCaseText = (v) => /^[A-Z]/.test(v) && looksLikeText(v, 'prop');

    // "Size"+n+"-Regular" / "sqrtSize"+k：单 token 字面量在 + 链里与非字面量操作数直接相邻（无空格边界），
    // 是在拼字体名 / 类名 / 标识符，不是文案（文案拼接总会带空格："Worked for "+x）
    const isGluedConcat = (node) => {
        const p = parentOf.get(node);
        if (!p || p.type !== 'BinaryExpression' || p.operator !== '+') return false;
        let root = p;
        for (let pp = parentOf.get(root); pp && pp.type === 'BinaryExpression' && pp.operator === '+'; pp = parentOf.get(root)) root = pp;
        const ops = [];
        (function flat(x) { if (x.type === 'BinaryExpression' && x.operator === '+') { flat(x.left); flat(x.right); } else ops.push(x); })(root);
        const i = ops.indexOf(node);
        const glued = (o) => !!o && !isStringLiteral(o) && o.type !== 'TemplateLiteral';
        return glued(ops[i - 1]) || glued(ops[i + 1]);
    };

    const stack = [ast];
    while (stack.length) {
        const node = stack.pop();

        // ---- 标识符位置采集 ----
        if (node.type === 'BinaryExpression' && COMPARE_OPS.has(node.operator)) {
            addIdent(node.left); addIdent(node.right);
        } else if (node.type === 'SwitchCase') {
            addIdent(node.test);
        } else if (node.type === 'MemberExpression' && node.computed) {
            addIdent(node.property);
        } else if (node.type === 'Property' && !node.computed) {
            if (node.key.type === 'Identifier') { identifierUse.add(node.key.name); strictIdentifierUse.add(node.key.name); }
            else addIdent(node.key);
            const k = getKeyName(node);
            if (k && !isStrongKey(k) && !WEAK_KEYS.has(k) && !SAFE_KEYS.has(k) && !ENTITY_KEYS.has(k) && !enumValueNodes.has(node.value)) addIdent(node.value);
        } else if (node.type === 'CallExpression' && !isCreateElementCall(node)) {
            const ci = calleeInfo(node);
            const lookupish = ci.prop && LOOKUP_METHODS.has(ci.prop);
            for (const a of node.arguments) {
                if (!isStringLiteral(a)) continue;
                if (lookupish) addIdent(a);
                else if (!/\s/.test(a.value)) identifierUse.add(a.value); // 单 token 实参：弱信号
            }
            if (lookupish && node.callee.object && node.callee.object.type === 'ArrayExpression') {
                for (const el of node.callee.object.elements) addIdent(el);
            }
        }

        // ---- 展示上下文识别 ----
        if (node.type === 'CallExpression') {
            if (isCreateElementCall(node)) {
                const props = node.arguments[1];
                if (props && props.type === 'ObjectExpression') markObjectProps(props);
                for (let i = 2; i < node.arguments.length; i++) markLeaves(node.arguments[i], 'children');
                if (node.arguments.length > 3) childrenLists.push(node.arguments.slice(2));
            } else {
                const ci = calleeInfo(node);
                if (ci.prop === 'setAttribute' && node.arguments.length >= 2 && isStringLiteral(node.arguments[0]) && SAFE_ATTRS.has(node.arguments[0].value)) {
                    markLeaves(node.arguments[1], 'safeprop');
                }
                const blocked = (ci.obj === 'console') || (ci.prop && NON_DISPLAY_METHODS.has(ci.prop)) || (ci.name && ERROR_CTORS.test(ci.name)) || (ci.prop && ERROR_CTORS.test(ci.prop));
                if (blocked && (ci.prop === 'push' || ci.prop === 'unshift')) {
                    // parts.push(`${c ? "Exploring" : "Explored"} ${f}`)：拼装摘要句子的常见写法，模板实参按展示处理
                    for (const a of node.arguments) if (a.type === 'TemplateLiteral' && a.expressions.length > 0) markLeaves(a, 'template');
                }
                if (!blocked) {
                    const nlsLike = node.arguments.length >= 2 && isStringLiteral(node.arguments[0]) && /^[\w.$-]+$/.test(node.arguments[0].value);
                    node.arguments.forEach((a, idx) => {
                        if (nlsLike && idx === 1) return;
                        if (isStringLiteral(a) || a.type === 'TemplateLiteral') {
                            if (!marked.has(a)) mark(a, 'callarg');
                        } else if (a.type === 'ConditionalExpression' || a.type === 'LogicalExpression') {
                            const leaves = []; collectLeaves(a, leaves);
                            for (const l of leaves) if (!marked.has(l)) mark(l, 'callarg');
                        }
                    });
                }
            }
        } else if (node.type === 'ObjectExpression') {
            markObjectProps(node);
            // 枚举 -> 文案 映射表：所有值都是字符串，且多数为 Title-case 文本
            const props = node.properties.filter(p => p.type === 'Property');
            if (props.length >= 2 && props.length === node.properties.length && props.every(p => isStringLiteral(p.value))) {
                const keys = props.map(getKeyName);
                if (!keys.some(k => k && (isStrongKey(k) || WEAK_KEYS.has(k) || k === 'className' || k === 'style'))) {
                    const vals = props.map(p => p.value.value);
                    const good = vals.filter(isTitleCaseText).length;
                    if (good >= Math.max(2, Math.ceil(vals.length * 0.6))) {
                        for (const p of props) if (isTitleCaseText(p.value.value)) { mark(p.value, 'enummap'); enumValueNodes.add(p.value); }
                    }
                }
            }
        } else if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'MemberExpression' && !node.left.computed && node.left.property.type === 'Identifier' && DOM_ASSIGN_PROPS.has(node.left.property.name)) {
            markLeaves(node.right, 'assign');
        } else if (node.type === 'ReturnStatement' && node.argument) {
            markLeaves(node.argument, 'return');
        } else if (node.type === 'ArrowFunctionExpression' && node.expression && node.body) {
            markLeaves(node.body, 'return');
        } else if ((node.type === 'VariableDeclarator' && node.init) || (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier')) {
            // let vK = "Terminal input" / h = "Open Project Picker" 这类先存到变量再渲染的句子
            // （要求多词且像句子，避免误伤代码常量；单词 / 无空格的值一律不算）
            const init = node.type === 'VariableDeclarator' ? node.init : node.right;
            const leaves = []; if (init.type !== 'ArrayExpression') collectLeaves(init, leaves);
            for (const l of leaves) {
                if (!isStringLiteral(l)) { if (l.type === 'TemplateLiteral' && l.expressions.length > 0 && !marked.has(l)) mark(l, 'template'); continue; }
                const t = l.value.trim();
                if (((/\s/.test(t) && (/^[A-Z]/.test(t) || /[.!?…]$/.test(t))) || RE_TITLE_WORD.test(t)) && !marked.has(l)) mark(l, 'return');
            }
        } else if (node.type === 'AssignmentPattern' && isStringLiteral(node.right)) {
            // 解构默认值：({ label: g = "Scroll to Bottom" }) / confirmLabel: h = "Install"
            const p = parentOf.get(node);
            const k = p && p.type === 'Property' ? getKeyName(p) : null;
            if (k && (isStrongKey(k) || SAFE_KEYS.has(k))) { mark(node.right, SAFE_KEYS.has(k) ? 'safeprop' : 'prop'); if (!propInfo.has(node.right)) propInfo.set(node.right, { propKey: k, siblings: new Set() }); }
            else if (k && WEAK_KEYS.has(k)) mark(node.right, 'weakprop');
            else { const t = node.right.value.trim(); if ((/\s/.test(t) && /^[A-Z]/.test(t)) || RE_TITLE_WORD.test(t)) mark(node.right, 'return'); }
        } else if (node.type === 'TemplateLiteral' && node.expressions.length > 0) {
            if (!marked.has(node)) mark(node, 'template');
        }

        // ---- 入栈子节点 ----
        for (const key in node) {
            if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
            const v = node[key];
            if (Array.isArray(v)) {
                for (const c of v) if (isChildNode(c)) { parentOf.set(c, node); stack.push(c); }
            } else if (isChildNode(v)) {
                parentOf.set(v, node); stack.push(v);
            }
        }
    }

    // ---- 二次过滤：文本形态 + 上下文排除 + 标识符冲突 ----
    const result = new Map();
    const blocked = new Map();          // 处于展示位置、但因在别处被当作标识符而未译的键 -> kinds
    for (const [node, kind] of marked) {
        const key = node.type === 'TemplateLiteral' ? templateKey(node) : node.value;
        const zi = inZone(node.start);
        if (zi >= 0) { zoneDropped.push({ key, kind, zone: zi }); continue; }
        if (isStringLiteral(node) && !/\s/.test(node.value) && isGluedConcat(node)) continue;
        if (kind === 'template' || kind === 'callarg' || kind === 'weakprop' || kind === 'return' || kind === 'enummap') {
            if (inNonDisplayContext(node)) continue;
        } else if (kind === 'entity') {
            // 实体标签对象本身就是展示用途
        } else {
            const p = parentOf.get(node);
            if (p && p.type === 'BinaryExpression' && COMPARE_OPS.has(p.operator)) continue;
        }
        const forced = force && force.has(key);
        if (!forced) {
            if (kind === 'entity') {
                if (!/^[A-Za-z][A-Za-z ]{1,40}$/.test(key)) continue;
            } else if (!looksLikeText(key, (kind === 'weakprop' || kind === 'return' || kind === 'enummap' || kind === 'safeprop') ? 'prop' : kind)) continue;
            if (kind === 'callarg' && !isSentenceLike(key)) continue;
            if (kind === 'weakprop' && !isSentenceLike(key) && !/\s/.test(key.trim())) continue;
            if (kind === 'return') {
                const t = key.trim();
                if (!((/\s/.test(t) && (/^[A-Z]/.test(t) || /[.!?…]$/.test(t))) || RE_TITLE_WORD.test(t))) continue;
            }
            if (kind === 'template' && !/[A-Za-z]{2,}/.test(key.replace(RE_PLACEHOLDER, ''))) continue;
        }
        // children 位置的节点只承担显示职责，替换绝对安全；其余类型若该字符串在别处被当作标识符使用，默认不译。
        // 字典里标为 scope:"display" 的键可以放宽（普通调用实参除外：nsb("Files") 这类可能是查找键）
        if (kind !== 'children' && kind !== 'safeprop' && kind !== 'entity' && identifierUse.has(key) && !(kind === 'enummap' && !strictIdentifierUse.has(key))) {
            if (!(displayScope && displayScope.has(key)) || kind === 'callarg' || kind === 'enummap') {
                if (!blocked.has(key)) blocked.set(key, new Set());
                blocked.get(key).add(kind);
                continue;
            }
        }
        // scope:"display" 的 keys / notWith 限定
        if (displayScope && displayScope.has(key)) {
            const ds = displayScope.get(key);
            const info = propInfo.get(node);
            if (ds.keys) {
                const pk = info ? info.propKey : (kind === 'children' ? 'children' : null);
                if (!pk || !ds.keys.has(pk)) continue;
            }
            if (ds.notWith && info && [...ds.notWith].some(sk => info.siblings.has(sk))) continue;
        }
        result.set(node, { kind, key });
    }
    return { marked: result, identifierUse, parentOf, childrenLists, blocked, zoneDropped };
}

function parse(src) {
    try {
        return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
    } catch (e) {
        return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    }
}

// ---------------------------------------------------------------------------
// 提取
// ---------------------------------------------------------------------------

/**
 * @returns {{ items: Array<{key:string, kinds:string[], count:number, risky:boolean, samples:string[]}>, stats: object }}
 */
function extract(src, opts = {}) {
    const sampleLen = opts.sampleLen || 90;
    const ast = parse(src);
    const lookup = opts.dict ? normalizeDict(opts.dict) : new Map();
    const { displayScope, allScope } = scopesOf(lookup);
    const zones = findProtectedZones(ast, src);
    const inZone = zoneIndexer(zones);
    const { marked, identifierUse, blocked, zoneDropped } = analyze(ast, { force: opts.force || null, displayScope, inZone });
    const byKey = new Map();
    const addSample = (e, node) => {
        if (e.samples.length < 2) e.samples.push(src.slice(Math.max(0, node.start - sampleLen), Math.min(src.length, node.end + sampleLen)).replace(/\s+/g, ' '));
    };
    for (const [node, { kind, key }] of marked) {
        let e = byKey.get(key);
        if (!e) { e = { key, kinds: new Set(), count: 0, samples: [] }; byKey.set(key, e); }
        e.kinds.add(kind);
        e.count++;
        addSample(e, node);
    }
    // scope:"all" 的键：统计整包内的全部字面量出现次数，并检查无法一致改名的位置（标识符键名 / 非计算成员名）
    const conflicts = new Map();
    const noteConflict = (k, what) => { if (!conflicts.has(k)) conflicts.set(k, []); const a = conflicts.get(k); if (!a.includes(what)) a.push(what); };
    if (allScope.size) {
        for (const node of allLiteralNodes(ast, allScope)) {
            const key = node.value;
            const zi = inZone(node.start);
            if (zi >= 0) { noteConflict(key, 'protected-zone: ' + zones[zi].label); continue; }
            let e = byKey.get(key);
            if (!e) { e = { key, kinds: new Set(), count: 0, samples: [] }; byKey.set(key, e); }
            e.kinds.add('all'); e.count++; addSample(e, node);
        }
        for (const [key, where] of findRenameConflicts(ast, allScope)) for (const w of where) noteConflict(key, w);
        for (const { node, tokens, sep } of splitListLiterals(ast, allScope)) {
            if (inZone(node.start) >= 0) continue;
            for (const t of new Set(tokens)) {
                if (!allScope.has(t)) continue;
                const zh = lookup.get(t).zh;
                noteConflict(t, zh && zh.includes(sep) ? `split-list-unsafe(sep=${JSON.stringify(sep)})` : 'split-list');
            }
        }
    }
    // 保护区报告：每段的名字 / 大小，以及区内“本来会被翻译”的字典命中（已拦下）
    const zoneReport = zones.map(z => ({ label: z.label, start: z.start, end: z.end, size: z.end - z.start, suppressed: {} }));
    const zoneKeys = new Set();
    for (const d of zoneDropped) {
        zoneKeys.add(d.key);
        const v = lookup.get(d.key);
        if (v && typeof v.zh === 'string' && v.zh !== d.key) { const sup = zoneReport[d.zone].suppressed; sup[d.key] = (sup[d.key] || 0) + 1; }
    }
    const items = [];
    for (const e of byKey.values()) {
        items.push({ key: e.key, kinds: [...e.kinds], count: e.count, risky: identifierUse.has(e.key), samples: e.samples });
    }
    items.sort((a, b) => a.key.localeCompare(b.key));
    const stats = { nodes: marked.size, unique: items.length, byKind: {} };
    for (const it of items) for (const k of it.kinds) stats.byKind[k] = (stats.byKind[k] || 0) + 1;
    return { items, stats, conflicts, blocked, zones: zoneReport, zoneKeys };
}

/** 从规范化字典中取出 scope 信息：displayScope: Map<key,{keys,notWith}>，allScope: Set<key> */
function scopesOf(lookup) {
    const displayScope = new Map(); const allScope = new Set();
    for (const [k, v] of lookup) {
        if (typeof v.zh !== 'string' || v.zh === k) continue;
        if (v.scope === 'display') displayScope.set(k, { keys: v.keys, notWith: v.notWith });
        else if (v.scope === 'all') allScope.add(k);
    }
    return { displayScope, allScope };
}

/**
 * "A B C".split(" ") 形式的列表字面量：scope:"all" 改名时其中的元素也要一起改，
 * 否则 "General Appearance ...".split(" ") 产出的英文键会与已改名的比较位置对不上。
 * 返回 [{ node: 被 split 的字符串字面量节点, sep, tokens }]
 */
function splitListLiterals(ast, keys) {
    const out = [];
    if (!keys.size) return out;
    const stack = [ast];
    while (stack.length) {
        const node = stack.pop();
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
            && node.callee.property.type === 'Identifier' && node.callee.property.name === 'split'
            && isStringLiteral(node.callee.object) && node.arguments.length >= 1 && isStringLiteral(node.arguments[0]) && node.arguments[0].value) {
            const sep = node.arguments[0].value;
            const tokens = node.callee.object.value.split(sep);
            if (tokens.length > 1 && tokens.some(t => keys.has(t))) out.push({ node: node.callee.object, sep, tokens });
        }
        for (const k in node) {
            if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
            const v = node[k];
            if (Array.isArray(v)) { for (const c of v) if (isChildNode(c)) stack.push(c); }
            else if (isChildNode(v)) stack.push(v);
        }
    }
    return out;
}

/** 遍历 AST，返回值命中 keys 的全部字符串字面量节点（跳过 "use strict" 指令与 import/export 的模块路径） */
function allLiteralNodes(ast, keys) {
    const out = [];
    const stack = [ast];
    while (stack.length) {
        const node = stack.pop();
        if (node.type === 'ExpressionStatement' && node.directive) continue;
        if (isStringLiteral(node) && keys.has(node.value)) out.push(node);
        for (const k in node) {
            if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
            if (k === 'source' && (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration')) continue;
            const v = node[k];
            if (Array.isArray(v)) { for (const c of v) if (isChildNode(c)) stack.push(c); }
            else if (isChildNode(v)) stack.push(v);
        }
    }
    return out;
}

/**
 * scope:"all" 整包改名做不到的位置：以标识符形式出现的对象键（{General: ...}）、非计算成员访问（x.General）、
 * 模板字面量的静态片段。这些位置不会被替换，需要维护者确认它们不与被改名的字符串值做比较。
 */
function findRenameConflicts(ast, keys) {
    const res = new Map();
    const add = (k, what) => { if (!res.has(k)) res.set(k, []); const a = res.get(k); if (a.length < 8) a.push(what); };
    const wordRe = new Map();
    for (const k of keys) wordRe.set(k, new RegExp('(^|[^A-Za-z0-9])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^A-Za-z0-9])'));
    const stack = [ast];
    while (stack.length) {
        const node = stack.pop();
        if (node.type === 'Property' && !node.computed && node.key.type === 'Identifier' && keys.has(node.key.name)) add(node.key.name, 'identifier-key');
        if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && keys.has(node.property.name)) add(node.property.name, 'member');
        if (node.type === 'TemplateLiteral') for (const q of node.quasis) { const s = q.value.cooked || ''; for (const [k, re] of wordRe) if (re.test(s)) add(k, 'template-fragment: ' + s.slice(0, 60)); }
        if (isStringLiteral(node) && !keys.has(node.value) && node.value.length < 200) { for (const [k, re] of wordRe) if (re.test(node.value)) add(k, 'literal-fragment: ' + node.value.slice(0, 60)); }
        for (const k in node) {
            if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
            const v = node[k];
            if (Array.isArray(v)) { for (const c of v) if (isChildNode(c)) stack.push(c); }
            else if (isChildNode(v)) stack.push(v);
        }
    }
    return res;
}

/** 把字典（值为 字符串 / null / "" / {zh, scope}）规范化为 Map<key, {zh, scope}> */
function placeholderCounts(text) {
    const counts = new Map();
    for (const token of text.match(/\$\{\d+\}/g) || []) counts.set(token, (counts.get(token) || 0) + 1);
    return counts;
}

// 省略参数必须明确声明；运行时还会确认它确实是英文复数后缀。
function validateTranslation(key, zh, entry = {}) {
    if (typeof zh !== 'string') return [];
    const source = placeholderCounts(key), target = placeholderCounts(zh);
    const omitted = entry.omitPlaceholders || [];
    const errors = [];
    if (!Array.isArray(omitted) || omitted.some(i => !Number.isInteger(i) || i < 0)) return ['omitPlaceholders 必须是非负整数数组'];
    for (const i of omitted) {
        const token = '${' + i + '}';
        if (!source.has(token) || target.has(token)) errors.push(`无效的省略声明 ${token}`);
    }
    for (const token of new Set([...source.keys(), ...target.keys()])) {
        if ((source.get(token) || 0) === (target.get(token) || 0)) continue;
        const index = Number(token.slice(2, -1));
        if (source.has(token) && !target.has(token) && omitted.includes(index)) continue;
        errors.push(`参数 ${token} 次数不一致`);
    }
    return errors;
}

function isPluralSuffix(node) {
    const suffix = n => isStringLiteral(n) && ['', 's', 'es'].includes(n.value);
    const pure = n => n && (n.type === 'Identifier' || n.type === 'Literal'
        || (n.type === 'MemberExpression' && pure(n.object) && (!n.computed || pure(n.property)))
        || (n.type === 'BinaryExpression' && pure(n.left) && pure(n.right)));
    return node && node.type === 'ConditionalExpression' && pure(node.test)
        && suffix(node.consequent) && suffix(node.alternate);
}

function normalizeDict(dict) {
    const out = new Map();
    const entries = dict instanceof Map ? dict.entries() : Object.entries(dict);
    for (const [k, v] of entries) {
        if (v === null || v === undefined) { out.set(k, { zh: null, scope: null }); continue; }
        if (typeof v === 'string') { out.set(k, { zh: v, scope: null }); continue; }
        if (typeof v === 'object') {
            const zh = typeof v.zh === 'string' ? v.zh : null;
            const scope = v.scope === 'all' || v.scope === 'display' ? v.scope : null;
            const keys = Array.isArray(v.keys) && v.keys.length ? new Set(v.keys) : null;
            const notWith = Array.isArray(v.notWith) && v.notWith.length ? new Set(v.notWith) : null;
            out.set(k, { zh, scope, keys, notWith, omitPlaceholders: v.omitPlaceholders, note: v.note });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// 替换
// ---------------------------------------------------------------------------

function escapeTemplateChunk(s) {
    return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * 把源码中处于展示位置、且命中字典的字面量替换为译文。
 * @param {string} src 原始 JS 源码
 * @param {Record<string,string|null>|Map<string,string|null>} dict 原文 -> 译文；值为 null / undefined / 空串 表示不翻译
 * @param {object} [opts]
 * @returns {{ code: string, replaced: number, matchedKeys: Set<string>, missing: Map<string, number>, zones: number, details?: Array }}
 *   opts.details = true 时额外返回每处替换的 { start, end, key, zh }（供工具统计）；zones 为渲染库保护区数量
 */
function translateSource(src, dict, opts = {}) {
    const ast = parse(src);
    const lookup = normalizeDict(dict);
    const force = new Set();
    for (const [k, v] of lookup) if (typeof v.zh === 'string' && v.zh !== k) force.add(k);
    const { displayScope, allScope } = scopesOf(lookup);
    const zones = findProtectedZones(ast, src);
    const inZone = zoneIndexer(zones);
    const { marked, parentOf, childrenLists } = analyze(ast, { force, displayScope, inZone });

    const reps = [];
    const repNodes = new Set();
    const matchedKeys = new Set();
    const missing = new Map();
    const rejected = new Map();
    const pushRep = (node, key, zh) => {
        if (repNodes.has(node)) return;
        const entry = lookup.get(key) || {};
        const errors = validateTranslation(key, zh, entry);
        if (errors.length) { rejected.set(key, errors); return; }
        if ((entry.omitPlaceholders || []).some(i => node.type !== 'TemplateLiteral' || !isPluralSuffix(node.expressions[i]))) {
            rejected.set(key, ['省略的参数不是可安全移除的英文复数后缀']);
            return;
        }
        matchedKeys.add(key);
        reps.push({ start: node.start, end: node.end, node, zh, key });
        repNodes.add(node);
    };
    for (const [node, { key }] of marked) {
        const v = lookup.get(key);
        const zh = v ? v.zh : undefined;
        if (zh == null || zh === key) {
            if (opts.collectMissing) missing.set(key, (missing.get(key) || 0) + 1);
            continue;
        }
        pushRep(node, key, zh);
    }
    // scope:"all"：整包内所有等于原文的字符串字面量一致改名（含比较、case、Map 键、调用实参），
    // 以及 "A B C".split(" ") 列表字面量里的对应元素
    // 渲染库保护区内的字面量一律跳过
    if (allScope.size) {
        for (const node of allLiteralNodes(ast, allScope)) { if (inZone(node.start) < 0) pushRep(node, node.value, lookup.get(node.value).zh); }
        for (const { node, sep, tokens } of splitListLiterals(ast, allScope)) {
            if (repNodes.has(node) || inZone(node.start) >= 0) continue;
            const out = tokens.map(t => allScope.has(t) ? lookup.get(t).zh : t);
            if (out.some((t, i) => t !== tokens[i] && t.includes(sep))) continue; // 译文含分隔符，改了会把列表拆坏
            const keysHit = tokens.filter(t => allScope.has(t));
            for (const k of keysHit) matchedKeys.add(k);
            reps.push({ start: node.start, end: node.end, node, zh: out.join(sep) });
            repNodes.add(node);
        }
    }

    // 配额摘要的 refreshText 来自接口字段（a.description），不是源码字面量。
    // 仅在同时具有 remainingFraction/subtext/disabled 的配额视图模型中包装该动态值，
    // 让已知配额句式在运行时进入受限翻译函数；其他 refreshText/description 均不处理。
    const runtimeTextFn = translateQuotaText.toString();
    const runtimeWrappedNodes = new Set();
    const wrapRuntimeText = (node) => {
        if (runtimeWrappedNodes.has(node)) return;
        reps.push({ start: node.start, end: node.end, node, runtimeTextFn });
        runtimeWrappedNodes.add(node);
    };
    const isInsideQuotaView = (node) => {
        let current = node;
        while ((current = parentOf.get(current))) {
            if (current.type !== 'FunctionDeclaration' && current.type !== 'FunctionExpression' && current.type !== 'ArrowFunctionExpression') continue;
            const functionSource = src.slice(current.start, current.end);
            if (/\.buckets\b/.test(functionSource) && /\bremainingFraction\b/.test(functionSource) && /\brefreshText\b/.test(functionSource)) return true;
        }
        return false;
    };
    for (const [node, parent] of parentOf) {
        if (!parent || inZone(node.start) >= 0) continue;
        if (parent.type === 'Property' && parent.value === node && getKeyName(parent) === 'refreshText'
            && !isStringLiteral(node) && node.type !== 'TemplateLiteral') {
            const obj = parentOf.get(parent);
            if (!obj || obj.type !== 'ObjectExpression') continue;
            const siblingKeys = new Set(obj.properties.map(getKeyName).filter(Boolean));
            if (siblingKeys.has('remainingFraction') && siblingKeys.has('subtext') && siblingKeys.has('disabled')) wrapRuntimeText(node);
            continue;
        }
        if (node.type !== 'MemberExpression' || node.computed || node.property.type !== 'Identifier' || node.property.name !== 'displayName') continue;
        const isLabelValue = parent.type === 'Property' && parent.value === node && getKeyName(parent) === 'label';
        const isElementChild = parent.type === 'CallExpression' && isCreateElementCall(parent) && parent.arguments.indexOf(node) >= 2;
        if ((isLabelValue || isElementChild) && isInsideQuotaView(node)) wrapRuntimeText(node);
    }

    // 复数后缀联动：children 序列中形如  n," item",n===1?"":"s"  的 "s"/"es" 分支，
    // 若其前面（2 个参数以内）有已翻译的字面量，则把整个条件表达式替换为 ""，避免出现“3 条评论s”
    const PLURAL = new Set(['', 's', 'es']);
    const isPluralCond = (a) => a && a.type === 'ConditionalExpression'
        && isStringLiteral(a.consequent) && isStringLiteral(a.alternate)
        && PLURAL.has(a.consequent.value) && PLURAL.has(a.alternate.value)
        && (a.consequent.value !== '' || a.alternate.value !== '');
    for (const args of childrenLists) {
        for (let i = 0; i < args.length; i++) {
            if (!isPluralCond(args[i])) continue;
            const prev = [args[i - 1], args[i - 2]].filter(Boolean);
            const translatedBefore = prev.some(p => repNodes.has(p) || (p.type === 'TemplateLiteral' && repNodes.has(p)));
            if (translatedBefore) reps.push({ start: args[i].start, end: args[i].end, node: { type: 'Literal' }, zh: '' });
        }
    }
    reps.sort((a, b) => a.start - b.start || b.end - a.end);

    let replaced = 0;
    function render(rangeStart, rangeEnd, list) {
        let out = '';
        let pos = rangeStart;
        let i = 0;
        while (i < list.length) {
            const r = list[i];
            if (r.start < pos) { i++; continue; }
            out += src.slice(pos, r.start);
            let j = i + 1;
            const inner = [];
            while (j < list.length && list[j].start < r.end) { inner.push(list[j]); j++; }
            out += renderNode(r, inner);
            replaced++;
            pos = r.end;
            i = j;
        }
        out += src.slice(pos, rangeEnd);
        return out;
    }
    function renderNode(r, inner) {
        const node = r.node;
        if (r.runtimeTextFn) {
            return '(' + r.runtimeTextFn + ')(' + render(node.start, node.end, inner) + ')';
        }
        if (node.type === 'Literal') return JSON.stringify(r.zh);
        const exprs = node.expressions;
        if (exprs.length === 0) return JSON.stringify(r.zh);
        const parts = r.zh.split(/(\$\{\d+\})/);
        let out = '`';
        for (const part of parts) {
            const m = /^\$\{(\d+)\}$/.exec(part);
            if (m) {
                const idx = Number(m[1]);
                if (idx < exprs.length) {
                    const ex = exprs[idx];
                    const sub = inner.filter(x => x.start >= ex.start && x.end <= ex.end);
                    out += '${' + render(ex.start, ex.end, sub) + '}';
                } else {
                    out += escapeTemplateChunk(part);
                }
            } else if (part) {
                out += escapeTemplateChunk(part);
            }
        }
        out += '`';
        return out;
    }

    const code = render(0, src.length, reps);
    const details = opts.details ? reps.filter(r => r.key !== undefined).map(r => ({ start: r.start, end: r.end, key: r.key, zh: r.zh })) : undefined;
    return { code, replaced, matchedKeys, missing, rejected, details, zones: zones.length };
}

module.exports = { extract, translateSource, translateQuotaText, normalizeDict, validateTranslation, findProtectedZones, looksLikeText, isSentenceLike, isStrongKey, templateKey, STRONG_KEYS, WEAK_KEYS };
