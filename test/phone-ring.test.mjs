import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneSip } from '../src/phone-sip.mjs';

function response(call, code) {
  return Buffer.from(`SIP/2.0 ${code} Test\r\nCall-ID: ${call.id}\r\nCSeq: 1 INVITE\r\nTo: <sip:redline@192.168.82.100>;tag=ata\r\nContent-Length: 0\r\n\r\n`);
}

test('two-ring cancellation starts at first 180 and repeated responses do not extend it', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const phone = new PhoneSip();
  const packets = [], endings = [];
  phone.send = packet => packets.push(packet);
  phone.on('ended', result => endings.push(result.reason));
  const call = phone.dial({ ringDurationMs: 8200 });
  t.mock.timers.tick(2000);
  phone.receiveSip(response(call, 180), { address: phone.peer, port: phone.peerPort });
  t.mock.timers.tick(6000);
  phone.receiveSip(response(call, 180), { address: phone.peer, port: phone.peerPort });
  t.mock.timers.tick(2199);
  assert.equal(phone.call, call);
  t.mock.timers.tick(1);
  assert.equal(phone.call, null);
  assert.deepEqual(endings, ['confirmation_complete']);
  assert.equal(packets.filter(packet => packet.startsWith('CANCEL ')).length, 1);
});

test('busy response ends confirmation without a later ring timeout', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const phone = new PhoneSip();
  const packets = [], endings = [];
  phone.send = packet => packets.push(packet);
  phone.on('ended', result => endings.push(result.reason));
  const call = phone.dial({ ringDurationMs: 8200 });
  phone.receiveSip(response(call, 486), { address: phone.peer, port: phone.peerPort });
  t.mock.timers.tick(60000);
  assert.deepEqual(endings, ['busy']);
  assert.equal(packets.filter(packet => packet.startsWith('ACK ')).length, 1);
  assert.equal(packets.filter(packet => packet.startsWith('CANCEL ')).length, 0);
});
