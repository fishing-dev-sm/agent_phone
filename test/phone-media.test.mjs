import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMuLaw, encodeMuLaw, makeRtp, parseRtp, muLawToPcm24k, speakable, speechChunks, synthesize } from '../src/phone-audio.mjs';
import { parseSip, mediaAddress } from '../src/phone-sip.mjs';

test('G.711 known vectors and telephone signal round-trip', () => {
  assert.equal(decodeMuLaw(255), 0);
  assert.equal(decodeMuLaw(0), -32124);
  assert.equal(decodeMuLaw(128), 32124);
  assert.equal(encodeMuLaw(0), 255);
  for (const sample of [-30000, -10000, -1000, 1000, 10000, 30000]) {
    assert.ok(Math.abs(decodeMuLaw(encodeMuLaw(sample)) - sample) < Math.abs(sample) * .04 + 10);
  }
  const pcm = muLawToPcm24k(Buffer.alloc(160, 255));
  assert.equal(pcm.length, 960);
  assert.ok(pcm.every(value => value === 0));
});

test('RTP parser validates framing, extensions, and padding', () => {
  const packet = makeRtp(Buffer.from([1, 2, 3]), 65536, 160, 123);
  assert.equal(parseRtp(packet).sequence, 0);
  assert.deepEqual(parseRtp(packet).payload, Buffer.from([1, 2, 3]));
  assert.equal(parseRtp(Buffer.alloc(8)), null);
  const invalid = Buffer.from(packet); invalid[0] |= 16;
  assert.equal(parseRtp(invalid), null);
  const padded = Buffer.concat([packet, Buffer.from([0, 2])]); padded[0] |= 32;
  assert.deepEqual(parseRtp(padded).payload, Buffer.from([1, 2, 3]));
});

test('SIP parsing retains duplicate Via headers; SDP stays on the configured peer', () => {
  const packet = Buffer.from('INVITE sip:redline@192.168.82.1 SIP/2.0\r\nVia: one\r\nVia: two\r\nCall-ID: 123\r\nCSeq: 1 INVITE\r\n\r\n');
  assert.deepEqual(parseSip(packet).headers.via, ['one', 'two']);
  assert.equal(parseSip(Buffer.from('garbage')), null);
  const sdp = 'v=0\r\nc=IN IP4 192.168.82.100\r\nm=audio 5004 RTP/AVP 0 101\r\n';
  assert.deepEqual(mediaAddress(sdp, '192.168.82.100'), { address: '192.168.82.100', port: 5004 });
  assert.equal(mediaAddress(sdp, '192.168.82.101'), null);
  assert.equal(mediaAddress(sdp.replace('0 101', '8 101'), '192.168.82.100'), null);
});

test('spoken reply excludes raw code and link destinations', () => {
  assert.equal(speakable('**完成**：见[结果](https://example.com)。'), '完成：见结果。');
  assert.ok(!speakable('```sh\nrm example\n```').includes('rm example'));
});

test('long speech is split at sentence boundaries without losing text', () => {
  const speech = '甲'.repeat(6) + '。' + '乙'.repeat(8) + '。';
  const chunks = speechChunks(speech, 10);
  assert.deepEqual(chunks, ['甲甲甲甲甲甲。', '乙乙乙乙乙乙乙乙。']);
  assert.equal(chunks.join(''), speech);
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 10));
});

test('OpenAI speech uses the selected official voice and joins telephone audio', async () => {
  const requests = []; let converted = 0;
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(Buffer.from(`wav-${requests.length}`), { status: 200 });
  };
  const audio = await synthesize('甲'.repeat(1001), {
    apiKey: 'test-key', fetchImpl,
    convert: async wav => { converted++; assert.match(wav.toString(), /^wav-/); return Buffer.from([converted]); }
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(requests[0].body.model, 'gpt-4o-mini-tts');
  assert.equal(requests[0].body.voice, 'cedar');
  assert.equal(requests[0].body.speed, 1.15);
  assert.match(requests[0].body.instructions, /机关干部向上级汇报工作/);
  assert.equal(requests.map(request => request.body.input).join(''), '甲'.repeat(1001));
  assert.equal(audio.length, 962);
  assert.equal(audio[0], 1);
  assert.ok(audio.subarray(1, 961).every(byte => byte === 0xff));
  assert.equal(audio[961], 2);
});

test('OpenAI speech errors are surfaced without local voice fallback', async () => {
  await assert.rejects(
    synthesize('测试', { apiKey: 'test-key', fetchImpl: async () => new Response('{"error":"quota"}', { status: 429 }) }),
    /语音合成失败 \(429\).*quota/
  );
});
