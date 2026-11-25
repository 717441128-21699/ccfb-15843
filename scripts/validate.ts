/* 精度验证：合成多站真值视频 -> 标定 -> 检测 -> 交会 -> 指标统计
   用法：tsx scripts/validate.ts [--quick] [--check] */
import { writeFileSync, mkdirSync } from 'node:fs';
import { STATIONS } from '../src/core/stations';
import { SHOWERS } from '../src/core/showers';
import { generateNight, type Scenario, type MeteorTruth } from '../src/synth/scenario';
import { StationRenderer } from '../src/synth/render';
import { MeteorDetectionPipeline } from '../src/detect/pipeline';
import { calibrateStation } from '../src/calibration/plate';
import { reconstructMeteors, aggregateRadiants, type StationBundle } from '../src/calibration/reconstruct';
import { fovDeg } from '../src/geo/camera';
import { angularDistanceDeg } from '../src/geo/astro';
import type { MeteorRecord, ValidationReport } from '../src/core/types';

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const CHECK = args.includes('--check');

const W = 640, H = 360, FPS = 15;

const NIGHTS = [
  { showerId: 'QUA', epoch: Date.UTC(2025, 0, 3, 19, 0, 0) },
  { showerId: 'PER', epoch: Date.UTC(2025, 7, 12, 18, 0, 0) },
  { showerId: 'ORI', epoch: Date.UTC(2025, 9, 21, 17, 0, 0) },
  { showerId: 'LEO', epoch: Date.UTC(2025, 10, 17, 18, 0, 0) },
  { showerId: 'GEM', epoch: Date.UTC(2025, 11, 14, 17, 0, 0) },
];

interface NightOut {
  sc: Scenario;
  records: MeteorRecord[];
  stationTrackCounts: Record<string, number>;
  stationMatchedCounts: Record<string, number>;
  unmatchedTracks: number;
}

function runNight(showerId: string, epoch: number, seed: number, count: number, durationS: number): NightOut {
  const sc = generateNight({
    nightId: `${showerId}-${seed}`, showerId, epochMs: epoch, durationS,
    meteorCount: count, stations: STATIONS, width: W, height: H, fps: FPS, seed,
  });
  const bundles: StationBundle[] = [];
  const stationTrackCounts: Record<string, number> = {};
  for (const st of sc.stations) {
    const renderer = new StationRenderer(sc, st.id);
    const calFrame = renderer.renderCalibration(epoch + durationS * 500);
    const cal = calibrateStation(st, calFrame, epoch + durationS * 500);
    const fov = fovDeg(st.camera);
    const pipe = new MeteorDetectionPipeline({
      stationId: st.id, nightId: sc.nightId, width: W, height: H, fps: FPS, degPerPx: fov.h / W,
    });
    for (let i = 0; i < sc.frameCount; i++) pipe.process(renderer.render(i));
    const res = pipe.finish();
    stationTrackCounts[st.id] = res.tracks.length;
    bundles.push({ station: st, solution: cal.solution, tracks: res.tracks });
  }
  const records = reconstructMeteors(bundles, { nightId: sc.nightId, dateMs: epoch });

  // 站级真值匹配
  let stationMatched = 0;
  let stationTruthTotal = 0;
  const matchedTrackIds = new Set<string>();
  for (const gt of sc.meteors) {
    for (const st of sc.stations) {
      const truthFrames = gt.observations[st.id] ?? [];
      if (truthFrames.length < 4) continue;
      stationTruthTotal++;
      const map = new Map(truthFrames.map((f) => [f.frame, f]));
      const bundle = bundles.find((b) => b.station.id === st.id)!;
      let best: { id: string; med: number } | null = null;
      for (const tr of bundle.tracks) {
        const ds: number[] = [];
        for (const o of tr.observations) {
          const tf = map.get(o.frame);
          if (tf) ds.push(Math.hypot(o.x - tf.x, o.y - tf.y));
        }
        if (ds.length < 3) continue;
        ds.sort((a, b) => a - b);
        const med = ds[ds.length >> 1];
        if (med < 20 && (!best || med < best.med)) best = { id: tr.id, med };
      }
      if (best) { stationMatched++; matchedTrackIds.add(best.id); }
    }
  }
  let allTracks = 0;
  for (const b of bundles) allTracks += b.tracks.length;
  return {
    sc, records, stationTrackCounts,
    stationMatchedCounts: { matched: stationMatched, total: stationTruthTotal },
    unmatchedTracks: allTracks - matchedTrackIds.size,
  };
}

