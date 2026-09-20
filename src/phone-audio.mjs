import { spawn } from 'node:child_process';

const TTS_INSTRUCTIONS = '使用普通话的原创中年男性声线。音色低沉但自然，表达克制、稳重、审慎，像机关干部向上级汇报工作。保持干练的正常交流语速，减少句间停顿，重点词轻微加重。保持礼貌、权威和谨慎感，不要戏剧化，不模仿任何真实人物、演员或影视角色。';
const MAX_TTS_CHARS = 1000;
const MAX_AUDIO_BYTES = 8000 * 600;

export function decodeMuLaw(byte) {
  const value = (~byte) & 255;
  const sample = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
  return value & 128 ? 132 - sample : sample - 132;
}

export function encodeMuLaw(sample) {
  const sign = sample < 0 ? 128 : 0;
  let value = Math.min(32635, Math.abs(Math.round(sample))) + 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(value & mask); mask >>= 1) exponent--;
  return (~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 15))) & 255;
}

export function muLawToPcm24k(payload) {
  // Integer-rate interpolation of the 8 kHz telephone stream for the STT API.
  const out = Buffer.alloc(payload.length * 6);
  for (let i = 0; i < payload.length; i++) {
    const a = decodeMuLaw(payload[i]);
    const b = decodeMuLaw(payload[Math.min(i + 1, payload.length - 1)]);
    for (let j = 0; j < 3; j++) out.writeInt16LE(Math.round(a + (b - a) * j / 3), i * 6 + j * 2);
  }
  return out;
}

export function parseRtp(packet) {
  if (packet.length < 12 || packet[0] >> 6 !== 2) return null;
  let offset = 12 + 4 * (packet[0] & 15);
  if (offset > packet.length) return null;
  if (packet[0] & 16) {
    if (offset + 4 > packet.length) return null;
    offset += 4 + 4 * packet.readUInt16BE(offset + 2);
  }
  const padding = packet[0] & 32 ? packet.at(-1) : 0;
  if (offset > packet.length - padding || ((packet[0] & 32) && !padding)) return null;
  return { payloadType: packet[1] & 127, sequence: packet.readUInt16BE(2), timestamp: packet.readUInt32BE(4), payload: packet.subarray(offset, packet.length - padding) };
}

export function makeRtp(payload, sequence, timestamp, ssrc) {
  const header = Buffer.alloc(12);
  header[0] = 128;
  header.writeUInt16BE(sequence & 65535, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

export function tone(frequency = 660, seconds = 0.15) {
  return Buffer.from(Array.from({ length: Math.round(8000 * seconds) }, (_, i) => encodeMuLaw(2500 * Math.sin(2 * Math.PI * frequency * i / 8000))));
}

export function speakable(text) {
  return text.replace(/```[\s\S]*?```/g, '。代码内容请查看对话。')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '链接见对话')
    .replace(/^[#>*\-]+\s*/gm, '').replace(/[`*_]/g, '').trim();
}

const SPEECH_LIMIT = 100;

function truncateForSpeech(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SPEECH_LIMIT) return flat;
  const cut = flat.slice(0, SPEECH_LIMIT - 1);
  const boundary = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('；'), cut.lastIndexOf('.'), cut.lastIndexOf(';'));
  return (boundary >= 40 ? cut.slice(0, boundary + 1) : cut) + '…';
}

// Long reports are compressed for the phone; the original always stays available
// in the archive and RPC result. LLM endpoint optional; truncation is the fallback.
export async function compressForSpeech(text, options = {}) {
  const speech = speakable(text);
  if (speech.length <= SPEECH_LIMIT) return { spokenText: speech, compressed: false };
  const endpoint = options.endpoint ?? process.env.PHONE_CHAT_ENDPOINT;
  if (endpoint) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(options.apiKey ?? process.env.PHONE_CHAT_KEY ? { Authorization: `Bearer ${options.apiKey ?? process.env.PHONE_CHAT_KEY}` } : {}) },
        body: JSON.stringify({
          ...(options.model ?? process.env.PHONE_CHAT_MODEL ? { model: options.model ?? process.env.PHONE_CHAT_MODEL } : {}),
          messages: [{ role: 'user', content: `把下面这段话压缩到100字以内，只保留结论和需要对方决策的事，直接输出压缩后的文本，不要任何解释：${speech}` }],
          max_tokens: 200,
        }),
      });
      if (response.ok) {
        const content = (await response.json()).choices?.[0]?.message?.content ?? '';
        const compressed = content.replace(/\s+/g, ' ').trim();
        if (compressed && compressed.length <= SPEECH_LIMIT + 20) {
          return { spokenText: truncateForSpeech(compressed), compressed: true };
        }
      }
    } catch { /* fall through to truncation */ }
    finally { clearTimeout(timer); }
  }
  return { spokenText: truncateForSpeech(speech), compressed: true };
}

