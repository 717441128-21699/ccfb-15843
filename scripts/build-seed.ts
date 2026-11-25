/* 生成应用内置演示数据集：5 个流星群之夜，全链路真实计算 + 缩略图 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { STATIONS } from '../src/core/stations';
import { generateNight, type Scenario } from '../src/synth/scenario';
import { StationRenderer } from '../src/synth/render';
import { MeteorDetectionPipeline } from '../src/detect/pipeline';
import { calibrateStation } from '../src/calibration/plate';
import { reconstructMeteors, type StationBundle } from '../src/calibration/reconstruct';
import { fovDeg } from '../src/geo/camera';
import { grayToDataUrl } from './png';
import type { MeteorRecord, NightRecord, ValidationReport } from '../src/core/types';

const W = 800, H = 450, FPS = 15;

const NIGHT_DEFS = [
  { id: 'night-qua-2025', showerId: 'QUA', date: '2025-01-04', epoch: Date.UTC(2025, 0, 3, 19, 0, 0), label: '象限仪座极大夜' },
  { id: 'night-per-2025', showerId: 'PER', date: '2025-08-13', epoch: Date.UTC(2025, 7, 12, 18, 0, 0), label: '英仙座极大夜' },
  { id: 'night-ori-2025', showerId: 'ORI', date: '2025-10-21', epoch: Date.UTC(2025, 9, 21, 17, 0, 0), label: '猎户座极大夜' },
  { id: 'night-leo-2025', showerId: 'LEO', date: '2025-11-18', epoch: Date.UTC(2025, 10, 17, 18, 0, 0), label: '狮子座极大夜' },
  { id: 'night-gem-2025', showerId: 'GEM', date: '2025-12-14', epoch: Date.UTC(2025, 11, 14, 17, 0, 0), label: '双子座极大夜' },
];

function makeThumbnail(
  renderer: StationRenderer,
  frameIndex: number,
  points: Array<{ x: number; y: number }>,
): string {
  const CW = 240, CH = 150;
  const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
  const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
  let x0 = Math.round(cx - CW / 2), y0 = Math.round(cy - CH / 2);
  x0 = Math.max(0, Math.min(W - CW, x0));
  y0 = Math.max(0, Math.min(H - CH, y0));
  const f = renderer.render(frameIndex);
  // 对比度拉伸
  let mn = 255, mx = 0;
  for (let y = 0; y < CH; y += 2) for (let x = 0; x < CW; x += 2) {
    const v = f.data[(y0 + y) * W + (x0 + x)];
    if (v < mn) mn = v; if (v > mx) mx = v;
  }
  const lo = mn + 8, hi = Math.max(lo + 30, mx - 6);
  const crop = new Uint8Array(CW * CH);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    let v = f.data[(y0 + y) * W + (x0 + x)];
    v = Math.max(0, Math.min(255, ((v - lo) / (hi - lo)) * 255));
    crop[y * CW + x] = v;
  }
  // 烧入观测点标记
  for (const p of points) {
    const px = Math.round(p.x - x0), py = Math.round(p.y - y0);
    for (const [dx, dy, c] of [[0, 0, 255], [1, 0, 220], [-1, 0, 220], [0, 1, 220], [0, -1, 220]] as const) {
      const x = px + dx, y = py + dy;
      if (x >= 0 && x < CW && y >= 0 && y < CH) crop[y * CW + x] = c;
    }
  }
  return grayToDataUrl(CW, CH, crop);
}

const nights: NightRecord[] = [];
const meteors: MeteorRecord[] = [];

for (let ni = 0; ni < NIGHT_DEFS.length; ni++) {
  const def = NIGHT_DEFS[ni];
  const seed = 5100 + ni * 137;
  const sc: Scenario = generateNight({
    nightId: def.id, showerId: def.showerId, epochMs: def.epoch,
    durationS: 95, meteorCount: 9, stations: STATIONS,
    width: W, height: H, fps: FPS, seed,
  });

  const bundles: StationBundle[] = [];
  const renderers = new Map<string, StationRenderer>();
  const rejectKinds: Record<string, number> = {};

  for (const st of sc.stations) {
    const renderer = new StationRenderer(sc, st.id);
    renderers.set(st.id, renderer);
    const calTime = def.epoch + 45_000;
    const calFrame = renderer.renderCalibration(calTime);
    const cal = calibrateStation(st, calFrame, calTime);
    const fov = fovDeg(st.camera);
    const pipe = new MeteorDetectionPipeline({
      stationId: st.id, nightId: def.id, width: W, height: H, fps: FPS, degPerPx: fov.h / W,
    });
    for (let i = 0; i < sc.frameCount; i++) pipe.process(renderer.render(i));
    const res = pipe.finish();
    for (const r of res.rejected) rejectKinds[r.kind] = (rejectKinds[r.kind] ?? 0) + 1;
    bundles.push({ station: st, solution: cal.solution, tracks: res.tracks });
  }

  const recs = reconstructMeteors(bundles, { nightId: def.id, dateMs: def.epoch, idPrefix: def.showerId });

  for (const rec of recs) {
    // 匹配真值以附加“公开网络参考解”
    const tMid = rec.trajectory ? (rec.trajectory.begin.time + rec.trajectory.end.time) / 2 : 0;
    let gt = sc.meteors[0]; let bestDt = Infinity;
    for (const g of sc.meteors) {
      const dt = Math.abs((g.startMs + g.endMs) / 2 - tMid);
      if (dt < bestDt) { bestDt = dt; gt = g; }
    }
    if (bestDt < 1600) {
      const hTrue = +(gt.begin.alt / 1000).toFixed(2);
      const vTrue = +(gt.speedMS / 1000).toFixed(2);
      rec.reference = {
        beginHeightKm: hTrue,
        speedKms: vTrue,
        radiant: gt.radiantTrue,
        network: 'GMN/CAMS 合成同轨参考解',
      };
      rec.heightErrorPct = +(Math.abs(rec.beginHeightKm - hTrue) / hTrue * 100).toFixed(2);
      rec.speedErrorPct = +(Math.abs(rec.speedKms - vTrue) / vTrue * 100).toFixed(2);
    }
    // 缩略图：取观测最多的站
    const byStation = new Map<string, typeof rec.equatorial>();
    for (const o of rec.equatorial) {
      if (!byStation.has(o.stationId)) byStation.set(o.stationId, []);
      byStation.get(o.stationId)!.push(o);
    }
    let bestSid = '', bestObs: typeof rec.equatorial = [];
    for (const [sid, obs] of byStation) if (obs.length > bestObs.length) { bestSid = sid; bestObs = obs; }
    const renderer = renderers.get(bestSid);
    if (renderer && bestObs.length) {
      const mid = bestObs[bestObs.length >> 1];
      rec.thumbnail = makeThumbnail(renderer, mid.frame, bestObs.map((o) => ({ x: o.x, y: o.y })));
    }
    meteors.push(rec);
  }

  nights.push({
    id: def.id,
    date: def.date,
    label: def.label,
    showerId: def.showerId,
    stationIds: sc.stations.map((s) => s.id),
    videoKind: 'synthetic',
    durationMin: +(95 / 60).toFixed(1),
    frames: sc.frameCount,
    status: 'seeded',
    meteorIds: recs.map((r) => r.id),
    falseAlarms: 0,
    rejectKinds,
    notes: `合成多站观测段，种子 ${seed}；含飞机/卫星/飞虫/闪电干扰`,
  });
  console.log(`${def.showerId}: ${recs.length} 颗流星入库`);
}

let report: ValidationReport | null = null;
const reportPath = 'src/seed/validation-report.json';
if (existsSync(reportPath)) {
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) as ValidationReport; } catch { /* ignore */ }
}

const dataset = {
  version: 1,
  generatedAt: new Date().toISOString(),
  coordinateNote: '合成视频使用真实亮星表与 WGS84/GMST 变换；参考解即合成真值，模拟公开流星网络同体结果',
  nights,
  meteors,
  validation: report,
};
writeFileSync('src/seed/dataset.json', JSON.stringify(dataset));
console.log(`dataset.json 写入：${nights.length} 夜 / ${meteors.length} 颗流星，${(JSON.stringify(dataset).length / 1024) | 0} KB`);
