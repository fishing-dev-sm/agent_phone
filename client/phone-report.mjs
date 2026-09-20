#!/usr/bin/env node
// phone-report client: talks to the companion daemon over TCP with a shared token.
// Usage: phone-report.mjs status | say <text> | ask <text> [--timeout SEC]
import net from 'node:net';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const host = process.env.PHONE_RPC_HOST ?? '192.168.1.10';
const port = Number(process.env.PHONE_RPC_PORT ?? 5091);
const token = process.env.PHONE_RPC_TOKEN ?? '';

function fail(message) { console.error(message); process.exit(1); }

export function call(request, timeoutMs, options = {}) {
  const targetHost = options.host ?? host, targetPort = options.port ?? port, auth = options.token ?? token;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: targetHost, port: targetPort });
    let data = '';
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`服务响应超时（${Math.round(timeoutMs / 1000)} 秒）`)));
    socket.on('connect', () => socket.write(JSON.stringify({ ...request, token: auth }) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 1048576) return socket.destroy(new Error('服务响应过大'));
      const end = data.indexOf('\n'); if (end < 0) return;
      try {
        const value = JSON.parse(data.slice(0, end));
        value.ok ? resolve(value.result) : reject(new Error(value.error));
      } catch (error) { reject(error); }
      socket.end();
    });
    socket.on('error', () => reject(new Error(`无法连接电话服务 ${targetHost}:${targetPort}（服务未启动或网络不通）`)));
    socket.on('end', () => { if (!data.includes('\n')) reject(new Error('电话服务连接已关闭')); });
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!token || token.length < 16) fail('缺少 PHONE_RPC_TOKEN（至少 16 个字符）；请先在环境中配置');
  if (command === 'status') {
    console.log(JSON.stringify(await call({ method: 'status' }, 10000), null, 2));
    return;
  }
  if (command === 'say' || command === 'ask') {
    const timeoutIndex = args.indexOf('--timeout');
    const text = (timeoutIndex >= 0 ? args.slice(0, timeoutIndex) : args).join(' ').trim();
    if (!text) fail(`用法：${command} 要朗读的文本 [--timeout 秒]`);
    const timeoutSec = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 120;
    // Server retries unanswered attempts up to 5 times (45s ring + 30s backoff each).
    const waitMs = command === 'say' ? 480000 : (timeoutSec + 420) * 1000;
    const result = await call({ method: command, text, timeoutSec }, waitMs);
    console.log(JSON.stringify(result, null, 2));
    if (!result.delivered) process.exitCode = 2;
    return;
  }
  fail(`未知命令：${command ?? '(空)'}\n用法：phone-report.mjs status | say <文本> | ask <文本> [--timeout 秒]`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => fail(error.message));
}
