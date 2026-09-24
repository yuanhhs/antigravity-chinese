const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const { loadDictionary, validateNativeMessages } = require('./dictionary');
const nativeMessages = require('./locales/zh-CN.json');

// 旧版 DOM 级汉化层（preload.js 里的 MutationObserver 引擎）的注入标记：已移除该层，仅用于清理历史注入
const LEGACY_DOM_SIGNATURE_START = "/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */";
const LEGACY_DOM_SIGNATURE_END = "/* --- ANTIGRAVITY CHINESE LOCALIZATION END --- */";

// ==========================================
// 源码级汉化层（拦截前端 bundle，按 AST 替换字面量）
// ==========================================
const SRC_SIGNATURE_START = "/* --- ANTIGRAVITY CHINESE LOCALIZATION SRC START --- */";
const SRC_SIGNATURE_END = "/* --- ANTIGRAVITY CHINESE LOCALIZATION SRC END --- */";
const srcDictsFolder = () => (typeof USE_TW !== 'undefined' && USE_TW) ? 'dicts_src_tw' : 'dicts_src';

function loadSrcDictionary() {
    const dir = path.join(__dirname, srcDictsFolder());
    if (!fs.existsSync(dir)) return null;
    return loadDictionary(dir);
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
        console.log(`[跳过] 未找到源码级字典目录 ${srcDictsFolder()}/，界面文案不会被汉化。`);
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


/** 清理旧版本注入到 preload.js 的 DOM 级汉化脚本（当前版本不再注入该层） */
function cleanLegacyDomLayer(content) {
    const regex = new RegExp(escapeRegExp(LEGACY_DOM_SIGNATURE_START) + "[\\s\\S]*?" + escapeRegExp(LEGACY_DOM_SIGNATURE_END), "g");
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

    // 3. preload.js：不再注入 DOM 级汉化脚本；若包里还残留旧版本注入的脚本则清理掉
    const preloadPath = path.join(tempDir, "dist", "preload.js");
    if (fs.existsSync(preloadPath)) {
        const content = fs.readFileSync(preloadPath, 'utf-8');
        if (content.includes(LEGACY_DOM_SIGNATURE_START)) {
            fs.writeFileSync(preloadPath, cleanLegacyDomLayer(content), 'utf-8');
            console.log(`[清理] 已移除 preload.js 中旧版本的 DOM 级汉化脚本。`);
        }
    }

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
    const translations = ${JSON.stringify(nativeMessages.menu)};
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
            if (Object.prototype.hasOwnProperty.call(translations, cleanLabel)) {
                item.label = translations[cleanLabel] + mnemonic;
            } else if (Object.prototype.hasOwnProperty.call(translations, label)) {
                item.label = translations[label];
            } else if (/^Version\\s*([\\d\\.]*)$/i.test(cleanLabel)) {
                item.label = cleanLabel.replace(/^Version\\s*([\\d\\.]*)$/i, (match, v) => v ? ${JSON.stringify(nativeMessages.status.version + " ")} + v : ${JSON.stringify(nativeMessages.status.version)});
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
    const translations = ${JSON.stringify(nativeMessages.tray)};
    for (const item of actions) {
        if (Object.prototype.hasOwnProperty.call(translations, item.label)) {
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
        const replacementCount = `countItem.label = count > 0 ? ${JSON.stringify(nativeMessages.status.agentsRunning)}.replace('\${0}', String(count)) : ${JSON.stringify(nativeMessages.tray['No agents running'])};`;
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
        const replacementText = '<div class="text">' + nativeMessages.status.loading + '</div>';
        
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
        const replacementOptions = `                title: ${JSON.stringify(nativeMessages.updater.title)},
                message: ${JSON.stringify(nativeMessages.updater.message)},
                buttons: [${JSON.stringify(nativeMessages.updater.confirm)}],`;
        
        updaterContent = updaterContent.replace(targetOptions, replacementOptions);
        fs.writeFileSync(updaterPath, updaterContent, 'utf-8');
        console.log(`[修改] 更新弹窗汉化注入成功！`);
    }

    // 3.5 注入源码级汉化层（拦截 language_server 下发的前端 bundle，按 AST 替换界面文案）
    console.log(`[修改] 正在注入源码级汉化层 (dist/agy_zh)...`);
    if (!injectSrcLayer(tempDir)) return false;

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
            // 旧版 DOM 层的品牌名显示选项，已随 DOM 层移除；为兼容旧命令行这里只跳过参数
            console.log("[提示] --brand-title 选项已移除（左上角品牌名保持官方英文），已忽略。");
            i++;
        }
    }

    // 修改安装包、关闭客户端前先校验全部词库。
    if (!huifu) {
        if (!loadSrcDictionary()) throw new Error('未找到界面词库');
        validateNativeMessages(nativeMessages);
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

    if (!isV2) {
        console.error(`[错误] 未在 ${resourcesDir} 找到 app.asar。本汉化包仅支持 Antigravity 2.x（Electron 架构）。`);
        process.exit(1);
    }

    if (huifu) {
        console.log("====== 正在卸载中文汉化，恢复官方原版 ======");
        success = restore20(resourcesDir);
    } else {
        console.log("====== 正在安装 Antigravity 中文汉化 ======");
        success = install20(resourcesDir);
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
