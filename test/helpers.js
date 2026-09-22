// Teszt-segédek a brave-mcp node --test csomagjához (2026-09-22).
import fs from 'node:fs';
import http from 'node:http';
import dns from 'node:dns';

// Böngésző: BRAVE_PATH, különben az első létező bináris. (A snap-os brave-et a
// sandbox miatt csak végső esetben választjuk.)
export function findBrowser() {
  const cands = [
    process.env.BRAVE_PATH,
    '/usr/bin/brave-browser', '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/brave',
  ].filter(Boolean);
  return cands.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

// Van-e kimenő net (DNS + TCP az example.com-ra). A publikus részek ettől függnek.
export async function hasNetwork() {
  try {
    const addrs = await dns.promises.resolve4('example.com');
    return addrs.length > 0;
  } catch (_) { return false; }
}

// Egyszerű fixture-szerver a 127.0.0.1-en. routes: { '/path': (req, res) => ... | 'html string' }
export async function startFixture(routes) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const h = routes[u.pathname];
    if (typeof h === 'function') return h(req, res, u);
    if (typeof h === 'string') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(h);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    server, port, base: `http://127.0.0.1:${port}`,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
