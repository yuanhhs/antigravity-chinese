'use strict';

// Loaded by the VS Code extension host. The sidebar iframe uses this loopback
// proxy so its /main.js can be translated with the same AST rules as the app.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { translateSource } = require('./agy_src_i18n');
const dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'dict.json'), 'utf8'));
const servers = new Map();
const cache = new Map();
const MAX_MAIN_JS = 32 * 1024 * 1024;

function isLoopback(hostname) {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname.toLowerCase());
}

function upstreamHeaders(headers, target) {
    const copy = { ...headers, host: target.host };
    delete copy['accept-encoding'];
    // A browser cache entry for the untranslated asset must not yield 304.
    delete copy['if-none-match'];
    delete copy['if-modified-since'];
    if (copy.origin) {
        try {
            const origin = new URL(copy.origin);
            if (isLoopback(origin.hostname)) copy.origin = target.origin;
        } catch (_) { /* preserve the original header */ }
    }
    if (copy.referer) {
        try {
            const referer = new URL(copy.referer);
            if (isLoopback(referer.hostname)) {
                referer.host = target.host;
                copy.referer = referer.toString();
            }
        } catch (_) { /* preserve the original header */ }
    }
    return copy;
}

function proxyRequest(req, res, target) {
    const mainJs = req.method === 'GET' && /^\/main\.js(?:\?|$)/.test(req.url || '');
    const upstream = http.request({
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req.headers, target),
    }, response => {
        if (!mainJs || response.statusCode !== 200) {
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
            return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_MAIN_JS) {
                upstream.destroy(new Error('main.js exceeds translation size limit'));
                return;
            }
            chunks.push(chunk);
        });
        response.on('end', () => {
            try {
                const source = Buffer.concat(chunks);
                const key = crypto.createHash('sha256').update(source).digest('hex');
                let translated = cache.get(key);
                if (!translated) {
                    const result = translateSource(source.toString('utf8'), dict);
                    translated = Buffer.from(result.code, 'utf8');
                    cache.clear();
                    cache.set(key, translated);
                    console.log(`[agy-zh] VS Code main.js: ${result.replaced} translations`);
                }
                const headers = { ...response.headers, 'content-length': translated.length, 'cache-control': 'no-store' };
                delete headers.etag;
                delete headers['last-modified'];
                delete headers['content-encoding'];
                delete headers['transfer-encoding'];
                res.writeHead(200, headers);
                res.end(translated);
            } catch (error) {
                console.error('[agy-zh] VS Code translation failed:', error);
                if (!res.headersSent) res.writeHead(502);
                res.end('Antigravity translation failed');
            }
        });
        response.on('error', error => {
            console.error('[agy-zh] VS Code response failed:', error.message);
            if (!res.headersSent) res.writeHead(502);
            res.end('Antigravity backend response failed');
        });
    });
    upstream.on('error', error => {
        console.error('[agy-zh] VS Code upstream failed:', error.message);
        if (!res.headersSent) res.writeHead(502);
        res.end('Antigravity backend unavailable');
    });
    req.pipe(upstream);
}

function proxyUpgrade(req, socket, head, target) {
    const upstream = net.connect(Number(target.port), target.hostname.replace(/^\[|\]$/g, ''));
    upstream.on('connect', () => {
        const headers = upstreamHeaders(req.headers, target);
        const request = [`${req.method} ${req.url} HTTP/1.1`,
            ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', ''].join('\r\n');
        upstream.write(request);
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
}

async function startProxy(serverUrl) {
    const target = new URL(serverUrl);
    if (target.protocol !== 'http:' || !isLoopback(target.hostname)) return serverUrl;
    const key = target.origin;
    if (!servers.has(key)) {
        const server = http.createServer((req, res) => proxyRequest(req, res, target));
        server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, target));
        servers.set(key, new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeAllListeners('error');
                server.on('error', error => console.error('[agy-zh] VS Code proxy:', error));
                resolve(server.address().port);
            });
        }).catch(error => {
            servers.delete(key);
            throw error;
        }));
    }
    const port = await servers.get(key);
    const proxyUrl = new URL(serverUrl);
    proxyUrl.hostname = '127.0.0.1';
    proxyUrl.port = String(port);
    return proxyUrl.toString();
}

module.exports = { startProxy };
