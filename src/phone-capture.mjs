import { EventEmitter } from 'node:events';

// One-shot commissioning test, deliberately separate from task submission.
export class PhoneCapture extends EventEmitter {
  constructor({ createSession, now = Date.now }) {
    super(); Object.assign(this, { createSession, now });
    this.expires = 0; this.active = null; this.result = null;
  }
  arm() {
    if (this.active) throw new Error('转写测试正在进行');
    this.result = null; this.expires = this.now() + 120000;
  }
  get armed() { return this.expires > this.now(); }
  status() { return { armed: this.armed, capturing: Boolean(this.active), result: this.result }; }
  async begin(callId) {
    if (!this.armed || this.active) return false;
    this.expires = 0;
    let session;
    try { session = this.createSession(); }
    catch (error) { this.result = { error: error.message }; this.emit('failure', error); return false; }
    const capture = { callId, session, failed: false };
    this.active = capture;
    const fail = error => {
      capture.failed = true; this.result = { error: error.message }; this.emit('failure', error);
    };
    session.on('failure', fail);
    capture.ready = session.start().then(() => true, error => { if (!capture.failed) fail(error); return false; });
    return await capture.ready && !capture.failed;
  }
  audio(data, callId) {
    if (this.active?.callId === callId && !this.active.failed) this.active.session.append(data);
  }
  async end(callId, reason) {
    const capture = this.active;
    if (!capture || capture.callId !== callId) return;
    try {
      if (reason !== 'hangup') { this.result = { error: '电话未正常挂机，未提交音频' }; return; }
      if (!await capture.ready || capture.failed) return;
      const text = await capture.session.finish();
      this.result = { text, submittedToCodex: false }; this.emit('completed');
    } catch (error) { this.result = { error: error.message }; this.emit('failure', error); }
    finally { capture.session.close(); if (this.active === capture) this.active = null; }
  }
  close() { this.expires = 0; this.active?.session.close(); this.active = null; this.result = null; }
}
