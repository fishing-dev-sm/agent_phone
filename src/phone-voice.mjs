import { EventEmitter } from 'node:events';

export class PhoneVoice extends EventEmitter {
  constructor({ createTranscription, createInput }) {
    super(); Object.assign(this, { createTranscription, createInput });
    this.enabled = false; this.active = null; this.result = null;
  }
  status() { return { enabled: this.enabled, active: Boolean(this.active), result: this.result }; }
  async begin(id, { beforeListening } = {}) {
    if (!this.enabled || this.active) return false;
    const call = { id, failed: false, ending: false, listening: !beforeListening };
    this.active = call; this.result = null;
    const fail = error => {
      if (call.failed) return;
      call.failed = true; this.result = { submittedToCodex: false, error: error.message };
      call.input?.close(); call.transcription?.close(); this.emit('failure', error);
    };
    call.fail = fail;
    try {
      call.input = this.createInput(); call.transcription = this.createTranscription();
      call.transcription.on('failure', fail);
      call.ready = Promise.all([call.input.start(), call.transcription.start()]).then(async () => {
        if (call.failed || this.active !== call) return false;
        if (beforeListening) {
          if (call.ending) return false;
          await beforeListening();
          if (call.failed || call.ending || this.active !== call) return false;
          call.listening = true;
        }
        return true;
      }).catch(error => { fail(error); return false; });
      return await call.ready;
    } catch (error) { fail(error); call.ready = Promise.resolve(false); return false; }
  }
  audio(data, id) {
    const call = this.active;
    if (call?.id !== id || call.failed || call.ending || !call.listening) return;
    try { call.transcription.append(data); } catch (error) { call.fail(error); }
  }
  async end(id, reason) {
    const call = this.active;
    if (call?.id !== id || call.ending) return;
    call.ending = true;
    try {
      if (reason !== 'hangup') { call.fail(new Error('电话异常结束，未提交')); return; }
      if (!await call.ready || call.failed) return;
      const text = await call.transcription.finish();
      if (call.failed || this.active !== call) return;
      if (!text.trim()) { this.result = { submittedToCodex: false, empty: true }; return; }
      await call.input.submit(text);
      this.result = { submittedToCodex: true, characters: text.length };
      this.emit('submitted');
    } catch (error) { call.fail(error); }
    finally {
      call.transcription?.close(); call.input?.close();
      if (this.active === call) this.active = null;
      this.emit('idle');
    }
  }
  close() {
    this.enabled = false;
    const call = this.active; this.active = null;
    if (call) { call.failed = true; call.transcription?.close(); call.input?.close(); }
  }
}
