import { EventEmitter } from 'node:events';
import { muLawWav } from './phone-archive.mjs';

// Per-request audio cap for the STT service. The GLM-ASR cloud endpoint caps at
// 30s; a self-hosted SenseVoice service typically accepts 120s. Override via env.
const MAX_SECONDS = Number(process.env.HT802_STT_MAX_SECONDS ?? (/bigmodel\.cn/.test(process.env.HT802_STT_ENDPOINT ?? 'https://open.bigmodel.cn') ? 28 : 115));

// File-based STT over any OpenAI-compatible /audio/transcriptions endpoint
// (self-hosted SenseVoice, GLM-ASR, ...). Buffers telephone audio during the
// call, transcribes once on hangup. Same interface as PhoneTranscription.
export class PhoneTranscriptionHttp extends EventEmitter {
  constructor({ apiKey = process.env.SPEECH_API_KEY ?? process.env.GLM_API_KEY ?? process.env.OPENAI_API_KEY, model = process.env.HT802_STT_MODEL ?? 'SenseVoice-Small', endpoint = process.env.HT802_STT_ENDPOINT ?? 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions', fetchImpl = globalThis.fetch } = {}) {
    super();
    if (!apiKey) throw new Error('缺少 SPEECH_API_KEY（语音服务的 Bearer key），无法开始语音转写');
    Object.assign(this, { apiKey, model, endpoint, fetchImpl });
    this.chunks = []; this.samples = 0; this.closed = false;
  }
  async start() { }
  append(payload) {
    if (this.closed) return;
    this.samples += payload.length;
    this.chunks.push(Buffer.from(payload));
  }
  async finish() {
    if (this.closed) throw new Error('转写会话已关闭');
    try {
      const audio = Buffer.concat(this.chunks);
      if (this.samples < 3200) return '';
      const seconds = this.samples / 8000;
      if (seconds > MAX_SECONDS) throw new Error(`语音超过 ${MAX_SECONDS} 秒上限，请分段录入（HT802_STT_MAX_SECONDS 可调）`);
      const form = new FormData();
      form.append('model', this.model);
      form.append('stream', 'false');
      form.append('file', new Blob([muLawWav(audio)], { type: 'audio/wav' }), 'phone.wav');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST', signal: controller.signal,
          headers: { Authorization: `Bearer ${this.apiKey}` },
          body: form,
        });
      } catch (error) {
        throw new Error(error.name === 'AbortError' ? '转写请求超时' : `转写请求失败：${error.message}`);
      } finally { clearTimeout(timer); }
      const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 500);
      if (!response.ok) throw new Error(`语音转写失败 (${response.status})${detail ? `：${detail}` : ''}`);
      let text;
      try { text = JSON.parse(detail).text; } catch { throw new Error(`转写响应无效：${detail}`); }
      this.finalText = (text ?? '').trim();
      this.emit('transcript', this.finalText);
      return this.finalText;
    } finally { this.close(); }
  }
  close() { this.closed = true; this.chunks = []; }
}
