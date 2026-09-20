import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { compressForSpeech } from './phone-audio.mjs';

// FIFO report queue: serializes say/ask calls over the single FXS line,
// retries unanswered attempts, and archives a text version of every report.
export class PhoneReports extends EventEmitter {
  constructor({ phone, synthesize, createTranscription, archivePath, compress = text => compressForSpeech(text), now = Date.now, maxQueue = 8, maxAttempts = 5, retryDelayMs = 30000 }) {
    super();
    Object.assign(this, { phone, synthesize, createTranscription, archivePath, compress, now, maxQueue, maxAttempts, retryDelayMs });
    this.queue = []; this.active = null; this.closed = false;
  }
  status() {
    return { queuedReports: this.queue.length, activeReport: this.active ? { id: this.active.id, kind: this.active.kind, attempt: this.active.attempt } : null };
  }
  submit({ kind, text, timeoutSec = 120 }) {
    if (this.closed) throw new Error('汇报队列已关闭');
    if (!['say', 'ask'].includes(kind)) throw new Error(`未知汇报类型：${kind}`);
    if (this.queue.length >= this.maxQueue) throw new Error(`汇报队列已满（${this.maxQueue} 条），请稍后再拨`);
    const job = { id: randomUUID(), kind, text, timeoutSec, attempt: 0, queuedAt: new Date(this.now()).toISOString() };
    const result = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this.queue.push(job);
    this.emit('queued', { id: job.id, kind });
    setImmediate(() => this.#run());
    return result;
  }
  async #run() {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    let outcome;
    try {
      const { spokenText, compressed } = await this.compress(job.text);
      job.spokenText = spokenText; job.compressed = compressed;
      job.audio = await this.synthesize(spokenText);
      while (job.attempt < this.maxAttempts && !this.closed) {
        job.attempt++;
        this.emit('attempt', { id: job.id, kind: job.kind, attempt: job.attempt });
        const result = await this.#attempt(job);
        outcome = result;
        if (result.delivered) break;
        if (job.attempt < this.maxAttempts && !this.closed) await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
      }
    } catch (error) {
      outcome = { delivered: false, answered: false, reason: 'error', error: error.message, attempts: job.attempt };
    }
    outcome ??= { delivered: false, answered: false, reason: 'closed', attempts: job.attempt };
    const record = { id: job.id, kind: job.kind, text: job.text, spokenText: job.spokenText, compressed: job.compressed ?? false, queuedAt: job.queuedAt, finishedAt: new Date(this.now()).toISOString(), ...outcome };
    delete record.audio;
    let archived = false;
    try { await appendFile(this.archivePath, JSON.stringify(record) + '\n', { mode: 0o600 }); archived = true; }
    catch (error) { this.emit('failure', error); }
    this.active = null;
    this.emit('finished', record);
    job.resolve({ reportId: job.id, archived, spokenText: job.spokenText, compressed: job.compressed ?? false, ...outcome });
    setImmediate(() => this.#run());
  }
  // One dial attempt. say: delivered once the message has been played, then the
  // daemon hangs up to free the line. ask: delivered once the callee's reply is
  // transcribed. Unanswered/failed dials resolve {delivered:false} for retry.
  #attempt(job) {
    return new Promise(resolve => {
      if (this.closed) return resolve({ delivered: false, answered: false, reason: 'closed', attempts: job.attempt });
      let call;
      try { call = this.phone.dial(); }
      catch (error) { return resolve({ delivered: false, answered: false, reason: 'dial_failed', error: error.message, attempts: job.attempt }); }
      const attempt = { callId: call.id, connected: false, session: null, timer: null };
      call.purpose = job.kind;
      job.current = attempt;
      const done = value => {
        if (job.current !== attempt) return;
        job.current = null;
        clearTimeout(attempt.timer); attempt.session?.close();
        resolve({ attempts: job.attempt, ...value });
      };
      attempt.done = done;
      call.onceConnected = () => {
        attempt.connected = true;
        this.phone.play(job.audio)
          .then(() => {
            if (job.kind === 'say') { try { this.phone.hangup('say_complete'); } catch {} return; }
            attempt.timer = setTimeout(() => { try { this.phone.hangup('ask_timeout'); } catch {} }, job.timeoutSec * 1000);
            this.emit('listening', { id: job.id });
          })
          .catch(() => {}); // Early hangup lands in onceEnded.
        if (job.kind === 'ask') {
          try { attempt.session = this.createTranscription(); }
          catch (error) { done({ delivered: true, answered: true, text: '', error: error.message }); return; }
          attempt.session.on('failure', error => done({ delivered: true, answered: true, text: '', error: error.message }));
          attempt.session.start().catch(error => done({ delivered: true, answered: true, text: '', error: error.message }));
        }
      };
      call.onceEnded = reason => {
        if (job.kind === 'ask' && attempt.session) {
          attempt.session.finish().then(
            text => done({ delivered: attempt.connected, answered: attempt.connected, text }),
            error => done({ delivered: attempt.connected, answered: attempt.connected, text: '', error: error.message }));
          return;
        }
        done(attempt.connected
          ? { delivered: true, answered: true, reason }
          : { delivered: false, answered: false, reason });
      };
    });
  }
  connected(call) { if (this.active?.current?.callId === call.id) call.onceConnected?.(); }
  ended(call, reason) { call.onceEnded?.(reason); }
  audio(data, call) { const current = this.active?.current; if (current?.callId === call.id && current.session) current.session.append(data); }
  // Queued jobs are settled immediately; the active job settles via the 'ended'
  // event when the daemon closes the phone, or when its RPC client disconnects.
  close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      job.resolve({ reportId: job.id, archived: false, delivered: false, answered: false, reason: 'closed', attempts: job.attempt });
    }
  }
}
