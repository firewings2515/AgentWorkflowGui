// The performance baseline's measurements in the main process (T040, V-18), for development runs only: `index.ts`
// starts it when the app is not packaged and AWG_PERF_LOG names a file. Every `intervalMs` one JSON line: the event
// loop's delay since the last line, memory, CPU of every process of the app, and the event batcher's counters; and a
// line for each mark (start, window, first Snapshot). Nothing of the data is written: numbers and fixed names only.
import { appendFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { BatcherStats } from './event-batcher';

/** What Electron's `app.getAppMetrics()` gives per process, as far as the log needs it. */
export interface ProcessMetric {
  type: string;
  pid: number;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number; privateBytes?: number };
}

export interface PerfLogOptions {
  path: string;
  intervalMs?: number;
  metrics?: () => ProcessMetric[];
  stats?: () => BatcherStats | undefined;
}

export interface PerfLog {
  mark(name: string, extra?: Record<string, number>): void;
  stop(): void;
}

const ms = (ns: number) => Math.round(ns / 1e4) / 100;

export function startPerfLog(options: PerfLogOptions): PerfLog {
  const write = (line: object) => {
    try {
      appendFileSync(options.path, `${JSON.stringify(line)}\n`);
    } catch {
      // A measurement never stops the app.
    }
  };
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const t = () => Math.round(performance.now());
  write({ kind: 'start', t: t(), timeOrigin: performance.timeOrigin, at: new Date().toISOString(), pid: process.pid, node: process.versions.node, electron: process.versions['electron'] ?? null });
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    write({
      kind: 'sample',
      t: t(),
      eventLoopDelayMs: { p50: ms(delay.percentile(50)), p95: ms(delay.percentile(95)), p99: ms(delay.percentile(99)), max: ms(delay.max), mean: ms(delay.mean) },
      mainMemory: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external },
      processes: (options.metrics?.() ?? []).map((p) => ({ type: p.type, pid: p.pid, cpu: p.cpu.percentCPUUsage, workingSetKb: p.memory.workingSetSize, privateKb: p.memory.privateBytes ?? null })),
      batcher: options.stats?.() ?? null,
    });
    delay.reset();
  }, options.intervalMs ?? 5000);
  timer.unref();
  return {
    mark: (name, extra = {}) => write({ kind: 'mark', name, t: t(), ...extra }),
    stop: () => {
      clearInterval(timer);
      delay.disable();
    },
  };
}
