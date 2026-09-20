import { EventEmitter } from 'node:events';

export class PhoneReplies extends EventEmitter {
  constructor({ phone, getBinding, synthesize, archive = async () => null, canRing = () => true, playbackDelayMs = 1000 }) {
    super(); Object.assign(this, { phone, getBinding, synthesize, archive, canRing, playbackDelayMs });
    this.queue = []; this.seen = new Set(); this.turns = new Map(); this.suppressed = new Set(); this.bindingStops = new Set(); this.closed = false;
  }
  status() { return { queuedReplies: this.queue.length, replyReady: Boolean(this.queue[0]?.audio), replyError: this.lastError ?? null, lastReplyArchive: this.lastArchive?.path ?? null }; }
  suppressBindingReply(threadId) {
    this.bindingStops.add(threadId);
    if (this.bindingStops.size > 100) this.bindingStops.delete(this.bindingStops.values().next().value);
    const turnId = this.turns.get(threadId);
    if (turnId) this.suppressed.add(`${threadId}:${turnId}`);
    if (this.suppressed.size > 200) this.suppressed.delete(this.suppressed.values().next().value);
  }
  receive(event) {
    const { session_id: threadId, turn_id: turnId, hook_event_name: name } = event;
    if (typeof threadId !== 'string' || typeof turnId !== 'string' || !turnId) return { accepted: false, reason: 'missing_ids' };
    if (name === 'UserPromptSubmit') {
      this.bindingStops.delete(threadId);
      this.turns.set(threadId, turnId);
      if (this.turns.size > 100) this.turns.delete(this.turns.keys().next().value);
      return { accepted: true };
    }
    const binding = this.getBinding();
    if (name !== 'Stop' || threadId !== binding?.threadId) return { accepted: false, reason: 'unrelated_event' };
    const key = `${threadId}:${turnId}`;
    if (this.bindingStops.has(threadId) || this.suppressed.has(key) || this.seen.has(key)) return { accepted: false, reason: 'duplicate_or_binding' };
    if (this.queue.length >= 8) throw new Error('待播放回复已满，请先接听电话');
    const text = typeof event.last_assistant_message === 'string' ? event.last_assistant_message.trim() : '';
    if (!text) return { accepted: false, reason: 'no_reply_text' };
    if (text.length > 20000) throw new Error('回复超过朗读长度限制，请在桌面查看');
    this.seen.add(key);
    if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value);
    this.queue.push({ key, threadId, turnId, projectPath: binding.projectPath, text, announced: false });
    this.prepare(); return { accepted: true };
  }
  async prepare() {
    const reply = this.queue[0];
    if (!reply || reply.preparing || reply.audio || this.closed) return;
    reply.preparing = true;
    try {
      const audio = await this.synthesize(reply.text);
      if (this.closed || this.queue[0] !== reply) return;
      const archived = await this.archive({ projectPath: reply.projectPath, threadId: reply.threadId, turnId: reply.turnId, audio });
      if (this.closed || this.queue[0] !== reply) return;
      this.lastArchive = archived;
      reply.audio = audio; delete reply.text;
      this.lastError = null; this.emit('ready'); this.maybeRing();
    } catch (error) {
      this.lastError = error.message; this.emit('failure', error);
      if (this.queue[0] === reply) this.queue.shift();
      this.prepare();
    }
  }
  maybeRing() {
    const reply = this.queue[0];
    if (this.closed || !reply?.audio || reply.announced || this.phone.call || !this.canRing()) return;
    try {
      reply.announced = true;
      const call = this.phone.dial({ ringDurationMs: 8200 }); call.purpose = 'reply'; this.emit('ringing');
    } catch (error) { this.lastError = error.message; this.emit('failure', error); }
  }
  async play(call) {
    const reply = this.queue[0];
    if (!reply?.audio || this.closed) return false;
    reply.announced = true;
    try {
      // PCMU silence keeps RTP flowing while the user raises the handset.
      // Using the same playback preserves normal cancellation on early hangup.
      const silence = Buffer.alloc(Math.round(this.playbackDelayMs * 8), 0xff);
      await this.phone.play(Buffer.concat([silence, reply.audio]));
      if (this.queue[0] === reply) this.queue.shift();
      // Let the companion reuse this connected call for the user's follow-up.
      this.emit('played', call); this.prepare();
    } catch {
      // Physical hangup skips this reply. Transport errors retain it for retry.
      if (call.endReason === 'hangup' && this.queue[0] === reply) {
        this.queue.shift(); this.emit('skipped', call); this.prepare();
      }
    }
    return true;
  }
  clear() { this.queue = []; this.lastError = null; }
  close() { this.closed = true; this.clear(); }
}
