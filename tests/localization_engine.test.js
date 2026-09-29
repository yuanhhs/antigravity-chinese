'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readAsarMetadata, prepareOfficialBackup } = require('../localization_engine');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-backup-test-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return path.join(dir, 'app.asar');
}

function archive(version, { patched = false, main = '"use strict";', preload = '' } = {}) {
    const pkg = Buffer.from(JSON.stringify({ version }));
    const mainBuffer = Buffer.from(main);
    const preloadBuffer = Buffer.from(preload);
    const dist = {
        'main.js': { size: mainBuffer.length, offset: String(pkg.length) },
        'preload.js': { size: preloadBuffer.length, offset: String(pkg.length + mainBuffer.length) },
    };
    if (patched) dist.agy_zh = { files: {} };
    const header = Buffer.from(JSON.stringify({ files: {
        'package.json': { size: pkg.length, offset: '0' }, dist: { files: dist },
    } }));
    const padded = Math.ceil(header.length / 4) * 4;
    const head = Buffer.alloc(16 + padded);
    head.writeUInt32LE(4, 0);
    head.writeUInt32LE(padded + 8, 4);
    head.writeUInt32LE(padded + 4, 8);
    head.writeUInt32LE(header.length, 12);
    header.copy(head, 16);
    return Buffer.concat([head, pkg, mainBuffer, preloadBuffer]);
}

test('官方升级后备份更新到新版本，并保留旧备份和当前应用', t => {
    const target = fixture(t);
    const old = archive('2.17.0');
    const current = archive('2.18.1');
    fs.writeFileSync(target, current);
    fs.writeFileSync(target + '.bak', old);
    assert.equal(prepareOfficialBackup(target), target + '.bak');
    assert.deepEqual(fs.readFileSync(target), current);
    assert.deepEqual(fs.readFileSync(target + '.bak'), current);
    const saved = fs.readdirSync(path.dirname(target)).find(name => name.startsWith('app.asar.bak.2.17.0.'));
    assert.ok(saved);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(target), saved)), old);
});

test('同版本重复汉化沿用官方备份；官方同版本重打包则刷新备份', t => {
    const target = fixture(t);
    const original = archive('2.18.1');
    fs.writeFileSync(target, original);
    prepareOfficialBackup(target);
    const patched = archive('2.18.1', { patched: true });
    fs.writeFileSync(target, patched);
    prepareOfficialBackup(target);
    assert.deepEqual(fs.readFileSync(target), patched);
    assert.deepEqual(fs.readFileSync(target + '.bak'), original);
    const rebuilt = archive('2.18.1', { main: '"use strict"; // official rebuild' });
    fs.writeFileSync(target, rebuilt);
    prepareOfficialBackup(target);
    assert.deepEqual(fs.readFileSync(target + '.bak'), rebuilt);
});

test('已汉化的新版缺少同版本官方备份时拒绝降级或覆盖', t => {
    const target = fixture(t);
    const patched = archive('2.18.1', { patched: true });
    fs.writeFileSync(target, patched);
    assert.throws(() => prepareOfficialBackup(target), /缺少同版本官方备份/);
    for (const invalidBackup of [archive('2.17.0'), archive('2.18.1', { patched: true })]) {
        fs.writeFileSync(target + '.bak', invalidBackup);
        assert.throws(() => prepareOfficialBackup(target), /缺少同版本官方备份/);
        assert.deepEqual(fs.readFileSync(target + '.bak'), invalidBackup);
    }
    assert.deepEqual(fs.readFileSync(target), patched);
});

test('识别历史注入标记，损坏的 ASAR 在备份前被拒绝', t => {
    const target = fixture(t);
    for (const options of [
        { main: '/* --- ANTIGRAVITY CHINESE LOCALIZATION SRC START --- */' },
        { preload: '/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */' },
    ]) {
        fs.writeFileSync(target, archive('2.18.1', options));
        assert.deepEqual(readAsarMetadata(target), { version: '2.18.1', patched: true });
    }
    fs.writeFileSync(target, Buffer.alloc(4));
    assert.throws(() => prepareOfficialBackup(target), /ASAR 头部不完整/);
    assert.equal(fs.existsSync(target + '.bak'), false);
});
