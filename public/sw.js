const SECRET_KEY = 0xAB;

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

self.addEventListener('fetch', (event) => {
    const url = event.request.url;
    // 自サーバーのリソースは通常通り取得
    if (url.includes(location.host) || !url.startsWith('http')) return;

    event.respondWith((async () => {
        const client = await clients.get(event.clientId);
        if (!client) return fetch(event.request);

        let bodyBase64 = null;
        if (['POST', 'PUT'].includes(event.request.method)) {
            const buf = await event.request.arrayBuffer();
            bodyBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        }

        return new Promise((resolve) => {
            const mc = new MessageChannel();
            mc.port1.onmessage = (msg) => {
                const res = msg.data;
                const bytes = Uint8Array.from(atob(res.body), c => c.charCodeAt(0));
                resolve(new Response(bytes, {
                    status: res.status,
                    headers: { 'Content-Type': res.contentType }
                }));
            };

            client.postMessage({
                type: 'PROXY_REQ',
                url: event.request.url,
                method: event.request.method,
                headers: Object.fromEntries(event.request.headers.entries()),
                body: bodyBase64
            }, [mc.port2]);
        });
    })());
});
