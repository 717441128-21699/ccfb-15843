// 带真值的多站流星场景合成：
// 按流星群公布辐射点 + 速度生成 ECEF 三维轨迹，再投影到各站相机，
// 只保留至少两站有足够帧、交会几何良好的流星。
import type { LngLatAlt, RaDec, Station } from '../core/types';
import { SHOWERS } from '../core/showers';
import { Rng } from '../core/random';
import {
  D2R, gmstRad, eciToEcef, raDecToEci, geodeticToEcef, ecefToGeodetic,
  enuBasis, ecefToEnuVec,
} from '../geo/astro';
import { createRig, projectEnu } from '../geo/camera';
import { COMMON_VOLUME } from '../core/stations';

export interface FrameTruth {
  frame: number;
  time: number;
  x: number;
  y: number;
}

export interface MeteorTruth {
  id: string;
  showerId: string;
  seed: number;
  startMs: number;
  endMs: number;
  begin: LngLatAlt;
  end: LngLatAlt;
  pBegin: [number, number, number];
  vEcef: [number, number, number];
  speedMS: number;
  radiantTrue: RaDec;
  peakAdu: number;
  observations: Record<string, FrameTruth[]>;
  convergenceDeg: number;
}

export interface NuisanceSpec {
  kind: 'aircraft' | 'satellite' | 'insect' | 'lightning';
  stationId: string;
  startFrame: number;
  endFrame: number;
  // 像素空间关键参数
  x0?: number; y0?: number; x1?: number; y1?: number;
  speed?: number;
  sigma?: number;
  peak?: number;
  phase?: number;
  path?: Array<{ x: number; y: number }>;
  flashes?: number[];
}

export interface Scenario {
  id: string;
  nightId: string;
  showerId: string;
  epochMs: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  stations: Station[];
  meteors: MeteorTruth[];
  nuisances: NuisanceSpec[];
  rngSeed: number;
}

export interface GenerateNightOptions {
  nightId: string;
  showerId: string;
  epochMs: number;
  durationS: number;
  meteorCount: number;
  stations: Station[];
  width: number;
  height: number;
  fps: number;
  seed: number;
  /** 每站每分钟 nuisance 密度倍率 */
  nuisanceLevel?: number;
  /** 只生成无流星的干扰视频（误报测试） */
  meteorFree?: boolean;
}

function scaledStation(st: Station, width: number, height: number, fps: number): Station {
  if (st.camera.width === width && st.camera.height === height && st.camera.fps === fps) return st;
  const sx = width / st.camera.width;
  return {
    ...st,
    camera: {
      ...st.camera,
      width, height, fps,
      fx: st.camera.fx * sx,
      fy: st.camera.fy * sx,
      cx: width / 2,
      cy: height / 2,
    },
  };
}

