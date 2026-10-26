#!/usr/bin/env node
// Offline only: no browser, network, process launch, or changes to runtime flags.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMITS = { fileBytes: 16 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, lineBytes: 1024 * 1024,
  events: 20000, linksPerHitch: 32, candidatesPerHitch: 4096 };
const finite = (n, name, min = 0) => {
  if (!Number.isFinite(n) || n < min) throw Error(`Invalid ${name}`);
  return n;
};
const isoTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const values = (text, keys) => Object.fromEntries(keys.flatMap(key => {
  const m = text.match(new RegExp(`\\b${key}=([0-9]+(?:\\.[0-9]+)?)`));
  return m ? [[key, Number(m[1])]] : [];
}));

function diagnostic(text) {
  let m;
  if ((m = text.match(/frametime:\s*n=(\d+)\s+max=([\d.]+)ms\s+hitches=(\d+)/)))
    return { kind: 'frame-window', metrics: { frames: +m[1], maxWorkMs: +m[2], hitchesOver50ms: +m[3], screen: text.match(/screen=(\S+)/)?.[1] ?? null } };
  if ((m = text.match(/GC\((\d+)\).*?Pause\s+(.+?)\s+(\d+)M->(\d+)M\((\d+)M\)\s+([\d.]+)ms/)))
    return { kind: 'gc-pause', spanMs: +m[6], metrics: { id: +m[1], pause: m[2], beforeMiB: +m[3], afterMiB: +m[4], capacityMiB: +m[5], pauseMs: +m[6] } };
  if ((m = text.match(/\[zwc\] compile time ([\d.]+) ms \(install ([\d.]+)\) in the last ([\d.]+) s: (\d+) compiles, (\d+) units \((\d+) bodies\), slowest ([\d.]+) ms/)))
    return { kind: 'jit-window', spanMs: +m[3] * 1000, metrics: { compileMs: +m[1], installSubsetMs: +m[2], reportedSeconds: +m[3], compiles: +m[4], units: +m[5], bodies: +m[6], slowestMs: +m[7], thread: text.match(/\| thread (.+)$/)?.[1] ?? null } };
  if ((m = text.match(/\[zwc\] slow install ([\d.]+) ms/)))
    return { kind: 'jit-install', spanMs: +m[1], metrics: { installMs: +m[1] } };
  if ((m = text.match(/\[frame-split\] batches=(\d+) java=([\d.]+)ms .*?gpuWorker=([\d.]+)ms .*?calls=(\d+)/)))
    return { kind: 'gpu-worker-window', spanMs: +m[2] + +m[3], metrics: { batches: +m[1], betweenBatchMs: +m[2], workerCallMs: +m[3], calls: +m[4], includesPacingAndWait: true, deviceGpuTime: false } };
  if (text.includes('framesplit:'))
    return { kind: 'client-phase-window', spanMs: 1000, metrics: values(text, ['frames', 'tickFrames', 'ticks', 'tick', 'level', 'entities', 'animate', 'particles', 'textures', 'rendererTick', 'render']) };
  if (text.includes('entitytick:'))
    return { kind: 'entity-window', spanMs: 1000, metrics: values(text, ['commonTick', 'tick', 'entities']) };
  if (/chunkpipe:|flow:/.test(text))
    return { kind: 'worldgen-observation', metrics: values(text, ['tick', 'loadedChunks', 'pendingTasks', 'readyChunks', 'tracked', 'trackedReady', 'genTasks', 'queued', 'completed', 'failed']) };
  if (/terrain:/.test(text))
    return { kind: 'scene-observation', metrics: values(text, ['clientChunks', 'visible', 'visRenderable', 'entities', 'mspt']) };
  if ((m = text.match(/world-state:level=(\S+) player=(\S+)/)))
    return { kind: 'world-observation', metrics: { level: m[1], player: m[2] } };
  return null;
}

function validateAnchors(anchors) {
  if (!Array.isArray(anchors)) throw Error('anchors must be an array');
  const map = new Map();
  for (const a of anchors) {
    if (!a || typeof a.clock !== 'string' || a.clock === 'utc' || a.to !== 'utc' || typeof a.evidence !== 'string' || !a.evidence.trim() || a.evidence.length > 500 || map.has(a.clock)) throw Error('Each unique clock anchor needs to=utc and explicit evidence');
    finite(a.offsetMs, 'anchor offset', -Number.MAX_VALUE);
    finite(a.uncertaintyMs, 'anchor uncertainty');
    if (a.uncertaintyMs > 60000) throw Error('Anchor uncertainty exceeds 60 seconds; cannot correlate usefully');
    map.set(a.clock, a);
  }
  return map;
}

