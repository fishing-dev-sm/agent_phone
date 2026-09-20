import { isAbsolute, resolve } from 'node:path';

export class DtmfDecoder {
  constructor() { this.seen = new Set(); }
  read({ payload, timestamp }) {
    if (payload.length < 4 || payload[0] > 15 || payload[1] & 64) return null;
    // RFC 4733 repeats ongoing/end packets; timestamp + event identifies a key.
    const key = `${timestamp}:${payload[0]}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value);
    return '0123456789*#ABCD'[payload[0]];
  }
}

export class PhoneBinding {
  constructor({ binding = null, now = Date.now, persist } = {}) {
    Object.assign(this, { binding, now, persist });
    this.confirming = false;
  }
  async bind({ threadId, title = '', hostId = 'local', projectPath }) {
    if (this.confirming) throw new Error('绑定正在保存，请稍后重试');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId ?? '')) throw new Error('必须提供当前 Codex 对话的真实 UUID');
    if (hostId !== 'local') throw new Error('这一版只支持本机 Codex 对话');
    if (typeof projectPath !== 'string' || !isAbsolute(projectPath) || resolve(projectPath) !== projectPath) throw new Error('必须从目标 Codex project 的绝对路径执行绑定');
    const binding = { version: 1, threadId, title: String(title).slice(0, 200), hostId, projectPath, boundAt: new Date(this.now()).toISOString() };
    this.confirming = true;
    try {
      await this.persist(binding);
      this.binding = binding;
      return { bound: true, binding };
    } finally { this.confirming = false; }
  }
  status() { return { binding: this.binding }; }
  async unbind() {
    if (this.confirming) throw new Error('绑定正在保存，请稍后重试');
    this.confirming = true;
    try {
      await this.persist(null);
      this.binding = null;
      return { bound: false, binding: null };
    } finally { this.confirming = false; }
  }
}