export function speechChunks(text, maxChars = MAX_TTS_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('语音分段长度无效');
  const remaining = Array.from(text); const chunks = [];
  const endings = new Set(['。', '！', '？', '!', '?', '；', ';', '\n']);
  while (remaining.length) {
    let cut = Math.min(maxChars, remaining.length);
    if (remaining.length > maxChars) {
      const floor = Math.ceil(maxChars * .55);
      for (let index = cut - 1; index >= floor; index--) {
        if (endings.has(remaining[index])) { cut = index + 1; break; }
      }
    }
    chunks.push(remaining.splice(0, cut).join(''));
  }
  return chunks;
}

async function responseBytes(response, limit = 16 * 1024 * 1024) {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('语音合成响应过大');
    return bytes;
  }
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new Error('语音合成响应过大'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function wavToMuLaw(wav) {
  const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 'mulaw', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = []; let bytes = 0, errors = '';
  ffmpeg.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= MAX_AUDIO_BYTES) chunks.push(chunk); else ffmpeg.kill(); });
  ffmpeg.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-2000); });
  const done = new Promise((resolve, reject) => {
    ffmpeg.once('error', reject);
    ffmpeg.once('close', code => code === 0 ? resolve() : reject(new Error(`电话音频转换失败 (${code}): ${errors}`)));
  });
  const timeout = setTimeout(() => ffmpeg.kill(), 60000);
  ffmpeg.stdin.on('error', () => {}); ffmpeg.stdin.end(wav);
  try { await done; return Buffer.concat(chunks); }
  finally { clearTimeout(timeout); ffmpeg.kill(); }
}

export async function synthesize(text, options = {}) {
  const speech = speakable(text);
  if (!speech) throw new Error('回复没有可朗读的文字');
  // 'http' = any OpenAI-compatible /audio/speech endpoint with a minimal body
  // (self-hosted Kokoro, GLM-TTS, ...); 'openai' adds instructions/speed fields.
  const provider = options.provider ?? process.env.HT802_TTS_PROVIDER ?? (!process.env.OPENAI_API_KEY && (process.env.SPEECH_API_KEY ?? process.env.GLM_API_KEY) ? 'http' : 'openai');
  const apiKey = options.apiKey ?? (provider === 'http' ? process.env.SPEECH_API_KEY ?? process.env.GLM_API_KEY : process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error(provider === 'http' ? '缺少 SPEECH_API_KEY（语音服务的 Bearer key），无法生成电话回复语音' : '缺少 OPENAI_API_KEY，无法生成电话回复语音');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const convert = options.convert ?? wavToMuLaw;
  const endpoint = options.endpoint ?? process.env.HT802_TTS_ENDPOINT ?? (provider === 'http' ? 'https://open.bigmodel.cn/api/paas/v4/audio/speech' : 'https://api.openai.com/v1/audio/speech');
  const model = options.model ?? process.env.HT802_TTS_MODEL ?? process.env.REDLINE_TTS_MODEL ?? (provider === 'http' ? 'kokoro-82M' : 'gpt-4o-mini-tts');
  const voice = options.voice ?? process.env.HT802_TTS_VOICE ?? process.env.REDLINE_TTS_VOICE ?? (provider === 'http' ? 'zf_xiaoxiao' : 'cedar');
  const speed = Number(options.speed ?? process.env.HT802_TTS_SPEED ?? process.env.REDLINE_TTS_SPEED ?? 1.15);
  if (!Number.isFinite(speed) || speed < .25 || speed > 4) throw new Error('HT802_TTS_SPEED 必须在 0.25 到 4 之间');
  const output = []; let used = 0;
  for (const input of speechChunks(speech)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    let response;
    const body = provider === 'http'
      ? { model, voice, input, response_format: 'wav' }
      : { model, voice, input, instructions: options.instructions ?? process.env.HT802_TTS_INSTRUCTIONS ?? process.env.REDLINE_TTS_INSTRUCTIONS ?? TTS_INSTRUCTIONS, response_format: 'wav', speed };
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new Error(error.name === 'AbortError' ? '语音合成请求超时' : `语音合成请求失败：${error.message}`);
    } finally { clearTimeout(timeout); }
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 500);
      throw new Error(`语音合成失败 (${response.status})${detail ? `：${detail}` : ''}`);
    }
    const audio = await convert(await responseBytes(response));
    const separator = output.length ? Buffer.alloc(960, 0xff) : Buffer.alloc(0);
    used += separator.length + audio.length;
    if (used > MAX_AUDIO_BYTES) throw new Error('电话回复超过十分钟音频限制');
    if (separator.length) output.push(separator);
    output.push(audio);
  }
  return Buffer.concat(output);
}
