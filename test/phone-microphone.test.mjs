import test from 'node:test';
import assert from 'node:assert/strict';
import { microphonePcm } from '../src/phone-microphone.mjs';
import { encodeMuLaw, decodeMuLaw } from '../src/phone-audio.mjs';

test('20ms telephone silence becomes 20ms of 48kHz stereo PCM silence', () => {
  const pcm = microphonePcm(Buffer.alloc(160, 0xff));
  assert.equal(pcm.length, 48000 * 2 * 2 * .02);
  assert.ok(pcm.every(value => value === 0));
});
test('telephone waveform preserves duration, channel equality and original sample values', () => {
  const ulaw = Buffer.from(Array.from({ length: 160 }, (_, i) => encodeMuLaw(3000 * Math.sin(i * Math.PI / 4))));
  const pcm = microphonePcm(ulaw);
  for (let i = 0; i < pcm.length; i += 4) assert.equal(pcm.readInt16LE(i), pcm.readInt16LE(i + 2));
  for (let i = 0; i < ulaw.length; i++) assert.equal(pcm.readInt16LE(i * 24), decodeMuLaw(ulaw[i]));
});
