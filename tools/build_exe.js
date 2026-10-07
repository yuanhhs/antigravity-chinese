#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEMP_DIR = path.join(ROOT_DIR, 'temp');
const RELEASE_DIR = path.join(ROOT_DIR, 'release');
const BUNDLE_DIR = path.join(TEMP_DIR, 'bundle_stage');
const PAYLOAD_ZIP = path.join(TEMP_DIR, 'payload.zip');
const LAUNCHER_C = path.join(ROOT_DIR, 'tools', 'launcher.c');
const LAUNCHER_EXE = path.join(TEMP_DIR, 'launcher_base.exe');
const MAGIC = 'AGYZHZIP';

function ensureCleanDir(dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
}

function copyFileSafe(src, dest) {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, dest);
}

function copyDirSafe(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSafe(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function build(version = '2.21.0') {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本号格式应为 major.minor.patch');
    const OUTPUT_EXE = path.join(RELEASE_DIR, `v${version}.exe`);
    console.log('====== 开始构建 Antigravity 极致压缩单文件 EXE ======');

    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    if (!fs.existsSync(RELEASE_DIR)) fs.mkdirSync(RELEASE_DIR, { recursive: true });

    // 1. 收集所有运行时必需文件到暂存目录
    console.log('[1/4] 正在归集核心脚本与翻译字典...');
    ensureCleanDir(BUNDLE_DIR);

    copyFileSafe(path.join(ROOT_DIR, 'dictionary.js'), path.join(BUNDLE_DIR, 'dictionary.js'));
    copyFileSafe(path.join(ROOT_DIR, 'localization_engine.js'), path.join(BUNDLE_DIR, 'localization_engine.js'));
    copyFileSafe(path.join(ROOT_DIR, 'terminology.js'), path.join(BUNDLE_DIR, 'terminology.js'));
    copyFileSafe(path.join(ROOT_DIR, 'locales', 'zh-CN.json'), path.join(BUNDLE_DIR, 'locales', 'zh-CN.json'));
    copyDirSafe(path.join(ROOT_DIR, 'dicts_src'), path.join(BUNDLE_DIR, 'dicts_src'));
    copyDirSafe(path.join(ROOT_DIR, 'src_layer'), path.join(BUNDLE_DIR, 'src_layer'));
    copyFileSafe(path.join(ROOT_DIR, 'tools', 'localize_vscode_extension.js'), path.join(BUNDLE_DIR, 'tools', 'localize_vscode_extension.js'));
    copyFileSafe(path.join(ROOT_DIR, 'tools', 'localize_both.js'), path.join(BUNDLE_DIR, 'tools', 'localize_both.js'));

    // 计算未压缩体积
    let rawSize = 0;
    (function calc(dir) {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, f.name);
            if (f.isDirectory()) calc(p);
            else rawSize += fs.statSync(p).size;
        }
    })(BUNDLE_DIR);
    console.log(`      核心文件归集完成，原始未压缩大小: ${(rawSize / 1024).toFixed(2)} KB`);

    // 2. 压缩为 payload.zip
    console.log('[2/4] 正在进行极限压缩打包 (ZIP Deflate)...');
    if (fs.existsSync(PAYLOAD_ZIP)) fs.unlinkSync(PAYLOAD_ZIP);

    let zipSuccess = false;
    // 优先尝试使用 7z 最大压缩率
    try {
        execSync(`7z a -tzip -mx=9 "${PAYLOAD_ZIP}" "./*"`, { cwd: BUNDLE_DIR, stdio: 'ignore' });
        if (fs.existsSync(PAYLOAD_ZIP)) zipSuccess = true;
    } catch (e) {
        zipSuccess = false;
    }

    if (!zipSuccess) {
        // Fallback 到 powershell Compress-Archive
        console.log('      (7z 不可用，使用 PowerShell 压缩...)');
        execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${BUNDLE_DIR}\\*' -DestinationPath '${PAYLOAD_ZIP}' -CompressionLevel Optimal"`, { stdio: 'inherit' });
    }

    const zipSize = fs.statSync(PAYLOAD_ZIP).size;
    console.log(`      Payload 压缩完成，大小: ${(zipSize / 1024).toFixed(2)} KB (压缩率: ${((1 - zipSize / rawSize) * 100).toFixed(1)}%)`);

    // 3. 编译 C 语言极简 Launcher
    console.log('[3/4] 正在编译极简原生 Launcher (GCC -Os -s)...');
    if (!fs.existsSync(LAUNCHER_C)) {
        throw new Error(`未找到 Launcher 源码: ${LAUNCHER_C}`);
    }
    execSync(`gcc -Os -s -Wall -o "${LAUNCHER_EXE}" "${LAUNCHER_C}"`, { stdio: 'inherit' });
    const launcherSize = fs.statSync(LAUNCHER_EXE).size;
    console.log(`      Launcher 基础二进制编译成功，体积: ${(launcherSize / 1024).toFixed(2)} KB`);

    // 4. 将 payload 与魔数嵌入生成单文件 EXE
    console.log('[4/4] 正在嵌入 Payload 并封装单文件可执行程序...');
    const launcherBuf = fs.readFileSync(LAUNCHER_EXE);
    const zipBuf = fs.readFileSync(PAYLOAD_ZIP);

    // 构造长度和魔数尾部
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(zipBuf.length, 0);
    const magicBuf = Buffer.from(MAGIC, 'ascii');

    const totalExe = Buffer.concat([launcherBuf, zipBuf, lenBuf, magicBuf]);
    fs.writeFileSync(OUTPUT_EXE, totalExe);

    const totalSize = totalExe.length;
    console.log('\n======================================================');
    console.log('🎉 单文件 EXE 打包完成！');
    console.log(`📁 产物路径: ${OUTPUT_EXE}`);
    console.log(`📊 产物大小: ${(totalSize / 1024).toFixed(2)} KB  (${(totalSize / (1024 * 1024)).toFixed(3)} MB)`);
    console.log('======================================================\n');
}

if (require.main === module) {
    try {
        build(process.argv[2]);
    } catch (err) {
        console.error(`[构建失败] ${err.message}`);
        process.exit(1);
    }
}

module.exports = { build };
