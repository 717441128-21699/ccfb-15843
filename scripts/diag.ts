/* 诊断：误报轨迹特征 + 漏检情况 */
import { STATIONS } from '../src/core/stations';
import { generateNight } from '../src/synth/scenario';
import { StationRenderer } from '../src/synth/render';
import { MeteorDetectionPipeline } from '../src/detect/pipeline';
import { calibrateStation } from '../src/calibration/plate';
import { fovDeg } from '../src/geo/camera';

const mode = process.argv[2] ?? 'fp';

if (mode === 'fp') {
  const si = Number(process.argv[3] ?? 2);
  const st0 = STATIONS[si];
  const sc = generateNight({
    nightId: 'diagfp', showerId: 'SPO', epochMs: Date.UTC(2025, 8, 1, 20),
    durationS: 240, meteorCount: 0, meteorFree: true,
    stations: [st0], width: 480, height: 270, fps: 10, seed: 7000 + si, nuisanceLevel: 1.25,
  });
  const st = sc.stations[0];
  const renderer = new StationRenderer(sc, st.id);
  const fov = fovDeg(st.camera);
  const pipe = new MeteorDetectionPipeline({
    stationId: st.id, nightId: 'diagfp', width: 480, height: 270, fps: 10, degPerPx: fov.h / 480,
  });
  for (let i = 0; i < sc.frameCount; i++) pipe.process(renderer.render(i));
  const res = pipe.finish();
  console.log(`station ${st.id} FA tracks: ${res.tracks.length}`);
  for (const t of res.tracks) {
    const obs = t.observations;
    const dur = (obs[obs.length - 1].time - obs[0].time) / 1000;
    const mw = obs.reduce((a, o) => a + (o.width ?? 0), 0) / obs.length;
    const ma = obs.reduce((a, o) => a + o.area, 0) / obs.length;
    const me = obs.reduce((a, o) => a + (o.ecc ?? 0), 0) / obs.length;
    console.log(` ${t.id} n=${obs.length} dur=${dur.toFixed(2)}s speed=${(t.speedPxS * fov.h / 480).toFixed(2)}°/s score=${t.score} frames ${obs[0].frame}..${obs[obs.length - 1].frame} w=${mw.toFixed(1)} area=${ma.toFixed(1)} ecc=${me.toFixed(2)} pos (${obs[0].x | 0},${obs[0].y | 0})->(${obs.at(-1)!.x | 0},${obs.at(-1)!.y | 0}) peak~${Math.max(...obs.map((o) => o.peak)) | 0}`);
  }
  // nuisances near these times
  for (const nz of sc.nuisances) {
    console.log(` nuisance ${nz.kind} f${nz.startFrame}..${nz.endFrame}`);
  }
  // rejected kind counts
  const kinds: Record<string, number> = {};
  for (const r of res.rejected) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  console.log('rejected', kinds, 'total', res.rejected.length);
}

if (mode === 'miss') {
  const W = 640, H = 360, FPS = 15;
  const showerId = process.argv[3] ?? 'LEO';
  const epochMap: Record<string, number> = {
    LEO: Date.UTC(2025, 10, 17, 18, 0, 0),
    PER: Date.UTC(2025, 7, 12, 18, 0, 0),
    GEM: Date.UTC(2025, 11, 14, 17, 0, 0),
    ORI: Date.UTC(2025, 9, 21, 17, 0, 0),
    QUA: Date.UTC(2025, 0, 3, 19, 0, 0),
  };
  const epoch = epochMap[showerId];
  const sc = generateNight({
    nightId: 'diagmiss', showerId, epochMs: epoch, durationS: 55,
    meteorCount: 5, stations: STATIONS, width: W, height: H, fps: FPS, seed: 101 + showerId.length,
  });
  interface StationRun { res: ReturnType<MeteorDetectionPipeline['finish']> }
  const runs: Record<string, StationRun> = {};
  for (const st0 of sc.stations) {
    const renderer = new StationRenderer(sc, st0.id);
    const fov = fovDeg(st0.camera);
    const pipe = new MeteorDetectionPipeline({
      stationId: st0.id, nightId: 'diagmiss', width: W, height: H, fps: FPS, degPerPx: fov.h / W,
    });
    for (let i = 0; i < sc.frameCount; i++) pipe.process(renderer.render(i));
    runs[st0.id] = { res: pipe.finish() };
  }
  for (const gt of sc.meteors) {
    console.log(`\n${gt.id} peak=${gt.peakAdu | 0} conv=${gt.convergenceDeg.toFixed(0)} v=${(gt.speedMS / 1000).toFixed(0)}`);
    for (const st0 of sc.stations) {
      const tf = gt.observations[st0.id] ?? [];
      const map = new Map(tf.map((f) => [f.frame, f]));
      const res = runs[st0.id].res;
      let best: { n: number; med: number; id: string; score: number; mw: number; ma: number; me: number } | null = null;
      for (const tr of res.tracks) {
        const ds: number[] = [];
        for (const o of tr.observations) { const t = map.get(o.frame); if (t) ds.push(Math.hypot(o.x - t.x, o.y - t.y)); }
        if (ds.length < 2) continue;
        ds.sort((a, b) => a - b);
        const med = ds[ds.length >> 1];
        const mw = tr.observations.reduce((a, o) => a + (o.width ?? 0), 0) / tr.observations.length;
        const ma = tr.observations.reduce((a, o) => a + o.area, 0) / tr.observations.length;
        const me = tr.observations.reduce((a, o) => a + (o.ecc ?? 0), 0) / tr.observations.length;
        if (!best || med < best.med) best = { n: ds.length, med, id: tr.id, score: tr.score, mw, ma, me };
      }
      let bestR: { kind: string; reason: string; med: number; n: number } | null = null;
      for (const r of res.rejected) {
        const ds: number[] = [];
        for (const o of r.observations) { const t = map.get(o.frame); if (t) ds.push(Math.hypot(o.x - t.x, o.y - t.y)); }
        if (ds.length < 2) continue;
        ds.sort((a, b) => a - b);
        const med = ds[ds.length >> 1];
        if (med < 25 && (!bestR || med < bestR.med)) bestR = { kind: r.kind, reason: r.reason, med, n: ds.length };
      }
      console.log(`  ${st0.id}: truthFrames=${tf.length} track=${best ? `${best.id} match${best.n} med${best.med.toFixed(1)} score${best.score} w${best.mw.toFixed(1)} area${best.ma.toFixed(0)} ecc${best.me.toFixed(2)}` : 'NONE'} rejected=${bestR ? `${bestR.kind} n${bestR.n} med${bestR.med.toFixed(1)} (${bestR.reason})` : '-'}`);
    }
  }
}
