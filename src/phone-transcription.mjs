import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { muLawToPcm24k, decodeMuLaw } from './phone-audio.mjs';

export class PhoneTranscription extends EventEmitter {
  constructor({ apiKey = process.env.OPENAI_API_KEY, model = 'gpt-live-transcribe' } = {}) {
    super();
    if (!apiKey) throw new Error('缺少 OPENAI_API_KEY，无法开始实时转写');
    this.apiKey = apiKey; this.model = model;
    this.queued = []; this.ready = false; this.samples = 0; this.speechSamples = 0;
    this.closed = false; this.committing = false; this.finalText = '';
  }
  async start() {
    this.ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: { Authorization: `Bearer ${this.apiKey}` }, handshakeTimeout: 15000,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('实时转写初始化超时')), 20000);
      const fail = error => {
        clearTimeout(timer); reject(error);
        this.emit('failure', error); this.finishReject?.(error); this.close();
      };
      this.ws.on('error', fail);
      this.ws.on('open', () => this.send({ type: 'session.update', session: {
        type: 'transcription', audio: { input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: this.model, languages: ['zh', 'en'], prompt: '用户通过电话给 Codex 下达编程任务。', delay: 'low' },
          turn_detection: null,
        } },
      } }));
      this.ws.on('message', data => {
        let event; try { event = JSON.parse(data); } catch { return fail(new Error('转写服务返回无效事件')); }
        if (event.type === 'error') return fail(new Error(event.error?.message ?? '转写服务出错'));
        if (event.type === 'session.updated') {
          clearTimeout(timer); this.ready = true;
          for (const audio of this.queued) this.sendAudio(audio);
          this.queued = []; resolve();
        }
        if (event.type === 'conversation.item.input_audio_transcription.delta') this.emit('delta', event.delta ?? '');
        if (event.type === 'conversation.item.input_audio_transcription.failed') fail(new Error(event.error?.message ?? '转写失败'));
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          this.finalText = event.transcript?.trim() ?? '';
          this.emit('transcript', this.finalText);
          this.finishResolve?.(this.finalText);
        }
      });
      this.ws.on('close', () => { if (!this.closed) fail(new Error('实时转写连接提前断开')); });
    });
  }
  append(payload) {
    if (this.closed || this.committing) return;
    this.samples += payload.length;
    for (const byte of payload) if (Math.abs(decodeMuLaw(byte)) > 250) this.speechSamples++;
    const pcm = muLawToPcm24k(payload);
    if (this.ready) this.sendAudio(pcm);
    else {
      this.queued.push(pcm);
      if (this.samples > 8000 * 20) { this.emit('failure', new Error('转写连接未就绪，音频缓冲已满')); this.close(); }
    }
  }
  sendAudio(pcm) { this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }); }
  send(event) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event)); }
  async finish() {
    if (this.closed) throw new Error('实时转写会话已关闭');
    if (!this.ready) throw new Error('转写连接尚未就绪，请重试');
    if (this.samples < 3200 || this.speechSamples < 400) { this.close(); return ''; }
    this.committing = true;
    const result = new Promise((resolve, reject) => { this.finishResolve = resolve; this.finishReject = reject; });
    const timer = setTimeout(() => this.finishReject?.(new Error('等待最终转写超时')), 30000);
    this.send({ type: 'input_audio_buffer.commit' });
    try { return await result; } finally { clearTimeout(timer); this.close(); }
  }
  close() { this.closed = true; this.queued = []; this.ws?.close(); }
}
