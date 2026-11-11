import { expect } from 'chai';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NetworkError, requestJson } from './http';

describe('http => requestJson', () => {
    let server: Server;
    let base: string;
    let hits: string[];

    before(done => {
        server = createServer((req, res) => {
            hits.push(`${req.method} ${req.url}`);

            switch (req.url?.split('?')[0]) {
                case '/json':
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"ok":true}');
                    break;
                case '/echo': {
                    let body = '';
                    req.on('data', chunk => (body += chunk));
                    req.on('end', () => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ body, auth: req.headers.authorization ?? null }));
                    });
                    break;
                }
                case '/limited':
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end('{"error":"too many"}');
                    break;
                case '/html':
                    res.writeHead(502, { 'Content-Type': 'text/html' });
                    res.end('<html>Bad Gateway</html>');
                    break;
                case '/empty':
                    res.writeHead(204);
                    res.end();
                    break;
                case '/redirect':
                    res.writeHead(307, { Location: '/json' });
                    res.end();
                    break;
                case '/slow':
                    // never answers
                    break;
                default:
                    res.writeHead(404);
                    res.end();
            }
        }).listen(0, '127.0.0.1', () => {
            base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            done();
        });
    });

    after(done => {
        server.closeAllConnections();
        server.close(() => done());
    });

    beforeEach(() => {
        hits = [];
    });

    it('parses a JSON answer', async () => {
        expect(await requestJson(`${base}/json`, { timeout: 2000 })).to.deep.equal({ status: 200, data: { ok: true } });
    });

    it('sends method, headers and body', async () => {
        const response = await requestJson(`${base}/echo`, {
            method: 'POST',
            headers: { Authorization: 'Bearer abc' },
            body: 'a=1',
            timeout: 2000,
        });

        expect(hits).to.deep.equal(['POST /echo']);
        expect(response.data).to.deep.equal({ body: 'a=1', auth: 'Bearer abc' });
    });

    it('resolves for an error status and keeps its body', async () => {
        expect(await requestJson(`${base}/limited`, { timeout: 2000 })).to.deep.equal({
            status: 429,
            data: { error: 'too many' },
        });
    });

    it('hands back a body that is not JSON as text', async () => {
        expect(await requestJson(`${base}/html`, { timeout: 2000 })).to.deep.equal({
            status: 502,
            data: '<html>Bad Gateway</html>',
        });
    });

    it('reports an empty body as null', async () => {
        expect(await requestJson(`${base}/empty`, { timeout: 2000 })).to.deep.equal({ status: 204, data: null });
    });

    it('follows a redirect by default', async () => {
        const response = await requestJson(`${base}/redirect`, { timeout: 2000 });

        expect(response.status).to.equal(200);
        expect(hits).to.deep.equal(['GET /redirect', 'GET /json']);
    });

    it('does not replay the request to a redirect target when told so', async () => {
        const response = await requestJson(`${base}/redirect`, {
            method: 'POST',
            body: 'secret',
            timeout: 2000,
            redirect: 'manual',
        });

        expect(response.status).to.equal(307);
        expect(hits).to.deep.equal(['POST /redirect']);
    });

    it('throws a NetworkError on a timeout', async () => {
        const error = await requestJson(`${base}/slow`, { timeout: 100 }).catch(e => e);

        expect(error).to.be.instanceOf(NetworkError);
        expect(error.code).to.equal('TimeoutError');
    });

    it('throws a NetworkError without the url when nothing listens', async () => {
        // a port that was just free: open a server, note its port, close it again
        const port = await new Promise<number>(resolve => {
            const probe = createServer().listen(0, '127.0.0.1', () => {
                const { port } = probe.address() as AddressInfo;

                probe.close(() => resolve(port));
            });
        });

        const error = await requestJson(`http://127.0.0.1:${port}/?api_key=topsecret`, { timeout: 2000 }).catch(e => e);

        expect(error).to.be.instanceOf(NetworkError);
        expect(error.code).to.equal('ECONNREFUSED');
        expect(error.message).to.not.include('topsecret');
    });
});
