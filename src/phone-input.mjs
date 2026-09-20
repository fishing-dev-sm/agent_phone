import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../.runtime/REDLINE Bridge.app/Contents/MacOS/RedlineBridge', import.meta.url));

// One native process holds the composer reference from pickup to hangup.
export class PhoneInput {
  async start() {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.result = new Promise((resolve, reject) => { this.resultResolve = resolve; this.resultReject = reject; });
    this.result.catch(() => {});
    this.child = spawn(executable, ['--session'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    const fail = error => {
      clearTimeout(this.timer); this.readyReject(error); this.resultReject(error); this.child.kill();
    };
    this.child.on('error', fail);
    this.child.stdin.on('error', fail);
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16384) return fail(new Error('辅助功能响应过大'));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { return fail(new Error('辅助功能响应无效')); }
        if (event.error) return fail(new Error(event.error));
        if (event.ready) {
          clearTimeout(this.timer); this.readyResolve();
          this.timer = setTimeout(() => fail(new Error('电话输入会话超时')), 360000);
        } else if (event.entered) {
          clearTimeout(this.timer);
          if (event.submitted) this.resultResolve(event);
          else fail(new Error('已按回车，但无法确认提交；不会重试'));
        }
      }
    });
    this.child.on('close', () => fail(new Error('辅助功能输入进程已结束')));
    this.timer = setTimeout(() => fail(new Error('辅助功能输入初始化超时')), 8000);
    return this.ready;
  }
  async submit(text) {
    if (this.sent) throw new Error('语音消息已尝试提交；不会重复发送');
    await this.ready;
    if (!text.trim() || Buffer.byteLength(text) > 65536) throw new Error('语音消息为空或过长');
    this.sent = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.resultReject(new Error('提交确认超时；不会重试')); this.close(); }, 10000);
    this.child.stdin.end(text);
    return this.result;
  }
  close() {
    clearTimeout(this.timer);
    const error = new Error('电话输入已取消');
    this.readyReject?.(error); this.resultReject?.(error);
    this.child?.kill();
  }
}
