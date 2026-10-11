// @ts-check
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createHandler } from './handler.js';
import { errorBody } from './openai.js';

const MAX_BODY = 8 * 1024 * 1024;

/**
 * @param {import('./handler.js').HandlerConfig} cfg
 * @param {{port?: number, host?: string, token: string, log?: (line: string) => void}} opts
 */
export async function startServer(cfg, { port = 8787, host = '127.0.0.1', token, log = console.error }) {
  const handler = createHandler(cfg);
  const MODELS = handler.models.map((id) => ({ id, object: 'model', owned_by: id.split('/')[0] }));
  const want = Buffer.from(`Bearer ${token}`);
  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    let model = '-';
    let code = '';
    const json = (/** @type {number} */ status, /** @type {any} */ body, /** @type {string} */ c = '') => {
      code = c;
      res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
      res.end(JSON.stringify(body));
    };
    res.on('finish', () => log(`${req.method} ${req.url?.split('?')[0]} ${res.statusCode} ${Date.now() - start}ms model=${model} code=${code || '-'}`));
    try {
      const actual = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      if (req.headers.host !== `127.0.0.1:${actual}` && req.headers.host !== `localhost:${actual}`) {
        return json(403, errorBody('forbidden_host', 'Host not allowed'), 'forbidden_host');
      }
      const got = Buffer.from(String(req.headers.authorization ?? ''));
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        return json(401, errorBody('invalid_shim_token', 'Missing or invalid shim token', 'authentication_error'), 'invalid_shim_token');
      }
      const url = req.url?.split('?')[0];
      if (req.method === 'GET' && url === '/v1/models') return json(200, { object: 'list', data: MODELS });
      if (req.method !== 'POST' || url !== '/v1/chat/completions') return json(404, errorBody('not_found', 'Not found'), 'not_found');
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
        return json(415, errorBody('unsupported_media_type', 'content-type must be application/json'), 'unsupported_media_type');
      }
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) {
          // Flush the 413 before the loop exit destroys the request, so the client can read it.
          res.setHeader('connection', 'close');
          json(413, errorBody('payload_too_large', 'Body too large'), 'payload_too_large');
          await new Promise((r) => { if (res.writableFinished) r(undefined); else res.once('finish', () => r(undefined)); });
          return;
        }
        chunks.push(c);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return json(400, errorBody('invalid_json', 'Invalid JSON body'), 'invalid_json'); }
      model = typeof body?.model === 'string' ? body.model.slice(0, 64) : '-';
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      code = (await handler.handleChatCompletion(body, res, ac.signal)) ?? '';
    } catch (e) {
      code = 'internal_error';
      if (!res.headersSent) json(500, errorBody('internal_error', 'Internal error', 'server_error'), 'internal_error');
      else res.end();
    }
  });
  await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
  const actualPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return { server, port: actualPort, close: () => new Promise((r) => { server.close(() => r(undefined)); server.closeAllConnections?.(); }) };
}
