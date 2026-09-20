import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneReports } from '../src/phone-reports.mjs';

function fixture(options = {}) {
  const phone = new EventEmitter();
  phone.call = null;
  phone.dialed = [];
  phone.dial = () => {
    if (phone.call) throw new Error('电话线路正忙');
    const call = { id: `call-${phone.dialed.length}`, outgoing: true };
    phone.dialed.push(call); phone.call = call;
    return call;
  };
  phone.play = async () => {};
  phone.hangup = reason => { const call = phone.call; phone.call = null; queueMicrotask(() => reports.ended(call, reason)); };
  const archiveDir = options.archiveDir;
  const reports = new PhoneReports({
    phone, retryDelayMs: 1, maxAttempts: options.maxAttempts ?? 5,
    synthesize: async text => Buffer.from(text),
    createTranscription: () => options.transcription ?? ({ on() {}, async start() {}, append() {}, async finish() { return '转写文本'; }, close() {} }),
    archivePath: join(archiveDir, 'reports.jsonl'),
  });
  return { phone, reports };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'phone-reports-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const answer = (phone, reports) => { const call = phone.call; reports.connected(call); return call; };

test('say 接通后播完自动挂断，归档文字版', async () => withTempDir(async dir => {
  const { phone, reports } = fixture({ archiveDir: dir });
  const resultPromise = reports.submit({ kind: 'say', text: '构建完成' });
  await new Promise(resolve => setImmediate(resolve));
  answer(phone, reports);
  const result = await resultPromise;
  assert.equal(result.delivered, true);
  assert.equal(result.answered, true);
  assert.equal(result.attempts, 1);
  const archive = JSON.parse((await readFile(join(dir, 'reports.jsonl'), 'utf8')).trim());
  assert.equal(archive.text, '构建完成');
  assert.equal(archive.delivered, true);
  assert.equal(phone.call, null);
}));

test('未接通自动重试，第二次接通后成功', async () => withTempDir(async dir => {
  const { phone, reports } = fixture({ archiveDir: dir });
  const resultPromise = reports.submit({ kind: 'say', text: 'hello' });
  await new Promise(resolve => setImmediate(resolve));
  // attempt 1: ring out unanswered
  const first = phone.call; phone.call = null; reports.ended(first, 'unanswered');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(phone.dialed.length, 2);
  answer(phone, reports);
  const result = await resultPromise;
  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 2);
}));

test('五次未接通后失败并归档，agent 可 fallback 文字汇报', async () => withTempDir(async dir => {
  const { phone, reports } = fixture({ archiveDir: dir });
  const resultPromise = reports.submit({ kind: 'say', text: '重要通知' });
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    const call = phone.call; phone.call = null; reports.ended(call, 'unanswered');
  }
  const result = await resultPromise;
  assert.equal(result.delivered, false);
  assert.equal(result.answered, false);
  assert.equal(result.attempts, 5);
  const archive = JSON.parse((await readFile(join(dir, 'reports.jsonl'), 'utf8')).trim());
  assert.equal(archive.text, '重要通知');
  assert.equal(archive.delivered, false);
  assert.equal(result.archived, true);
}));

test('队列串行：第二条汇报在第一条完成后才开始', async () => withTempDir(async dir => {
  const { phone, reports } = fixture({ archiveDir: dir });
  const first = reports.submit({ kind: 'say', text: '第一条' });
  const second = reports.submit({ kind: 'say', text: '第二条' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(phone.dialed.length, 1);
  answer(phone, reports);
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(phone.dialed.length, 2);
  answer(phone, reports);
  await second;
  const lines = (await readFile(join(dir, 'reports.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(JSON.parse(lines[0]).text, '第一条');
  assert.equal(JSON.parse(lines[1]).text, '第二条');
}));

test('队列满拒绝新汇报', async () => withTempDir(async dir => {
  const { phone, reports } = fixture({ archiveDir: dir });
  reports.maxQueue = 2;
  const first = reports.submit({ kind: 'say', text: 'a' });
  reports.submit({ kind: 'say', text: 'b' }).catch(() => {});
  assert.throws(() => reports.submit({ kind: 'say', text: 'c' }), /队列已满/);
  await new Promise(resolve => setImmediate(resolve));
  answer(phone, reports);
  await first;
}));

test('ask 返回用户语音转写', async () => withTempDir(async dir => {
  const { phone, reports } = fixture({ archiveDir: dir });
  const resultPromise = reports.submit({ kind: 'ask', text: '可以执行吗' });
  await new Promise(resolve => setImmediate(resolve));
  const call = answer(phone, reports);
  await new Promise(resolve => setImmediate(resolve));
  phone.call = null;
  reports.ended(call, 'hangup');
  const result = await resultPromise;
  assert.equal(result.delivered, true);
  assert.equal(result.answered, true);
  assert.equal(result.text, '转写文本');
}));