/** Parse saved logs/snapshots without inventing an origin for JVM uptime. */
export function normalizeStutterInputs(inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length > 16) throw Error('Use at most16 input files');
  const frameWindowMs = finite(options.frameWindowMs ?? 1000, 'frameWindowMs', 1);
  const anchors = validateAnchors(options.anchors ?? []), events = [], seen = new Map(), coverage = [], provenance = [];
  let duplicates = 0, ignoredLines = 0, unplacedOccurrences = 0;
  const unplaced = new Map();
  const add = (text, row, input, line, basis = 'receipt') => {
    if (typeof text !== 'string') return;
    const parsed = diagnostic(text);
    if (!parsed) return;
    let endMs = isoTime(row.utc), clock = endMs === null ? null : 'utc';
    let timeBasis = basis, uncertaintyMs = 0;
    // A GC native wall-clock decorator beats receipt time; uptime beats a
    // delayed collector observation. observedUTC is never an origin anchor.
    const nativeUTC = text.match(/\[(\d{4}-\d\d-\d\dT[^\]]+)\]/)?.[1];
    const uptime = text.match(/\[([\d.]+)s\]/);
    if (parsed.kind === 'gc-pause' && isoTime(nativeUTC) !== null) {
      endMs = isoTime(nativeUTC); clock = 'utc'; timeBasis = 'native-log-completion';
    } else if (parsed.kind === 'gc-pause' && uptime) {
      endMs = +uptime[1] * 1000; clock = `jvm-uptime:${input.label}`; timeBasis = 'native-log-completion';
    } else if (endMs === null && Number.isFinite(row.timeMs) && typeof row.clock === 'string') {
      endMs = row.timeMs; clock = row.clock; timeBasis = 'explicit-clock';
    } else if (endMs === null) {
      const relative = text.match(/^\[([\d.]+)\]\s/);
      if (relative) { endMs = +relative[1] * 1000; clock = `log-relative:${input.label}`; timeBasis = 'receipt-relative'; }
    }
    if (endMs === null || !Number.isFinite(endMs)) {
      unplacedOccurrences++;
      const key = input.label + '\0' + parsed.kind + '\0' + text;
      if (!unplaced.has(key)) {
        if (events.length + unplaced.size >= LIMITS.events) throw Error(`More than ${LIMITS.events} unique events; narrow the capture`);
        unplaced.set(key, { kind: parsed.kind, label: input.label, text: text.slice(0, 2048), metrics: parsed.metrics,
          reason: row.observedUTC ? 'Only delayed observation time exists; event time is unknown' : 'No event timestamp or explicit clock', observedUTC: row.observedUTC ?? null });
      }
      return;
    }
    let spanMs = parsed.spanMs ?? 0;
    const semantics = [];
    if (parsed.kind === 'frame-window') {
      // Reports occur after >=1s, on a frame boundary. This is a triage
      // lookback, not an upper bound: pacing oversleep/receipt delay is unknown.
      spanMs = frameWindowMs + parsed.metrics.maxWorkMs;
      semantics.push('heuristic report lookback, not a measured duration or an individually timed frame');
    }
    if (timeBasis.startsWith('receipt')) semantics.push('receipt latency is not measured');
    if (parsed.kind === 'jit-window') semantics.push('install is a subset of compileMs; window aggregate is not a single compile');
    if (parsed.kind === 'gpu-worker-window') semantics.push('between-batch time includes pacing/wait; workerCallMs is not device GPU time');
    finite(spanMs, 'event span');
    if (spanMs > 600000) throw Error('Diagnostic span exceeds 10 minutes');
    const origin = { clock, endMs };
    const anchor = anchors.get(clock);
    if (anchor) { endMs += anchor.offsetMs; clock = 'utc'; uncertaintyMs = anchor.uncertaintyMs; semantics.push('explicit uncertain clock mapping'); }
    const key = `${input.label}\0${clock}\0${endMs}\0${text}`;
    if (seen.has(key)) { duplicates++; return; }
    if (events.length + unplaced.size >= LIMITS.events) throw Error(`More than ${LIMITS.events} unique events; narrow the capture`);
    const event = { id: events.length + 1, label: input.label, kind: parsed.kind, clock, startMs: endMs - spanMs, endMs, spanMs,
      timeBasis, uncertaintyMs, origin, metrics: parsed.metrics, semantics, text: text.slice(0, 2048), input: input.name, line };
    if (isoTime(row.observedUTC) !== null) event.observedUTC = row.observedUTC;
    events.push(event); seen.set(key, event.id);
  };
  let totalBytes = 0;
  for (const input of inputs) {
    if (!input || !/^[\w-]{1,64}$/.test(input.label) || typeof input.text !== 'string') throw Error('Input requires bounded label and text');
    const bytes = Buffer.byteLength(input.text); totalBytes += bytes;
    if (bytes > LIMITS.fileBytes || totalBytes > LIMITS.totalBytes) throw Error('Input byte limit exceeded (16 MiB/file,32 MiB total)');
    provenance.push({ label: input.label, name: input.name ?? input.label, bytes, sha256: createHash('sha256').update(input.text).digest('hex') });
    const times = [], lines = input.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]; if (!line.trim()) continue;
      if (Buffer.byteLength(line) > LIMITS.lineBytes) throw Error('Input line exceeds 1 MiB');
      if (!line.trimStart().startsWith('{')) { add(line, {}, input, i + 1); continue; }
      let row;
      try { row = JSON.parse(line); } catch { throw Error(`Invalid JSON at ${input.name ?? input.label}:${i + 1}`); }
      if (!row || typeof row !== 'object' || Array.isArray(row)) { ignoredLines++; continue; }
      if (Array.isArray(row.timing)) {
        const t = isoTime(row.utc); if (t !== null) times.push(t);
        for (const event of row.timing) if (event && typeof event === 'object') add(event.text, event, input, i + 1);
        for (const field of ['terrain', 'world', 'flow']) add(row[field], { utc: row.utc }, input, i + 1, 'observation');
        // frameTime is only the last stale display row, never another event.
        if (!row.timing.length && row.frameTime) add(row.frameTime, { observedUTC: row.utc }, input, i + 1);
      } else if (typeof row.text === 'string' || typeof row.line === 'string') add(row.text ?? row.line, row, input, i + 1);
      else if (row.frameTime) add(row.frameTime, { observedUTC: row.utc }, input, i + 1);
      else ignoredLines++;
    }
    times.sort((a, b) => a - b);
    if (times.length) coverage.push({ label: input.label, input: input.name, samples: times.length, firstUTC: new Date(times[0]).toISOString(), lastUTC: new Date(times.at(-1)).toISOString(),
      maxSnapshotGapMs: times.reduce((max, t, i) => i ? Math.max(max, t - times[i - 1]) : max, 0), sampleTimes: times });
  }
  events.sort((a, b) => a.clock.localeCompare(b.clock) || a.endMs - b.endMs || a.id - b.id);
  return { events, unplaced: [...unplaced.values()], coverage, provenance, duplicates, ignoredLines, unplacedOccurrences, anchors: [...anchors.values()] };
}

