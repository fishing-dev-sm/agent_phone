#!/usr/bin/env node
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, unlink, chmod, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { PhoneSip } from './phone-sip.mjs';
import { PhoneBinding } from './phone-binding.mjs';
import { tone, synthesize } from './phone-audio.mjs';
import { archiveReply, prepareArchive } from './phone-archive.mjs';
import { PhoneMicrophone, checkMicrophone, restoreMicrophone } from './phone-microphone.mjs';
import { PhoneCapture } from './phone-capture.mjs';
import { PhoneTranscription } from './phone-transcription.mjs';
import { PhoneTranscriptionHttp } from './phone-transcription-http.mjs';
import { beginPhoneListening, connectPhoneFollowup } from './phone-followup.mjs';
import { PhoneInput } from './phone-input.mjs';
import { PhoneVoice } from './phone-voice.mjs';
import { PhoneReplies } from './phone-replies.mjs';
import { PhoneReports } from './phone-reports.mjs';

const entry = fileURLToPath(import.meta.url);
const runtime = join(dirname(dirname(entry)), '.runtime');
const socketPath = join(runtime, 'phone.sock');
const bindingPath = join(runtime, 'phone-binding.json');
const localAddress = process.env.HT802_LOCAL_ADDRESS ?? '192.168.82.1';
const deviceAddress = process.env.HT802_ADDRESS ?? '192.168.82.100';
async function rpc(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let data = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('companion 响应超时')));
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 65536) return socket.destroy(new Error('companion 响应过大'));
      const end = data.indexOf('\n'); if (end < 0) return;
      try { const value = JSON.parse(data.slice(0, end)); value.ok ? resolve(value.result) : reject(new Error(value.error)); }
      catch (error) { reject(error); }
      socket.end();
    });
    socket.on('error', reject);
    socket.on('end', () => { if (!data.includes('\n')) reject(new Error('companion 连接已关闭')); });
  });
}

