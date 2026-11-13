// The hardware test (home's docs/video-hardware-tests-plan.md, H1): how many times
// faster than real time each kind of film converts here, on the GPU and on the
// CPU, and how many people that lets watch at once.
//
// Each scenario is a short clip made here once (kept in the samples folder, made
// again when ffmpeg changes) and converted exactly as a viewer's player would get
// it: the plan buildPlan() makes from the clip's own probe, the arguments
// ffmpegArgs() gives a viewer's run. So it measures what watching does, filters,
// limits and all, not a command written for the test.
//
// It runs only when an admin asks, never while someone watches converted video
// (the app stops it the moment someone starts), and copies, fills and detection
// wait while it runs. Results are kept (hardware_tests, the last 20).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "./db.js";
import { decideDelivery, type Delivery, type Rung } from "./delivery.js";
import { probe, type MediaInfo, type Tools } from "./ffmpeg.js";
import { HDR10_MASTER_DISPLAY, type GpuCapabilities, type GpuRun } from "./hardware.js";
import { buildPlan, ffmpegArgs } from "./hls.js";

export type ScenarioId = "4k-hdr" | "4k-sdr" | "1080p-hevc" | "1080p-to-720p" | "divx" | "av1";

export interface Scenario {
  id: ScenarioId;
  /** What it stands for, in English (home words it in the admin's language). */
  label: string;
  width: number;
  height: number;
  ext: string;
  /** The quality rung the player asks for; null: the most a conversion makes (1080p). */
  rung: Rung | null;
  /** Ways to encode the clip's picture, tried in turn (AV1 has two encoders, either may be missing). */
  encoders: string[][];
  /** Its sound's encoder. */
  audio: string[];
}