const lowerBound = (rows, t) => {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].endMs < t) lo = mid + 1; else hi = mid; }
  return lo;
};
const quantile = (rows, q) => rows.length ? rows[Math.floor((rows.length - 1) * q)] : null;

/** Same-clock report proximity only, never attribution or proof of cause. */
export function correlateStutter(normalized, options = {}) {
  const thresholdMs = finite(options.thresholdMs ?? 100, 'thresholdMs', 1), proximityMs = finite(options.proximityMs ?? 100, 'proximityMs');
  const fromMs = options.fromUTC ? isoTime(options.fromUTC) : null, toMs = options.toUTC ? isoTime(options.toUTC) : null;
  if ((options.fromUTC && fromMs === null) || (options.toUTC && toMs === null) || (fromMs !== null && toMs !== null && fromMs > toMs)) throw Error('Invalid UTC phase bounds');
  const boundedPhase = fromMs !== null || toMs !== null;
  const unmappedEvents = boundedPhase ? normalized.events.filter(e => e.clock !== 'utc') : [];
  const selected = normalized.events.filter(e => e.clock !== 'utc' ? !boundedPhase : (fromMs === null || e.endMs >= fromMs) && (toMs === null || e.endMs <= toMs));
  const selectedIds = new Set(selected.map(e => e.id));
  const frames = selected.filter(e => e.kind === 'frame-window'), evidence = new Map(), scene = new Map();
  const domain = e => e.label + '/' + e.clock;
  for (const e of normalized.events) {
    const map = /^(scene|world)-observation$/.test(e.kind) ? scene : evidence;
    if (e.kind === 'frame-window') continue;
    if (map === evidence && !selectedIds.has(e.id)) continue;
    const key = domain(e);
    if (!map.has(key)) map.set(key, []); map.get(key).push(e);
  }
  const counts = {};
  for (const e of selected) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const spans = new Map([...evidence.entries()].map(([clock, rows]) => [clock, rows.reduce((n, e) => Math.max(n, e.spanMs + e.uncertaintyMs), 0)]));
  const hitches = [];
  for (const frame of frames.filter(e => e.metrics.maxWorkMs >= thresholdMs)) {
    const key = domain(frame), rows = evidence.get(key) ?? [], scenes = scene.get(key) ?? [];
    const maxSpan = spans.get(key) ?? 0;
    const links = []; let scanned = 0, truncated = false;
    for (let i = lowerBound(rows, frame.startMs - maxSpan - proximityMs - frame.uncertaintyMs); i < rows.length; i++) {
      const e = rows[i];
      if (e.endMs > frame.endMs + proximityMs + frame.uncertaintyMs + maxSpan) break;
      if (++scanned > LIMITS.candidatesPerHitch) { truncated = true; break; }
      const slack = proximityMs + frame.uncertaintyMs + e.uncertaintyMs;
      if (e.startMs - slack > frame.endMs || e.endMs + slack < frame.startMs) continue;
      if (links.length === LIMITS.linksPerHitch) { truncated = true; break; }
      links.push({ id: e.id, kind: e.kind, endDeltaMs: e.endMs - frame.endMs,
        relation: e.timeBasis.startsWith('receipt') || frame.timeBasis.startsWith('receipt') ? 'receipt-report-proximity' : 'possible-window-overlap',
        uncertaintyMs: frame.uncertaintyMs + e.uncertaintyMs, metrics: e.metrics });
    }
    const context = {};
    for (let i = lowerBound(scenes, frame.endMs + 0.001) - 1; i >= 0; i--) {
      const e = scenes[i], ageMs = frame.endMs - e.endMs;
      if (ageMs > 15000) break;
      if (!context[e.kind]) context[e.kind] = { id: e.id, ageMs, metrics: e.metrics, basis: 'sampled observation, not exact per-frame geometry' };
      if (context['scene-observation'] && context['world-observation']) break;
    }
    hitches.push({ frameId: frame.id, label: frame.label, clock: frame.clock, startMs: frame.startMs, endMs: frame.endMs, metrics: frame.metrics, context, links, truncated });
  }
  const maxima = frames.map(e => e.metrics.maxWorkMs).sort((a, b) => a - b);
  const frameClocks = [...new Set(frames.map(domain))];
  const sameClockEvidence = Object.fromEntries(frameClocks.map(key => [key, Object.fromEntries(
    ['gc-pause', 'jit-window', 'gpu-worker-window', 'worldgen-observation'].map(kind => [kind, selected.filter(e => domain(e) === key && e.kind === kind).length]))]));
  const coverageWarnings = frameClocks.flatMap(key => Object.entries(sameClockEvidence[key])
    .filter(([, count]) => count === 0).map(([kind]) => `No timestamped ${kind} in frame domain ${key}; cannot exclude that activity`));
  const coverage = normalized.coverage.map(c => {
    const { sampleTimes, ...wholeInput } = c;
    const times = sampleTimes.filter(t => (fromMs === null || t >= fromMs) && (toMs === null || t <= toMs));
    return { ...wholeInput, phaseSamples: times.length, phaseFirstUTC: times.length ? new Date(times[0]).toISOString() : null,
      phaseLastUTC: times.length ? new Date(times.at(-1)).toISOString() : null,
      phaseMaxSnapshotGapMs: times.reduce((max, t, i) => i ? Math.max(max, t - times[i - 1]) : max, 0) };
  });
  for (const c of coverage) if (c.phaseMaxSnapshotGapMs > 15000) coverageWarnings.push(`Geometry snapshots for ${c.label} have a ${c.phaseMaxSnapshotGapMs} ms phase gap; context is omitted when older than15seconds`);
  return { schema: 'mcweb-stutter-timeline-v1', limits: LIMITS, options: { thresholdMs, proximityMs, fromUTC: options.fromUTC ?? null, toUTC: options.toUTC ?? null },
    summary: { eventCounts: counts, frameReportWindows: frames.length, reportedFramesInHitchWindows: frames.reduce((n, e) => n + e.metrics.frames, 0),
      reportedHitchesOver50ms: frames.reduce((n, e) => n + e.metrics.hitchesOver50ms, 0), selectedHitchWindows: hitches.length,
      windowMaxWorkMs: { median: quantile(maxima, 0.5), p95OfWindowMaxima: quantile(maxima, 0.95), worst: maxima.at(-1) ?? null },
      clocks: [...new Set(normalized.events.map(e => e.clock))], unplacedDistinct: normalized.unplaced.length, unplacedOccurrences: normalized.unplacedOccurrences,
      duplicatesRemoved: normalized.duplicates, truncatedHitchLinks: hitches.filter(h => h.truncated).length, sameClockEvidence,
      unmappedEventsExcludedFromUTCPhase: unmappedEvents.length },
    limitations: ['Correlation is report proximity, not a cause, CPU sample or individual-frame attribution.',
      'Frame reports cover only windows containing >50ms work; window maxima are not frame p95 or all-frame FPS.',
      'Frame lookback is heuristic; pacing oversleep or queue delay may exceed it, so missing links cannot exclude a pause.',
      'Receipt/observation timestamps have unknown queue delay. UTC clock jumps and device clock synchronization are not validated.',
      'Unmapped JVM/relative clocks stay separate; delayed observedUTC is never used as their origin.',
      'Client phases are nested per-tick/per-frame aggregates; GPU-worker gaps include pacing/waits, not Java CPU or device GPU time.',
      'Missing timestamps/events and bounded/truncated links mean absence of a link is not absence of activity.'],
    provenance: normalized.provenance, anchors: normalized.anchors, coverage, coverageWarnings, hitches,
    events: selected, unmappedEvents, unplaced: normalized.unplaced };
}