async function serve() {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  // A live owner must never have its socket unlinked by a second launch.
  try { await rpc({ method: 'status' }); throw new Error('companion 已经运行'); }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    if (error.code === 'ECONNREFUSED') await unlink(socketPath);
  }
  let saved = null;
  try { saved = JSON.parse(await readFile(bindingPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved && (saved.version !== 1 || typeof saved.threadId !== 'string')) throw new Error('绑定记录格式无效，未覆盖');
  const binding = new PhoneBinding({ binding: saved, persist: async value => {
    const tmp = `${bindingPath}.${randomUUID()}.tmp`;
    try { await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(tmp, bindingPath); }
    finally { await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  } });
  const phone = new PhoneSip();
  let settling = false, confirmation = null, lastEvent = null, stopped = false, callbackTimer;
  const log = (event, details = {}) => {
    lastEvent = { time: new Date().toISOString(), event, ...details };
    console.log(JSON.stringify(lastEvent));
  };
  let microphoneUntil = 0, microphoneCall = null, microphoneResult = null, testSayAudio = null;
  const microphoneStatus = () => ({ armed: microphoneUntil > Date.now(), active: Boolean(microphoneCall), result: microphoneResult });
  phone.on('audio', (data, call) => {
    const active = microphoneCall;
    if (active?.id !== call.id || active.failed) return;
    try { active.session.append(data); }
    catch (error) { active.failed = true; microphoneResult = { error: error.message }; active.session.close().catch(() => {}); log('microphone_failed', { error: error.message }); }
  });
  async function endMicrophone(call, reason) {
    const active = microphoneCall;
    if (!active || active.id !== call.id) return;
    try {
      await active.ready;
      if (reason === 'hangup' && !active.failed) microphoneResult = await active.session.finish();
      else await active.session.close();
    } catch (error) { microphoneResult = { error: error.message }; log('microphone_failed', { error: error.message }); }
    finally { if (microphoneCall === active) microphoneCall = null; replies.maybeRing(); }
  }
  const sttProvider = process.env.HT802_STT_PROVIDER ?? (!process.env.OPENAI_API_KEY && (process.env.SPEECH_API_KEY ?? process.env.GLM_API_KEY) ? 'http' : 'openai');
  const createTranscription = () => sttProvider === 'http' ? new PhoneTranscriptionHttp() : new PhoneTranscription();
  const voice = new PhoneVoice({ createTranscription, createInput: () => new PhoneInput() });
  voice.on('failure', error => log('voice_failed', { error: error.message }));
  voice.on('submitted', () => log('voice_submitted'));
  voice.on('idle', () => replies.maybeRing());
  phone.on('audio', (data, call) => voice.audio(data, call.id));
  const capture = new PhoneCapture({ createSession: createTranscription });
  capture.on('failure', error => log('transcription_failed', { error: error.message }));
  capture.on('completed', () => log('transcription_completed'));
  phone.on('audio', (data, call) => capture.audio(data, call.id));
  const replies = new PhoneReplies({ phone, getBinding: () => binding.binding, synthesize, archive: archiveReply, canRing: () => !settling && !binding.confirming && !microphoneCall && !voice.active });
  connectPhoneFollowup({ phone, replies, voice, log });
  replies.on('failure', error => log('reply_failed', { error: error.message }));
  const reports = new PhoneReports({ phone, synthesize, createTranscription, archivePath: join(runtime, 'phone-reports.jsonl') });
  reports.on('queued', event => log('report_queued', event));
  reports.on('attempt', event => log('report_attempt', event));
  reports.on('listening', event => log('report_listening', event));
  reports.on('finished', record => log('report_finished', { id: record.id, kind: record.kind, delivered: record.delivered, attempts: record.attempts, reason: record.reason }));
  reports.on('failure', error => log('report_failed', { error: error.message }));
  for (const event of ['ready', 'ringing', 'played', 'skipped']) replies.on(event, () => log(`reply_${event}`));
  const status = () => ({ ...binding.status(), ...replies.status(), ...reports.status(), transcriptionTest: capture.status(), dictateAudioTest: microphoneStatus(), voiceSubmission: voice.status(), inputTransport: 'accessibility_current_composer', mode: 'agent', handset: phone.call && !phone.call.outgoing ? 'off_hook' : 'on_hook', pid: process.pid, lineBusy: Boolean(phone.call), settling, confirmation, lastEvent });
  phone.allowIncoming = () => !settling && !binding.confirming && !microphoneCall && !voice.active;
  phone.on('failure', error => log('phone_error', { error: error.message }));
  phone.on('digit', digit => log('dtmf', { digit }));
  phone.on('incoming', () => log('handset_up'));
  phone.on('connected', call => {
    if (call.purpose === 'say' || call.purpose === 'ask') {
      clearTimeout(call.confirmTimer);
      reports.connected(call);
      return;
    }
    if (call.purpose === 'test') {
      clearTimeout(call.confirmTimer);
      const audio = testSayAudio; testSayAudio = null;
      phone.play(audio ?? Buffer.concat([tone(880, .4), tone(660, .4)])).catch(() => {});
      return;
    }
    if (call.purpose === 'reply' || (!call.outgoing && replies.status().replyReady)) {
      replies.play(call).catch(error => log('reply_failed', { error: error.message }));
    } else if (call.outgoing) {
      clearTimeout(call.confirmTimer);
      confirmation = 'answered';
      beginPhoneListening({ phone, voice, call, log, event: 'confirmation_listening' }).catch(error => log('voice_failed', { error: error.message }));
    } else if (microphoneUntil > Date.now()) {
      microphoneUntil = 0;
      const active = { id: call.id, session: new PhoneMicrophone(), failed: false }; microphoneCall = active;
      active.ready = active.session.start().then(() => {
        if (phone.call?.id === call.id) phone.play(tone(660, .3)).catch(() => {});
      }, error => {
        active.failed = true; microphoneResult = { error: error.message }; log('microphone_failed', { error: error.message });
        if (phone.call?.id === call.id) phone.play(tone(220, .6)).catch(() => {});
      });
    } else if (capture.armed) {
      capture.begin(call.id).then(ready => {
        // Prepend silence: the first packets after connect are eaten by the media path warmup.
        const cue = tone(ready ? 660 : 220, .3);
        if (phone.call?.id === call.id) phone.play(Buffer.concat([Buffer.alloc(4000, 0xff), cue])).catch(() => {});
      }).catch(error => log('transcription_failed', { error: error.message }));
    } else if (voice.enabled) {
      voice.begin(call.id).then(async ready => {
        // A failure can arrive before the HT802 media path is audible.
        if (!ready) await new Promise(resolve => setTimeout(resolve, 350));
        if (phone.call?.id === call.id) phone.play(tone(ready ? 660 : 220, ready ? .3 : .6)).catch(() => {});
      }).catch(error => log('voice_failed', { error: error.message }));
    } else phone.play(tone(220, .6)).catch(() => {});
  });
  function ringConfirmation() {
    confirmation = 'pending'; settling = true;
    callbackTimer = setTimeout(() => {
      settling = false;
      if (stopped || phone.call) { confirmation = 'line_busy'; log('confirmation_skipped'); return; }
      try {
        // c=2000/4000: two bursts at 0–2 and 6–8 seconds, no third burst.
        phone.dial({ ringDurationMs: 8200 }); confirmation = 'ringing'; log('confirmation_ringing');
      } catch (error) { confirmation = 'failed'; log('confirmation_failed', { error: error.message }); }
    }, 1200);
  }
  phone.on('audio', (data, call) => reports.audio(data, call));
  phone.on('ended', ({ call, reason }) => {
    if (call.purpose === 'say' || call.purpose === 'ask') {
      log(`${call.purpose}_call_ended`, { reason });
      reports.ended(call, reason);
      return;
    }
    if (call.purpose === 'test') { log('test_call_ended', { reason }); return; }
    if (call.outgoing) { confirmation = reason; log(call.purpose === 'reply' ? 'reply_call_ended' : 'confirmation_ended', { reason });
      setTimeout(() => replies.maybeRing(), 1200); return; }
    endMicrophone(call, reason).catch(error => log('microphone_failed', { error: error.message }));
    capture.end(call.id, reason).catch(error => log('transcription_failed', { error: error.message }));
    log('handset_down', { reason });
    setTimeout(() => replies.maybeRing(), 1200);
  });
  await phone.start();
  async function dispatch(request) {
    if (request.method === 'status') return status();
    if (request.method === 'enable-voice' || request.method === 'disable-voice') {
      if (phone.call || settling || microphoneCall || capture.active || voice.active || replies.status().queuedReplies) throw new Error('电话正忙');
      if (request.method === 'enable-voice' && !binding.binding) throw new Error('请先绑定目标任务');
      if (request.method === 'enable-voice' && !process.env.OPENAI_API_KEY && !process.env.SPEECH_API_KEY) throw new Error('缺少语音服务凭据');
      voice.enabled = request.method === 'enable-voice';
      capture.expires = 0; microphoneUntil = 0; return voice.status();
    }
    if (request.method === 'test-dictate-audio') {
      if (phone.call || settling || microphoneCall || capture.active || voice.active || replies.status().queuedReplies) throw new Error('电话正忙');
      await checkMicrophone(); capture.expires = 0; microphoneUntil = Date.now() + 120000; microphoneResult = null; return microphoneStatus();
    }
    if (request.method === 'test-transcription') {
      if (phone.call || settling || voice.active || replies.status().queuedReplies) throw new Error('电话正忙');
      if (microphoneCall) throw new Error('虚拟麦克风正忙');
      microphoneUntil = 0; capture.arm(); return capture.status();
    }
    if (request.method === 'hook') return replies.receive(request.event ?? {});
    if (request.method === 'unbind') {
      const result = await binding.unbind();
      clearTimeout(callbackTimer); settling = false; confirmation = null;
      voice.close(); capture.close(); microphoneUntil = 0; replies.clear();
      phone.hangup('unbound');
      log('unbound');
      return result;
    }
    if (request.method === 'test-ring') {
      if (phone.call || settling || microphoneCall || capture.active || voice.active || replies.status().queuedReplies) throw new Error('电话正忙');
      const call = phone.dial({ ringDurationMs: 8200 }); call.purpose = 'test'; return { ringing: true };
    }
    if (request.method === 'test-say') {
      if (phone.call || settling || microphoneCall || capture.active || voice.active || replies.status().queuedReplies || reports.active) throw new Error('电话正忙');
      const text = typeof request.text === 'string' ? request.text.trim() : '';
      if (!text || text.length > 1000) throw new Error('test-say 需要 1 到 1000 字的文本');
      testSayAudio = await synthesize(text);
      try {
        const call = phone.dial({ ringDurationMs: 8200 });
        call.purpose = 'test';
        return { ringing: true, characters: text.length };
      } catch (error) { testSayAudio = null; throw error; }
    }
    if (request.method === 'say' || request.method === 'ask') {
      const text = typeof request.text === 'string' ? request.text.trim() : '';
      if (!text || text.length > 20000) throw new Error(`${request.method} 文本必须在 1 到 20000 字之间；超过 100 字的部分会自动压缩播报`);
      const timeoutSec = Number(request.timeoutSec ?? 120);
      if (!Number.isFinite(timeoutSec) || timeoutSec < 10 || timeoutSec > 300) throw new Error('timeoutSec 必须在 10 到 300 之间');
      return await reports.submit({ kind: request.method, text, timeoutSec });
    }
    if (request.method === 'bind') {
      if (phone.call || settling || microphoneCall || capture.active || voice.active || replies.status().queuedReplies) throw new Error('电话或响铃操作正忙，请稍后重试绑定');
      if (!process.env.OPENAI_API_KEY && !process.env.SPEECH_API_KEY) throw new Error('缺少语音服务凭据');
      await prepareArchive(request.target?.projectPath);
      const result = await binding.bind(request.target);
      voice.enabled = true;
      replies.suppressBindingReply(result.binding.threadId);
      log('bound', { threadId: result.binding.threadId, title: result.binding.title });
      ringConfirmation();
      return result;
    }
    if (request.method === 'stop') { setTimeout(shutdown, 100); return { stopping: true }; }
    throw new Error('未知命令');
  }
  function handleConnection(socket, token) {
    let data = '', handled = false;
    socket.on('error', () => {}); socket.setTimeout(700000, () => socket.destroy());
    socket.on('data', async chunk => {
      if (handled) return;
      data += chunk;
      if (data.length > 262144) return socket.destroy();
      const end = data.indexOf('\n'); if (end < 0) return;
      handled = true;
      try {
        const request = JSON.parse(data.slice(0, end));
        if (token) {
          const provided = Buffer.from(String(request.token ?? ''));
          if (provided.length !== token.length || !timingSafeEqual(provided, token)) throw new Error('RPC token 无效');
        }
        const result = await dispatch(request);
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch (error) { socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'); }
    });
  }
  const server = net.createServer(socket => handleConnection(socket, null));
  let tcpServer = null, rpcTokenBuffer = null;
  const rpcPort = Number(process.env.PHONE_RPC_PORT ?? 0);
  const rpcToken = process.env.PHONE_RPC_TOKEN;
  if (rpcPort) {
    if (!Number.isInteger(rpcPort) || rpcPort < 1024 || rpcPort > 65535) throw new Error('PHONE_RPC_PORT 必须是 1024 到 65535 之间的端口');
    if (!rpcToken || rpcToken.length < 16) throw new Error('启用 PHONE_RPC_PORT 时 PHONE_RPC_TOKEN 至少需要 16 个字符');
    rpcTokenBuffer = Buffer.from(rpcToken);
    tcpServer = net.createServer(socket => handleConnection(socket, rpcTokenBuffer));
  }
  async function shutdown() {
    if (stopped) return; stopped = true; clearTimeout(callbackTimer);
    voice.close(); capture.close(); replies.close(); reports.close(); phone.close(); server.close(); tcpServer?.close();
    if (microphoneCall) await microphoneCall.session.close().catch(error => log('microphone_restore_failed', { error: error.message }));
    await unlink(socketPath).catch(() => {}); log('stopped');
    setTimeout(() => process.exit(0), 100);
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    if (tcpServer) await new Promise((resolve, reject) => { tcpServer.once('error', reject); tcpServer.listen(rpcPort, resolve); });
  } catch (error) { phone.close(); throw error; }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  log('ready', { sip: `${phone.host}:${phone.port}`, peer: phone.peer, mode: 'agent', rpc: tcpServer ? `tcp:${rpcPort}` : 'unix' });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'restore-microphone') { await restoreMicrophone(); console.log('Microphone recovery complete'); return; }
  if (command === 'serve') return serve();
  if (command === 'start') {
    try { console.log(JSON.stringify(await rpc({ method: 'status' }), null, 2)); return; }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const log = await open(join(runtime, 'phone.log'), 'a', 0o600);
    const child = spawn(process.execPath, [entry, 'serve'], { detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.on('error', error => console.error(error.message)); child.unref(); await log.close();
    for (let i = 0; i < 25; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      try { console.log(JSON.stringify(await rpc({ method: 'status' }), null, 2)); return; } catch {}
    }
    throw new Error(`companion 未启动，请检查 ${join(runtime, 'phone.log')}。先确认有线网口为 ${localAddress}。`);
  }
  if (command === 'bind') {
    if (args.length && (args.length !== 2 || args[0] !== '--title')) throw new Error('bind 只支持可选的 --title 标题；目标来自 CODEX_THREAD_ID');
    const threadId = process.env.CODEX_THREAD_ID;
    if (!threadId) throw new Error('请从目标 Codex 任务运行 bind；缺少 CODEX_THREAD_ID');
    const title = args[1] ?? '';
    console.log(JSON.stringify(await rpc({ method: 'bind', target: { threadId, title, hostId: 'local', projectPath: process.cwd() } }), null, 2)); return;
  }
  if (command === 'say' || command === 'ask' || command === 'test-say') {
    const text = args.join(' ');
    if (!text) throw new Error(`用法：${command} 要朗读的文本`);
    console.log(JSON.stringify(await rpc({ method: command, text }), null, 2)); return;
  }
  if (['status', 'stop', 'unbind', 'test-ring', 'test-transcription', 'test-dictate-audio', 'enable-voice', 'disable-voice'].includes(command)) {
    console.log(JSON.stringify(await rpc({ method: command }), null, 2)); return;
  }
  if (command && !['help', '--help'].includes(command)) throw new Error('未知命令；运行 --help 查看用法');
  console.log(`HT802 Codex phone

  start             Start the local SIP companion
  enable-voice      Pickup transcribes; hangup submits to the focused Codex composer
  disable-voice     Disable automatic voice input (reply playback stays enabled)
  test-dictate-audio Route one call to BlackHole; operate Dictate manually
  restore-microphone Restore input after an interrupted audio test
  test-transcription Arm one pickup within 120 seconds; return text in status, never submit
  test-ring          Ring the phone twice; answering plays two test tones
  test-say TEXT      Ring, then speak TEXT via the configured TTS provider
  say TEXT           Queue a spoken report; retries up to 5 times, archives text version
  ask TEXT           Like say, then records the reply; hangup returns the transcript
  status            Read saved binding and confirmation ring state
  bind [--title T]  Bind to the invoking agent's CODEX_THREAD_ID; ring twice
  unbind           Clear binding, cancel calls and queued replies, disable voice
  stop              Stop SIP service; keep the existing binding

Run bind as the final operation of a binding task. No keypad code, focused
composer, accessibility permission, or separate Codex session is needed.
Requires Mac ${localAddress} and HT802 ${deviceAddress}, PHONE 1 on hook.
Codex Stop hooks ring, archive, and read replies. Voice input is off after daemon
restart; use enable-voice or bind again to enable it. Keep the intended bound
task visible with an empty composer throughout the call. This UI transport
cannot verify a task ID.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
