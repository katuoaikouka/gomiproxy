const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SECRET_KEY = 0xAB;
const transform = (buf) => Buffer.from(buf).map(b => b ^ SECRET_KEY);

// リソース書き換えロジック
const rewriteResources = (content, targetUrl, contentType) => {
    const urlObj = new URL(targetUrl);
    const origin = urlObj.origin;

    if (contentType.includes('text/html')) {
        const $ = cheerio.load(content);

        // 1. 最優先で実行される偽装スクリプトを注入
        const injection = `
        <script>
        (function() {
            window.__TARGET_ORIGIN__ = "${origin}";
            window.__TARGET_URL__ = "${targetUrl}";

            // Locationの偽装
            const locMock = Object.create(null);
            ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'].forEach(p => {
                Object.defineProperty(locMock, p, {
                    get: () => new URL(window.__TARGET_URL__)[p],
                    set: (v) => console.log("Blocked Nav:", v)
                });
            });
            window.__PROXY_LOC__ = locMock;

            // XHRのパッチ
            const OldXHR = window.XMLHttpRequest;
            window.XMLHttpRequest = function() {
                const xhr = new OldXHR();
                const oldOpen = xhr.open;
                xhr.open = function(method, url) {
                    if (!url.startsWith('http')) url = new URL(url, window.__TARGET_ORIGIN__).href;
                    return oldOpen.apply(this, [method, url, ...Array.from(arguments).slice(2)]);
                };
                return xhr;
            };

            // Fetchのパッチ
            const oldFetch = window.fetch;
            window.fetch = function(input, init) {
                let url = (typeof input === 'string') ? input : input.url;
                if (!url.startsWith('http')) url = new URL(url, window.__TARGET_ORIGIN__).href;
                return oldFetch(url, init);
            };
        })();
        </script>`;

        $('head').prepend(injection);
        $('head').prepend(`<base href="${origin}/">`);

        // 静的パスのリライト
        $('[src], [href], [action]').each((i, el) => {
            ['src', 'href', 'action'].forEach(attr => {
                const val = $(el).attr(attr);
                if (val && !val.startsWith('data:') && !val.startsWith('#')) {
                    try { $(el).attr(attr, new URL(val, targetUrl).href); } catch(e) {}
                }
            });
        });

        // セキュリティ解除
        $('meta[http-equiv*="Content-Security-Policy" i]').remove();
        return $.html();
    }

    if (contentType.includes('javascript')) {
        return content.toString()
            .replace(/\bwindow\.location\b/g, 'window.__PROXY_LOC__')
            .replace(/\bdocument\.location\b/g, 'window.__PROXY_LOC__');
    }

    if (contentType.includes('text/css')) {
        return content.toString().replace(/url\(['"]?([^'"]+)['"]?\)/g, (match, p1) => {
            try {
                if (p1.startsWith('data:') || p1.startsWith('http')) return match;
                return `url("${new URL(p1, targetUrl).href}")`;
            } catch(e) { return match; }
        });
    }

    return content;
};

wss.on('connection', (ws) => {
    const jar = new Map();

    ws.on('message', async (msg) => {
        try {
            const decrypted = transform(msg).toString();
            const { url, method, headers, body, id } = JSON.parse(decrypted);
            const urlObj = new URL(url);

            const res = await axios({
                url,
                method: method || 'GET',
                data: body ? Buffer.from(body, 'base64') : null,
                headers: {
                    ...headers,
                    'Cookie': jar.get(urlObj.hostname) || '',
                    'Referer': url,
                    'Origin': urlObj.origin
                },
                responseType: 'arraybuffer',
                validateStatus: false
            });

            if (res.headers['set-cookie']) {
                jar.set(urlObj.hostname, res.headers['set-cookie'].map(c => c.split(';')).join('; '));
            }

            let bodyData = res.data;
            const contentType = res.headers['content-type'] || '';

            if (contentType.includes('text/html') || contentType.includes('text/css') || contentType.includes('javascript')) {
                bodyData = Buffer.from(rewriteResources(bodyData.toString(), url, contentType));
            }

            ws.send(transform(JSON.stringify({
                id,
                url,
                body: bodyData.toString('base64'),
                status: res.status,
                contentType
            })));
        } catch (e) {
            ws.send(transform(JSON.stringify({ error: e.message })));
        }
    });
});

app.use(express.static('public'));
server.listen(3000, () => console.log('Server running on port 3000'));
