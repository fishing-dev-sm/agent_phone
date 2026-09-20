import { tone } from './phone-audio.mjs';

export async function beginPhoneListening({ phone, voice, call, log, event = 'followup_listening' }) {
  const ready = await voice.begin(call.id, { beforeListening: async () => {
    if (phone.call !== call) throw new Error('电话已挂断');
    await phone.play(tone(660, .3));
  } });
  if (phone.call !== call) return false;
  if (ready) { log(event); return true; }
  await new Promise(resolve => setTimeout(resolve, 350));
  if (phone.call === call) await phone.play(tone(220, .6)).catch(() => {});
  return false;
}

export function connectPhoneFollowup({ phone, replies, voice, log }) {
  replies.on('played', call => {
    if (!voice.enabled || phone.call !== call) return;
    beginPhoneListening({ phone, voice, call, log }).catch(error => log('voice_failed', { error: error.message }));
  });
  // Replies are outbound SIP calls too: their physical hangup must commit speech.
  phone.on('ended', ({ call, reason }) => {
    voice.end(call.id, reason).catch(error => log('voice_failed', { error: error.message }));
  });
}
