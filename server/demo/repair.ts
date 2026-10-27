import { createRequire } from 'node:module';

const snappy = createRequire(import.meta.url)('snappyjs') as { uncompress(b: Uint8Array): Uint8Array };

const DEM_STOP = 0;
const DEM_PACKET = 7;
const DEM_SIGNON_PACKET = 8;
const DEM_IS_COMPRESSED = 64;
const GAME_EVENT = 207; // GE_Source1LegacyGameEvent
const QUESTION_MARK = 0x3f;

const utf8 = new TextDecoder('utf-8', { fatal: true });

interface Field {
  field: number;
  wireType: number;
  /** for length-delimited fields: value position inside the parsed buffer */
  start: number;
  end: number;
}

function protoFields(b: Uint8Array): Field[] {
  let p = 0;
  const varint = () => {
    let r = 0;
    let shift = 0;
    let x = 0;
    do {
      x = b[p++];
      r += (x & 0x7f) * 2 ** shift;
      shift += 7;
    } while (x & 0x80);
    return r;
  };
  const out: Field[] = [];
  while (p < b.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wireType = key & 7;
    if (wireType === 0) varint();
    else if (wireType === 1) p += 8;
    else if (wireType === 5) p += 4;
    else if (wireType === 2) {
      const len = varint();
      out.push({ field, wireType, start: p, end: p + len });
      p += len;
    } else throw new Error(`unsupported wire type ${wireType}`);
  }
  return out;
}

/** Reads/writes a little-endian bit stream, the netmessage framing inside demo packets. */
class BitStream {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  read(n: number) {
    let r = 0;
    for (let i = 0; i < n; i++, this.pos++) r += ((this.b[this.pos >> 3] >> (this.pos & 7)) & 1) * 2 ** i;
    return r;
  }
  writeByte(bitPos: number, value: number) {
    for (let i = 0; i < 8; i++) {
      const at = bitPos + i;
      if ((value >> i) & 1) this.b[at >> 3] |= 1 << (at & 7);
      else this.b[at >> 3] &= ~(1 << (at & 7));
    }
  }
  ubitvar() {
    const r = this.read(6);
    switch (r & 48) {
      case 16: return (r & 15) | (this.read(4) << 4);
      case 32: return (r & 15) | (this.read(8) << 4);
      case 48: return (r & 15) + this.read(28) * 16;
      default: return r;
    }
  }
  varint() {
    let r = 0;
    let shift = 0;
    let x = 0;
    do {
      x = this.read(8);
      r += (x & 0x7f) * 2 ** shift;
      shift += 7;
    } while (x & 0x80);
    return r;
  }
  get bitsLeft() {
    return this.b.length * 8 - this.pos;
  }
}

/**
 * Replaces every byte of an invalid UTF-8 string value inside game events
 * with '?' (same length, so nothing else in the demo moves). Returns how many
 * strings were repaired; patches `data` in place.
 */
function repairPacketData(data: Uint8Array): number {
  const bits = new BitStream(data);
  let repaired = 0;
  while (bits.bitsLeft > 8) {
    const type = bits.ubitvar();
    const size = bits.varint();
    const msgBit = bits.pos;
    if (size * 8 > bits.bitsLeft) break;
    if (type === GAME_EVENT) {
      const msg = new Uint8Array(size);
      for (let i = 0; i < size; i++) msg[i] = bits.read(8);
      for (const f of protoFields(msg)) {
        // CMsgSource1LegacyGameEvent: field 1 event_name, field 3 keys { field 2 val_string }
        const strings = f.field === 1 ? [f] : f.field === 3 ? protoFields(msg.subarray(f.start, f.end)).filter((k) => k.field === 2).map((k) => ({ ...k, start: f.start + k.start, end: f.start + k.end })) : [];
        for (const s of strings) {
          if (isUtf8(msg.subarray(s.start, s.end))) continue;
          for (let i = s.start; i < s.end; i++) {
            if (msg[i] >= 0x80) bits.writeByte(msgBit + i * 8, QUESTION_MARK);
          }
          repaired++;
        }
      }
    } else {
      bits.pos += size * 8;
    }
  }
  return repaired;
}

function isUtf8(b: Uint8Array) {
  try {
    utf8.decode(b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Some demos contain a game event with a broken string (e.g. a player name cut
 * mid-character), which makes demoparser2 reject the whole file with
 * "MalformedMessage". Returns a copy of the demo with those strings repaired;
 * patched frames are written back uncompressed.
 */
export function repairDemo(buf: Buffer): { buf: Buffer; repaired: number } {
  const chunks: Buffer[] = [buf.subarray(0, 16)];
  let pos = 16;
  let repaired = 0;
  const varint = () => {
    let r = 0;
    let shift = 0;
    let x = 0;
    do {
      x = buf[pos++];
      r += (x & 0x7f) * 2 ** shift;
      shift += 7;
    } while (x & 0x80);
    return r;
  };
  while (pos < buf.length) {
    const frameStart = pos;
    const rawCmd = varint();
    const tick = varint();
    const size = varint();
    const payloadStart = pos;
    pos += size;
    const cmd = rawCmd & ~DEM_IS_COMPRESSED;

    if (cmd === DEM_PACKET || cmd === DEM_SIGNON_PACKET) {
      const compressed = (rawCmd & DEM_IS_COMPRESSED) !== 0;
      const payload = compressed
        ? Buffer.from(snappy.uncompress(buf.subarray(payloadStart, pos)))
        : Buffer.from(buf.subarray(payloadStart, pos));
      const data = protoFields(payload).find((f) => f.field === 3); // CDemoPacket.data
      const fixed = data ? repairPacketData(payload.subarray(data.start, data.end)) : 0;
      if (fixed > 0) {
        repaired += fixed;
        chunks.push(encodeVarint(cmd), encodeVarint(tick), encodeVarint(payload.length), payload);
        continue;
      }
    }
    chunks.push(buf.subarray(frameStart, pos));
    if (cmd === DEM_STOP) break;
  }
  if (pos < buf.length) chunks.push(buf.subarray(pos));
  return { buf: repaired ? Buffer.concat(chunks) : buf, repaired };
}

function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}