export async function stutterTimelineMain(argv) {
  const specs = [], options = {}; let out, anchorsFile;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[++i];
    if (!value) throw Error(`Missing value for ${flag}`);
    if (flag === '--input') { const at = value.indexOf('='); if (at < 1) throw Error('--input requires label=file'); specs.push({ label: value.slice(0, at), path: value.slice(at + 1) }); }
    else if (flag === '--out') out = value;
    else if (flag === '--anchors') anchorsFile = value;
    else if (flag === '--from') options.fromUTC = value;
    else if (flag === '--to') options.toUTC = value;
    else if (flag === '--threshold-ms') options.thresholdMs = Number(value);
    else if (flag === '--near-ms') options.proximityMs = Number(value);
    else throw Error(`Unknown option ${flag}`);
  }
  if (!specs.length) throw Error('Usage: node tools/stutter-timeline.mjs --input run=world-samples.jsonl [--input run=gc-events.jsonl] [--anchors anchors.json] [--from UTC --to UTC] [--out new-report.json]');
  if (specs.length > 16) throw Error('Use at most16 input files');
  let total = 0;
  const inputs = [];
  for (const spec of specs) {
    const size = (await stat(spec.path)).size; total += size;
    if (size > LIMITS.fileBytes || total > LIMITS.totalBytes) throw Error('Input byte limit exceeded');
    const bytes = await readFile(spec.path), text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw Error('Inputs must be valid UTF-8 text');
    inputs.push({ label: spec.label, name: spec.path, text });
  }
  if (anchorsFile) { if ((await stat(anchorsFile)).size > 65536) throw Error('Anchor file exceeds64KiB'); options.anchors = JSON.parse(await readFile(anchorsFile, 'utf8')); }
  const report = correlateStutter(normalizeStutterInputs(inputs, options), options), json = JSON.stringify(report, null, 2) + '\n';
  if (out) await writeFile(out, json, { flag: 'wx' }); else process.stdout.write(json);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stutterTimelineMain(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
