const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

const DICTS_FOLDER = 'dicts';
const BRAND_TITLE_ALIASES = {
    english: 'english',
    en: 'english',
    default: 'english',
    hidden: 'hidden',
    hide: 'hidden',
    none: 'hidden',
    translated: 'translated',
    chinese: 'translated',
    cn: 'translated',
    zh: 'translated'
};

function getOptionValue(name, defaultValue) {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === name) {
            return args[i + 1] || defaultValue;
        }
        if (args[i].startsWith(name + '=')) {
            return args[i].slice(name.length + 1);
        }
    }
    return defaultValue;
}

const BRAND_TITLE_MODE = BRAND_TITLE_ALIASES[String(getOptionValue('--brand-title', 'english')).toLowerCase()] || 'english';


const SIGNATURE_START = "/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */";
const SIGNATURE_END = "/* --- ANTIGRAVITY CHINESE LOCALIZATION END --- */";

// ==========================================
// 源码级汉化层（拦截前端 bundle，按 AST 替换字面量）
// ==========================================
const SRC_SIGNATURE_START = "/* --- ANTIGRAVITY CHINESE LOCALIZATION SRC START --- */";
const SRC_SIGNATURE_END = "/* --- ANTIGRAVITY CHINESE LOCALIZATION SRC END --- */";
const srcDictsFolder = () => (typeof USE_TW !== 'undefined' && USE_TW) ? 'dicts_src_tw' : 'dicts_src';

function loadSrcDictionary() {
    const dir = path.join(__dirname, srcDictsFolder());
    if (!fs.existsSync(dir)) return null;
    const merged = {};
    let files = 0;
    for (const file of fs.readdirSync(dir).sort()) {
        if (!file.endsWith('.json')) continue;
        try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
            for (const [k, v] of Object.entries(data)) {
                if (v === null || typeof v === 'string') merged[k] = v;
            }
            files++;
        } catch (e) {
            console.warn(`[警告] 源码级字典 ${file} 解析失败，已跳过: ${e.message}`);
        }
    }
    return files ? merged : null;
}

function cleanSrcBootstrap(content) {
    const regex = new RegExp(escapeRegExp(SRC_SIGNATURE_START) + "[\\s\\S]*?" + escapeRegExp(SRC_SIGNATURE_END) + "\\n?", "g");
    return content.replace(regex, "");
}

/**
 * 把源码级汉化层写入解包目录：dist/agy_zh/{acorn.js, agy_src_i18n.js, bootstrap.js, dict.json}
 * 并在 dist/main.js 的 "use strict" 之后挂载 require。
 */
function injectSrcLayer(tempDir) {
    const dict = loadSrcDictionary();
    if (!dict) {
        console.log(`[跳过] 未找到源码级字典目录 ${srcDictsFolder()}/，仅使用 DOM 层汉化。`);
        return false;
    }
    const mainPath = path.join(tempDir, "dist", "main.js");
    if (!fs.existsSync(mainPath)) {
        console.warn(`[警告] 未找到 dist/main.js，跳过源码级汉化层。`);
        return false;
    }
    const srcDir = path.join(__dirname, "src_layer");
    const required = ["acorn.js", "agy_src_i18n.js", "bootstrap.js"];
    for (const f of required) {
        if (!fs.existsSync(path.join(srcDir, f))) {
            console.warn(`[警告] 缺少 src_layer/${f}，跳过源码级汉化层。`);
            return false;
        }
    }
    const outDir = path.join(tempDir, "dist", "agy_zh");
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of required) fs.copyFileSync(path.join(srcDir, f), path.join(outDir, f));
    if (fs.existsSync(path.join(srcDir, "acorn.LICENSE"))) fs.copyFileSync(path.join(srcDir, "acorn.LICENSE"), path.join(outDir, "acorn.LICENSE"));
    fs.writeFileSync(path.join(outDir, "dict.json"), JSON.stringify(dict), 'utf-8');

    let main = cleanSrcBootstrap(fs.readFileSync(mainPath, 'utf-8'));
    const hook = SRC_SIGNATURE_START + "\n" +
        'try { require("./agy_zh/bootstrap.js"); } catch (e) { console.error("[agy-zh] source-level localization failed to load:", e); }' + "\n" +
        SRC_SIGNATURE_END + "\n";
    const marker = '"use strict";';
    const idx = main.indexOf(marker);
    if (idx !== -1) {
        const end = idx + marker.length;
        main = main.slice(0, end) + "\n" + hook + main.slice(end);
    } else {
        main = hook + main;
    }
    fs.writeFileSync(mainPath, main, 'utf-8');
    console.log(`[修改] 源码级汉化层注入成功（字典 ${Object.keys(dict).length} 条）！`);
    return true;
}

/** 卸载时清理源码级汉化的译文缓存（位于用户数据目录，安装时由运行时自动生成） */
function cleanSrcCache() {
    const candidates = [];
    if (process.platform === 'win32' && process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'Antigravity', 'zh-cn-src-cache'));
    if (process.platform === 'darwin' && process.env.HOME) candidates.push(path.join(process.env.HOME, 'Library', 'Application Support', 'Antigravity', 'zh-cn-src-cache'));
    if (process.platform === 'linux' && process.env.HOME) candidates.push(path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config'), 'Antigravity', 'zh-cn-src-cache'));
    for (const dir of candidates) {
        try {
            if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); console.log(`[清理] 已删除源码级汉化缓存: ${dir}`); }
        } catch (e) { /* ignore */ }
    }
}

/**
 * 读取 asar 头部，找出官方包里标记为 unpacked 的文件所在目录（如 node_modules/chrome-devtools-mcp），
 * 重新打包时用 --unpack-dir 保持一致，避免主进程按 app.asar.unpacked 路径找不到文件。
 */
function getAsarUnpackDirs(asarFile) {
    try {
        const fd = fs.openSync(asarFile, 'r');
        const head = Buffer.alloc(16);
        fs.readSync(fd, head, 0, 16, 0);
        const headerSize = head.readUInt32LE(12);
        const buf = Buffer.alloc(headerSize);
        fs.readSync(fd, buf, 0, headerSize, 16);
        fs.closeSync(fd);
        const header = JSON.parse(buf.toString('utf8').replace(/\0+$/, ''));
        const dirs = new Set();
        (function walk(node, prefix) {
            for (const [name, v] of Object.entries(node.files || {})) {
                if (v.files) walk(v, prefix + name + "/");
                else if (v.unpacked) {
                    const parts = (prefix + name).split("/");
                    dirs.add(parts[0] === "node_modules" && parts.length > 2 ? parts.slice(0, 2).join("/") : parts.slice(0, Math.max(1, parts.length - 1)).join("/"));
                }
            }
        })(header, "");
        return [...dirs];
    } catch (e) {
        return [];
    }
}


