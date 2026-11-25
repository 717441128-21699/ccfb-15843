// 天文标定：从星场帧提取亮星质心，与真实星表按名义指向匹配，
// 迭代剔除离群点并拟合 6 系数切平面（affine/gnomonic）底片模型。
import type { GrayFrame, PlateSolution, RaDec, Station } from '../core/types';
import { STARS } from '../core/catalog';
import { connectedComponents } from '../detect/components';
import { fitAffine, applyAffine, invertAffine } from '../core/linalg';
import { createRig, projectEnu } from '../geo/camera';
import {
  gmstRad, eciToEcef, raDecToEci, enuBasis, ecefToEnuVec,
  geodeticToEcef, ecefToEci,
} from '../geo/astro';

export interface MatchedStar {
  hip: number;
  nameZh?: string;
  mag: number;
  px: number;
  py: number;
  xi: number;
  eta: number;
  predX: number;
  predY: number;
  residualPx: number;
  ra: number;
  dec: number;
}

export interface CalibrationResult {
  solution: PlateSolution;
  matches: MatchedStar[];
  candidates: number;
}

/** 提取亚像素亮星质心（阈值 = 中位数 + k*MAD 与绝对下限） */
export function extractCentroids(frame: GrayFrame, k = 7): Array<{ x: number; y: number; flux: number; area: number }> {
  const d = frame.data;
  const n = frame.width * frame.height;
  const hist = new Int32Array(256);
  for (let i = 0; i < n; i++) hist[d[i]]++;
  let acc = 0, median = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) { median = v; break; } }
  let madAcc = 0;
  const dev = new Int32Array(256);
  for (let i = 0; i < n; i++) dev[Math.abs(d[i] - median)]++;
  let mad = 0; acc = 0;
  for (let v = 0; v < 256; v++) { acc += dev[v]; if (acc >= n / 2) { mad = v; break; } }
  const sigma = Math.max(1.5, 1.4826 * mad);
  const thr = Math.max(median + 28, median + k * sigma);

  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = d[i] >= thr ? 1 : 0;
  const comps = connectedComponents(frame.width, frame.height, mask, d as unknown as ArrayLike<number>, 2);
  const out: Array<{ x: number; y: number; flux: number; area: number }> = [];
  for (const c of comps) {
    if (c.area > 26) continue; // 排除云/大块
    if (c.x1 - c.x0 > 9 || c.y1 - c.y0 > 9) continue;
    out.push({ x: c.cx, y: c.cy, flux: c.flux, area: c.area });
  }
  return out.sort((a, b) => b.flux - a.flux);
}

/**
 * 执行标定。
 * @param timeMs 标定帧时刻（恒星位置按该时刻计算地平坐标）
 */
