/* 快速冒烟：单夜小场景，打印全链路情况，供调参 */
import { STATIONS } from '../src/core/stations';
import { generateNight } from '../src/synth/scenario';
import { StationRenderer } from '../src/synth/render';
import { MeteorDetectionPipeline } from '../src/detect/pipeline';
import { calibrateStation } from '../src/calibration/plate';
import { reconstructMeteors } from '../src/calibration/reconstruct';
import { fovDeg } from '../src/geo/camera';

const W = 640, H = 360, FPS = 15;
const epoch = Date.UTC(2025, 7, 12, 18, 0, 0);

const sc = generateNight({
  nightId: 'smoke', showerId: 'PER', epochMs: epoch, durationS: 45,
  meteorCount: 6, stations: STATIONS, width: W, height: H, fps: FPS, seed: 20260813,
});

console.log(`scenario meteors=${sc.meteors.length} nuisances=${sc.nuisances.length}`);
for (const m of sc.meteors) {
  const vis = Object.entries(m.observations).map(([id, o]) => `${id}:${o.length}f`).join(' ');
  console.log(`  ${m.id} conv=${m.convergenceDeg.toFixed(1)}° peak=${m.peakAdu | 0} ${vis}`);
}

const bundles = [];
for (const st of sc.stations) {
  const renderer = new StationRenderer(sc, st.id);
  // 标定
  const calFrame = renderer.renderCalibration(epoch + 5000);
  let cal;
  try {
    cal = calibrateStation(st, calFrame, epoch + 5000);
    console.log(`[${st.id}] cal stars=${cal.solution.matchedStars} rms=${cal.solution.rmsPx}px ${cal.solution.rmsArcsec}" scale=${cal.solution.plateScaleArcsecPx}"/px candidates=${cal.candidates}`);
  } catch (e) {
    console.log(`[${st.id}] CAL FAIL`, (e as Error).message);
    continue;
  }
  const fov = fovDeg(st.camera);
  const pipe = new MeteorDetectionPipeline({
    stationId: st.id, nightId: 'smoke', width: W, height: H, fps: FPS,
    degPerPx: fov.h / W,
  });
  let t0 = Date.now();
  for (let i = 0; i < sc.frameCount; i++) {
    const f = renderer.render(i);
    pipe.process(f);
  }
  const res = pipe.finish();
  console.log(`[${st.id}] tracks=${res.tracks.length} rejected=${res.rejected.length} frames=${res.framesProcessed} ${(Date.now() - t0)}ms`);
  for (const t of res.tracks) {
    console.log(`    MET ${t.id} obs=${t.observations.length} score=${t.score} speed=${(t.speedPxS * fov.h / W).toFixed(1)}°/s`);
  }
  const kinds: Record<string, number> = {};
  for (const r of res.rejected) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  console.log('    rejected kinds', kinds);
  bundles.push({ station: st, solution: cal.solution, tracks: res.tracks });
}

const mets = reconstructMeteors(bundles, { nightId: 'smoke', dateMs: epoch });
console.log(`\nreconstructed ${mets.length} meteors`);
for (const m of mets) {
  const gt = sc.meteors.find((g) => Math.abs(g.startMs - (m.trajectory?.begin.time ?? 0)) < 1500);
  let cmp = '';
  if (gt) {
    const hErr = Math.abs(m.beginHeightKm - gt.begin.alt / 1000) / (gt.begin.alt / 1000) * 100;
    const vErr = Math.abs(m.speedKms - gt.speedMS / 1000) / (gt.speedMS / 1000) * 100;
    cmp = ` | GT h=${(gt.begin.alt / 1000).toFixed(1)} v=${(gt.speedMS / 1000).toFixed(1)} errs h=${hErr.toFixed(1)}% v=${vErr.toFixed(1)}%`;
  }
  console.log(`  ${m.id} ${m.showerId} h=${m.beginHeightKm}->${m.endHeightKm} v=${m.speedKms} rad=${m.radiant.ra.toFixed(1)},${m.radiant.dec.toFixed(1)} off=${m.radiantOffsetDeg}° st=${m.stationCount} rms=${m.trajectory?.rmsResidualM}m conv=${m.convergenceDeg}${cmp}`);
}