function normalizeText(text) {
    if (!text) return "";
    return text.replace(/\s+/g, ' ')
               .trim()
               .replace(/’/g, "'")
               .replace(/‘/g, "'")
               .replace(/“/g, '"')
               .replace(/”/g, '"')
               .replace(/…/g, '...');
}

function loadDictionary() {
    const totalMap = {};
    const dictsDir = path.join(__dirname, DICTS_FOLDER);
    if (fs.existsSync(dictsDir)) {
        const files = fs.readdirSync(dictsDir);
        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const filePath = path.join(dictsDir, file);
                    const fileContent = fs.readFileSync(filePath, 'utf-8');
                    const data = JSON.parse(fileContent);
                    for (const [k, v] of Object.entries(data)) {
                        const normK = normalizeText(k);
                        if (normK) totalMap[normK] = v;
                    }
                } catch (e) {
                    // ignore
                }
            }
        }
    }
    if (BRAND_TITLE_MODE === 'english') {
        delete totalMap[normalizeText('Antigravity')];
    } else if (BRAND_TITLE_MODE === 'hidden') {
        totalMap[normalizeText('Antigravity')] = '';
    }
    return totalMap;
}

function generateJs() {
    const fullDict = loadDictionary();
    const longEntries = Object.entries(fullDict).sort((a, b) => b[0].length - a[0].length);
    
    const dictJson = JSON.stringify(fullDict, null, 4);
    const entriesJson = JSON.stringify(longEntries);

    const jsSource = `${SIGNATURE_START}
(() => {
    // V12.0 终极隔离版：基于容器回溯的物理隔离引擎
    // 逻辑：不再仅仅检查当前标签，而是向上回溯父级，识别“代码/编辑器”禁区
    const map = new Map(Object.entries(DICT_PLACEHOLDER));
    const lowerMap = new Map();
    for (const [k, v] of map.entries()) lowerMap.set(k.toLowerCase(), v);
    
    const longEntries = REPLACEMENT_ENTRIES_PLACEHOLDER;
    const translatedValues = new WeakMap();

    // 轻量级安全隔离：跳过脚本、样式、代码块(pre/code)以及编辑器区域
    const SKIP_TAGS = ['SCRIPT', 'STYLE', 'PRE', 'CODE'];

    function isProtectedZone(node) {
        try {
            if (!node) return false;
            const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            if (!el || typeof el.closest !== 'function') return false;

            // 1. 代码块、Monaco编辑器、终端及用户可编辑区域
            if (el.closest('pre, code, .monaco-editor, [contenteditable="true"], .xterm, [class*="terminal"]')) {
                return true;
            }

            // 2. 项目列表与项目选择器（用户项目/文件夹名称，严禁被汉化字典误译）
            // 包含：侧边栏项目卡片 [data-project-card="true"]、项目选择器下拉项 [data-testid="project-selector-item"] / [data-project-name]、
            // 顶栏项目选择触发器 [data-testid="project-selector-trigger"] 以及面包屑导航 [data-testid="breadcrumb-segment"]
            if (el.closest('[data-project-card="true"], [data-testid="project-selector-item"], [data-project-name], [data-testid="project-selector-trigger"], [data-testid="breadcrumb-segment"]')) {
                return true;
            }

            // 3. 对话列表中的会话标题（会话标题属于用户/模型命名内容，严禁被字典替换为智能体、应用设置等）
            // 在侧边栏和历史对话列表中，[data-cascade-id] / [data-testid^="conversation-row-"] 内的 .grow 容器即为标题
            if (el.closest('[data-cascade-id], [data-testid^="conversation-row-"]') && el.closest('.grow, [class*="grow"]')) {
                return true;
            }

            // 4. 文件树与文件名选项卡（防止 agent.ts, app.py 等文件名或目录名被汉化）
            if (el.closest('[data-testid="file-title-name"], [data-testid="file-tree-node-icon"], [class*="group/tree"]')) {
                return true;
            }

            // 5. 对话正文区域（用户输入的消息和模型生成的思考与回答正文）
            if (el.closest('[data-testid="user-input-step"], [data-testid="planner-response-text"]')) {
                return true;
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    function norm(s) {
        if (!s) return '';
        return s.replace(/\\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').trim();
    }

    function translateWithShortcut(val) {
        if (!val) return null;
        const match = val.match(/^(.+?)\\s*\\((Ctrl|Cmd|Alt|Shift|⌘|⌥|⇧|⌃)\\+?([^)]*)\\)$/i);
        if (match) {
            const prefix = match[1].trim();
            const normPref = norm(prefix);
            const lowerPref = normPref.toLowerCase();
            let transPref = null;
            if (map.has(normPref)) {
                transPref = map.get(normPref);
            } else if (lowerMap.has(lowerPref)) {
                transPref = lowerMap.get(lowerPref);
            }
            if (transPref) {
                return transPref + " (" + match[2] + (match[3] ? "+" + match[3] : "") + ")";
            }
        }
        return null;
    }

    function translateNode(node) {
        try {
            if (!node) return;
            
            if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toUpperCase();
                if (SKIP_TAGS.includes(tag)) return;
                if (node.isContentEditable) return;
                if (node.classList && node.classList.contains('monaco-editor')) return;

                // 翻译属性：placeholder, title, aria-label
                for (const attr of ['placeholder', 'title', 'aria-label']) {
                    const v = node.getAttribute(attr);
                    if (v) {
                        // 处于保护区内的元素，跳过属性翻译
                        if (isProtectedZone(node)) continue;

                        // 对话列表行的主跳转链接 a[href^="/c/"]，其 aria-label 即为会话标题，不应翻译
                        if (attr === 'aria-label' && ((node.getAttribute('href') || '').startsWith('/c/') || node.closest?.('[data-cascade-id], [data-testid^="conversation-row-"]')?.querySelector?.('a') === node)) {
                            continue;
                        }

                        const t = norm(v);
                        const shortcutTrans = translateWithShortcut(t);
                        if (shortcutTrans) node.setAttribute(attr, shortcutTrans);
                        else if (/^Select project, current:/i.test(t)) {
                            const trans = t.replace(/^Select project, current:\s*(.*)$/i, (m, name) => {
                                return "选择项目，当前: " + name;
                            });
                            node.setAttribute(attr, trans);
                        }
                        else if (map.has(t)) node.setAttribute(attr, map.get(t));
                        else if (lowerMap.has(t.toLowerCase())) node.setAttribute(attr, lowerMap.get(t.toLowerCase()));
                        else if (/^Show\\s+(\\d+)\\s+more/i.test(t)) {
                            const trans = t.replace(/^Show\\s+(\\d+)\\s+more(\\s+(results?|items?|commands?|options?))?(\\.\\.\\.|…)?$/i, (m, num, p2, type) => {
                                if (type) {
                                    if (/result/i.test(type)) return "显示另外 " + num + " 个结果...";
                                    if (/command/i.test(type)) return "显示另外 " + num + " 个命令...";
                                    if (/item/i.test(type)) return "显示另外 " + num + " 个项目...";
                                    if (/option/i.test(type)) return "显示另外 " + num + " 个选项...";
                                }
                                return "显示另外 " + num + " 个...";
                            });
                            node.setAttribute(attr, trans);
                        }
                    }
                }

                if (node.shadowRoot) translateNode(node.shadowRoot);
                for (const child of node.childNodes) translateNode(child);

            } else if (node.nodeType === Node.TEXT_NODE) {
                if (isProtectedZone(node)) return;

                let originalVal = node.nodeValue;
                if (!originalVal || originalVal.trim().length < 1) return;

                // 核心：如果是 skeleton 骨架占位文本，强制打上不翻译标记，防止自动翻译（例如 Google Translate 网页翻译）将其翻译为“装。资料。包装。资料。”
                if (originalVal.toLowerCase().includes('pack.info')) {
                    const parent = node.parentElement;
                    if (parent) {
                        if (parent.getAttribute('translate') !== 'no') {
                            parent.setAttribute('translate', 'no');
                        }
                        try {
                            if (!parent.classList.contains('notranslate')) {
                                parent.classList.add('notranslate');
                            }
                        } catch (e) {}
                    }
                    return;
                }

                if (translatedValues.get(node) === originalVal) return;

                let newVal = originalVal;
                const valNorm = norm(originalVal);
                const valLower = valNorm.toLowerCase();
                
                // 1. 精确匹配（含大小写自动纠正与快捷键检测）
                const shortcutTrans = translateWithShortcut(valNorm);
                if (shortcutTrans) {
                    newVal = shortcutTrans;
                } else if (map.has(valNorm)) {
                    newVal = map.get(valNorm);
                } else if (lowerMap.has(valLower)) {
                    newVal = lowerMap.get(valLower);
                } else if (/^The AlloyDB for PostgreSQL remote/i.test(valNorm)) {
                    newVal = "AlloyDB for PostgreSQL 远程 MCP 服务器可让您访问并运行 AlloyDB 工具，用于管理 AlloyDB 集群及实例、管理用户，以及创建和恢复数据备份。";
                } else if (/^The Cloud SQL remote/i.test(valNorm)) {
                    newVal = "Cloud SQL 远程 MCP 服务器可让您访问并运行 Cloud SQL 工具，用于管理 Cloud SQL 实例、管理用户、创建和恢复数据备份及数据库运维。";
                } else if (/^The Spanner remote/i.test(valNorm)) {
                    newVal = "Spanner 远程 MCP 服务器可让您从 AI 开发环境中访问并运行 Spanner 工具，以创建、管理和查询分布式数据库资源。";
                } else if (/^Ask questions\.\s*Get answers\./i.test(valNorm) || /PostHog data/i.test(valNorm)) {
                    newVal = "提问，即得答案。该 MCP 是供您的编程智能体调用的服务器。用英语提出问题，它会针对您的 PostHog 数据运行查询，结果将直接呈现在您的编辑器中。";
                } else if (/^The GKE remote MCP server/i.test(valNorm)) {
                    newVal = "GKE 远程 MCP 服务器提供对 GKE Kubernetes 资源的读写权限。允许 AI 智能体检查并监控您的运行环境。";
                } else if (/^Cloud CLI MCP Server/i.test(valNorm)) {
                    newVal = "Cloud CLI MCP 服务器提供在远程沙箱环境中运行 gcloud 与 bq CLI 命令的工具集。";
                } else if (/^The Apigee API hub remote MCP server/i.test(valNorm)) {
                    newVal = "Apigee API hub 远程 MCP 服务器可让您管理注册在 Apigee API hub 中的 API、版本、规范、操作、部署、属性、外部 API 以及依赖项。";
                } else if (/^The Google Home Developer MCP server/i.test(valNorm)) {
                    newVal = "Google Home Developer MCP 服务器支持检索 Google Home 文档、OpenThread 与 Matter 规范文档。";
                } else if (/^The Cloud Quotas MCP server/i.test(valNorm)) {
                    newVal = "Cloud Quotas MCP 服务器支持查看配额分配、申请提升配额以及管理 Quota Adjuster 自动调整配置。";
                } else if (/^Build, edit, deploy, and manage full-stack web apps with Lovable/i.test(valNorm)) {
                    newVal = "使用自然语言，借助 AI 应用构建工具 Lovable 构建、编辑、部署和管理全栈 Web 应用。该 MCP 服务器将您的 AI 客户端连接至 Lovable，允许您的 AI 智能体直接在偏好的编辑器或助手中交互、创建和管理 Lovable 项目。";
                } else if (/^Build applications with the Gemini Interactions API and Live API/i.test(valNorm)) {
                    newVal = "使用 Gemini Interactions API 和 Live API 构建应用，涵盖文本生成、多轮对话、流式传输、函数调用、托管智能体以及实时音视频交互。";
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?, (\\d+) hours?\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?, (\\d+) hours?\\.?$/i, (match, d, h) => {
                        return d + " 天 " + h + " 小时后刷新";
                    });
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?, (\\d+) minutes?\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?, (\\d+) minutes?\\.?$/i, (match, h, m) => {
                        return h + " 小时 " + m + " 分钟后刷新";
                    });
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?\\.?$/i, (match, d) => {
                        return d + " 天后刷新";
                    });
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?\\.?$/i, (match, h) => {
                        return h + " 小时后刷新";
                    });
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) minutes?\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) minutes?\\.?$/i, (match, m) => {
                        return m + " 分钟后刷新";
                    });
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in less than a minute\\.?$/i.test(valNorm)) {
                    newVal = "不到 1 分钟后刷新";
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in a few seconds\\.?$/i.test(valNorm)) {
                    newVal = "几秒后刷新";
                } else if (/^Learn more about$/i.test(valNorm)) {
                    newVal = "了解更多关于";
                } else if (/^Learn more about (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Learn more about (.+)$/i, (match, p) => {
                        let translatedPreset = p;
                        const pLow = p.toLowerCase();
                        if (pLow === 'default' || pLow.includes('默认')) translatedPreset = "默认 (Default)";
                        else if (pLow === 'full machine' || pLow.includes('全机')) translatedPreset = "全机访问 (Full Machine)";
                        else if (pLow === 'turbo mode' || pLow.includes('极速')) translatedPreset = "极速模式 (Turbo Mode)";
                        else if (pLow === 'custom' || pLow.includes('自定义')) translatedPreset = "自定义 (Custom)";
                        return "了解更多关于 " + translatedPreset + " 的信息";
                    });
                } else if (/^Yes, and always allow '(.+)' in this project$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, and always allow '(.+)' in this project$/i, (match, cmd) => {
                        return "是，且在此项目中始终允许运行 '" + cmd + "'";
                    });
                } else if (/^Yes, and always allow '(.+)'$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, and always allow '(.+)'$/i, (match, cmd) => {
                        return "是，且始终允许运行 '" + cmd + "'";
                    });
                } else if (/^(\\d+) tools? enabled$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+) tools? enabled$/i, (match, num) => {
                        return num + " 个工具已启用";
                    });
                } else if (/^including\\s+(\\d+)\\s+active conversations?([.。])?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^including\\s+(\\d+)\\s+active conversations?([.。])?$/i, (match, num, punct) => {
                        const p = punct ? "。" : "";
                        return "（包含 " + num + " 个活跃会话）" + p;
                    });
                } else if (/^(Permanently delete\\s+)?(.+?)\\s+including\\s+(\\d+)\\s+active conversations?([.。])?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(Permanently delete\\s+)?(.+?)\\s+including\\s+(\\d+)\\s+active conversations?([.。])?$/i, (match, del, proj, num, punct) => {
                        const prefix = del ? "永久删除 " : "";
                        const p = punct ? "。" : "";
                        return prefix + proj + "（包含 " + num + " 个活跃会话）" + p;
                    });
                } else if (/^Show\\s+(\\d+)\\s+more(\\s+(results?|items?|commands?|options?))?(\\.\\.\\.|…)?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Show\\s+(\\d+)\\s+more(\\s+(results?|items?|commands?|options?))?(\\.\\.\\.|…)?$/i, (match, num, p2, type) => {
                        if (type) {
                            if (/result/i.test(type)) return "显示另外 " + num + " 个结果...";
                            if (/command/i.test(type)) return "显示另外 " + num + " 个命令...";
                            if (/item/i.test(type)) return "显示另外 " + num + " 个项目...";
                            if (/option/i.test(type)) return "显示另外 " + num + " 个选项...";
                        }
                        return "显示另外 " + num + " 个...";
                    });
                } else if (/^See all\\s*\\((\\d+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^See all\\s*\\((\\d+)\\)$/i, (match, num) => {
                        return "显示全部 (" + num + ")";
                    });
                } else if (/^Available AI Credits: (\\d+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Available AI Credits: (\\d+)$/i, (match, num) => {
                        return "可用 AI 额度: " + num;
                    });
                } else if (/^Version\\s+([\\d\\.]+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Version\\s+([\\d\\.]+)$/i, (match, v) => {
                        return "版本 " + v;
                    });
                } else if (/^(\\d+)(s|m|h|d|w|mo|yr)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+)(s|m|h|d|w|mo|yr)$/i, (match, num, unit) => {
                        const unitLower = unit.toLowerCase();
                        let unitStr = "";
                        if (unitLower === "s") unitStr = "秒前";
                        else if (unitLower === "m") unitStr = "分钟前";
                        else if (unitLower === "h") unitStr = "小时前";
                        else if (unitLower === "d") unitStr = "天前";
                        else if (unitLower === "w") unitStr = "周前";
                        else if (unitLower === "mo") unitStr = "个月前";
                        else if (unitLower === "yr") unitStr = "年前";
                        return num + unitStr;
                    });
                } else if (/^(.+?): context deadline exceeded$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(.+?): context deadline exceeded$/i, (match, prefix) => {
                        return prefix + ": 请求超时 (context deadline exceeded)";
                    });
                } else if (/^(.+?): i\\/o timeout$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(.+?): i\\/o timeout$/i, (match, prefix) => {
                        return prefix + ": I/O 超时 (i/o timeout)";
                    });
                } else if (/^Are you sure you want to delete (the |this )?project (.+?)\\??$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Are you sure you want to delete (the |this )?project (.+?)\\??$/i, (match, article, name) => {
                        return "您确定要删除项目 " + name + " 吗？";
                    });
                } else if (/^The (.+?) remote MCP server lets you access and run (.+?) tools to (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^The (.+?) remote MCP server lets you access and run (.+?) tools to (.+)$/i, (match, name, tools, action) => {
                        return name + " 远程 MCP 服务器可让您访问并运行 " + tools + " 工具以进行管理与操作。";
                    });
                } else if (/^The (.+?) remote MCP server lets you manage (.+) resources\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^The (.+?) remote MCP server lets you manage (.+) resources\\.?$/i, (match, name, res) => {
                        return name + " 远程 MCP 服务器可让您管理 " + res + " 资源。";
                    });
                } else if (/^Send feedback as(\\s+(.+))?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Send feedback as(\\s+(.+))?$/i, (match, p1, email) => {
                        if (email) {
                            return "以 " + email + " 身份发送反馈";
                        }
                        return "以如下身份发送反馈：";
                    });
                } else {
                    // 2. 长句子串滑动替换与前缀截断智能匹配 (缩短至前 18 字符即可高精度命中)
                    for (const [key, translated] of longEntries) {
                        if (key.length > 15 && valNorm.includes(key)) {
                            newVal = newVal.split(key).join(translated);
                            break;
                        } else if (key.length >= 18 && valNorm.length >= 18 && valLower.slice(0, 18) === key.slice(0, 18).toLowerCase()) {
                            newVal = translated;
                            break;
                        }
                    }
                }

                if (newVal !== originalVal) {
                    translatedValues.set(node, newVal);
                    node.nodeValue = newVal;
                }
            }
        } catch (e) {}
    }

    const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.type === 'childList') {
                for (const n of m.addedNodes) translateNode(n);
            } else if (m.type === 'characterData') {
                translateNode(m.target);
            }
        }
    });

    const obsOpts = { childList: true, subtree: true, characterData: true };

    const startEngine = () => {
        const target = document.body || document.documentElement;
        if (target) {
            try {
                observer.observe(target, obsOpts);
                translateNode(target);
            } catch (e) {}
        }
    };

    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function() {
        const sr = origAttachShadow.apply(this, arguments);
        try { observer.observe(sr, obsOpts); } catch(e) {}
        return sr;
    };

    // 强力多阶段触发绑定
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startEngine);
    } else {
        startEngine();
    }
    window.addEventListener('load', startEngine);
    setTimeout(startEngine, 100);
    setTimeout(startEngine, 300);
    setTimeout(startEngine, 1000);
    setTimeout(startEngine, 3000);
    setTimeout(startEngine, 6000);
})();
${SIGNATURE_END}`;

    return jsSource.replace("DICT_PLACEHOLDER", dictJson).replace("REPLACEMENT_ENTRIES_PLACEHOLDER", entriesJson);
}

