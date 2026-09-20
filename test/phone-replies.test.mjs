import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneReplies } from '../src/phone-replies.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const stop = (turn = 'turn1', extra = {}) => ({ hook_event_name: 'Stop', session_id: 'bound', turn_id: turn, last_assistant_message: '完成', ...extra });
function setup() {
  const calls = [], audio = [];
  const phone = { call: null, dial() { this.call = { id: 'call' }; calls.push(this.call); return this.call; }, async play(data) { audio.push(data.toString()); } };
  const replies = new PhoneReplies({ phone, playbackDelayMs: 0, getBinding: () => ({ threadId: 'bound' }), synthesize: async text => Buffer.from(text) });
  replies.on('failure', () => {});
  return { replies, phone, calls, audio };
}

test('documented Stop event rings and plays its reply; physical hangup owns the call', async () => {
  const x = setup(); assert.equal(x.replies.receive(stop()).accepted, true);
  await tick(); assert.equal(x.calls.length, 1);
  await x.replies.play(x.phone.call);
  assert.deepEqual(x.audio, ['完成']); assert.equal(x.replies.queue.length, 0);
  assert.ok(x.phone.call);
});

test('reply is archived before it can ring', async () => {
  const order = [];
  const phone = { call: null, dial() { order.push('ring'); return this.call = { id: 'call' }; }, async play() {} };
  const replies = new PhoneReplies({
    phone, getBinding: () => ({ threadId: 'bound', projectPath: '/project' }),
    synthesize: async () => Buffer.from('speech'),
    archive: async details => { order.push('archive'); assert.equal(details.projectPath, '/project'); assert.equal(details.turnId, 'turn1'); return { path: '/project/reply.wav' }; }
  });
  replies.receive(stop()); await tick();
  assert.deepEqual(order, ['archive', 'ring']);
  assert.equal(replies.status().lastReplyArchive, '/project/reply.wav');
});

test('unrelated tasks, subagent events, blank replies and duplicate Stop events do not ring', async () => {
  const x = setup();
  for (const event of [stop('a', { session_id: 'other' }), stop('b', { hook_event_name: 'SubagentStop' }), stop('c', { last_assistant_message: '' })]) assert.equal(x.replies.receive(event).accepted, false);
  x.replies.receive(stop()); assert.equal(x.replies.receive(stop()).accepted, false);
  await tick(); assert.equal(x.calls.length, 1);
});

test('binding turn completion does not cause an extra notification', async () => {
  const x = setup();
  x.replies.receive({ hook_event_name: 'UserPromptSubmit', session_id: 'bound', turn_id: 'binding-turn' });
  x.replies.suppressBindingReply('bound');
  assert.equal(x.replies.receive(stop('binding-turn')).accepted, false);
  x.replies.receive({ hook_event_name: 'UserPromptSubmit', session_id: 'bound', turn_id: 'next-turn' });
  assert.equal(x.replies.receive(stop('next-turn')).accepted, true);
  await tick(); assert.equal(x.calls.length, 1);
});

test('busy phone defers ringing; playback errors and unanswered replies remain available', async () => {
  const x = setup(); x.phone.call = { id: 'busy' };
  x.replies.receive(stop()); await tick(); assert.equal(x.calls.length, 0);
  x.phone.call = null; x.replies.maybeRing(); assert.equal(x.calls.length, 1);
  x.phone.play = async () => { throw new Error('hangup'); };
  await x.replies.play(x.phone.call); x.phone.call = null;
  x.replies.maybeRing(); assert.equal(x.calls.length, 1); assert.equal(x.replies.queue.length, 1);
});

test('physical hangup skips current reply without starting follow-up or replaying it', async () => {
  const x = setup(); let finish, played = 0, skipped = 0;
  x.replies.on('played', () => played++); x.replies.on('skipped', () => skipped++);
  x.replies.receive(stop()); await tick();
  const call = x.phone.call;
  x.phone.play = () => new Promise((resolve, reject) => { finish = reject; });
  const playback = x.replies.play(call);
  call.endReason = 'hangup'; x.phone.call = null; finish(new Error('hangup'));
  await playback;
  assert.equal(x.replies.status().replyReady, false); assert.equal(x.replies.queue.length, 0);
  assert.equal(played, 0); assert.equal(skipped, 1);
  x.replies.maybeRing(); assert.equal(x.calls.length, 1);
  assert.equal(x.replies.receive(stop()).accepted, false);
});

test('multiple replies stay ordered and cannot grow without bound', async () => {
  const x = setup();
  for (let i = 0; i < 8; i++) x.replies.receive(stop(String(i), { last_assistant_message: String(i) }));
  assert.throws(() => x.replies.receive(stop('overflow')), /已满/);
  await tick(); await x.replies.play(x.phone.call); await tick();
  await x.replies.play(x.phone.call); assert.deepEqual(x.audio, ['0', '1']);
});

test('synthesis failure is visible; shutdown cannot ring from late synthesis', async () => {
  const x = setup();
  x.replies.synthesize = async () => { throw new Error('say failed'); };
  x.replies.receive(stop()); await tick(); assert.equal(x.replies.status().replyError, 'say failed');
  let finish; x.replies.synthesize = () => new Promise(resolve => { finish = resolve; });
  x.replies.receive(stop('2')); x.replies.close(); finish(Buffer.from('reply'));
  await tick(); assert.equal(x.calls.length, 0);
});


test('default playback starts with 1 second of PCMU silence and retains all speech', async () => {
  let played;
  const speech = Buffer.from([1, 2, 3]);
  const phone = { call: null, dial() { this.call = { id: 'delay' }; return this.call; }, async play(data) { played = data; } };
  const replies = new PhoneReplies({ phone, getBinding: () => ({ threadId: 'bound' }), synthesize: async () => speech });
  replies.receive(stop()); await tick(); await replies.play(phone.call);
  assert.equal(played.length, 8000 + speech.length);
  assert.ok(played.subarray(0, 8000).every(byte => byte === 0xff));
  assert.deepEqual(played.subarray(8000), speech);
});

test('reply callback uses the two-ring deadline and does not repeat after unanswered', async () => {
  const x = setup(); let options, count = 0;
  x.phone.dial = value => { options = value; count++; return x.phone.call = { id: 'two' }; };
  x.replies.receive(stop()); await tick();
  assert.equal(options.ringDurationMs, 8200);
  x.phone.call = null; x.replies.maybeRing();
  assert.equal(count, 1); assert.equal(x.replies.status().replyReady, true);
});
test('clearing replies during synthesis cannot resurrect a cancelled notification', async () => {
  const x = setup(); let finish;
  x.replies.synthesize = () => new Promise(resolve => { finish = resolve; });
  x.replies.receive(stop()); x.replies.clear(); finish(Buffer.from('cancelled'));
  await tick(); assert.equal(x.calls.length, 0); assert.equal(x.replies.queue.length, 0);
});
