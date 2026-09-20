import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneBinding, DtmfDecoder } from '../src/phone-binding.mjs';

const threadId = '01a071cf-9a2d-7ba0-8695-28b2389162cf';
const projectPath = '/tmp/redline-project';

test('agent binds directly without a telephone request; saved binding survives restart', async () => {
  let saved;
  const binding = new PhoneBinding({ persist: async value => { saved = value; } });
  const result = await binding.bind({ threadId, projectPath });
  assert.equal(result.bound, true);
  assert.equal(saved.threadId, threadId);
  assert.equal(saved.projectPath, projectPath);
  assert.deepEqual(new PhoneBinding({ binding: saved }).status().binding, saved);
});

test('invalid IDs and remote targets cannot change binding', async () => {
  const original = { threadId: 'old' };
  const binding = new PhoneBinding({ binding: original, persist: async () => assert.fail() });
  for (const id of [undefined, '', 'invented']) await assert.rejects(binding.bind({ threadId: id }), /UUID/);
  await assert.rejects(binding.bind({ threadId, hostId: 'remote', projectPath }), /本机/);
  await assert.rejects(binding.bind({ threadId, projectPath: 'relative' }), /绝对路径/);
  assert.equal(binding.binding, original);
});

test('save failure preserves prior binding and permits explicit retry', async () => {
  const original = { threadId: 'old' };
  let fail = true;
  const binding = new PhoneBinding({ binding: original, persist: async () => { if (fail) throw new Error('disk full'); } });
  await assert.rejects(binding.bind({ threadId, projectPath }), /disk full/);
  assert.equal(binding.binding, original);
  fail = false;
  assert.equal((await binding.bind({ threadId, projectPath })).bound, true);
});

test('concurrent binding cannot overwrite an in-flight save', async () => {
  let finish;
  const binding = new PhoneBinding({ persist: () => new Promise(resolve => { finish = resolve; }) });
  const first = binding.bind({ threadId, projectPath });
  await assert.rejects(binding.bind({ threadId, projectPath }), /正在保存/);
  finish(); await first;
});

test('DTMF redundancies and long key presses are deduplicated, repeated keys retained', () => {
  const decoder = new DtmfDecoder();
  const event = (digit, timestamp, end = false) => ({ timestamp, payload: Buffer.from([digit, end ? 128 : 0, 0, 160]) });
  assert.equal(decoder.read(event(11, 100)), '#');
  assert.equal(decoder.read(event(11, 100, true)), null);
  assert.equal(decoder.read(event(11, 200, true)), '#');
  assert.equal(decoder.read(event(30, 400)), null);
});

test('unbind persists null, survives restart, and is idempotent', async () => {
  let saved;
  const binding = new PhoneBinding({ binding: { threadId }, persist: async value => { saved = value; } });
  assert.deepEqual(await binding.unbind(), { bound: false, binding: null });
  assert.equal(saved, null); assert.equal(new PhoneBinding({ binding: saved }).binding, null);
  assert.equal((await binding.unbind()).bound, false);
});
test('unbind persistence failure preserves binding and concurrent mutations are rejected', async () => {
  const original = { threadId };
  const binding = new PhoneBinding({ binding: original, persist: async () => { throw new Error('disk full'); } });
  await assert.rejects(binding.unbind(), /disk full/); assert.equal(binding.binding, original);
  let finish; binding.persist = () => new Promise(resolve => { finish = resolve; });
  const unbind = binding.unbind();
  await assert.rejects(binding.bind({ threadId, projectPath }), /正在保存/);
  await assert.rejects(binding.unbind(), /正在保存/);
  finish(); await unbind; assert.equal(binding.binding, null);
});
