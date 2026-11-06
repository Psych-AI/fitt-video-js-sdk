import { createServer, request as forward } from 'node:http';

/**
 * A proxy that refuses preflights (run as `node tests/contract/proxy.ts`).
 * It answers every OPTIONS with 405 and no CORS headers, counts every request
 * by method, and forwards everything else to the API server unchanged.
 */
const PORT = 8125;
const UPSTREAM = { host: '127.0.0.1', port: 8123 };

let counts: Record<string, number> = {};

const server = createServer((incoming, outgoing) => {
    const url = incoming.url ?? '/';

    if (url === '/__counts' && incoming.method === 'GET') {
        outgoing.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        outgoing.end(JSON.stringify(counts));

        return;
    }

    if (url === '/__counts/reset' && incoming.method === 'POST') {
        counts = {};
        outgoing.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        outgoing.end();

        return;
    }

    const method = incoming.method ?? 'GET';
    counts[method] = (counts[method] ?? 0) + 1;

    if (method === 'OPTIONS') {
        outgoing.writeHead(405);
        outgoing.end();

        return;
    }

    const upstream = forward(
        {
            ...UPSTREAM,
            method,
            path: url,
            headers: {
                ...incoming.headers,
                host: `${UPSTREAM.host}:${UPSTREAM.port}`,
            },
        },
        (answer) => {
            outgoing.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
            answer.pipe(outgoing);
        },
    );

    upstream.on('error', (error) => {
        if (!outgoing.headersSent) {
            outgoing.writeHead(502, { 'Content-Type': 'text/plain' });
        }

        outgoing.end(String(error));
    });

    incoming.pipe(upstream);
});

server.listen(PORT, '127.0.0.1');
