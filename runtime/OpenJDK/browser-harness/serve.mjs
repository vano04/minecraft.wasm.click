// Static server with the cross-origin isolation SharedArrayBuffer needs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
// Serves build/wasmjvm-harness, where link.sh puts the VM and the pages.
const root = new URL('../../build/wasmjvm-harness/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream' };
export function serve(port = 0) {
  return new Promise(resolve => {
    const srv = createServer(async (req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '');
      try {
        const body = await readFile(join(root, path || 'run.html'));
        res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream',
          'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp',
          'cross-origin-resource-policy': 'same-origin' });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