const X265 = (pixels: string, extra = "") => ["-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", pixels, "-x265-params", `log-level=error${extra}`];

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "4k-hdr", label: "4K HDR (HEVC 10-bit, HDR10) to 1080p", width: 3840, height: 2160, ext: ".mkv", rung: null,
    encoders: [X265("yuv420p10le", `:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=${HDR10_MASTER_DISPLAY}:max-cll=1000,400`)],
    audio: ["-c:a", "aac", "-b:a", "192k"]
  },
  { id: "4k-sdr", label: "4K (HEVC) to 1080p", width: 3840, height: 2160, ext: ".mkv", rung: null, encoders: [X265("yuv420p")], audio: ["-c:a", "aac", "-b:a", "192k"] },
  { id: "1080p-hevc", label: "1080p HEVC 10-bit", width: 1920, height: 1080, ext: ".mkv", rung: null, encoders: [X265("yuv420p10le")], audio: ["-c:a", "ac3", "-b:a", "384k"] },
  {
    id: "1080p-to-720p", label: "1080p H.264 to 720p (away from home)", width: 1920, height: 1080, ext: ".mkv", rung: 720,
    encoders: [["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]], audio: ["-c:a", "aac", "-b:a", "192k"]
  },
  { id: "divx", label: "DivX / XviD (MPEG-4 Part 2)", width: 720, height: 400, ext: ".avi", rung: null, encoders: [["-c:v", "mpeg4", "-vtag", "XVID", "-q:v", "4"]], audio: ["-c:a", "ac3", "-b:a", "192k"] },
  {
    id: "av1", label: "1080p AV1", width: 1920, height: 1080, ext: ".mkv", rung: null,
    encoders: [["-c:v", "libsvtav1", "-preset", "12", "-pix_fmt", "yuv420p"], ["-c:v", "libaom-av1", "-cpu-used", "8", "-row-mt", "1", "-pix_fmt", "yuv420p"]],
    audio: ["-c:a", "aac", "-b:a", "192k"]
  }
];

/** Which scenarios the "how many at once" steps measure, heaviest first. */
const TOGETHER_SCENARIOS: readonly ScenarioId[] = ["4k-hdr", "1080p-hevc"];

export interface TestLimits {
  /** Seconds of film in each clip. */
  clipSeconds: number;
  /** How long one conversion is timed for. */
  runMs: number;
  /** How long each "how many at once" step runs. */
  togetherMs: number;
  /** The most at once ever tried. */
  togetherMax: number;
  /** A clip being made gets this long. */
  makeMs: number;
}

export const DEFAULT_LIMITS: TestLimits = { clipSeconds: 20, runMs: 15_000, togetherMs: 10_000, togetherMax: 6, makeMs: 10 * 60_000 };

/** ×real time from which watching is smooth, tight but playing, or too slow. */
const SMOOTH = 1.5;
const PLAYS = 1.0;
/** Each of N at once must keep this pace for N to count. */
const TOGETHER_PACE = 1.2;

export type Verdict = "smooth" | "tight" | "slow" | "failed";

export interface RunResult {
  /** ×real time: seconds of film made per second. null when it failed. */
  speed: number | null;
  fps: number | null;
  /** Seconds of film made, and in how long. */
  filmSeconds: number;
  wallSeconds: number;
  verdict: Verdict;
  error: string | null;
  /** What the GPU did (decode, tone-map) — null on the CPU. */
  gpu: GpuRun | null;
}

export interface ScenarioResult {
  id: ScenarioId;
  label: string;
  /** Why it wasn't run ("this ffmpeg can't make AV1"); null when it was. */
  skipped: string | null;
  /** null: no GPU to try it on. */
  gpuRun: RunResult | null;
  cpuRun: RunResult | null;
}

export interface TogetherResult {
  id: ScenarioId;
  label: string;
  converter: "gpu" | "cpu";
  /** The most at once that each kept TOGETHER_PACE; 0 when even one didn't. */
  atOnce: number;
  /** The steps stopped at the most they try (the viewer limit plus one) while still
   *  keeping pace: it manages at least atOnce, maybe more. */
  atLeast: boolean;
  /** Each step tried: how many, and the slowest of them. */
  steps: { count: number; slowest: number | null }[];
}

/** What a test is doing now: making a clip, timing one on the GPU or the CPU, or several at once. */
export interface TestStep {
  kind: "make" | "gpu" | "cpu" | "together";
  scenario: ScenarioId;
  /** "together": how many at once. */
  count?: number;
}

export type TestPhase = "samples" | "converting" | "together" | "done" | "stopped" | "failed";

export interface HardwareTest {
  id: number | null;
  startedAt: string;
  finishedAt: string | null;
  phase: TestPhase;
  /** What it is doing now, for the page ("Making the 4K HDR clip"). */
  doing: string | null;
  /** The same as data, for a page that words it in its own language. */
  step: TestStep | null;
  /** Why it stopped or failed. */
  reason: string | null;
  ffmpeg: string | null;
  gpu: Pick<GpuCapabilities, "device" | "driver" | "decode" | "tonemap" | "overlay" | "error"> | null;
  scenarios: ScenarioResult[];
  together: TogetherResult[];
  /** The viewer limit the results allow, to suggest; null when they don't say. */
  suggestedViewers: number | null;
}

export const verdictOf = (speed: number | null): Verdict =>
  speed === null ? "failed" : speed >= SMOOTH ? "smooth" : speed >= PLAYS ? "tight" : "slow";

interface Run {
  code: number | null;
  out: string;
}

function runTool(binary: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<Run> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).pop() ?? "no answer";

/** The clips, made once and kept; made again when ffmpeg or the clip length changes. */
export async function ensureSamples(
  tools: Tools,
  dir: string,
  scenarios: readonly Scenario[],
  ffmpegVersion: string,
  limits: TestLimits,
  progress: (scenario: Scenario) => void,
  signal: AbortSignal
): Promise<Map<ScenarioId, { file: string } | { skipped: string }>> {
  fs.mkdirSync(dir, { recursive: true });
  const stampFile = path.join(dir, "made-with.json");
  const stamp = JSON.stringify({ ffmpeg: ffmpegVersion, seconds: limits.clipSeconds });
  let kept = "";
  try { kept = fs.readFileSync(stampFile, "utf8"); } catch { /* none yet */ }
  if (kept !== stamp) {
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
    fs.writeFileSync(stampFile, stamp);
  }
  const made = new Map<ScenarioId, { file: string } | { skipped: string }>();
  for (const scenario of scenarios) {
    signal.throwIfAborted();
    const file = path.join(dir, `${scenario.id}-${scenario.width}x${scenario.height}${scenario.ext}`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      made.set(scenario.id, { file });
      continue;
    }
    progress(scenario);
    let error = "";
    for (const encoder of scenario.encoders) {
      const partial = `${file}.part${scenario.ext}`;
      const answer = await runTool(tools.ffmpeg, [
        "-hide_banner", "-v", "error", "-y",
        "-f", "lavfi", "-i", `testsrc2=size=${scenario.width}x${scenario.height}:rate=24`,
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", String(limits.clipSeconds), "-map", "0:v", "-map", "1:a", ...encoder, ...scenario.audio, partial
      ], limits.makeMs, signal);
      signal.throwIfAborted();
      if (answer.code === 0 && fs.existsSync(partial)) {
        fs.renameSync(partial, file);
        error = "";
        break;
      }
      fs.rmSync(partial, { force: true });
      error = lastLine(answer.out);
    }
    made.set(scenario.id, error ? { skipped: `This ffmpeg can't make the clip: ${error}` } : { file });
  }
  return made;
}

/** A viewer's conversion of the clip, as hls.ts would start it, timed. */
export async function timeConversion(
  tools: Tools,
  sample: { file: string; info: MediaInfo; scenario: Scenario },
  gpu: GpuRun | null,
  limitMs: number,
  signal: AbortSignal
): Promise<RunResult> {
  const decided = decideDelivery(sample.info, sample.scenario.ext, null, null, sample.scenario.rung);
  // Always converted, as a browser needs it: the test is about re-encoding.
  const delivery: Delivery = { ...decided, mode: "transcode", videoCopy: false };
  const plan = buildPlan("hardware-test", sample.file, sample.info, delivery, null);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-test-"));
  const args = ffmpegArgs(plan, 0, out, gpu);
  // How far it is, a line at a time.
  args.splice(args.indexOf("-y") + 1, 0, "-nostats", "-progress", "pipe:1");
  // The clip over and over, so every case is timed for the whole time allowed:
  // a fast one would otherwise finish in a moment and measure ffmpeg starting.
  args.splice(args.indexOf("-i"), 0, "-stream_loop", "-1");
  const started = performance.now();
  return new Promise<RunResult>((resolve) => {
    const proc = spawn(tools.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let filmSeconds = 0;
    let frames = 0;
    let stderr = "";
    let timedOut = false;
    let pending = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const [key, value] = line.split("=");
        if (key === "out_time_us" || key === "out_time_ms") {
          // Both are microseconds (out_time_ms is misnamed in ffmpeg).
          const micro = Number(value);
          if (Number.isFinite(micro) && micro > 0) filmSeconds = micro / 1_000_000;
        } else if (key === "frame") {
          const count = Number(value);
          if (Number.isFinite(count) && count > 0) frames = count;
        }
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    const stop = () => { timedOut = true; proc.kill("SIGKILL"); };
    const timer = setTimeout(stop, limitMs);
    signal.addEventListener("abort", stop, { once: true });
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      fs.rm(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }, () => undefined);
      const wallSeconds = (performance.now() - started) / 1000;
      const failed = !timedOut && code !== 0;
      const speed = failed || filmSeconds <= 0 || wallSeconds <= 0 ? null : filmSeconds / wallSeconds;
      const fps = speed === null || frames <= 0 ? null : frames / wallSeconds;
      resolve({
        speed: speed === null ? null : Math.round(speed * 100) / 100,
        fps: fps === null ? null : Math.round(fps * 10) / 10,
        filmSeconds: Math.round(filmSeconds * 10) / 10,
        wallSeconds: Math.round(wallSeconds * 10) / 10,
        verdict: verdictOf(speed),
        error: failed ? lastLine(stderr) : speed === null ? "Nothing was converted in the time allowed" : null,
        gpu
      });
    });
  });
}

