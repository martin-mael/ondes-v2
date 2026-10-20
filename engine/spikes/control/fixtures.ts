// Writes the spike's test audio: plain sine-tone WAV files, so the spike needs no
// binary fixtures in git and no ffmpeg. Usage: node fixtures.ts <dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SAMPLE_RATE = 44100;

/** 16-bit mono PCM WAV. `amplitude` is linear (0.5 = -6 dBFS peak). */
function sineWav(freq: number, seconds: number, amplitude: number): Buffer {
  const samples = Math.round(seconds * SAMPLE_RATE);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return Buffer.concat([wavHeader(data.length), data]);
}

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE((36 + dataBytes) >>> 0, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes >>> 0, 40);
  return h;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? '/media';
  mkdirSync(join(dir, 'safety'), { recursive: true });
  mkdirSync(join(dir, 'empty'), { recursive: true });
  const files: Array<[string, number, number, number]> = [
    // name, Hz, seconds, amplitude
    ['tone-a.wav', 440, 20, 0.5],
    ['tone-b.wav', 550, 14, 0.5],
    ['tone-c.wav', 660, 12, 0.5],
    ['tone-d.wav', 770, 12, 0.5],
    ['tone-e.wav', 880, 10, 0.5],
    ['safety/safety-1.wav', 330, 40, 0.3],
    ['safety/safety-2.wav', 370, 40, 0.3],
    ['emergency.wav', 220, 15, 0.2],
  ];
  for (const [name, freq, seconds, amp] of files) {
    writeFileSync(join(dir, name), sineWav(freq, seconds, amp));
  }
  // 12 s of digital silence, for blank.detect.
  writeFileSync(join(dir, 'silence.wav'), sineWav(0, 12, 0));
  console.log(`fixtures written to ${dir}`);
}