function matchRecordToTruth(rec: MeteorRecord, truths: MeteorTruth[]): MeteorTruth | null {
  const tMid = rec.trajectory ? (rec.trajectory.begin.time + rec.trajectory.end.time) / 2 : 0;
  let best: MeteorTruth | null = null;
  let bestDt = 1400;
  for (const gt of truths) {
    const dt = Math.abs((gt.startMs + gt.endMs) / 2 - tMid);
    if (dt < bestDt) { bestDt = dt; best = gt; }
  }
  return best;
}

async function main() {
  const seeds = QUICK ? [101] : [101, 202];
  const perNight = QUICK ? 5 : 7;
  const durationS = QUICK ? 55 : 80;

  let truthTotal = 0;
  let eventDetected = 0;
  let stationMatched = 0, stationTotal = 0;
  let unmatchedInClips = 0;
  const heightErrs: number[] = [], speedErrs: number[] = [];
  const within5H = { n: 0, t: 0 }, within5V = { n: 0, t: 0 };
  const radiantOffsetsCatalog: number[] = [];
  const perShowerMap = new Map<string, { truth: number; detected: number; offsets: number[] }>();

  const nightRadiants: Array<{ showerId: string; offset: number; n: number }> = [];

  for (const n of NIGHTS) {
    for (const seed of seeds) {
      const out = runNight(n.showerId, n.epoch, seed + n.showerId.length, perNight, durationS);
      truthTotal += out.sc.meteors.length;
      stationMatched += out.stationMatchedCounts.matched;
      stationTotal += out.stationMatchedCounts.total;
      unmatchedInClips += out.unmatchedTracks;

      const ps = perShowerMap.get(n.showerId) ?? { truth: 0, detected: 0, offsets: [] };
      ps.truth += out.sc.meteors.length;

      const matchedGt = new Set<string>();
      for (const rec of out.records) {
        const gt = matchRecordToTruth(rec, out.sc.meteors);
        if (!gt) continue;
        if (matchedGt.has(gt.id)) continue;
        matchedGt.add(gt.id);
        eventDetected++;
        ps.detected++;
        const hTrue = gt.begin.alt / 1000;
        const vTrue = gt.speedMS / 1000;
        const hErr = Math.abs(rec.beginHeightKm - hTrue) / hTrue * 100;
        const vErr = Math.abs(rec.speedKms - vTrue) / vTrue * 100;
        heightErrs.push(hErr); speedErrs.push(vErr);
        within5H.t++; if (hErr <= 5) within5H.n++;
        within5V.t++; if (vErr <= 5) within5V.n++;
        const sh = SHOWERS.find((s) => s.id === n.showerId)!;
        if (!Number.isNaN(sh.ra)) {
          radiantOffsetsCatalog.push(rec.radiantOffsetDeg ?? angularDistanceDeg(rec.radiant, { ra: sh.ra, dec: sh.dec }));
        }
      }
      // 夜级聚合辐射点
      const agg = aggregateRadiants(out.records.filter((r) => matchedGt.has(matchRecordToTruth(r, out.sc.meteors)?.id ?? '')));
      const sh = SHOWERS.find((s) => s.id === n.showerId)!;
      if (agg && out.records.length >= 2 && !Number.isNaN(sh.ra)) {
        const off = angularDistanceDeg(agg.radiant, { ra: sh.ra, dec: sh.dec });
        nightRadiants.push({ showerId: n.showerId, offset: off, n: out.records.length });
        ps.offsets.push(off);
      }
      perShowerMap.set(n.showerId, ps);
      process.stdout.write(`  ${n.showerId} seed${seed}: truth=${out.sc.meteors.length} records=${out.records.length} matched=${matchedGt.size} unmatchedTracks=${out.unmatchedTracks}\n`);
    }
  }

  // ---------- 误报小时：无流星视频 ----------
  const fpMinutesPerStation = QUICK ? 40 : 20; // quick: 3*40min=2h 更快样本? 实际 quick 用 3*60s 短
  const fpDurS = QUICK ? 240 : fpMinutesPerStation * 60;
  const fpFps = 10;
  const fpW = 480, fpH = 270;
  let falseAlarms = 0;
  let faStationBreakdown: Record<string, number> = {};
  for (let si = 0; si < STATIONS.length; si++) {
    const st0 = STATIONS[si];
    const sc = generateNight({
      nightId: `FP-${si}`, showerId: 'SPO', epochMs: Date.UTC(2025, 8, 1, 20),
      durationS: fpDurS, meteorCount: 0, meteorFree: true,
      stations: [st0], width: fpW, height: fpH, fps: fpFps, seed: 7000 + si, nuisanceLevel: 1.25,
    });
    const st = sc.stations[0];
    const renderer = new StationRenderer(sc, st.id);
    const fov = fovDeg(st.camera);
    const pipe = new MeteorDetectionPipeline({
      stationId: st.id, nightId: sc.nightId, width: fpW, height: fpH, fps: fpFps, degPerPx: fov.h / fpW,
    });
    const t0 = Date.now();
    for (let i = 0; i < sc.frameCount; i++) pipe.process(renderer.render(i));
    const res = pipe.finish();
    faStationBreakdown[st.id] = res.tracks.length;
    falseAlarms += res.tracks.length;
    process.stdout.write(`  FP ${st.id}: ${fpDurS}s @${fpW}x${fpH} ${fpFps}fps -> FA=${res.tracks.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
  const falseAlarmHours = (STATIONS.length * fpDurS) / 3600;
  const faPerHour = falseAlarms / falseAlarmHours;

  // ---------- 汇总 ----------
  const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const max = (a: number[]) => a.length ? Math.max(...a) : 0;
  const radiantMean = mean(nightRadiants.map((n) => n.offset));
  const radiantMax = max(nightRadiants.map((n) => n.offset));

  const report: ValidationReport = {
    generatedAt: new Date().toISOString(),
    seeds,
    meteorTruth: truthTotal,
    meteorDetectedEvents: eventDetected,
    eventRecallPct: +(100 * eventDetected / Math.max(1, truthTotal)).toFixed(1),
    stationObservationRecallPct: +(100 * stationMatched / Math.max(1, stationTotal)).toFixed(1),
    falseAlarms,
    falseAlarmHours: +falseAlarmHours.toFixed(2),
    falseAlarmsPerHour: +faPerHour.toFixed(2),
    radiantMeanOffsetDeg: +radiantMean.toFixed(2),
    radiantMaxOffsetDeg: +radiantMax.toFixed(2),
    heightMeanAbsErrorPct: +mean(heightErrs).toFixed(2),
    heightMaxAbsErrorPct: +max(heightErrs).toFixed(2),
    speedMeanAbsErrorPct: +mean(speedErrs).toFixed(2),
    speedMaxAbsErrorPct: +max(speedErrs).toFixed(2),
    within5PctHeight: within5H.n,
    within5PctSpeed: within5V.n,
    totalTriangulated: within5H.t,
    perShower: [...perShowerMap.entries()].map(([showerId, v]) => ({
      showerId, truth: v.truth, detected: v.detected,
      radiantOffsetDeg: +mean(v.offsets).toFixed(2),
    })),
    acceptance: [],
  };

  report.acceptance = [
    {
      key: 'recall', label: '检测召回率 ≥ 90%', target: '≥90%',
      actual: `${report.eventRecallPct}% (${eventDetected}/${truthTotal})`,
      pass: report.eventRecallPct >= 90,
    },
    {
      key: 'falseAlarm', label: '每小时误报 ≤ 3 个', target: '≤3/h',
      actual: `${report.falseAlarmsPerHour}/h（${falseAlarms} 个 / ${report.falseAlarmHours} 站时；${JSON.stringify(faStationBreakdown)}）`,
      pass: report.falseAlarmsPerHour <= 3,
    },
    {
      key: 'radiant', label: '夜聚合辐射点与公布值相差 ≤ 2°', target: '≤2°',
      actual: `均值 ${report.radiantMeanOffsetDeg}°，最大 ${report.radiantMaxOffsetDeg}°`,
      pass: report.radiantMeanOffsetDeg <= 2 && report.radiantMaxOffsetDeg <= 2,
    },
    {
      key: 'height', label: '高度与参考网络结果相差 ≤ 5%', target: '≤5%',
      actual: `平均 ${report.heightMeanAbsErrorPct}%，最大 ${report.heightMaxAbsErrorPct}%，${within5H.n}/${within5H.t} 达标`,
      pass: within5H.t > 0 && within5H.n / within5H.t >= 0.9,
    },
    {
      key: 'speed', label: '速度与参考网络结果相差 ≤ 5%', target: '≤5%',
      actual: `平均 ${report.speedMeanAbsErrorPct}%，最大 ${report.speedMaxAbsErrorPct}%，${within5V.n}/${within5V.t} 达标`,
      pass: within5V.t > 0 && within5V.n / within5V.t >= 0.9,
    },
  ];

  mkdirSync('src/seed', { recursive: true });
  writeFileSync('src/seed/validation-report.json', JSON.stringify(report, null, 2));
  console.log('\n===== 验证报告 =====');
  for (const a of report.acceptance) console.log(`${a.pass ? 'PASS' : 'FAIL'}  ${a.label}  [${a.target}]  实际：${a.actual}`);
  console.log(`站级观测召回 ${report.stationObservationRecallPct}%  片段内未匹配轨迹 ${unmatchedInClips}`);
  console.log('per shower', JSON.stringify(report.perShower));

  if (CHECK && report.acceptance.some((a) => !a.pass)) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