function cleanJsContent(content) {
    const regex = new RegExp(escapeRegExp(SIGNATURE_START) + "[\\s\\S]*?" + escapeRegExp(SIGNATURE_END), "g");
    return content.replace(regex, "");
}

function cleanMenuJsContent(content) {
    const startMark = "// ==========================================";
    const endMark = "translateMenu(menu.items);";
    const startIdx = content.indexOf(startMark);
    const endIdx = content.indexOf(endMark);
    if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
        return content.substring(0, startIdx) + content.substring(endIdx + endMark.length);
    }
    return content;
}

function cleanTrayJsContent(content) {
    const startMark = "/* --- TRAY TRANSLATION START --- */";
    const endMark = "/* --- TRAY TRANSLATION END --- */";
    const startIdx = content.indexOf(startMark);
    const endIdx = content.indexOf(endMark);
    if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
        content = content.substring(0, startIdx) + content.substring(endIdx + endMark.length);
    }
    const dblStartMark = "/* --- TRAY DOUBLE CLICK START --- */";
    const dblEndMark = "/* --- TRAY DOUBLE CLICK END --- */";
    const dblStartIdx = content.indexOf(dblStartMark);
    const dblEndIdx = content.indexOf(dblEndMark);
    if (dblStartIdx !== -1 && dblEndIdx !== -1 && dblStartIdx < dblEndIdx) {
        content = content.substring(0, dblStartIdx) + content.substring(dblEndIdx + dblEndMark.length);
    }
    return content;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let wasAppRunning = false;

