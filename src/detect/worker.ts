/// <reference lib="webworker" />
// 视频处理 Web Worker：
//  A) 一次性跑完一整个合成多站之夜（渲染 + 背景更新 + 检测 + 标定 + 交会）
//  B) 接收主线程从 <video>/<canvas> 抓来的 RGBA 帧做流式检测
import { MeteorDetectionPipeline } from '../detect/pipeline';
import { StationRenderer } from '../synth/render';
import { generateNight } from '../synth/scenario';
import { calibrateStation } from '../calibration/plate';
import { reconstructMeteors, type StationBundle } from '../calibration/reconstruct';
import { fovDeg } from '../geo/camera';
import { STATIONS } from '../core/stations';
import type { GrayFrame, MeteorTrack, RejectedTrack, Station } from '../core/types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface DetectSession {
  pipe: MeteorDetectionPipeline;
  width: number; height: number;
}
let session: DetectSession | null = null;

function rgbaToGray(buf: ArrayBuffer | Uint8Array, w: number, h: number): Uint8Array {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < w * h; i += 4, j++) {
    // Rec.601 亮度
    gray[j] = (0.299 * u8[i] + 0.587 * u8[i + 1] + 0.114 * u8[i + 2]) | 0;
  }
  return gray;
}

ctx.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  const id = msg.id as number;
  const reply = (payload: Record<string, unknown>, transfer?: Transferable[]) =>
    ctx.postMessage({ id, ...payload }, transfer ?? []);

  try {
    if (msg.kind === 'calibrate') {
      const station = msg.station as Station;
      const timeMs = msg.timeMs as number;
      // 用合成星场渲染一帧（与站点页“模拟晴朗标定帧”一致）
      const sc = generateNight({
        nightId: 'cal', showerId: 'SPO', epochMs: timeMs, durationS: 4, meteorCount: 0,
        stations: [station], width: station.camera.width, height: station.camera.height,
        fps: station.camera.fps, seed: 4242,
      });
      const renderer = new StationRenderer(sc, station.id);
      const frame = renderer.renderCalibration(timeMs);
      const result = calibrateStation(station, frame, timeMs);
      reply({ kind: 'calibrated', result });
      return;
    }

    if (msg.kind === 'run-synth') {
      const p = msg.params;
      const width = p.width ?? 640, height = p.height ?? 360, fps = p.fps ?? 15;
      const stations = STATIONS.filter((s) => (p.stationIds ?? STATIONS.map((x) => x.id)).includes(s.id));
      const sc = generateNight({
        nightId: p.nightId, showerId: p.showerId ?? 'PER', epochMs: p.epochMs,
        durationS: p.durationS ?? 70, meteorCount: p.count ?? 7,
        stations, width, height, fps, seed: p.seed ?? (Date.now() % 100000),
        nuisanceLevel: 1,
      });

      const bundles: StationBundle[] = [];
      const stationSummary: Record<string, unknown> = {};
      const totalFrames = sc.frameCount * sc.stations.length;
      let doneFrames = 0;

      for (const st of sc.stations) {
        const renderer = new StationRenderer(sc, st.id);
        const calTime = p.epochMs + (p.durationS ?? 70) * 500;
        const calFrame = renderer.renderCalibration(calTime);
        const cal = calibrateStation(st, calFrame, calTime);
        const fov = fovDeg(st.camera);
        const pipe = new MeteorDetectionPipeline({
          stationId: st.id, nightId: p.nightId, width, height, fps, degPerPx: fov.h / width,
        });
        let tracks: MeteorTrack[] = [];
        let rejected: RejectedTrack[] = [];
        for (let i = 0; i < sc.frameCount; i++) {
          const f = renderer.render(i);
          pipe.process(f);
          doneFrames++;
          if (i % 15 === 0) {
            ctx.postMessage({ id, kind: 'progress', pct: doneFrames / totalFrames, stage: `${st.id} 帧 ${i}/${sc.frameCount}` });
            // 让事件循环有机会处理消息
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        const res = pipe.finish();
        tracks = res.tracks; rejected = res.rejected;
        const rejectKinds: Record<string, number> = {};
        for (const r of rejected) rejectKinds[r.kind] = (rejectKinds[r.kind] ?? 0) + 1;
        stationSummary[st.id] = {
          matchedStars: cal.solution.matchedStars,
          rmsArcsec: cal.solution.rmsArcsec,
          tracks: tracks.length,
          rejected: rejected.length,
          rejectKinds,
          trackPreviews: tracks.map((t) => ({
            id: t.id, score: t.score, obsCount: t.observations.length,
            speedDegS: +(t.speedPxS * fov.h / width).toFixed(2),
            points: t.observations.map((o) => [o.frame, +o.x.toFixed(1), +o.y.toFixed(1)]),
          })),
          rejectPreviews: rejected.slice(0, 24).map((r) => ({
            id: r.id, kind: r.kind, reason: r.reason, frames: r.frames,
            points: r.observations.map((o) => [o.frame, +o.x.toFixed(0), +o.y.toFixed(0)]),
          })),
        };
        bundles.push({ station: st, solution: cal.solution, tracks });
      }

      const records = reconstructMeteors(bundles, { nightId: p.nightId, dateMs: p.epochMs });
      ctx.postMessage({
        id, kind: 'synth-done', records, stationSummary,
        truthCount: sc.meteors.length,
        night: {
          id: p.nightId, date: p.date ?? new Date(p.epochMs).toISOString().slice(0, 10),
          label: p.label ?? '交互式合成夜', showerId: p.showerId ?? 'SPO',
          stationIds: sc.stations.map((s) => s.id), videoKind: 'synthetic',
          durationMin: +((p.durationS ?? 70) / 60).toFixed(1), frames: sc.frameCount,
          status: 'processed', meteorIds: records.map((r) => r.id), falseAlarms: 0,
        },
      });
      return;
    }

    if (msg.kind === 'init-detect') {
      const { stationId, nightId, width, height, fps, degPerPx } = msg;
      const pipe = new MeteorDetectionPipeline({ stationId, nightId, width, height, fps, degPerPx });
      session = { pipe, width, height };
      reply({ kind: 'ready' });
      return;
    }

    if (msg.kind === 'frame-rgba') {
      if (!session) throw new Error('检测会话未初始化');
      const { buffer, width, height, time, index } = msg as {
        buffer: ArrayBuffer; width: number; height: number; time: number; index: number;
      };
      const gray = rgbaToGray(buffer, width, height);
      const frame: GrayFrame = { width, height, data: gray, time, index };
      const out = session.pipe.process(frame);
      // 传输 gray buffer 无意义（每次新建）；仅回传事件摘要
      reply({
        kind: 'frame-result',
        meteors: out.meteors.map((m) => ({ id: m.id, n: m.observations.length, score: m.score })),
        rejects: out.rejects.map((r) => ({ id: r.id, kind: r.kind })),
      });
      return;
    }

    if (msg.kind === 'finish-detect') {
      if (!session) throw new Error('检测会话未初始化');
      const result = session.pipe.finish();
      session = null;
      reply({ kind: 'detect-done', result });
      return;
    }
  } catch (e) {
    ctx.postMessage({ id, kind: 'error', message: (e as Error).message, stack: (e as Error).stack });
  }
};
