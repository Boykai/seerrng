import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import QuestarrNGAPI from './questarrng';
import ROMarrNGAPI from './romarrng';

for (const Provider of [ROMarrNGAPI, QuestarrNGAPI]) {
  it(`${Provider.name} preserves range errors without forwarding provider error bodies`, async () => {
    const server = createServer((req, res) => {
      assert.strictEqual(req.headers.range, 'bytes=999-');
      res.writeHead(416, {
        'Content-Type': 'application/json',
        'Content-Range': 'bytes */100',
      });
      res.end(JSON.stringify({ error: 'private provider path or credential' }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    try {
      const api = new Provider({
        hostname: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        baseUrl: '',
        useSsl: false,
        apiKey: 'test',
      });
      const result = await api.streamAsset(
        'request-1',
        'asset-1',
        'bytes=999-'
      );
      assert.strictEqual(result.statusCode, 416);
      assert.strictEqual(result.contentRange, 'bytes */100');
      assert.strictEqual(result.contentLength, 0);
      const chunks = [];
      for await (const chunk of result.stream) chunks.push(chunk);
      assert.deepStrictEqual(chunks, []);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
