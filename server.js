const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SECRET_KEY = 0xAB; 

// 既存の難読化（XOR）
const transform = (buf) => Buffer.from(buf).map(b => b ^ SECRET_KEY);

// CSS内の url() 指定を正規化する補助関数
const rewriteCSS = (css, targetUrl) => {
    return css.replace(/url\(['"]?([^'"]+)['"]?\)/g, (match, p1) => {
        try {
            if (p1.startsWith('data:') || p1.startsWith('http')) return match;
            return `url("${new URL(p1, targetUrl).href}")`;
        } catch(e) {
            return match;
        }
    });
};

// リソース書き換え機能: HTMLおよびCSS内のパスを正規化
const rewriteResources = (content, targetUrl, contentType) => {
    // HTMLのリライト
    if (contentType.includes('text/html')) {
        const $ = cheerio.load(content);
        const urlObj = new URL(targetUrl);

        // 1. <base>タグを挿入して相対パスの基準をターゲットドメインに固定
        $('head').prepend(`<base href="${urlObj.origin}${urlObj.pathname}">`);
        
        // ゲーム用にCanvasを全画面表示にするスタイルを強制注入
        $('head').append(`
            <style>
                body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
                canvas { display: block; width: 100vw; height: 100vh; }
            </style>
        `);

        // 2. a, img, link, script 等のURL属性を修正（絶対パス化）
        $('a, img, link, script, source, iframe, form').each((i, el) => {
            ['href', 'src', 'action'].forEach(attr => {
                const val = $(el).attr(attr);
                if (val && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith('javascript:')) {
                    try {
                        $(el).attr(attr, new URL(val, targetUrl).href);
                    } catch (e) {}
                }
            });
        });

        // 3. インラインCSSのリライト
        $('style').each((i, el) => {
            const css = $(el).text();
            $(el).text(rewriteCSS(css, targetUrl));
        });

        // 4. セキュリティポリシー(CSP)およびフレーム制限の解除
        $('meta[http-equiv*="Content-Security-Policy" i]').remove();
        $('meta[name*="viewport"]').attr('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');

        return $.html();
    }
    
    // CSSファイル単体のリライト
    if (contentType.includes('text/css')) {
        return rewriteCSS(content.toString(), targetUrl);
    }
    
    return content;
};

app.use(express.static('public'));

wss.on('connection', (ws) => {
    const jar = new Map();

    ws.on('message', async (msg) => {
        try {
            const decrypted = transform(msg).toString();
            const { url, method, headers, data } = JSON.parse(decrypted);
            const urlObj = new URL(url);
            const host = urlObj.hostname;

            const res = await axios({
                url,
                method: method || 'GET',
                data: data || null,
                headers: {
                    ...headers,
                    'Cookie': jar.get(host) || '',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Referer': url,
                    'Origin': urlObj.origin
                },
                responseType: 'arraybuffer',
                validateStatus: false
            });

            if (res.headers['set-cookie']) {
                jar.set(host, res.headers['set-cookie'].map(c => c.split(';')[0]).join('; '));
            }

            let bodyData = res.data;
            const contentType = res.headers['content-type'] || '';

            // ゲーム用リソース（WASMやバイナリ）は書き換えずにそのまま送る
            // HTMLまたはCSSの場合のみリライトを実行
            if (contentType.includes('text/html') || contentType.includes('text/css')) {
                bodyData = Buffer.from(rewriteResources(bodyData.toString(), url, contentType));
            }

            // バイナリ整合性を守るためBase64で送信
            ws.send(transform(JSON.stringify({
                body: bodyData.toString('base64'),
                status: res.status,
                contentType: contentType,
                url: url
            })));
        } catch (e) {
            ws.send(transform(JSON.stringify({ error: e.message })));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Stealth Engine active on port ${PORT}`));
