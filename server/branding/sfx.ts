import { writeFileSync } from 'node:fs';

/**
 * Sound effects for the intro and outro, synthesized so nothing has to be
 * licensed or downloaded. Each effect adds itself into a mono mix at a time.
 */
export class Mix {
  readonly data: Float32Array;
  constructor(
    readonly sampleRate: number,
    seconds: number,
  ) {
    this.data = new Float32Array(Math.ceil(seconds * sampleRate));
  }

  private add(at: number, len: number, fn: (t: number, i: number) => number) {
    const start = Math.round(at * this.sampleRate);
    const n = Math.min(Math.round(len * this.sampleRate), this.data.length - start);
    for (let i = 0; i < n; i++) this.data[start + i] += fn(i / this.sampleRate, i);
  }

  /** Filtered noise sweeping up then down: things flying past. */
  whoosh(at: number, len = 0.45, gain = 0.5, from = 300, to = 3500) {
    let low = 0;
    let band = 0;
    this.add(at, len, (t) => {
      const x = t / len;
      const f = from + (to - from) * Math.sin(Math.PI * Math.min(1, x * 1.1));
      // state-variable band-pass, swept
      const k = 2 * Math.sin((Math.PI * f) / this.sampleRate);
      const high = noise() - low - 0.6 * band;
      band += k * high;
      low += k * band;
      return band * gain * envelope(x, 0.55);
    });
  }

  /** Noise rising in pitch and level into the hit. */
  riser(at: number, len = 0.6, gain = 0.25) {
    let low = 0;
    this.add(at, len, (t) => {
      const x = t / len;
      const k = 0.02 + 0.5 * x * x;
      low += k * (noise() - low);
      return low * gain * x * x;
    });
  }

  /** Cinematic hit: falling sub tone, a thump and a noise crack. */
  impact(at: number, gain = 0.9) {
    let phase = 0;
    this.add(at, 1.6, (t) => {
      const f = 38 + 110 * Math.exp(-t * 14);
      phase += (2 * Math.PI * f) / this.sampleRate;
      const sub = Math.sin(phase) * Math.exp(-t * 2.6);
      const crack = noise() * Math.exp(-t * 28) * 0.6;
      return (sub + crack) * gain;
    });
    this.whoosh(at, 0.9, 0.25, 2000, 200); // the tail
  }

  /** Bubble pop: a quick downward blip. */
  pop(at: number, gain = 0.5) {
    let phase = 0;
    this.add(at, 0.14, (t) => {
      const f = 900 * Math.exp(-t * 22) + 180;
      phase += (2 * Math.PI * f) / this.sampleRate;
      return Math.sin(phase) * Math.exp(-t * 30) * gain;
    });
  }

  /** Mouse click: two tiny ticks. */
  click(at: number, gain = 0.6) {
    for (const [dt, g] of [[0, 1], [0.045, 0.6]] as const) {
      this.add(at + dt, 0.02, (t) => (noise() * 0.5 + Math.sin(2 * Math.PI * 3200 * t)) * Math.exp(-t * 400) * gain * g);
    }
  }

  /** Notification bell. */
  ding(at: number, gain = 0.35) {
    const partials: [number, number, number][] = [[1318.5, 1, 3], [2637, 0.5, 5], [3955, 0.25, 8], [5274, 0.12, 12]];
    this.add(at, 1.6, (t) => partials.reduce((s, [f, a, d]) => s + Math.sin(2 * Math.PI * f * t) * a * Math.exp(-t * d), 0) * gain * Math.min(1, t * 400));
  }

  /** Soft sparkle: a few quick high blips. */
  sparkle(at: number, gain = 0.12) {
    [0, 0.06, 0.11, 0.17].forEach((dt, i) => {
      const f = 2400 + i * 520;
      this.add(at + dt, 0.25, (t) => Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 18) * gain);
    });
  }

  /** 16-bit WAV with the mix soft-limited and copied to every channel. */
  writeWav(path: string, channels: number) {
    const n = this.data.length;
    const buf = Buffer.alloc(44 + n * channels * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n * channels * 2, 4);
    buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(this.sampleRate, 24);
    buf.writeUInt32LE(this.sampleRate * channels * 2, 28);
    buf.writeUInt16LE(channels * 2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(n * channels * 2, 40);
    for (let i = 0; i < n; i++) {
      const v = Math.round(Math.tanh(this.data[i] * 1.2) * 0.85 * 32767);
      for (let c = 0; c < channels; c++) buf.writeInt16LE(v, 44 + (i * channels + c) * 2);
    }
    writeFileSync(path, buf);
  }
}

const noise = () => Math.random() * 2 - 1;

/** 0 -> 1 -> 0 with the peak at `peak` (0..1). */
const envelope = (x: number, peak: number) => (x < peak ? (x / peak) ** 2 : ((1 - x) / (1 - peak)) ** 1.5);
