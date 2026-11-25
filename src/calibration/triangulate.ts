// 多站视线交会：把每条像素观测转成 ECEF 射线，
// 联合最小二乘拟合 X(t)=p0+v*(t-t0)/1000，再算高度/速度/辐射点。
import type { PlateSolution, Station, TrajectorySolution } from '../core/types';
import { pixelToEcefRay } from '../calibration/plate';
import { createLS6, addRow6, solveLS6 } from '../core/linalg';
import { geodeticToEcef, ecefToGeodetic, gmstRad, ecefToEci, eciToRaDec } from '../geo/astro';

export interface RayObs {
  stationId: string;
  station: Station;
  sol: PlateSolution;
  x: number;
  y: number;
  time: number;
}

function skewRows(u: [number, number, number]): number[][] {
  // [u]_x 的三行
  return [
    [0, -u[2], u[1]],
    [u[2], 0, -u[0]],
    [-u[1], u[0], 0],
  ];
}

export function solveTrajectory(obs: RayObs[]): TrajectorySolution {
  if (obs.length < 4) throw new Error('交会观测数不足');
  const tRef = obs.reduce((a, o) => a + o.time, 0) / obs.length;
  const ls = createLS6();

  const cache = obs.map((o) => {
    const u = pixelToEcefRay(o.sol, o.station, o.x, o.y);
    const S: [number, number, number] = [
      // 测站 ECEF
      ...stationEcef(o.station),
    ];
    const tau = (o.time - tRef) / 1000;
    return { o, u, S, tau };
  });

  for (const { u, S, tau } of cache) {
    const K = skewRows(u);
    for (let r = 0; r < 3; r++) {
      // [K, tau K] z = K S
      const row = [
        K[r][0], K[r][1], K[r][2],
        tau * K[r][0], tau * K[r][1], tau * K[r][2],
      ];
      const b = K[r][0] * S[0] + K[r][1] * S[1] + K[r][2] * S[2];
      addRow6(ls, row, b, 1);
    }
  }

  const z = solveLS6(ls);
  const p0: [number, number, number] = [z[0], z[1], z[2]];
  const vEcef: [number, number, number] = [z[3], z[4], z[5]];
  const speedMS = Math.hypot(vEcef[0], vEcef[1], vEcef[2]);

  // 残差
  let ss = 0, maxR = 0;
  const stationIds = new Set<string>();
  for (const { o, u, S, tau } of cache) {
    stationIds.add(o.stationId);
    const X = [p0[0] + vEcef[0] * tau, p0[1] + vEcef[1] * tau, p0[2] + vEcef[2] * tau] as const;
    const w = [X[0] - S[0], X[1] - S[1], X[2] - S[2]];
    // |w × u|
    const cx = w[1] * u[2] - w[2] * u[1];
    const cy = w[2] * u[0] - w[0] * u[2];
    const cz = w[0] * u[1] - w[1] * u[0];
    const r = Math.hypot(cx, cy, cz);
    ss += r * r;
    if (r > maxR) maxR = r;
  }
  const rmsResidualM = Math.sqrt(ss / cache.length);

  // 起终点（按观测时间范围）
  let tMin = Infinity, tMax = -Infinity;
  for (const o of obs) { tMin = Math.min(tMin, o.time); tMax = Math.max(tMax, o.time); }
  const beginTau = (tMin - tRef) / 1000;
  const endTau = (tMax - tRef) / 1000;
  const bEcef: [number, number, number] = [p0[0] + vEcef[0] * beginTau, p0[1] + vEcef[1] * beginTau, p0[2] + vEcef[2] * beginTau];
  const eEcef: [number, number, number] = [p0[0] + vEcef[0] * endTau, p0[1] + vEcef[1] * endTau, p0[2] + vEcef[2] * endTau];
  const beginGeo = ecefToGeodetic(...bEcef);
  const endGeo = ecefToGeodetic(...eEcef);

  // 辐射点：-v 从 ECEF 转 ECI
  const gmst = gmstRad(tRef);
  const vEci = ecefToEci(vEcef, gmst);
  const radiant = eciToRaDec([-vEci[0], -vEci[1], -vEci[2]]);

  // 交会角：目标中点处各站方向的两两夹角最大值
  const mid = [(bEcef[0] + eEcef[0]) / 2, (bEcef[1] + eEcef[1]) / 2, (bEcef[2] + eEcef[2]) / 2];
  const dirs: number[][] = [];
  for (const id of stationIds) {
    const st = obs.find((o) => o.stationId === id)!.station;
    const S = stationEcef(st);
    const d = [S[0] - mid[0], S[1] - mid[1], S[2] - mid[2]];
    const n = Math.hypot(d[0], d[1], d[2]);
    dirs.push([d[0] / n, d[1] / n, d[2] / n]);
  }
  let convergenceDeg = 0;
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      const dot = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1] + dirs[i][2] * dirs[j][2];
      convergenceDeg = Math.max(convergenceDeg, Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI);
    }
  }

  return {
    t0: tRef,
    p0,
    vEcef,
    speedMS,
    begin: { ...beginGeo, time: tMin },
    end: { ...endGeo, time: tMax },
    radiant,
    rmsResidualM: +rmsResidualM.toFixed(1),
    maxResidualM: +maxR.toFixed(1),
    stationCount: stationIds.size,
    observationCount: obs.length,
    convergenceDeg: +convergenceDeg.toFixed(2),
  };
}

const ecefCache = new WeakMap<Station, [number, number, number]>();
function stationEcef(st: Station): [number, number, number] {
  let v = ecefCache.get(st);
  if (!v) {
    v = geodeticToEcef(st.location);
    ecefCache.set(st, v);
  }
  return v;
}
