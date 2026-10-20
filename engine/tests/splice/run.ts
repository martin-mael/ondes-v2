// Splice test: renders islands, plays `A body → island → B body` through the pinned
// Liquidsoap image, records the output and runs the seam detector on it.
//
//   node engine/tests/splice/run.ts [--quick] [--only <substring>] [--keep]
//
// Exits non-zero if a FLAC case (the configuration the engine will use) shows a seam.
// Lossy cases are measured and reported, not enforced. See README.md.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type Audio, decode, mono, writeWav } from './audio.ts';
import { FORMATS, type Format, makeMaterial, playoutCopy, type Signal } from './fixtures.ts';
import {
  cues,
  joins,
  makePlan,
  type Plan,
  reference,
  renderIsland,
  type Splice,
} from './island.ts';
import {
  compareJoins,
  detectClicks,
  detectDropouts,
  type JoinReport,
  joinEvents,
  type SeamEvent,
  trackAlignment,
} from './seam-detector.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

/** How the engine is told to join the tracks. */
export type Mode =
  | 'sequence' // butt splice, no transition operator
  | 'segment' // butt splice, chain merged into one track ahead of the station crossfade
  | 'crossfade-off' // butt splice, station crossfade disabled per track through metadata
  | 'crossfade-micro' // micro-crossfade through stdlib `crossfade` metadata
  | 'cross-micro'; // micro-crossfade through a custom `cross` transition

const MODES: Record<Mode, { splice: Splice; liq: string }> = {
  sequence: { splice: 'butt', liq: 'none' },
  segment: { splice: 'butt', liq: 'segment' },
  'crossfade-off': { splice: 'butt', liq: 'crossfade' },
  'crossfade-micro': { splice: 'micro', liq: 'crossfade' },
  'cross-micro': { splice: 'micro', liq: 'cross' },
};

export type Case = {
  signal: Signal;
  format: Format;
  mode: Mode;
  /** Cue-ins snapped to the playout copy's packet grid (what the renderer must do). */
  snap: boolean;
  /** Island rendered from the FLAC masters instead of the playout copies (lossy only). */
  islandFromMaster?: boolean;
};

const caseName = (c: Case) =>
  `${c.signal}-${c.format}-${c.mode}${c.snap ? '' : '-unsnapped'}${c.islandFromMaster ? '-island-from-master' : ''}`;

function liquidsoapImage(): string {
  if (process.env.LIQUIDSOAP_IMAGE) return process.env.LIQUIDSOAP_IMAGE;
  const compose = readFileSync(join(repo, 'deploy/compose.dev.yml'), 'utf8');
  const m = compose.match(/image:\s*(savonet\/liquidsoap:\S+)/);
  if (!m?.[1])
    throw new Error('no Liquidsoap image in deploy/compose.dev.yml; set LIQUIDSOAP_IMAGE');
  return m[1];
}

/** Track metadata for each mode: the part the feeder (#57) has to reproduce. */
function metadata(mode: Mode, p: Plan, track: 'a' | 'island' | 'b'): Record<string, string> {
  const d = (p.handle / p.sampleRate).toFixed(9);
  const out = track !== 'b';
  const inn = track !== 'a';
  switch (mode) {
    case 'sequence':
    case 'segment':
      return {};
    case 'crossfade-off':
      return {
        ...(out ? { liq_cross_duration: '0.', liq_fade_out: '0.' } : {}),
        ...(inn ? { liq_fade_in: '0.' } : {}),
      };
    case 'crossfade-micro':
      return {
        ...(out ? { liq_cross_duration: d, liq_fade_out: d, liq_fade_out_type: 'lin' } : {}),
        ...(inn ? { liq_fade_in: d, liq_fade_in_type: 'lin' } : {}),
      };
    case 'cross-micro':
      return out ? { liq_cross_duration: d } : {};
  }
}

function annotate(meta: Record<string, string>, path: string): string {
  const pairs = Object.entries(meta).map(([k, v]) => `${k}="${v}"`);
  return pairs.length ? `annotate:${pairs.join(',')}:${path}` : path;
}

