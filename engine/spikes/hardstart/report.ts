// Turns a spike report (results/<run>.json) into the markdown tables of RESULTS.md.
// Usage: node engine/spikes/hardstart/report.ts engine/spikes/hardstart/results/hour.json
import { readFileSync } from 'node:fs';
import { MUSIC } from './playlist.ts';

type Result = {
  lane: { name: string; offset: number };
  episode?: { asRunErr: number; asRunWallErr: number; audioErr?: number; corr?: number };
  items: Array<{ id: string; err?: number }>;
  replans: Array<{ onAir: string; err: number; change: string }>;
  commands: Array<{ what: string; ms: number }>;
  timing?: { delayP50Ms: number; delayP99Ms: number; delayMaxMs: number };
  clock: Array<{ wall: number; audioPos: number }>;
  notes: string[];
};

const report = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as {
  run: string;
  results: Result[];
};
const ms = (s: number | undefined) => (s === undefined ? '–' : `${(s * 1000).toFixed(1)}`);

console.log(`### Episode start vs T (${report.run})\n`);
console.log(
  '| lane | offset (s) | audio (ms) | as-run, audio timeline (ms) | as-run, `time()` (ms) | re-plans | frame delay p50 / p99 / max (ms) |',
);
console.log('|---|---|---|---|---|---|---|');
for (const r of report.results) {
  const t = r.timing;
  console.log(
    `| \`${r.lane.name}\` | ${r.lane.offset} | **${ms(r.episode?.audioErr)}** | ${ms(r.episode?.asRunErr)} | ${ms(r.episode?.asRunWallErr)} | ${r.replans.length} | ${t ? `${t.delayP50Ms.toFixed(0)} / ${t.delayP99Ms.toFixed(0)} / ${t.delayMaxMs.toFixed(0)}` : '–'} |`,
  );
}

// Per transition: how much later than planned each song started, relative to the one before.
const lanes = report.results.filter(
  (r) => r.lane.name.startsWith('ontime') || r.lane.name.endsWith('-none'),
);
console.log("\n### Drift per transition (ms, song start vs plan, minus the previous song's)\n");
console.log(
  `| into | from | from format | overlap (s) | from has cue-out | ${lanes.map((l) => `\`${l.lane.name}\``).join(' | ')} |`,
);
console.log(`|---|---|---|---|---|${lanes.map(() => '---').join('|')}|`);
const first = lanes[0];
if (first) {
  for (let i = 1; i < first.items.length; i++) {
    const into = first.items[i]?.id;
    const from = first.items[i - 1]?.id;
    const track = MUSIC.find((m) => m.id === from);
    if (!track || !into) continue;
    const cells = lanes.map((l) => {
      const a = l.items.find((x) => x.id === from)?.err;
      const b = l.items.find((x) => x.id === into)?.err;
      return a === undefined || b === undefined ? '–' : ms(b - a);
    });
    console.log(
      `| ${into} | ${from} | ${track.format} | ${track.cross} | ${track.cueOut === undefined ? 'no' : 'yes'} | ${cells.join(' | ')} |`,
    );
  }
  console.log(
    `| **total at the last song** | | | | | ${lanes.map((l) => `**${ms(l.items.at(-1)?.err)}**`).join(' | ')} |`,
  );
}

console.log('\n### Re-plans\n');
for (const r of report.results.filter((x) => x.replans.length)) {
  for (const p of r.replans) {
    console.log(`- \`${r.lane.name}\` on ${p.onAir}: ${ms(p.err)} ms off → ${p.change}`);
  }
}

const cmds = report.results.flatMap((r) => r.commands);
for (const what of ['push', 'remove', 'skip', 'schedule']) {
  const xs = cmds
    .filter((c) => c.what.startsWith(what))
    .map((c) => c.ms)
    .sort((a, b) => a - b);
  if (xs.length) {
    console.log(
      `\n${what}: n=${xs.length}, median ${xs[Math.floor(xs.length / 2)]} ms, max ${xs.at(-1)} ms`,
    );
  }
}

// Least delayed frame in the first and the last 10 minutes: the clock's real drift, without
// the scheduling jitter of single samples.
console.log('\n### Clock drift (audio timeline vs wall clock)\n');
for (const r of report.results) {
  const pts = r.clock.filter((c) => c.audioPos > 30);
  const a = pts[0];
  const b = pts.at(-1);
  if (!a || !b || b.audioPos - a.audioPos < 600) continue;
  const lo = (from: number, to: number) =>
    Math.min(
      ...pts.filter((c) => c.audioPos >= from && c.audioPos < to).map((c) => c.wall - c.audioPos),
    );
  const drift = lo(b.audioPos - 600, b.audioPos + 1) - lo(a.audioPos, a.audioPos + 600);
  console.log(
    `- \`${r.lane.name}\`: ${ms(drift)} ms over ${(b.audioPos - a.audioPos).toFixed(0)} s`,
  );
}

for (const r of report.results.filter((x) => x.notes.length)) {
  console.log(`\n\`${r.lane.name}\`: ${r.notes.join('; ')}`);
}