export function calibrateStation(
  station: Station,
  frame: GrayFrame,
  timeMs: number,
  opts?: { maxStars?: number; gatePx?: number },
): CalibrationResult {
  const rig = createRig(station.camera);
  const basis = enuBasis(station.location);
  const gmst = gmstRad(timeMs);
  const centroids = extractCentroids(frame).slice(0, opts?.maxStars ?? 220);

  // 星表 -> 名义像素 + 切平面坐标
  interface CatProj {
    hip: number; nameZh?: string; mag: number; ra: number; dec: number;
    x: number; y: number; xi: number; eta: number;
  }
  const cat: CatProj[] = [];
  for (const s of STARS) {
    if (s.mag > 5.0) continue;
    const eci = raDecToEci(s.ra, s.dec);
    const ecef = eciToEcef(eci, gmst);
    const enu = ecefToEnuVec(ecef, basis);
    if (enu[2] < 0.02) continue;
    const z = enu[0] * rig.forward[0] + enu[1] * rig.forward[1] + enu[2] * rig.forward[2];
    if (z <= 0.05) continue;
    const xc = enu[0] * rig.right[0] + enu[1] * rig.right[1] + enu[2] * rig.right[2];
    const yc = enu[0] * rig.up[0] + enu[1] * rig.up[1] + enu[2] * rig.up[2];
    const xi = xc / z, eta = yc / z;
    const px = projectEnu(rig, enu);
    if (!px || px.x < -40 || px.x > frame.width + 40 || px.y < -40 || px.y > frame.height + 40) continue;
    cat.push({ hip: s.hip, nameZh: s.nameZh, mag: s.mag, ra: s.ra, dec: s.dec, x: px.x, y: px.y, xi, eta });
  }

  // 贪心最近邻匹配（质心按亮度顺序），迭代收紧
  const gate = opts?.gatePx ?? 34;
  let pairs: Array<{ c: (typeof centroids)[number]; s: CatProj }> = [];
  const usedCat = new Set<number>();
  for (const c of centroids) {
    let best: CatProj | null = null;
    let bd = gate * gate;
    for (const s of cat) {
      if (usedCat.has(s.hip)) continue;
      const dd = (c.x - s.x) ** 2 + (c.y - s.y) ** 2;
      if (dd < bd) { bd = dd; best = s; }
    }
    if (best) { usedCat.add(best.hip); pairs.push({ c, s: best }); }
  }

  if (pairs.length < 8) {
    throw new Error(`标定星匹配不足：仅 ${pairs.length} 颗（需要 ≥8），检查相机指向与晴朗星帧`);
  }

  let affine: [number, number, number, number, number, number] = [
    1 / station.camera.fx, 0, -station.camera.cx / station.camera.fx,
    0, -1 / station.camera.fy, station.camera.cy / station.camera.fy,
  ];
  let matches: MatchedStar[] = [];

  for (let iter = 0; iter < 4; iter++) {
    affine = fitAffine(pairs.map((p) => ({ sx: p.c.x, sy: p.c.y, dx: p.s.xi, dy: p.s.eta })));
    matches = pairs.map((p) => {
      const [xiH, etaH] = applyAffine(affine, p.c.x, p.c.y);
      // 残差换算回像素：用名义 fx
      const rx = (xiH - p.s.xi) * station.camera.fx;
      const ry = (etaH - p.s.eta) * station.camera.fy;
      return {
        hip: p.s.hip, nameZh: p.s.nameZh, mag: p.s.mag,
        px: p.c.x, py: p.c.y, xi: p.s.xi, eta: p.s.eta,
        predX: p.s.x, predY: p.s.y,
        residualPx: Math.hypot(rx, ry),
        ra: p.s.ra, dec: p.s.dec,
      };
    });
    const rms = Math.sqrt(matches.reduce((a, m) => a + m.residualPx ** 2, 0) / matches.length);
    const lim = iter === 0 ? 6 : Math.max(1.6, 2.2 * rms);
    const kept = pairs.filter((p, i) => matches[i].residualPx <= lim);
    if (kept.length < 8) break;
    if (kept.length === pairs.length && iter > 0) break;
    pairs = kept;
  }

  affine = fitAffine(pairs.map((p) => ({ sx: p.c.x, sy: p.c.y, dx: p.s.xi, dy: p.s.eta })));
  matches = pairs.map((p) => {
    const [xiH, etaH] = applyAffine(affine, p.c.x, p.c.y);
    const rx = (xiH - p.s.xi) * station.camera.fx;
    const ry = (etaH - p.s.eta) * station.camera.fy;
    return {
      hip: p.s.hip, nameZh: p.s.nameZh, mag: p.s.mag,
      px: p.c.x, py: p.c.y, xi: p.s.xi, eta: p.s.eta,
      predX: p.s.x, predY: p.s.y,
      residualPx: Math.hypot(rx, ry), ra: p.s.ra, dec: p.s.dec,
    };
  });

  const rmsPx = Math.sqrt(matches.reduce((a, m) => a + m.residualPx ** 2, 0) / matches.length);
  // 底片比例尺：affine 中 x 系数模长（无量纲/px）-> 角秒/px
  const scaleRadPx = Math.hypot(affine[0], affine[3]);
  const plateScaleArcsecPx = scaleRadPx * (180 / Math.PI) * 3600;
  const rmsArcsec = rmsPx * plateScaleArcsecPx;

  const solution: PlateSolution = {
    stationId: station.id,
    calibratedAt: timeMs,
    matchedStars: matches.length,
    rmsPx: +rmsPx.toFixed(3),
    rmsArcsec: +rmsArcsec.toFixed(1),
    plateScaleArcsecPx: +plateScaleArcsecPx.toFixed(1),
    affine,
    boresightAz: station.camera.az,
    boresightAlt: station.camera.alt,
    fx: station.camera.fx,
    fy: station.camera.fy,
    cx: station.camera.cx,
    cy: station.camera.cy,
  };
  return { solution, matches, candidates: centroids.length };
}

/** 像素 -> ENU 单位射线（使用标定 affine 反投影） */
export function pixelToEnuRay(sol: PlateSolution, station: Station, x: number, y: number): [number, number, number] {
  const inv = invertAffine(sol.affine);
  // inv maps (xi,eta)? 注意 invertAffine 返回像素 = f(xi,eta)。
  // 我们需要的是 (xi,eta)=affine(x,y) 直接可得，无需逆。
  void inv;
  const [xi, eta] = applyAffine(sol.affine, x, y);
  const rig = createRig(station.camera);
  let v: [number, number, number] = [
    rig.forward[0] + xi * rig.right[0] + eta * rig.up[0],
    rig.forward[1] + xi * rig.right[1] + eta * rig.up[1],
    rig.forward[2] + xi * rig.right[2] + eta * rig.up[2],
  ];
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** 像素 -> ECEF 单位射线 */
export function pixelToEcefRay(sol: PlateSolution, station: Station, x: number, y: number): [number, number, number] {
  const enu = pixelToEnuRay(sol, station, x, y);
  const basis = enuBasis(station.location);
  // ENU vector -> ECEF rotation (transpose of ecefToEnu)
  return [
    enu[0] * basis.east[0] + enu[1] * basis.north[0] + enu[2] * basis.up[0],
    enu[0] * basis.east[1] + enu[1] * basis.north[1] + enu[2] * basis.up[1],
    enu[0] * basis.east[2] + enu[1] * basis.north[2] + enu[2] * basis.up[2],
  ];
}

/** 像素 + 时刻 -> RA/Dec */
export function pixelToRaDec(sol: PlateSolution, station: Station, timeMs: number, x: number, y: number): RaDec {
  const rayEcef = pixelToEcefRay(sol, station, x, y);
  const eci = ecefToEci(rayEcef, gmstRad(timeMs));
  const dec = Math.asin(Math.max(-1, Math.min(1, eci[2]))) * 180 / Math.PI;
  let ra = Math.atan2(eci[1], eci[0]) * 180 / Math.PI;
  if (ra < 0) ra += 360;
  return { ra, dec };
}

/** 把一条像素轨迹全部转成赤道观测 */
export function trackToEquatorial(
  sol: PlateSolution,
  station: Station,
  obs: Array<{ x: number; y: number; time: number; frame: number }>,
) {
  return obs.map((o) => ({
    ...pixelToRaDec(sol, station, o.time, o.x, o.y),
    time: o.time, frame: o.frame, x: o.x, y: o.y, stationId: station.id,
  }));
}

export { geodeticToEcef };