/** 沿 p(t)=p0+v*t 求高度降到 targetAlt 时的秒数（二分） */
function timeToAltitude(
  p0: [number, number, number],
  v: [number, number, number],
  targetAlt: number,
  maxT: number,
): number | null {
  const altAt = (t: number) => ecefToGeodetic(p0[0] + v[0] * t, p0[1] + v[1] * t, p0[2] + v[2] * t).alt;
  if (altAt(maxT) > targetAlt) return null;
  let lo = 0, hi = maxT;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (altAt(mid) > targetAlt) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function generateNight(opts: GenerateNightOptions): Scenario {
  const rng = new Rng(opts.seed);
  const shower = SHOWERS.find((s) => s.id === opts.showerId) ?? SHOWERS[SHOWERS.length - 1];
  const stations = opts.stations.map((s) => scaledStation(s, opts.width, opts.height, opts.fps));
  const frameCount = Math.floor(opts.durationS * opts.fps);
  const meteors: MeteorTruth[] = [];
  const nuisances: NuisanceSpec[] = [];

  if (!opts.meteorFree) {
    let attempts = 0;
    let midx = 0;
    while (meteors.length < opts.meteorCount && attempts < opts.meteorCount * 80) {
      attempts++;
      const m = tryMeteor({
        rng, showerId: shower.id, epochMs: opts.epochMs, durationS: opts.durationS,
        stations, fps: opts.fps, width: opts.width, height: opts.height,
        seedBase: opts.seed * 1000 + midx * 97 + attempts,
        index: midx,
      });
      if (m) { meteors.push(m); midx++; }
    }
  }

  // 干扰目标
  const level = opts.nuisanceLevel ?? 1;
  for (const st of stations) {
    nuisances.push(...generateNuisances(rng, st.id, frameCount, opts.fps, opts.width, level, opts.meteorFree ?? false));
  }

  return {
    id: `SC-${opts.nightId}`,
    nightId: opts.nightId,
    showerId: shower.id,
    epochMs: opts.epochMs,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    frameCount,
    stations,
    meteors,
    nuisances,
    rngSeed: opts.seed,
  };
}

interface TryArgs {
  rng: Rng;
  showerId: string;
  epochMs: number;
  durationS: number;
  stations: Station[];
  fps: number;
  width: number;
  height: number;
  seedBase: number;
  index: number;
}

function tryMeteor(a: TryArgs): MeteorTruth | null {
  const rng = new Rng(a.seedBase >>> 0);
  const shower = SHOWERS.find((s) => s.id === a.showerId)!;
  // 事件时刻：在整段时间内随机，但避开最前 1.2s（背景初始化）
  const relS = rng.range(1.4, Math.max(1.6, a.durationS - 1.2));
  const tAbs = a.epochMs + relS * 1000;

  // 辐射点加弥散（约 0.7°，单位为度）
  const jitR = Math.abs(rng.gauss(0, 0.75));
  const jitAng = rng.range(0, Math.PI * 2);
  const ra = shower.ra + (Math.cos(jitAng) * jitR) / Math.max(0.35, Math.cos(shower.dec * D2R));
  const dec = shower.dec + Math.sin(jitAng) * jitR;
  const speedKms = Math.max(18, shower.vg + rng.gauss(0, 2.5));

  // 入射起点：公共区域附近
  const beginGeo: LngLatAlt = {
    lat: COMMON_VOLUME.lat + rng.gauss(0, 0.22),
    lng: COMMON_VOLUME.lng + rng.gauss(0, 0.28),
    alt: rng.range(102_000, 118_000),
  };
  const pBegin = geodeticToEcef(beginGeo);

  const radiantTrue = { ra: ((ra % 360) + 360) % 360, dec };
  const rEci = raDecToEci(radiantTrue.ra, radiantTrue.dec);
  const vEci: [number, number, number] = [-rEci[0] * speedKms * 1000, -rEci[1] * speedKms * 1000, -rEci[2] * speedKms * 1000];
  const gmst = gmstRad(tAbs);
  const vEcef = eciToEcef(vEci, gmst);

  // 下降方向检查
  const bEcef = geodeticToEcef(beginGeo);
  const enu0 = ecefToEnuVec(vEcef, enuBasis(beginGeo));
  if (enu0[2] >= -8) return null; // 几乎不平飞/上升
  const elev = Math.asin(Math.max(-1, Math.min(1, enu0[2] / Math.hypot(enu0[0], enu0[1], enu0[2])))) / D2R;
  if (elev > -8 || elev < -75) return null;

  const endAlt = rng.range(77_000, 88_000);
  const dur = timeToAltitude(pBegin, vEcef, endAlt, 2.2);
  if (dur == null || dur < 0.22 || dur > 1.7) return null;
  const endT = relS + dur;
  if (endT > a.durationS - 0.3) return null;

  const pEnd: [number, number, number] = [pBegin[0] + vEcef[0] * dur, pBegin[1] + vEcef[1] * dur, pBegin[2] + vEcef[2] * dur];
  const endGeo = ecefToGeodetic(pEnd[0], pEnd[1], pEnd[2]);

  // 各站投影
  const observations: Record<string, FrameTruth[]> = {};
  const midPoint: [number, number, number] = [(pBegin[0] + pEnd[0]) / 2, (pBegin[1] + pEnd[1]) / 2, (pBegin[2] + pEnd[2]) / 2];
  const losByStation: Array<{ id: string; ray: [number, number, number] }> = [];
  let goodStations = 0;
  let totalPathPx = 0;
  for (const st of a.stations) {
    const rig = createRig(st.camera);
    const sEcef = geodeticToEcef(st.location);
    const frames: FrameTruth[] = [];
    const f0 = Math.ceil((relS - a.epochMs / 1000 + a.epochMs / 1000) * a.fps); // 仅相对秒
    void f0;
    const iStart = Math.round(relS * a.fps);
    const iEnd = Math.round(endT * a.fps);
    for (let fi = iStart; fi <= iEnd; fi++) {
      const tS = fi / a.fps; // 帧时刻相对 epoch（帧中心近似 fi/fps）
      if (tS < relS - 0.02 || tS > endT + 0.02) continue;
      const tau = Math.max(0, Math.min(dur, tS - relS));
      const p: [number, number, number] = [pBegin[0] + vEcef[0] * tau, pBegin[1] + vEcef[1] * tau, pBegin[2] + vEcef[2] * tau];
      const dEcef: [number, number, number] = [p[0] - sEcef[0], p[1] - sEcef[1], p[2] - sEcef[2]];
      const dist = Math.hypot(dEcef[0], dEcef[1], dEcef[2]);
      const enu = ecefToEnuVec([dEcef[0] / dist, dEcef[1] / dist, dEcef[2] / dist], enuBasis(st.location));
      const px = projectEnu(rig, enu);
      if (px && px.x > 14 && px.x < a.width - 14 && px.y > 14 && px.y < a.height - 14) {
        frames.push({ frame: fi, time: a.epochMs + (fi / a.fps) * 1000, x: px.x, y: px.y });
      }
    }
    observations[st.id] = frames;
    if (frames.length >= 4) {
      goodStations++;
      const first = frames[0], last = frames[frames.length - 1];
      totalPathPx += Math.hypot(last.x - first.x, last.y - first.y);
      const dEcef: [number, number, number] = [midPoint[0] - sEcef[0], midPoint[1] - sEcef[1], midPoint[2] - sEcef[2]];
      const dn = Math.hypot(...dEcef);
      losByStation.push({ id: st.id, ray: [dEcef[0] / dn, dEcef[1] / dn, dEcef[2] / dn] });
    }
  }
  if (goodStations < 2) return null;
  if (totalPathPx / goodStations < 26) return null;

  // 交会角：两站在目标处的视线夹角
  let convergenceDeg = 0;
  if (losByStation.length >= 2) {
    let bestConv = 0;
    for (let i = 0; i < losByStation.length; i++) {
      for (let j = i + 1; j < losByStation.length; j++) {
        const dot = losByStation[i].ray[0] * losByStation[j].ray[0] + losByStation[i].ray[1] * losByStation[j].ray[1] + losByStation[i].ray[2] * losByStation[j].ray[2];
        const ang = Math.acos(Math.max(-1, Math.min(1, dot))) / D2R;
        if (ang > bestConv) bestConv = ang;
      }
    }
    convergenceDeg = bestConv;
  }
  if (convergenceDeg < 8) return null;

  // 峰值亮度：覆盖从暗到亮，约 18% 较暗
  const faint = rng.next() < 0.2;
  const peakAdu = faint ? rng.range(52, 82) : rng.range(95, 235);

  return {
    id: `GT-${a.showerId}-${String(a.index + 1).padStart(2, '0')}`,
    showerId: a.showerId,
    seed: a.seedBase,
    startMs: a.epochMs + relS * 1000,
    endMs: a.epochMs + endT * 1000,
    begin: beginGeo,
    end: endGeo,
    pBegin,
    vEcef,
    speedMS: speedKms * 1000,
    radiantTrue,
    peakAdu,
    observations,
    convergenceDeg,
  };
}

function generateNuisances(
  rng: Rng,
  stationId: string,
  frameCount: number,
  fps: number,
  width: number,
  level: number,
  meteorFree: boolean,
): NuisanceSpec[] {
  const out: NuisanceSpec[] = [];
  const minutes = frameCount / fps / 60;
  const scale = width / 800;

  const nPlane = Math.round(minutes * (meteorFree ? 0.55 : 0.35) * level);
  for (let i = 0; i < nPlane; i++) {
    // 真实飞机在广角监控中的角速度约 0.4-1.7°/s（4-18 px/s @800）
    const speed = rng.range(4, 17) * scale;
    const durS = rng.range(12, 42);
    const start = rng.int(0, Math.max(1, frameCount - durS * fps - 2));
    const edge = rng.int(0, 3);
    let x0: number, y0: number, ang: number;
    if (edge === 0) { x0 = -20; y0 = rng.range(40, 320) * scale; ang = rng.gauss(0, 0.25); }
    else if (edge === 1) { x0 = width + 20; y0 = rng.range(40, 320) * scale; ang = Math.PI + rng.gauss(0, 0.25); }
    else if (edge === 2) { y0 = -20; x0 = rng.range(40, width - 40); x0 = x0; y0 = -20; ang = Math.PI / 2 + rng.gauss(0, 0.3); }
    else { y0 = 470 * scale + 20; x0 = rng.range(40, width - 40); ang = -Math.PI / 2 + rng.gauss(0, 0.3); }
    const len = speed * durS;
    out.push({
      kind: 'aircraft', stationId, startFrame: start, endFrame: start + Math.floor(durS * fps),
      x0, y0, x1: x0 + Math.cos(ang) * len, y1: y0 + Math.sin(ang) * len,
      phase: rng.range(0, 10), peak: rng.range(120, 210),
    });
  }

  const nSat = Math.round(minutes * (meteorFree ? 1.4 : 0.8) * level);
  for (let i = 0; i < nSat; i++) {
    // 卫星/ISS 类似：0.15-1.0°/s（1.5-10.5 px/s @800）
    const speed = rng.range(1.6, 10.5) * scale;
    const durS = rng.range(14, 55);
    const start = rng.int(0, Math.max(1, frameCount - durS * fps - 2));
    const y = rng.range(30, 420) * scale;
    const ltr = rng.next() < 0.5;
    const x0 = ltr ? -15 : width + 15;
    const dir = ltr ? 1 : -1;
    const len = speed * durS;
    out.push({
      kind: 'satellite', stationId, startFrame: start, endFrame: start + Math.floor(durS * fps),
      x0, y0: y, x1: x0 + dir * len, y1: y + rng.gauss(0, 26 * scale),
      peak: rng.range(42, 88), sigma: rng.range(0.8, 1.2), phase: rng.range(0, 6),
    });
  }

  const nBug = Math.round(minutes * (meteorFree ? 1.1 : 0.7) * level);
  for (let i = 0; i < nBug; i++) {
    const durS = rng.range(0.5, 2.6);
    const start = rng.int(2, Math.max(3, frameCount - durS * fps - 2));
    const cx = rng.range(60, width - 60);
    const cy = rng.range(60, 400 * scale);
    const baseAng = rng.range(0, Math.PI * 2);
    const sp = rng.range(28, 120) * scale;
    const n = Math.floor(durS * fps);
    const path: Array<{ x: number; y: number }> = [];
    let x = cx, y = cy, ang = baseAng;
    for (let f = 0; f <= n; f++) {
      path.push({ x, y });
      ang += rng.gauss(0, 0.55);
      x += Math.cos(ang) * sp / fps + rng.gauss(0, 3 * scale);
      y += Math.sin(ang) * sp / fps + rng.gauss(0, 3 * scale);
    }
    out.push({
      kind: 'insect', stationId, startFrame: start, endFrame: start + n,
      path, sigma: rng.range(4.5, 8.5) * Math.max(0.62, scale), peak: rng.range(55, 120),
    });
  }

  const nLight = Math.round(minutes * (meteorFree ? 0.22 : 0.12) * level);
  for (let i = 0; i < nLight; i++) {
    const start = rng.int(10, Math.max(11, frameCount - 6));
    out.push({
      kind: 'lightning', stationId, startFrame: start,
      endFrame: start + rng.int(1, 4),
      flashes: [start, start + 1],
      peak: rng.range(45, 95), phase: rng.range(0, 100),
    });
  }

  return out;
}