function runLiquidsoap(work: string, playlist: string, out: string, liqMode: string): string {
  const image = liquidsoapImage();
  const res = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${work}:/work`,
      '-v',
      `${join(here, 'splice.liq')}:/splice.liq:ro`,
      '-e',
      `SPLICE_PLAYLIST=/work/${relative(work, playlist)}`,
      '-e',
      `SPLICE_OUT=/work/${relative(work, out)}`,
      '-e',
      `SPLICE_MODE=${liqMode}`,
      '-e',
      `SPLICE_LOG_LEVEL=${process.env.SPLICE_LOG_LEVEL ?? '3'}`,
      ...(process.env.SPLICE_DECODER ? ['-e', `SPLICE_DECODER=${process.env.SPLICE_DECODER}`] : []),
      ...(process.env.SPLICE_FRAME ? ['-e', `SPLICE_FRAME=${process.env.SPLICE_FRAME}`] : []),
      image,
      '/splice.liq',
    ],
    { encoding: 'utf8', timeout: 300_000 },
  );
  if (res.status !== 0) {
    const log = `${res.stdout}\n${res.stderr}`
      .split('\n')
      .filter((l) => !/ffmpeg\.filter|\] Using: /.test(l));
    throw new Error(`liquidsoap failed (${res.status}):\n${log.slice(-40).join('\n')}`);
  }
  return res.stdout;
}

export type CaseResult = {
  name: string;
  case: Case;
  plan: Plan;
  pass: boolean;
  enforced: boolean;
  lengthDelta: number;
  joins: JoinReport[];
  events: SeamEvent[];
};

/**
 * The reference is built from the same playout copies the engine decodes, so even lossy
 * cases should match to the 24-bit floor (~-110 dB) when the splice is right.
 */
const MAX_RESIDUAL_DB = -70;

async function runCase(c: Case, work: string, handle: number): Promise<CaseResult> {
  const name = caseName(c);
  const { splice, liq } = MODES[c.mode];
  const plan = makePlan({ handle, splice, grid: c.snap ? FORMATS[c.format].grid : undefined });
  const mat = await makeMaterial(c.signal, join(work, 'material'));
  const copies = {
    a: playoutCopy(mat.masters.a, c.format),
    b: playoutCopy(mat.masters.b, c.format),
  };
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const islandPath = join(dir, 'island.flac');
  const islandSrc = c.islandFromMaster ? mat.masters : { ...copies, vt: mat.masters.vt };
  renderIsland(plan, islandSrc, islandPath);

  const cue = cues(plan, splice);
  const toContainer = (p: string) => `/work/${relative(work, p)}`;
  const lines = [
    annotate(
      {
        liq_cue_in: cue.a.cueIn,
        liq_cue_out: cue.a.cueOut,
        liq_amplify: `${plan.gainA} dB`,
        ...metadata(c.mode, plan, 'a'),
      },
      toContainer(copies.a),
    ),
    annotate(
      { liq_amplify: '0. dB', ...metadata(c.mode, plan, 'island') },
      toContainer(islandPath),
    ),
    annotate(
      { liq_cue_in: cue.b.cueIn, liq_amplify: `${plan.gainB} dB`, ...metadata(c.mode, plan, 'b') },
      toContainer(copies.b),
    ),
  ];
  const playlist = join(dir, 'playlist.m3u');
  writeFileSync(playlist, `${lines.join('\n')}\n`);
  const outPath = join(dir, 'output.wav');
  rmSync(outPath, { force: true });
  const log = runLiquidsoap(work, playlist, outPath, liq);
  writeFileSync(join(dir, 'liquidsoap.log'), log);

  const output = decode(outPath);
  // The reference is built from what the engine decodes: the playout copies.
  const ref: Audio = reference(plan, decode(copies.a), decode(islandPath), decode(copies.b));
  writeWav(join(dir, 'reference.wav'), ref);
  const y = mono(output);
  const r = mono(ref);

  const events: SeamEvent[] = [];
  const lossless = c.format === 'flac';
  if (c.signal === 'tone') {
    events.push(...detectClicks(y, plan.sampleRate), ...detectDropouts(y));
  } else {
    events.push(...trackAlignment(y, r).events, ...detectDropouts(y));
  }
  // On a steady tone the lag is only defined modulo a period: search less than half of one.
  const reports = compareJoins(
    y,
    r,
    joins(plan, splice),
    c.signal === 'tone' ? { maxLag: 32 } : {},
  );
  events.push(...joinEvents(reports, MAX_RESIDUAL_DB));
  if (y.length !== r.length) {
    events.push({
      kind: y.length > r.length ? 'gap' : 'overlap',
      offset: Math.min(y.length, r.length),
      samples: Math.abs(y.length - r.length),
      detail: `output is ${y.length - r.length} samples longer than the reference`,
    });
  }
  return {
    name,
    case: c,
    plan,
    pass: events.length === 0,
    // FLAC is what the engine will play: snapped cases must be clean, and unsnapped ones
    // must show the seek error (it proves the detector sees a real engine seam).
    enforced: lossless,
    lengthDelta: y.length - r.length,
    joins: reports,
    events,
  };
}

export function matrix(quick: boolean): Case[] {
  const signals: Signal[] = quick ? ['tone', 'noise'] : ['tone', 'noise', 'music'];
  const formats = (quick ? ['flac'] : Object.keys(FORMATS)) as Format[];
  const modes = Object.keys(MODES) as Mode[];
  const cases: Case[] = [];
  for (const signal of signals) {
    for (const format of formats) {
      for (const mode of modes) cases.push({ signal, format, mode, snap: true });
      if (format !== 'flac') {
        cases.push({ signal, format, mode: 'segment', snap: true, islandFromMaster: true });
      }
    }
  }
  // Without snapping, every format is expected to show the seek error.
  for (const format of formats) {
    cases.push({ signal: 'noise', format, mode: 'sequence', snap: false });
    cases.push({ signal: 'noise', format, mode: 'cross-micro', snap: false });
  }
  return cases;
}

/**
 * Enforced on FLAC: snapped butt splices without `cross` are clean; everything else is a
 * known Liquidsoap 2.4 limitation and must keep showing a seam. If one of those turns
 * clean after an upgrade, the run fails so the rules in README.md get revisited.
 */
const expectClean = (c: Case) => c.snap && (c.mode === 'sequence' || c.mode === 'segment');

function fmtJoin(j: JoinReport): string {
  return `${j.label}: lag ${j.lagBefore}→${j.lagAfter} (shift ${j.shift}), residual ${j.residualDb.toFixed(1)} dB / floor ${j.baselineDb.toFixed(1)} dB`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      quick: { type: 'boolean', default: false },
      only: { type: 'string' },
      work: { type: 'string', default: join(here, '.work') },
    },
  });
  const work = resolve(values.work);
  mkdirSync(work, { recursive: true });
  const handle = Number(process.env.SPLICE_HANDLE ?? 441);
  const cases = matrix(values.quick).filter(
    (c) => !values.only || caseName(c).includes(values.only),
  );
  const results: CaseResult[] = [];
  for (const c of cases) {
    const res = await runCase(c, work, handle);
    results.push(res);
    const asExpected = res.pass === expectClean(c);
    const tag = res.pass ? 'ok  ' : asExpected ? 'seam' : res.enforced ? 'FAIL' : 'seam';
    console.log(
      `${tag} ${res.name}  (length ${res.lengthDelta >= 0 ? '+' : ''}${res.lengthDelta})`,
    );
    for (const j of res.joins) console.log(`       ${fmtJoin(j)}`);
    for (const e of res.events.slice(0, 6))
      console.log(`       ! ${e.kind} @${e.offset}: ${e.detail}`);
    if (res.events.length > 6) console.log(`       ! … ${res.events.length - 6} more`);
  }
  writeFileSync(join(work, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.enforced && r.pass !== expectClean(r.case));
  console.log(
    `\n${results.length} cases, ${results.filter((r) => r.pass).length} clean, ${failed.length} unexpected FLAC results. Details: ${relative(process.cwd(), join(work, 'results.json'))}`,
  );
  for (const f of failed) {
    console.log(
      f.pass
        ? `  ${f.name}: clean although expected to show a seam; Liquidsoap changed, revisit README.md`
        : `  ${f.name}: seam on FLAC`,
    );
  }
  if (failed.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
