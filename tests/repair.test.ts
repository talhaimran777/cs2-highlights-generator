import { describe, expect, it } from 'vitest';
import { repairDemo } from '../server/demo/repair.ts';

const varint = (n: number) => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const field = (num: number, bytes: number[]) => [num * 8 + 2, ...varint(bytes.length), ...bytes];
const ascii = (s: string) => [...Buffer.from(s, 'latin1')];

/** Little-endian bit writer, the netmessage framing inside demo packets. */
class Bits {
  bits: number[] = [];
  write(v: number, n: number) {
    for (let i = 0; i < n; i++) this.bits.push(Math.floor(v / 2 ** i) & 1);
  }
  bytes(bs: number[]) {
    for (const b of bs) this.write(b, 8);
  }
  toBuffer() {
    const out = Buffer.alloc(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => (out[i >> 3] |= bit << (i & 7)));
    return out;
  }
}

function gameEvent(name: string, value: number[]) {
  return [...field(1, ascii(name)), ...field(3, field(2, value))];
}

/** One packet frame holding: a 3-byte other message, then a game event (207), so the event is not byte-aligned. */
function demoWith(eventMsg: number[]) {
  const bits = new Bits();
  bits.write(4, 6); // msg type 4 (ubitvar, small)
  bits.bytes(varint(3));
  bits.bytes([1, 2, 3]);
  bits.write(15 | 32, 6); // ubitvar 207: low 4 bits 15, then 8 more bits = 12
  bits.write(12, 8);
  bits.bytes(varint(eventMsg.length));
  bits.bytes(eventMsg);
  const packet = field(3, [...bits.toBuffer()]);
  return Buffer.from([
    ...ascii('PBDEMS2\0'), 0, 0, 0, 0, 0, 0, 0, 0,
    ...varint(7), ...varint(100), ...varint(packet.length), ...packet, // DEM_Packet
    0, 0, 0, // DEM_Stop
  ]);
}

/** Reads the val_string back out of the (single) game event. */
function readValue(demo: Buffer): Buffer {
  const sizeStart = 16 + 2; // cmd 7 + tick 100 are one byte each
  const packetLen = demo[sizeStart] & 0x7f ? demo[sizeStart] : 0;
  const packet = demo.subarray(sizeStart + 1, sizeStart + 1 + packetLen);
  const data = packet.subarray(2); // field 3 tag + 1-byte length
  const bit = (i: number) => (data[i >> 3] >> (i & 7)) & 1;
  const byteAt = (bitPos: number) => {
    let v = 0;
    for (let i = 0; i < 8; i++) v |= bit(bitPos + i) << i;
    return v;
  };
  const msgBit = 6 + 8 + 3 * 8 + 6 + 8 + 8; // type, size, 3 bytes, ubitvar 207, size
  const msg = Buffer.from(Array.from({ length: byteAt(msgBit - 8) }, (_, i) => byteAt(msgBit + i * 8)));
  const nameLen = msg[1];
  const keys = msg.subarray(2 + nameLen + 2);
  return keys.subarray(2, 2 + keys[1]);
}

describe('demo repair', () => {
  it('replaces invalid UTF-8 in a game event string, nothing else', () => {
    const broken = [0x40, 0x43, 0x8c, 0xde, 0x3b, 0x04]; // the real one from a FACEIT demo
    const demo = demoWith(gameEvent('player_chat', broken));
    const { buf, repaired } = repairDemo(demo);
    expect(repaired).toBe(1);
    expect(buf.length).toBe(demo.length);
    const value = readValue(buf);
    expect([...value]).toEqual([0x40, 0x43, 0x3f, 0x3f, 0x3b, 0x04]); // "@C??;"
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(value)).not.toThrow();
  });

  it('leaves valid demos untouched', () => {
    const valid = demoWith(gameEvent('player_chat', [...Buffer.from('gg wp ★', 'utf8')]));
    expect(repairDemo(valid)).toEqual({ buf: valid, repaired: 0 });
  });
});
