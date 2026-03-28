const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SECRET_KEY = 0xAB;
const transform = (buf) => Buffer.from(buf).map(b => b ^ SECRET_KEY);

const rewriteResources = (content, targetUrl, contentType) => {
    const urlObj = new URL(targetUrl);
    const origin = urlObj.origin;

    if (contentType.includes('text/html')) {
        const $ = cheerio.load(content);

        const injection = `
        <script>
        (function() {
            window.__TARGET_ORIGIN__ = "${origin}";
            window.__TARGET_URL__ = "${targetUrl}";

            const locMock = Object.create(null);
            ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'].forEach(p => {
                Object.defineProperty(locMock, p, {
                    get: () => new URL(window.__TARGET_URL__)[p],
                    set: (v) => console.log("Nav Blocked:", v)
                });
            });
            window.__PROXY_LOC__ = locMock;

            // iframe脱出防止
            window.top = window.self;
            window.parent = window.self;

            const OldXHR = window.XMLHttpRequest;
            window.XMLHttpRequest = function() {
                const xhr = new OldXHR();
                const oldOpen = xhr.open;
                xhr.open = function(method, url) {
                    if (typeof url === 'string' && !url.startsWith('http')) {
                        url = new URL(url, window.__TARGET_ORIGIN__).href;
                    }
                    return oldOpen.apply(this, arguments);
                };
                return xhr;
            };

            const oldFetch = window.fetch;
            window.fetch = function(input, init) {
                let url = (typeof input === 'string') ? input : input.url;
                if (typeof url === 'string' && !url.startsWith('http')) {
                    url = new URL(url, window.__TARGET_ORIGIN__).href;
                }
                return oldFetch(url, init);
            };
        })();
        </script>`;

        $('head').prepend(injection);
        $('head').prepend(`<base href="${origin}/">`);
        $('meta[http-equiv*="Content-Security-Policy" i]').remove();
        $('meta[name="referrer"]').remove();

        $('[src], [href], [action]').each((i, el) => {
            ['src', 'href', 'action'].forEach(attr => {
                const val = $(el).attr(attr);
                if (val && !val.startsWith('data:') && !val.startsWith('#')) {
                    try { $(el).attr(attr, new URL(val, targetUrl).href); } catch(e) {}
                }
            });
        });

        return $.html();
    }

    if (contentType.includes('javascript')) {
        return content.toString()
            .replace(/\bwindow\.location\b/g, 'window.__PROXY_LOC__')
            .replace(/\bdocument\.location\b/g, 'window.__PROXY_LOC__')
            .replace(/\bwindow\.top\b/g, 'window.self')
            .replace(/\bwindow\.parent\b/g, 'window.self');
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
                    'Origin': urlObj.origin,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Encoding': 'identity'
                },
                responseType: 'arraybuffer',
                validateStatus: false,
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            });

            if (res.headers['set-cookie']) {
                const cookies = res.headers['set-cookie'].map(c => c.split(';')).join('; ');
                jar.set(urlObj.hostname, cookies);
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
server.listen(3000, () => console.log('Stealth Server: http://localhost:3000'));
