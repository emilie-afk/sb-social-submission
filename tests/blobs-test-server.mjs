// Minimal Netlify Blobs edge API for tests, used instead of the bundled local BlobsServer
// because that server (a) does not return ETags on reads and (b) does not apply
// If-None-Match atomically under concurrency. Production Netlify Blobs provides both, and
// our code relies on them. This server keeps all entries in one process and handles each
// request synchronously, so conditional writes are atomic — including across separate
// function processes that talk to it over HTTP.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export function startTestBlobsServer({ token }) {
  const data = new Map(); // `${store}/${key}` -> { body:Buffer, etag }
  let version = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); return res.end(); }
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean); // site, store, ...key
      const store = decodeURIComponent(parts[1] || '');
      const key = parts.slice(2).map(decodeURIComponent).join('/');
      const id = `${store}/${key}`;
      const cur = data.get(id);

      if (req.method === 'GET' && !key) {
        const prefix = url.searchParams.get('prefix') || '';
        const blobs = [...data.entries()]
          .filter(([k]) => k.startsWith(`${store}/`) && k.slice(store.length + 1).startsWith(prefix))
          .map(([k, v]) => ({ key: k.slice(store.length + 1), etag: v.etag, size: v.body.length, last_modified: new Date().toISOString() }));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ blobs, directories: [] }));
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!cur) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { etag: cur.etag, 'content-type': 'application/json' });
        return res.end(req.method === 'HEAD' ? undefined : cur.body);
      }
      if (req.method === 'PUT') {
        const ifMatch = req.headers['if-match'];
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch === '*' && cur) { res.writeHead(412); return res.end(); }
        if (ifMatch && (!cur || cur.etag !== ifMatch)) { res.writeHead(412); return res.end(); }
        const body = Buffer.concat(chunks);
        const etag = `"${createHash('sha256').update(body).update(String(++version)).digest('hex').slice(0, 32)}"`;
        data.set(id, { body, etag });
        res.writeHead(200, { etag });
        return res.end();
      }
      if (req.method === 'DELETE') {
        data.delete(id);
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(405); res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, data, stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}
