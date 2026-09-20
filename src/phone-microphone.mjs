import { spawn, execFile } from 'node:child_process';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { decodeMuLaw } from './phone-audio.mjs';
const run = promisify(execFile);
const helper = fileURLToPath(new URL('../.runtime/phone-audio', import.meta.url));

export function microphonePcm(payload) {
  const pcm = Buffer.alloc(payload.length * 24);
  for (let i = 0; i < payload.length; i++) {
    const a = decodeMuLaw(payload[i]);
    const b = decodeMuLaw(payload[Math.min(i + 1, payload.length - 1)]);
    for (let j = 0; j < 6; j++) {
      const value = Math.round(a + (b - a) * j / 6);
      const offset = i * 24 + j * 4;
      pcm.writeInt16LE(value, offset); pcm.writeInt16LE(value, offset + 2);
    }
  }
  return pcm;
}
async function control(...args) {
  const { stdout } = await run(helper, args, { timeout: 5000 });
  return JSON.parse(stdout);
}
const recovery = fileURLToPath(new URL('../.runtime/microphone-input-backup.json', import.meta.url));
export async function restoreMicrophone() {
  let saved;
  try { saved = JSON.parse(await readFile(recovery, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const current = await control('--devices');
  if (current.defaultInputUid === saved.targetUid) await control('--set-input', saved.previousInputUid);
  await unlink(recovery);
}
export async function checkMicrophone() {
  const inventory = await control('--devices');
  if (!inventory.devices.some(device => device.name === 'BlackHole 2ch')) throw new Error('BlackHole 2ch 尚未被系统识别，请先重启 Mac');
  return inventory;
}
export class PhoneMicrophone {
  constructor() { this.samples = 0; this.queue = []; this.ready = false; this.finished = false; }
  async start() {
    const inventory = await checkMicrophone();
    const target = inventory.devices.find(device => device.name === 'BlackHole 2ch');
    if (!target) throw new Error('BlackHole 2ch 尚未被系统识别，请先重启 Mac');
    this.uid = target.uid;
    const previousInput = inventory.defaultInputUid;
    await writeFile(recovery, JSON.stringify({ previousInputUid: previousInput, targetUid: this.uid }), { mode: 0o600, flag: 'wx' });
    this.previousInput = previousInput;
    try {
      const changed = await control('--set-input', this.uid);
      if (!changed.changed) throw new Error('无法选择 BlackHole 麦克风');
    } catch (error) { await this.restore(); throw error; }
    this.child = spawn(helper, ['--route', this.uid], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => { this.error = error; });
    this.done = new Promise(resolve => this.child.once('close', code => resolve(code)));
    try {
      await new Promise((resolve, reject) => {
        let data = '';
        const timer = setTimeout(() => reject(new Error('虚拟麦克风启动超时')), 5000);
        const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
        this.child.once('error', finish);
        this.child.once('exit', code => { if (!this.ready) finish(new Error(`音频桥退出 (${code})`)); });
        this.child.stdout.on('data', chunk => {
          data += chunk;
          let index;
          while ((index = data.indexOf('\n')) >= 0) {
            const line = data.slice(0, index); data = data.slice(index + 1);
            let event; try { event = JSON.parse(line); } catch { continue; }
            if (event.error) { this.error = new Error(event.error); finish(this.error); }
            if (event.ready) { this.ready = true; finish(); }
          }
        });
      });
      for (const pcm of this.queue) this.child.stdin.write(pcm);
      this.queue = [];
    } catch (error) { await this.close(); throw error; }
  }
  append(payload) {
    if (this.finished) return;
    if (this.error) throw this.error;
    this.samples += payload.length;
    const pcm = microphonePcm(payload);
    if (!this.ready) {
      if (this.samples > 8000 * 5) throw new Error('虚拟麦克风尚未就绪');
      this.queue.push(pcm);
    } else {
      if (this.child.stdin.writableLength > 384000) throw new Error('虚拟麦克风音频缓冲已满');
      this.child.stdin.write(pcm);
    }
  }
  async restore() {
    if (!this.previousInput) return;
    await restoreMicrophone();
    this.previousInput = null;
  }
  async finish() {
    this.finished = true;
    this.child?.stdin.end();
    let timer;
    try {
      const code = await Promise.race([this.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('等待音频送完超时')), 5000); })]);
      if (code !== 0 || this.error) throw this.error ?? new Error(`音频桥退出 (${code})`);
      return { audioSeconds: this.samples / 8000, submittedToCodex: false };
    } finally { clearTimeout(timer); await this.close(); }
  }
  async close() { this.finished = true; this.queue = []; this.child?.kill(); await this.restore(); }
}
