import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveReply, ARCHIVE_DIRECTORY, muLawWav, prepareArchive } from '../src/phone-archive.mjs';

test('telephone PCMU becomes a standard 8 kHz mono PCM WAV', () => {
  const wav = muLawWav(Buffer.from([0xff, 0x00, 0x80]));
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 6);
});

test('reply archive is atomic, private, playable, and ignored by Git', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'redline-archive-test-'));
  try {
    const result = await archiveReply({
      projectPath, threadId: 'thread', turnId: '../unsafe turn', audio: Buffer.alloc(80, 0xff),
      now: new Date('2026-09-08T12:34:56.789Z'), id: 'fixed-id'
    });
    assert.equal(result.path, join(projectPath, ARCHIVE_DIRECTORY, '2026-09-08T12-34-56-789Z__unsafeturn__fixed-id.wav'));
    const wav = await readFile(result.path);
    assert.equal(wav.readUInt32LE(24), 8000);
    assert.equal(wav.length, 204);
    assert.equal(await readFile(join(projectPath, ARCHIVE_DIRECTORY, '.gitignore'), 'utf8'), '*\n');
    assert.deepEqual((await readdir(join(projectPath, ARCHIVE_DIRECTORY))).sort(), ['.gitignore', '2026-09-08T12-34-56-789Z__unsafeturn__fixed-id.wav']);
  } finally { await rm(projectPath, { recursive: true, force: true }); }
});

test('reply archive rejects missing project identity and empty audio', async () => {
  await assert.rejects(archiveReply({ projectPath: 'relative', audio: Buffer.from([1]) }), /project 路径/);
  await assert.rejects(archiveReply({ projectPath: '/tmp', audio: Buffer.alloc(0) }), /没有可归档/);
  await assert.rejects(prepareArchive('/tmp/redline-project-that-does-not-exist'), /不存在/);
});