/** The viewer limit the results allow: what the heaviest measured case keeps up with,
 *  never less than one (a server too slow for 4K still plays 1080p to someone). */
export function suggestViewers(together: TogetherResult[]): number | null {
  const counts = together.map((entry) => entry.atOnce).filter((count) => count > 0);
  return counts.length === 0 ? null : Math.max(1, Math.min(...counts));
}

export interface TesterOptions {
  db: Db;
  tools: Tools;
  samplesDir: string;
  ffmpegVersion: () => Promise<string | null>;
  /** The GPU's choice for a film, ignoring the admin's setting (Hardware.gpuFor). */
  gpuFor: (info: MediaInfo, delivery: Delivery) => GpuRun | null;
  gpuState: () => HardwareTest["gpu"];
  /** The admin's viewer limit: the steps go one past it. */
  maxViewers: () => number;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  scenarios?: readonly Scenario[];
  limits?: Partial<TestLimits>;
}

/** How many tests are kept. */
const KEPT_TESTS = 20;

export class HardwareTester {
  private current: HardwareTest | null = null;
  private abort: AbortController | null = null;
  private done: Promise<void> = Promise.resolve();
  private limits: TestLimits;

  constructor(private options: TesterOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  running(): boolean {
    return this.current !== null && !["done", "stopped", "failed"].includes(this.current.phase);
  }

  /** The running test, or null. */
  progress(): HardwareTest | null {
    return this.running() ? this.current : null;
  }

  /** Waits for the test running now, if any (tests and closing). */
  settled(): Promise<void> {
    return this.done;
  }

  /** Starts a test; throws when one runs already. */
  start(): HardwareTest {
    if (this.running()) throw new Error("A test is running already");
    const test: HardwareTest = {
      id: null, startedAt: new Date().toISOString(), finishedAt: null, phase: "samples", doing: null, step: null, reason: null,
      ffmpeg: null, gpu: this.options.gpuState(), scenarios: [], together: [], suggestedViewers: null
    };
    this.current = test;
    this.abort = new AbortController();
    this.done = this.run(test, this.abort.signal);
    return test;
  }

  /** Stops the running test; `reason` is shown with it ("Someone started watching"). */
  stop(reason: string): void {
    if (!this.running() || !this.abort || this.abort.signal.aborted) return;
    this.current!.reason = reason;
    this.abort.abort();
  }

  private async run(test: HardwareTest, signal: AbortSignal): Promise<void> {
    const { tools, log } = this.options;
    const scenarios = this.options.scenarios ?? SCENARIOS;
    try {
      test.ffmpeg = await this.options.ffmpegVersion();
      const samples = await ensureSamples(tools, this.options.samplesDir, scenarios, test.ffmpeg ?? "unknown", this.limits,
        (scenario) => { test.doing = `Making the clip: ${scenario.label}`; test.step = { kind: "make", scenario: scenario.id }; }, signal);
      test.phase = "converting";
      const probed = new Map<ScenarioId, { file: string; info: MediaInfo; scenario: Scenario }>();
      for (const scenario of scenarios) {
        signal.throwIfAborted();
        const made = samples.get(scenario.id);
        if (!made || "skipped" in made) {
          test.scenarios.push({ id: scenario.id, label: scenario.label, skipped: made && "skipped" in made ? made.skipped : "Not made", gpuRun: null, cpuRun: null });
          continue;
        }
        const info = await probe(tools, made.file);
        const sample = { file: made.file, info, scenario };
        probed.set(scenario.id, sample);
        const result: ScenarioResult = { id: scenario.id, label: scenario.label, skipped: null, gpuRun: null, cpuRun: null };
        test.scenarios.push(result);
        const gpu = this.options.gpuFor(info, { ...decideDelivery(info, scenario.ext, null, null, scenario.rung), mode: "transcode", videoCopy: false });
        if (gpu) {
          test.doing = `On the GPU: ${scenario.label}`;
          test.step = { kind: "gpu", scenario: scenario.id };
          result.gpuRun = await timeConversion(tools, sample, gpu, this.limits.runMs, signal);
          signal.throwIfAborted();
        }
        test.doing = `On the CPU: ${scenario.label}`;
        test.step = { kind: "cpu", scenario: scenario.id };
        result.cpuRun = await timeConversion(tools, sample, null, this.limits.runMs, signal);
        signal.throwIfAborted();
      }

      test.phase = "together";
      for (const id of TOGETHER_SCENARIOS) {
        const sample = probed.get(id);
        const result = test.scenarios.find((entry) => entry.id === id);
        if (!sample || !result) continue;
        // The way a viewer would get it: the GPU when it plays there, else the CPU.
        const onGpu = result.gpuRun !== null && result.gpuRun.speed !== null;
        const single = onGpu ? result.gpuRun! : result.cpuRun;
        const entry: TogetherResult = { id, label: sample.scenario.label, converter: onGpu ? "gpu" : "cpu", atOnce: 0, atLeast: false, steps: [{ count: 1, slowest: single?.speed ?? null }] };
        test.together.push(entry);
        if (!single?.speed || single.speed < TOGETHER_PACE) continue;
        entry.atOnce = 1;
        const most = Math.min(this.limits.togetherMax, this.options.maxViewers() + 1);
        for (let count = 2; count <= most; count++) {
          signal.throwIfAborted();
          test.doing = `${count} at once: ${sample.scenario.label}`;
          test.step = { kind: "together", scenario: id, count };
          const runs = await Promise.all(Array.from({ length: count }, () =>
            timeConversion(tools, sample, onGpu ? result.gpuRun!.gpu : null, this.limits.togetherMs, signal)));
          signal.throwIfAborted();
          const slowest = runs.some((run) => run.speed === null) ? null : Math.min(...runs.map((run) => run.speed!));
          entry.steps.push({ count, slowest });
          if (slowest === null || slowest < TOGETHER_PACE) break;
          entry.atOnce = count;
        }
        entry.atLeast = entry.atOnce === most && most > 1;
      }
      test.suggestedViewers = suggestViewers(test.together);
      test.phase = "done";
    } catch (err) {
      if (signal.aborted) {
        test.phase = "stopped";
        test.reason ??= "Stopped";
      } else {
        test.phase = "failed";
        test.reason = err instanceof Error ? err.message : String(err);
        log.warn({ err }, "The hardware test failed");
      }
    } finally {
      test.doing = null;
      test.step = null;
      test.finishedAt = new Date().toISOString();
      test.id = this.keep(test);
      log.info({ phase: test.phase, suggestedViewers: test.suggestedViewers, reason: test.reason }, "Hardware test finished");
    }
  }

  private keep(test: HardwareTest): number | null {
    const { db } = this.options;
    if (!db.open) return null;
    const id = Number(db.prepare("INSERT INTO hardware_tests (started_at, finished_at, phase, result) VALUES (?, ?, ?, ?)")
      .run(test.startedAt, test.finishedAt, test.phase, JSON.stringify(test)).lastInsertRowid);
    db.prepare("DELETE FROM hardware_tests WHERE id NOT IN (SELECT id FROM hardware_tests ORDER BY id DESC LIMIT ?)").run(KEPT_TESTS);
    return id;
  }
}

/** The tests kept, newest first (their results whole). */
export function listTests(db: Db, limit = KEPT_TESTS): HardwareTest[] {
  return (db.prepare("SELECT id, result FROM hardware_tests ORDER BY id DESC LIMIT ?").all(limit) as { id: number; result: string }[])
    .map((row) => ({ ...(JSON.parse(row.result) as HardwareTest), id: row.id }));
}

// ── H2: a note when the hardware changes ──────────────────────────────────────

export interface HardwareFingerprint {
  device: string | null;
  driver: string | null;
  decode: string[];
  tonemap: boolean;
  overlay: boolean;
  ffmpeg: string | null;
}

export interface HardwareChange {
  id: number;
  at: string;
  before: HardwareFingerprint;
  after: HardwareFingerprint;
  summary: string;
}

export function fingerprintOf(caps: GpuCapabilities, ffmpeg: string | null): HardwareFingerprint {
  return {
    device: caps.encode ? caps.device : null,
    driver: caps.driver,
    decode: [...caps.decode].sort(),
    tonemap: caps.tonemap === true,
    overlay: caps.overlay === true,
    ffmpeg
  };
}

/** "driver 24.1 → 25.2; now decodes av1", in English for the log and the report. */
export function describeChange(before: HardwareFingerprint, after: HardwareFingerprint): string {
  const parts: string[] = [];
  if (before.device !== after.device) parts.push(after.device ? (before.device ? `GPU ${before.device} → ${after.device}` : `GPU found (${after.device})`) : "GPU gone");
  if (before.driver !== after.driver) parts.push(`driver ${before.driver ?? "none"} → ${after.driver ?? "none"}`);
  const gained = after.decode.filter((codec) => !before.decode.includes(codec));
  const lost = before.decode.filter((codec) => !after.decode.includes(codec));
  if (gained.length) parts.push(`now decodes ${gained.join(", ")}`);
  if (lost.length) parts.push(`no longer decodes ${lost.join(", ")}`);
  if (before.tonemap !== after.tonemap) parts.push(after.tonemap ? "now tone-maps HDR" : "no longer tone-maps HDR");
  if (before.overlay !== after.overlay) parts.push(after.overlay ? "now draws subtitles" : "no longer draws subtitles");
  if (before.ffmpeg !== after.ffmpeg) parts.push(`ffmpeg ${before.ffmpeg ?? "?"} → ${after.ffmpeg ?? "?"}`);
  return parts.join("; ");
}

/** Compares what the check found with the last fingerprint kept, and notes a
 *  difference. The first check ever only keeps its fingerprint. Returns the change. */
export function noteHardware(db: Db, fingerprint: HardwareFingerprint): HardwareChange | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'hardware-fingerprint'").get() as { value: string } | undefined;
  const value = JSON.stringify(fingerprint);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('hardware-fingerprint', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run(value);
  if (!row || row.value === value) return null;
  const before = JSON.parse(row.value) as HardwareFingerprint;
  const summary = describeChange(before, fingerprint);
  if (!summary) return null;
  const at = new Date().toISOString();
  const id = Number(db.prepare("INSERT INTO hardware_changes (at, before, after, summary) VALUES (?, ?, ?, ?)")
    .run(at, row.value, value, summary).lastInsertRowid);
  db.prepare("DELETE FROM hardware_changes WHERE id NOT IN (SELECT id FROM hardware_changes ORDER BY id DESC LIMIT 50)").run();
  return { id, at, before, after: fingerprint, summary };
}

export function listChanges(db: Db, limit = 20): HardwareChange[] {
  return (db.prepare("SELECT id, at, before, after, summary FROM hardware_changes ORDER BY id DESC LIMIT ?").all(limit) as { id: number; at: string; before: string; after: string; summary: string }[])
    .map((row) => ({ id: row.id, at: row.at, before: JSON.parse(row.before) as HardwareFingerprint, after: JSON.parse(row.after) as HardwareFingerprint, summary: row.summary }));
}
