import { randomUUID } from 'node:crypto';
import { link, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { decodeMuLaw } from './phone-audio.mjs';

export const ARCHIVE_DIRECTORY = join('.redline', 'phone-replies');

export function validProjectPath(projectPath) {
  return typeof projectPath === 'string' && isAbsolute(projectPath) && resolve(projectPath) === projectPath;
}

export function muLawWav(audio) {
  const samples = Buffer.alloc(audio.length * 2);
  for (let index = 0; index < audio.length; index++) samples.writeInt16LE(decodeMuLaw(audio[index]), index * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

export async function prepareArchive(projectPath) {
  if (!validProjectPath(projectPath)) throw new Error('绑定记录缺少有效的 project 路径，请重新绑定电话');
  const project = await stat(projectPath).catch(() => null);
  if (!project?.isDirectory()) throw new Error('绑定的 project 目录不存在');
  const directory = join(projectPath, ARCHIVE_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  return directory;
}

export async function archiveReply({ projectPath, threadId, turnId, audio, now = new Date(), id = randomUUID() }) {
  if (!Buffer.isBuffer(audio) || !audio.length) throw new Error('没有可归档的回复音频');
  const directory = await prepareArchive(projectPath);
  const safeTurn = String(turnId ?? '').replace(/[^0-9a-z_-]/gi, '').slice(0, 80) || 'turn';
  const safeId = String(id).replace(/[^0-9a-z_-]/gi, '').slice(0, 80) || randomUUID();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const filename = `${stamp}__${safeTurn}__${safeId}.wav`;
  const target = join(directory, filename); const temporary = join(directory, `.${safeId}.tmp`);
  try {
    await writeFile(temporary, muLawWav(audio), { flag: 'wx', mode: 0o600 });
    await link(temporary, target);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { path: target, threadId, turnId, bytes: audio.length };
}
