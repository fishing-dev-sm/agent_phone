import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PhoneVoice } from '../src/phone-voice.mjs';
import { PhoneReplies } from '../src/phone-replies.mjs';
import { beginPhoneListening, connectPhoneFollowup } from '../src/phone-followup.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const audio = [], sent = [], playing = [];
  const phone = Object.assign(new EventEmitter(), {
    call: null, dial() { return this.call = { id: 'reply-call', outgoing: true }; },
    play(data) { return new Promise((resolve, reject) => playing.push({ data, resolve, reject })); },
  });
  const session = Object.assign(new EventEmitter(), { async start() {}, append(data) { audio.push(data); }, async finish() { return audio.length ? '继续测试' : ''; }, close() {} });
  const voice = new PhoneVoice({ createTranscription: () => session, createInput: () => ({ async start() {}, async submit(text) { sent.push(text); }, close() {} }) });
  voice.enabled = true; voice.on('failure', () => {});
  phone.on('audio', data => voice.audio(data, 'reply-call'));
  const replies = new PhoneReplies({ phone, getBinding: () => ({ threadId: 'bound' }), synthesize: async () => Buffer.from('reply') });
  connectPhoneFollowup({ phone, replies, voice, log() {} });
  replies.receive({ hook_event_name: 'Stop', session_id: 'bound', turn_id: '1', last_assistant_message: '完成' });
  return { phone, voice, replies, playing, sent, audio };
}
test('outbound reply finishes, cue finishes, then speech is captured and hangup submits', async () => {
  const x = setup(); await tick(); const call = x.phone.call;
  const playback = x.replies.play(call);
  x.phone.emit('audio', Buffer.from('reply echo')); assert.equal(x.voice.active, null);
  x.playing[0].resolve(); await playback; await tick();
  assert.equal(x.playing.length, 2); assert.equal(x.playing[1].data.length, 2400);
  x.phone.emit('audio', Buffer.from('cue echo')); assert.equal(x.audio.length, 0);
  x.playing[1].resolve(); await tick();
  x.phone.emit('audio', Buffer.from('follow up')); assert.equal(x.audio.length, 1);
  const idle = once(x.voice, 'idle'); x.phone.call = null;
  x.phone.emit('ended', { call, reason: 'hangup' }); await idle;
  assert.deepEqual(x.sent, ['继续测试']); assert.equal(x.replies.queue.length, 0);
});
test('hangup during cue never submits; interrupted reply never starts listening', async () => {
  for (const phase of ['reply', 'cue']) {
    const x = setup(); await tick(); const call = x.phone.call;
    const playback = x.replies.play(call);
    if (phase === 'cue') { x.playing[0].resolve(); await playback; await tick(); }
    call.endReason = 'hangup';
    x.phone.call = null; x.phone.emit('ended', { call, reason: 'hangup' });
    x.playing.at(-1).reject(new Error('hung up')); await playback; await tick();
    assert.deepEqual(x.sent, []); assert.equal(x.voice.active, null);
    assert.equal(x.replies.queue.length, 0);
    assert.equal(await x.voice.begin('next-call'), true);
    x.voice.audio(Buffer.from('new round'), 'next-call');
    await x.voice.end('next-call', 'hangup');
    assert.deepEqual(x.sent, ['继续测试']);
  }
});
test('voice disabled leaves completed playback without a cue or recording', async () => {
  const x = setup(); x.voice.enabled = false; await tick();
  const playback = x.replies.play(x.phone.call); x.playing[0].resolve(); await playback; await tick();
  assert.equal(x.playing.length, 1); assert.equal(x.voice.active, null);
});

test('answered binding confirmation cues listening and hangup submits speech', async () => {
  const x = setup();
  const call = { id: 'binding-call', outgoing: true }; x.phone.call = call;
  const listening = beginPhoneListening({ phone: x.phone, voice: x.voice, call, log() {}, event: 'confirmation_listening' });
  await tick();
  assert.equal(x.playing.length, 1); assert.equal(x.playing[0].data.length, 2400);
  x.voice.audio(Buffer.from('cue echo'), call.id); assert.equal(x.audio.length, 0);
  x.playing[0].resolve(); assert.equal(await listening, true);
  x.voice.audio(Buffer.from('new request'), call.id);
  await x.voice.end(call.id, 'hangup');
  assert.deepEqual(x.sent, ['继续测试']);
});
