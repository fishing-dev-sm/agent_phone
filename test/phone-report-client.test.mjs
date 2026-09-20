import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { call } from '../client/phone-report.mjs';

function fakeServer(handler) {
  const server = net.createServer(socket => {
    let data = '';
    socket.on('data', chunk => {
      data += chunk;
      const end = data.indexOf('\n'); if (end < 0) return;
      const request = JSON.parse(data.slice(0, end));
      const response = handler(request);
      socket.end(JSON.stringify(response) + '\n');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('client sends token and parses ok result', async () => {
  const { server, port } = await fakeServer(request => {
    assert.equal(request.token, 'secret-token-123456');
    assert.equal(request.method, 'status');
    return { ok: true, result: { handset: 'on_hook' } };
  });
  const result = await call({ method: 'status' }, 3000, { host: '127.0.0.1', port, token: 'secret-token-123456' });
  assert.deepEqual(result, { handset: 'on_hook' });
  server.close();
});

test('client surfaces server errors', async () => {
  const { server, port } = await fakeServer(() => ({ ok: false, error: 'RPC token 无效' }));
  await assert.rejects(call({ method: 'status' }, 3000, { host: '127.0.0.1', port, token: 'wrong-token-00000' }), /token 无效/);
  server.close();
});

test('client reports unreachable service clearly', async () => {
  await assert.rejects(call({ method: 'status' }, 2000, { host: '127.0.0.1', port: 1, token: 'secret-token-123456' }), /无法连接电话服务/);
});