function checkIfAppIsRunning() {
    try {
        if (process.platform === 'win32') {
            const stdout = child_process.execSync('tasklist /fi "imagename eq Antigravity.exe" /nh', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return stdout.toLowerCase().includes('antigravity.exe');
        } else if (process.platform === 'darwin') {
            const stdout = child_process.execSync('pgrep -f Antigravity', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return stdout.trim().length > 0;
        }
    } catch (e) {
        // ignore
    }
    return false;
}

function closeAntigravityProcesses() {
    console.log("[1] 检测到 Antigravity 客户端正在运行，正在关闭以解除文件锁...");
    try {
        if (process.platform === 'win32') {
            child_process.execSync('taskkill /f /im Antigravity.exe /t >nul 2>nul');
        } else {
            child_process.execSync('pkill -f Antigravity >/dev/null 2>&1');
        }
    } catch (e) {
        // ignore
    }
    const start = Date.now();
    while (Date.now() - start < 1500) {}
}

function detectInstallationDir(manualDir) {
    if (manualDir) {
        if (fs.existsSync(manualDir)) {
            let resolved = path.resolve(manualDir);
            if (fs.statSync(resolved).isFile() && resolved.endsWith('app.asar')) {
                resolved = path.dirname(resolved);
            }
            return resolved;
        } else {
            console.error(`[错误] 手动指定的路径不存在: ${manualDir}`);
            process.exit(1);
        }
    }

    const candidates = [];
    const seenCandidates = new Set();
    const addCandidate = (candidate) => {
        if (!candidate) return;
        const normalized = path.resolve(candidate);
        const key = normalized.toLowerCase();
        if (!seenCandidates.has(key)) {
            candidates.push(normalized);
            seenCandidates.add(key);
        }
    };
    const hasAntigravityResources = (candidate) => {
        return fs.existsSync(path.join(candidate, "resources", "app.asar")) ||
            fs.existsSync(path.join(candidate, "app.asar")) ||
            fs.existsSync(path.join(candidate, "Contents", "Resources", "app.asar")) ||
            fs.existsSync(path.join(candidate, "resources", "app", "product.json"));
    };

    if (process.platform === 'win32') {
        addCandidate(process.env.ANTIGRAVITY_INSTALL_DIR);
        addCandidate(process.env.ANTIGRAVITY_HOME);

        const registryRoots = [
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
        ];
        for (const root of registryRoots) {
            try {
                const output = child_process.execSync(`reg query "${root}" /s /f Antigravity /d`, { encoding: 'utf-8', stdio: 'pipe' });
                for (const line of output.split(/\r?\n/)) {
                    const match = line.match(/^\s*(InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/i);
                    if (!match) continue;
                    let value = match[2].trim().replace(/^"|"$/g, '');
                    if (/Antigravity\.exe/i.test(value)) {
                        value = path.dirname(value);
                    }
                    addCandidate(value);
                }
            } catch (e) {
                // Registry probing is best-effort; fall back to common locations below.
            }
        }

        const driveLetters = ['C', 'D', 'E', 'F'];
        for (const drive of driveLetters) {
            addCandidate(`${drive}:\\Programs\\Antigravity`);
            addCandidate(`${drive}:\\Antigravity`);
        }
        addCandidate("C:\\Program Files\\Antigravity");

        const localAppdata = process.env.LOCALAPPDATA;
        if (localAppdata) {
            addCandidate(path.join(localAppdata, 'Programs', 'antigravity'));
        }
    } else if (process.platform === 'darwin') {
        addCandidate("/Applications/Antigravity.app");
        addCandidate(path.join(process.env.HOME || '', 'Applications', 'Antigravity.app'));
    }

    for (const p of candidates) {
        if (fs.existsSync(p) && hasAntigravityResources(p)) {
            console.log(`[探测] 成功自动识别到 Antigravity 安装目录: ${p}`);
            return path.resolve(p);
        }
    }

    console.error("[错误] 未找到默认安装目录，请使用 --install-dir 手动指定您的安装路径！");
    process.exit(1);
}

function runCommandSync(cmd) {
    try {
        const out = child_process.execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
        return { success: true, stdout: out, stderr: '' };
    } catch (e) {
        return { success: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
}

function resignAppOnMac(anyPath) {
    if (process.platform !== 'darwin') return;
    
    let targetApp = "";
    let current = path.resolve(anyPath);
    for (let i = 0; i < 10; i++) {
        if (current.endsWith(".app")) {
            targetApp = current;
            break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    
    if (targetApp && fs.existsSync(targetApp)) {
        console.log(`[签名] 检测到 macOS 平台，正在对应用包进行本地 ad-hoc 深度重签名: ${targetApp} ...`);
        const signRes = runCommandSync(`codesign --force --deep --sign - "${targetApp}"`);
        if (signRes.success) {
            console.log(`[签名] 重新签名成功！`);
        } else {
            console.warn(`[警告] 重新签名失败。可能会导致应用无法打开。详情:\n${signRes.stderr}\n${signRes.stdout}`);
        }
    } else {
        console.warn(`[警告] 未能从路径 ${anyPath} 识别到有效的 .app 路径，跳过重新签名。`);
    }
}

function ensureWritePermission(targetDir) {
    if (process.platform !== 'darwin') return true;
    try {
        fs.accessSync(targetDir, fs.constants.W_OK);
        return true;
    } catch (err) {
        if (process.getuid && process.getuid() !== 0) {
            console.log("[权限] 检测到当前用户对 macOS 应用目录缺少写入权限，正在尝试请求管理员权限 (sudo) 重新运行...");
            const args = process.argv.slice(1);
            const res = child_process.spawnSync('sudo', [process.execPath, ...args], {
                stdio: 'inherit'
            });
            if (res.status === 0) {
                process.exit(0);
            } else {
                console.error("\n[错误] 管理员提权执行失败或用户取消了密码输入。");
                process.exit(res.status || 1);
            }
        }
        return false;
    }
}

// ==========================================
// Antigravity 2.0 汉化引擎 (ASAR打包注入模式)
// ==========================================
function install20(resourcesDir) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");

    if (!fs.existsSync(asarPath)) {
        console.error(`[错误] 未在资源目录中找到 app.asar: ${resourcesDir}`);
        return false;
    }

    // 1. 备份
    if (!fs.existsSync(bakPath)) {
        console.log(`[备份] 正在创建官方原始包备份: app.asar.bak ...`);
        try {
            fs.copyFileSync(asarPath, bakPath);
            console.log(`[备份] 备份成功！`);
        } catch (e) {
            console.error(`[错误] 创建备份失败: ${e.message}`);
            if (process.platform === 'darwin' && e.code === 'EPERM') {
                console.error(`[提示] macOS 写入受限，请使用管理员权限运行脚本。`);
            }
            return false;
        }
    } else {
        // 尝试用官方备份覆盖当前 app.asar，以确保每次汉化都基于最干净的官方英文包
        try {
            fs.copyFileSync(bakPath, asarPath);
            console.log(`[还原] 已重置当前 app.asar 为官方原始备份包，以进行全新注入...`);
        } catch (e) {
            console.log(`[提示] 当前 app.asar 被锁定（可能是客户端正在运行），将使用当前包进行增量注入。`);
        }
    }

    // 2. 临时提取目录
    const tempDir = path.join(__dirname, "_temp_asar");
    if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log(`[解包] 正在使用 npx 提取 app.asar...`);
    const extractRes = runCommandSync(`npx -y @electron/asar extract "${asarPath}" "${tempDir}"`);
    if (!extractRes.success || !fs.existsSync(tempDir)) {
        console.error(`[错误] 解包失败，可能是由于系统未安装 Node.js/npm 或者网络限制。`);
        console.error(`详情: ${extractRes.stderr}\n${extractRes.stdout}`);
        return false;
    }

    // 3. 注入 preload.js
    const preloadPath = path.join(tempDir, "dist", "preload.js");
    if (!fs.existsSync(preloadPath)) {
        console.error(`[错误] 解压后未能在指定路径找到 preload.js: ${preloadPath}`);
        fs.rmSync(tempDir, { recursive: true, force: true });
        return false;
    }

    console.log(`[修改] 正在向 preload.js 注入汉化代码...`);
    let content = fs.readFileSync(preloadPath, 'utf-8');

    // 清理已有的汉化，重新注入
    const cleanedContent = cleanJsContent(content);
    const translationJs = generateJs();
    const newContent = cleanedContent + "\n" + translationJs;

    fs.writeFileSync(preloadPath, newContent, 'utf-8');
    console.log(`[修改] 注入成功！`);

    // 3.1 注入 menu.js (系统菜单汉化)
    const menuPath = path.join(tempDir, "dist", "menu.js");
    if (fs.existsSync(menuPath)) {
        console.log(`[修改] 正在向 menu.js 注入菜单汉化代码...`);
        let menuContent = fs.readFileSync(menuPath, 'utf-8');
        
        const menuCleaned = cleanMenuJsContent(menuContent);
        
        const menuTranslationJs = `
    // ==========================================
    // Antigravity Native Menu Chinese Translation
    // ==========================================
    const translations = {
        'File': '文件',
        'Edit': '编辑',
        'View': '视图',
        'Window': '窗口',
        'Help': '帮助',
        'New Window': '新建窗口',
        'Create Project': '创建项目',
        'Command Palette': '命令面板',
        'Docs': '文档',
        'Check for Updates': '检查更新',
        'Toggle Developer Tools': '切换开发者工具',
        'Undo': '撤销',
        'Redo': '重做',
        'Cut': '剪切',
        'Copy': '复制',
        'Paste': '粘贴',
        'Select All': '全选',
        'Minimize': '最小化',
        'Maximize': '最大化',
        'Close': '关闭',
        'Zoom': '缩放',
        'Reset Zoom': '重置缩放',
        'Zoom In': '放大',
        'Zoom Out': '缩小',
        'Toggle Full Screen': '切换全屏',
        'Split Terminal': '拆分终端',
        'Split Conversation Horizontally': '水平拆分会话',
        'Split Conversation Vertically': '垂直拆分会话',
        'Find in conversation': '在会话中查找',
        'Version': '版本'
    };
    function translateMenu(items) {
        for (const item of items) {
            let label = item.label || '';
            let mnemonic = '';
            let cleanLabel = label;
            const m = label.match(/&([a-zA-Z])/);
            if (m) {
                mnemonic = "(&" + m[1] + ")";
                cleanLabel = label.replace('&', '');
            }
            if (translations[cleanLabel]) {
                item.label = translations[cleanLabel] + mnemonic;
            } else if (translations[label]) {
                item.label = translations[label];
            } else if (/^Version\\s*([\\d\\.]*)$/i.test(cleanLabel)) {
                item.label = cleanLabel.replace(/^Version\\s*([\\d\\.]*)$/i, (match, v) => v ? "版本 " + v : "版本");
            }
            if (item.submenu && item.submenu.items) {
                translateMenu(item.submenu.items);
            }
        }
    }
    translateMenu(menu.items);
    `;

        const targetStr = "electron_1.Menu.setApplicationMenu(menu);";
        const idx = menuCleaned.indexOf(targetStr);
        if (idx !== -1) {
            const patchedMenuContent = menuCleaned.substring(0, idx) + menuTranslationJs + "\n    " + menuCleaned.substring(idx);
            fs.writeFileSync(menuPath, patchedMenuContent, 'utf-8');
            console.log(`[修改] 菜单汉化注入成功！`);
        } else {
            console.warn(`[警告] 未能在 menu.js 中找到设定的插入点。`);
        }
    }

    // 3.2 注入 tray.js (任务栏右键菜单汉化)
    const trayPath = path.join(tempDir, "dist", "tray.js");
    if (fs.existsSync(trayPath)) {
        console.log(`[修改] 正在向 tray.js 注入任务栏菜单汉化...`);
        let trayContent = fs.readFileSync(trayPath, 'utf-8');
        
        // 先清理已有的汉化块
        let trayCleaned = cleanTrayJsContent(trayContent);
        
        // 1. 注入 createTray 里的翻译块 (带标记)
        const targetCreate = "function createTray(actions) {";
        const replacementCreate = `function createTray(actions) {
    /* --- TRAY TRANSLATION START --- */
    const translations = {
        'No agents running': '无运行中的智能体',
        'Open Antigravity': '打开反重力智能编程',
        'Quit': '退出'
    };
    for (const item of actions) {
        if (translations[item.label]) {
            item.label = translations[item.label];
        }
    }
    /* --- TRAY TRANSLATION END --- */`;
        
        let trayPatched = trayCleaned.replace(targetCreate, replacementCreate);
        
        // 2. 注入托盘图标双击弹出/聚焦 Antigravity 界面事件
        const dblClickTarget = /tray\.setContextMenu\(contextMenu\);/;
        const dblClickReplacement = `tray.setContextMenu(contextMenu);
    /* --- TRAY DOUBLE CLICK START --- */
    const openAction = actions.find(item => item && typeof item.click === 'function' && !['Quit', '退出', '結束'].includes(item.label));
    if (openAction) {
        tray.on('double-click', () => {
            const wins = electron_1.BrowserWindow.getAllWindows();
            if (wins.length > 0 && wins[0].isMinimized()) {
                wins[0].restore();
            }
            openAction.click();
        });
    }
    /* --- TRAY DOUBLE CLICK END --- */`;
        trayPatched = trayPatched.replace(dblClickTarget, dblClickReplacement);

        // 3. 使用正则替换 updateTrayAgentCount 里的动态显示文本
        const countRegex = /countItem\.label\s*=\s*\([\s\S]*?' running';/g;
        const replacementCount = "countItem.label = count > 0 ? `${count} 个智能体运行中` : '无运行中的智能体';";
        trayPatched = trayPatched.replace(countRegex, replacementCount);
        
        fs.writeFileSync(trayPath, trayPatched, 'utf-8');
        console.log(`[修改] 任务栏菜单汉化注入成功！`);
    }

    // 3.3 注入 loadingOverlay.js (加载页汉化)
    const loadingPath = path.join(tempDir, "dist", "loadingOverlay.js");
    if (fs.existsSync(loadingPath)) {
        console.log(`[修改] 正在向 loadingOverlay.js 注入加载页汉化...`);
        let loadingContent = fs.readFileSync(loadingPath, 'utf-8');
        
        const targetText = '<div class="text">Loading Antigravity</div>';
        const replacementText = '<div class="text">反重力引擎已启动，正在努力摆脱地心引力...</div>';
        
        loadingContent = loadingContent.replace(targetText, replacementText);
        
        fs.writeFileSync(loadingPath, loadingContent, 'utf-8');
        console.log(`[修改] 加载页汉化注入成功！`);
    }

    // 3.4 注入 updater.js (更新弹窗汉化)
    const updaterPath = path.join(tempDir, "dist", "updater.js");
    if (fs.existsSync(updaterPath)) {
        console.log(`[修改] 正在向 updater.js 注入更新弹窗汉化...`);
        let updaterContent = fs.readFileSync(updaterPath, 'utf-8');
        
        // 替换 Check for Updates 弹窗的属性
        const targetOptions = `                title: 'Check for Updates',
                message: 'No updates available',
                buttons: ['OK'],`;
        const replacementOptions = `                title: '检查更新',
                message: '暂无可用更新',
                buttons: ['确定'],`;
        
        updaterContent = updaterContent.replace(targetOptions, replacementOptions);
        fs.writeFileSync(updaterPath, updaterContent, 'utf-8');
        console.log(`[修改] 更新弹窗汉化注入成功！`);
    }

    // 3.5 注入源码级汉化层（拦截 language_server 下发的前端 bundle，按 AST 替换界面文案）
    console.log(`[修改] 正在注入源码级汉化层 (dist/agy_zh)...`);
    injectSrcLayer(tempDir);

    // 4. 重新打包
    console.log(`[打包] 正在将修改后的内容打包回 app.asar...`);
    const unpackDirs = getAsarUnpackDirs(fs.existsSync(bakPath) ? bakPath : asarPath);
    const unpackArg = unpackDirs.length === 0 ? "" : (unpackDirs.length === 1 ? ` --unpack-dir "${unpackDirs[0]}"` : ` --unpack-dir "{${unpackDirs.join(",")}}"`);
    if (unpackArg) console.log(`[打包] 保持 unpacked 目录: ${unpackDirs.join(", ")}`);
    const packRes = runCommandSync(`npx -y @electron/asar pack "${tempDir}" "${asarPath}"${unpackArg}`);
    
    // 5. 清理临时文件夹
    fs.rmSync(tempDir, { recursive: true, force: true });

    if (!packRes.success) {
        console.error(`[错误] 打包失败。`);
        console.error(`详情: ${packRes.stderr}\n${packRes.stdout}`);
        return false;
    }

    resignAppOnMac(resourcesDir);
    console.log(`[√] Antigravity 2.0 汉化部署完成！`);
    return true;
}

function restore20(resourcesDir) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");

    if (!fs.existsSync(bakPath)) {
        console.log("[!] 未找到备份文件 app.asar.bak，可能尚未安装过汉化或备份被删除。");
        return false;
    }

    console.log("[还原] 正在用官方备份文件恢复...");
    cleanSrcCache();
    try {
        fs.copyFileSync(bakPath, asarPath);
        fs.unlinkSync(bakPath);
    } catch (e) {
        console.error(`[错误] 恢复备份失败: ${e.message}`);
        if (process.platform === 'darwin' && e.code === 'EPERM') {
            console.error(`[提示] macOS 写入受限，请使用管理员权限运行脚本。`);
        }
        return false;
    }
    resignAppOnMac(resourcesDir);
    console.log("[√] 官方 app.asar 已成功恢复！");
    return true;
}

// ==========================================
// Antigravity 1.0 汉化引擎 (旧版 HTML 注入模式)
// ==========================================
const OLD_TARGET_FILES = [
    path.join("resources", "app", "out", "vs", "code", "electron-browser", "workbench", "workbench-jetski-agent.html"),
    path.join("resources", "app", "out", "vs", "code", "electron-browser", "workbench", "workbench.html")
];

function backupFiles10(installDir) {
    for (const relPath of OLD_TARGET_FILES) {
        const absPath = path.join(installDir, relPath);
        const bakPath = absPath + ".bak";
        if (fs.existsSync(absPath) && !fs.existsSync(bakPath)) {
            fs.copyFileSync(absPath, bakPath);
            console.log(`[备份] 已创建旧版 HTML 备份: ${path.basename(absPath)}.bak`);
        }
    }
}

function injectHtml10(installDir, htmlRelPath) {
    const absPath = path.join(installDir, htmlRelPath);
    if (!fs.existsSync(absPath)) return false;
    
    let content = fs.readFileSync(absPath, 'utf-8');
    
    const injectStr = '<script src="../../../../ag_agent_hanhua.js"></script>';
    content = content.replace(/<script.*ag_agent_hanhua\.js.*><\/script>/g, '');
    
    if (content.includes('</body>')) {
        content = content.replace('</body>', `${injectStr}</body>`);
    } else {
        content += injectStr;
    }
        
    fs.writeFileSync(absPath, content, 'utf-8');
    return true;
}

function updateChecksums10(installDir) {
    const productJsonPath = path.join(installDir, "resources", "app", "product.json");
    if (!fs.existsSync(productJsonPath)) return;
    
    const data = JSON.parse(fs.readFileSync(productJsonPath, 'utf-8'));
    
    for (const relPath of OLD_TARGET_FILES) {
        const absPath = path.join(installDir, relPath);
        if (fs.existsSync(absPath)) {
            const key = relPath.replace(/\\/g, "/").replace("resources/app/out/", "");
            
            const fileBuffer = fs.readFileSync(absPath);
            const hash = crypto.createHash('sha256').update(fileBuffer).digest();
            data.checksums[key] = hash.toString('base64').replace(/=/g, '');
        }
    }
    
    fs.writeFileSync(productJsonPath, JSON.stringify(data, null, '\t'), 'utf-8');
}

function install10(installDir) {
    console.log("====== 检测到 Antigravity 1.0 架构，正在使用 HTML 注入引擎 ======");
    backupFiles10(installDir);
    
    // 生成单独的 js 汉化文件
    const hanhuaJsPath = path.join(installDir, "resources", "app", "out", "ag_agent_hanhua.js");
    fs.mkdirSync(path.dirname(hanhuaJsPath), { recursive: true });
    
    const jsContent = generateJs();
    fs.writeFileSync(hanhuaJsPath, jsContent, 'utf-8');
        
    for (const html of OLD_TARGET_FILES) {
        if (injectHtml10(installDir, html)) {
            console.log(`[√] 注入成功: ${path.basename(html)}`);
        }
    }
            
    updateChecksums10(installDir);
    resignAppOnMac(installDir);
    console.log("[√] Antigravity 1.0 汉化部署完成！");
    return true;
}

function restore10(installDir) {
    console.log("====== 正在恢复 Antigravity 1.0 官方原版 ======");
    let changed = false;
    for (const relPath of OLD_TARGET_FILES) {
        const absPath = path.join(installDir, relPath);
        const bakPath = absPath + ".bak";
        if (fs.existsSync(bakPath)) {
            fs.copyFileSync(bakPath, absPath);
            fs.unlinkSync(bakPath);
            console.log(`[还原] 已恢复 HTML: ${path.basename(absPath)}`);
            changed = true;
        }
    }
    
    const hanhuaJsPath = path.join(installDir, "resources", "app", "out", "ag_agent_hanhua.js");
    if (fs.existsSync(hanhuaJsPath)) {
        fs.unlinkSync(hanhuaJsPath);
        console.log(`[还原] 已删除汉化脚本`);
        changed = true;
    }
        
    if (changed) {
        updateChecksums10(installDir);
        resignAppOnMac(installDir);
        console.log("[√] 校验值已同步，1.0 软件恢复至原始状态。");
    } else {
        console.log("[!] 未找到 1.0 备份文件。");
    }
    return true;
}

// ==========================================
// 入口
// ==========================================
function main() {
    let huifu = false;
    let manualDir = "";
    let noKill = false;

    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--huifu') {
            huifu = true;
        } else if (args[i] === '--install-dir') {
            manualDir = args[i + 1] || "";
            i++;
        } else if (args[i] === '--no-kill') {
            noKill = true;
        } else if (args[i] === '--brand-title') {
            i++;
        }
    }

    // 1. 探测路径
    const installDir = detectInstallationDir(manualDir);
    
    // 2. 检测客户端是否正在运行，并根据参数决定是否关闭以解除文件锁定
    wasAppRunning = checkIfAppIsRunning();
    if (noKill) {
        console.log("[跳过] 检测到 --no-kill 参数，跳过关闭 Antigravity 运行进程。");
    } else {
        closeAntigravityProcesses();
    }

    // 3. 找到 resources 资源目录
    let resourcesDir = "";
    if (fs.existsSync(path.join(installDir, "resources"))) {
        resourcesDir = path.join(installDir, "resources");
    } else if (fs.existsSync(path.join(installDir, "Contents", "Resources"))) {
        resourcesDir = path.join(installDir, "Contents", "Resources");
    } else if (installDir.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase().endsWith("/resources")) {
        resourcesDir = installDir;
    } else {
        if (fs.existsSync(path.join(installDir, "app.asar"))) {
            resourcesDir = installDir;
        } else {
            resourcesDir = path.join(installDir, "resources");
        }
    }

    if (!fs.existsSync(resourcesDir)) {
        console.error(`[错误] 无法定位有效的资源(resources)目录: ${resourcesDir}`);
        process.exit(1);
    }

    ensureWritePermission(resourcesDir);

    // 4. 根据架构执行
    const asarPath = path.join(resourcesDir, "app.asar");
    const isV2 = fs.existsSync(asarPath);
    let success = false;

    if (huifu) {
        console.log("====== 正在卸载中文汉化，恢复官方原版 ======");
        if (isV2) {
            success = restore20(resourcesDir);
        } else {
            success = restore10(installDir);
        }
    } else {
        console.log("====== 正在安装 Antigravity 中文汉化 ======");
        if (isV2) {
            success = install20(resourcesDir);
        } else {
            success = install10(installDir);
        }
    }

    // 5. 校验通过且原来客户端在运行，则自动重新启动客户端
    if (success && wasAppRunning) {
        console.log("\n[启动] 检测到安装前反重力客户端处于开启状态，正在重新启动客户端...");
        try {
            if (process.platform === 'win32') {
                const exePath = path.join(installDir, 'Antigravity.exe');
                if (fs.existsSync(exePath)) {
                    const child = child_process.spawn(exePath, [], {
                        detached: true,
                        stdio: 'ignore'
                    });
                    child.unref();
                    console.log("[启动] 客户端启动成功！");
                } else {
                    console.warn(`[警告] 未找到客户端主程序: ${exePath}`);
                }
            } else if (process.platform === 'darwin') {
                child_process.exec(`open "${installDir}"`);
                console.log("[启动] 客户端启动成功！");
            }
        } catch (e) {
            console.warn(`[警告] 客户端启动失败: ${e.message}`);
        }
    }

    if (!success) {
        process.exit(1);
    }
}

main();
