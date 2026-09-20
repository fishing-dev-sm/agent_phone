import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PhoneCapture } from '../src/phone-capture.mjs';
function setup() {
  const sent = []; let commits = 0;
  const session = Object.assign(new EventEmitter(), { async start() {}, append(data) { sent.push(data); }, async finish() { commits++; return '你好'; }, close() {} });
  const capture = new PhoneCapture({ createSession: () => session });
  capture.on('failure', () => {});
  return { capture, session, sent, commits: () => commits };
}
test('one-shot test only captures matching call and commits on hangup', async () => {
  const x = setup(); assert.equal(await x.capture.begin('call'), false);
  x.capture.arm(); await x.capture.begin('call');
  x.capture.audio(Buffer.from('wrong'), 'other'); x.capture.audio(Buffer.from('speech'), 'call');
  assert.equal(x.sent.length, 1); assert.equal(x.commits(), 0);
  await x.capture.end('call', 'hangup'); assert.equal(x.commits(), 1);
  assert.deepEqual(x.capture.result, { text: '你好', submittedToCodex: false });
  assert.equal(await x.capture.begin('next'), false);
});
test('expired arm and abnormal termination cannot commit', async () => {
  const x = setup(); let now = 0; x.capture.now = () => now;
  x.capture.arm(); now = 120001; assert.equal(await x.capture.begin('call'), false);
  x.capture.arm(); await x.capture.begin('call'); await x.capture.end('call', 'duration_limit');
  assert.equal(x.commits(), 0);
});
test('initialization failure stays visible and never commits', async () => {
  const x = setup(); x.session.start = async () => { throw new Error('unavailable'); };
  x.capture.arm(); assert.equal(await x.capture.begin('call'), false);
  await x.capture.end('call', 'hangup'); assert.equal(x.commits(), 0);
  assert.equal(x.capture.result.error, 'unavailable');
});
