import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PhoneVoice } from '../src/phone-voice.mjs';
function setup() {
  const sent = [], audio = [];
  const transcription = Object.assign(new EventEmitter(), { async start() {}, append(data) { audio.push(data); }, async finish() { return '测试任务'; }, close() {} });
  const input = { async start() {}, async submit(text) { sent.push(text); }, close() {} };
  const voice = new PhoneVoice({ createTranscription: () => transcription, createInput: () => input });
  voice.on('failure', () => {}); voice.enabled = true;
  return { voice, input, transcription, sent, audio };
}
test('only normal hangup submits once, and only matching audio is transcribed', async () => {
  const x = setup(); await x.voice.begin('a');
  x.voice.audio(Buffer.from('other'), 'b'); x.voice.audio(Buffer.from('speech'), 'a');
  assert.equal(x.audio.length, 1); assert.equal(x.sent.length, 0);
  await Promise.all([x.voice.end('a', 'hangup'), x.voice.end('a', 'hangup')]);
  assert.deepEqual(x.sent, ['测试任务']); assert.equal(x.voice.result.submittedToCodex, true);
  assert.equal(x.voice.active, null);
});
test('unavailable composer, silence, abnormal hangup and transcription failure never submit', async () => {
  for (const scenario of ['composer', 'silence', 'disconnect', 'api']) {
    const x = setup();
    if (scenario === 'composer') x.input.start = async () => { throw new Error('draft present'); };
    if (scenario === 'silence') x.transcription.finish = async () => '';
    if (scenario === 'api') x.transcription.finish = async () => { throw new Error('API failed'); };
    await x.voice.begin('a'); await x.voice.end('a', scenario === 'disconnect' ? 'timeout' : 'hangup');
    assert.deepEqual(x.sent, [], scenario); assert.equal(x.voice.active, null);
  }
});
test('shutdown during final transcription cannot submit', async () => {
  const x = setup(); let finish;
  x.transcription.finish = () => new Promise(resolve => { finish = resolve; });
  await x.voice.begin('a'); const end = x.voice.end('a', 'hangup');
  await Promise.resolve(); x.voice.close(); finish('late transcript'); await end;
  assert.deepEqual(x.sent, []);
});
test('uncertain input submission is not retried', async () => {
  const x = setup(); let attempts = 0;
  x.input.submit = async () => { attempts++; throw new Error('confirmation unavailable'); };
  await x.voice.begin('a'); await x.voice.end('a', 'hangup'); await x.voice.end('a', 'hangup');
  assert.equal(attempts, 1); assert.match(x.voice.result.error, /confirmation/);
});
