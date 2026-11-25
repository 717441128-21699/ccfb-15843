// 主线程 Worker RPC 客户端
import type { Station } from '../core/types';
// Vite 识别 `new Worker(new URL(...))` 打包
const worker = new Worker(new URL('../detect/worker.ts', import.meta.url), { type: 'module' });

let seq = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const progressListeners = new Set<(p: { id: number; pct: number; stage: string }) => void>();

worker.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.kind === 'progress') {
    progressListeners.forEach((fn) => fn({ id: m.id, pct: m.pct, stage: m.stage }));
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.kind === 'error') p.reject(new Error(m.message));
  else p.resolve(m);
};

function call<T = any>(message: Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer ?? []);
  });
}

export function onProgress(fn: (p: { id: number; pct: number; stage: string }) => void): () => void {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

export const workerApi = {
  calibrate(station: Station, timeMs: number) {
    return call<{ result: import('../calibration/plate').CalibrationResult }>({ kind: 'calibrate', station, timeMs });
  },
  runSynth(params: {
    nightId: string; showerId: string; epochMs: number; durationS: number; count: number;
    stationIds?: string[]; seed?: number; width?: number; height?: number; fps?: number;
    date?: string; label?: string;
  }) {
    return call<{
      records: import('../core/types').MeteorRecord[];
      night: import('../core/types').NightRecord;
      stationSummary: Record<string, any>;
      truthCount: number;
    }>({ kind: 'run-synth', params });
  },
  initDetect(opts: { stationId: string; nightId: string; width: number; height: number; fps: number; degPerPx: number }) {
    return call({ kind: 'init-detect', ...opts });
  },
  pushRgbaFrame(buffer: ArrayBuffer, width: number, height: number, time: number, index: number) {
    return call({ kind: 'frame-rgba', buffer, width, height, time, index }, [buffer]);
  },
  finishDetect() {
    return call<{ result: import('../core/types').DetectionResult }>({ kind: 'finish-detect' });
  },
};
