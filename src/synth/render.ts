// 把 Scenario 逐帧渲染成灰度视频：真实星表位置 + 高斯 PSF + 传感器噪声，
// 以及流星拖尾 / 飞机 / 卫星 / 飞虫 / 闪电。Node 与浏览器 Worker 共用。
import type { GrayFrame, Station } from '../core/types';
import type { Scenario, NuisanceSpec, MeteorTruth } from './scenario';
import { STARS, type CatalogStar } from '../core/catalog';
import {
  gmstRad, eciToEcef, raDecToEci, geodeticToEcef, ecefToEnuVec, enuBasis,
} from '../geo/astro';
import { createRig, projectEnu, type CameraRig } from '../geo/camera';
import { Rng } from '../core/random';

interface RenderStar {
  s: CatalogStar;
  eci: [number, number, number];
  amp: number;
  sigma: number;
}

// 高斯噪声查找表
function makeGaussLut(seed: number): Float32Array {
  const rng = new Rng(seed);
  const lut = new Float32Array(2048);
  for (let i = 0; i < lut.length; i++) lut[i] = rng.gauss(0, 1);
  return lut;
}

export class StationRenderer {
  sc: Scenario;
  station: Station;
  rig: CameraRig;
  buf: Uint8Array;
  frame: GrayFrame;
  private stars: RenderStar[];
  private gradient: Float32Array;
  private lut = makeGaussLut(20260813);
  private prngState = { s: 987654321 };
  private frameNuisance: NuisanceSpec[][] = [];

  constructor(sc: Scenario, stationId: string, noiseSigma = 5.2) {
    this.sc = sc;
    const st = sc.stations.find((s) => s.id === stationId)!;
    this.station = st;
    this.rig = createRig(st.camera);
    this.buf = new Uint8Array(sc.width * sc.height);
    this.frame = { width: sc.width, height: sc.height, data: this.buf, time: sc.epochMs, index: 0 };

    // 星等 -> PSF 中心振幅（合成相机响应）：
    // 0 等亮星接近饱和，3 等约 60ADU，5 等约 10ADU（单帧微弱、叠加后可标定）
    this.stars = STARS.filter((s) => s.mag <= 5.3).map((s) => ({
      s,
      eci: raDecToEci(s.ra, s.dec),
      amp: 820 * Math.pow(10, -0.4 * (s.mag - 0.15)),
      sigma: s.mag < 1.5 ? 1.25 : s.mag < 3 ? 1.05 : 0.85,
    }));

    // 天空基底：顶部 16 -> 地平线附近 42，加一点径向暗角
    this.gradient = new Float32Array(sc.width * sc.height);
    for (let y = 0; y < sc.height; y++) {
      const ty = y / sc.height;
      const rowBase = 16 + 26 * Math.pow(ty, 1.7);
      for (let x = 0; x < sc.width; x++) {
        const dx = (x / sc.width - 0.5) * 1.4;
        const vig = 1 - 0.18 * Math.min(1, dx * dx + (ty - 0.4) ** 2);
        this.gradient[y * sc.width + x] = rowBase * vig + 3;
      }
    }
    this.noiseSigma = noiseSigma;

    // 按起始帧索引干扰
    this.frameNuisance = new Array(sc.frameCount);
    for (let i = 0; i < sc.frameCount; i++) this.frameNuisance[i] = [];
    for (const nz of sc.nuisances) {
      if (nz.stationId !== stationId) continue;
      for (let f = Math.max(0, nz.startFrame); f <= Math.min(sc.frameCount - 1, nz.endFrame); f++) {
        this.frameNuisance[f].push(nz);
      }
    }
  }

  noiseSigma: number;

  /** 渲染一帧；返回的 GrayFrame 内部缓冲会被下一帧复用 */
  render(index: number): GrayFrame {
    const { width: w, height: h } = this.sc;
    const d = this.buf;
    const tMs = this.sc.epochMs + (index / this.sc.fps) * 1000;
    const gmst = gmstRad(tMs);
    const basis = enuBasis(this.station.location);
    const sEcef = geodeticToEcef(this.station.location);
    void sEcef;

    // 1) 基底 + 噪声
    const lut = this.lut;
    let ps = this.prngState.s >>> 0 || 1;
    for (let i = 0; i < w * h; i++) {
      ps ^= ps << 13; ps >>>= 0; ps ^= ps >> 17; ps ^= ps << 5; ps >>>= 0;
      const g = lut[ps & 2047];
      let v = this.gradient[i] + g * this.noiseSigma;
      d[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
    this.prngState.s = ps || 1;

    // 2) 恒星
    for (const rs of this.stars) {
      const ex = eciToEcef(rs.eci, gmst);
      const enu = ecefToEnuVec(ex, basis);
      if (enu[2] <= 0.01) continue;
      const px = projectEnu(this.rig, enu);
      if (!px || px.x < -6 || px.x > w + 6 || px.y < -6 || px.y > h + 6) continue;
      this.stamp(px.x, px.y, rs.sigma, rs.amp);
    }

    // 3) 干扰
    for (const nz of this.frameNuisance[index] ?? []) {
      this.renderNuisance(nz, index, tMs);
    }

    // 4) 流星
    for (const m of this.sc.meteors) {
      if (tMs < m.startMs - 30 || tMs > m.endMs + 30) continue;
      this.renderMeteor(m, tMs, index);
    }

    this.frame.time = tMs;
    this.frame.index = index;
    return this.frame;
  }

  /** 标定用干净星场（多帧平均思想：直接提高暗星振幅，无移动目标） */
  renderCalibration(timeMs: number): GrayFrame {
    const { width: w, height: h } = this.sc;
    const d = this.buf;
    const gmst = gmstRad(timeMs);
    const basis = enuBasis(this.station.location);
    for (let i = 0; i < w * h; i++) d[i] = this.gradient[i] | 0;
    for (const rs of this.stars) {
      const ex = eciToEcef(rs.eci, gmst);
      const enu = ecefToEnuVec(ex, basis);
      if (enu[2] <= 0.01) continue;
      const px = projectEnu(this.rig, enu);
      if (!px || px.x < -8 || px.x > w + 8 || px.y < -8 || px.y > h + 8) continue;
      // 标定帧为多帧叠加/长曝光，等效增益更高、无随机噪声
      this.stamp(px.x, px.y, rs.sigma * 0.9, rs.amp * 3.2);
    }
    this.frame.time = timeMs;
    this.frame.index = 0;
    return this.frame;
  }

  private stamp(x: number, y: number, sigma: number, peak: number) {
    const d = this.buf;
    const w = this.sc.width, h = this.sc.height;
    const r = Math.max(1, Math.ceil(sigma * 3));
    const xi = Math.round(x), yi = Math.round(y);
    const inv2s2 = 1 / (2 * sigma * sigma);
    for (let oy = -r; oy <= r; oy++) {
      const yy = yi + oy;
      if (yy < 0 || yy >= h) continue;
      for (let ox = -r; ox <= r; ox++) {
        const xx = xi + ox;
        if (xx < 0 || xx >= w) continue;
        const dd = (xx - x) ** 2 + (yy - y) ** 2;
        const add = peak * Math.exp(-dd * inv2s2);
        const i = yy * w + xx;
        const v = d[i] + add;
        d[i] = v > 255 ? 255 : v;
      }
    }
  }

  private line(x0: number, y0: number, x1: number, y1: number, sigma: number, peak: number) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len / 0.7));
    for (let i = 0; i <= steps; i++) {
      const q = i / steps;
      this.stamp(x0 + (x1 - x0) * q, y0 + (y1 - y0) * q, sigma, peak * 0.55);
    }
  }

  private meteorPosition(m: MeteorTruth, tMs: number): [number, number, number] {
    const tau = Math.max(0, Math.min((m.endMs - m.startMs) / 1000, (tMs - m.startMs) / 1000));
    return [m.pBegin[0] + m.vEcef[0] * tau, m.pBegin[1] + m.vEcef[1] * tau, m.pBegin[2] + m.vEcef[2] * tau];
  }

  private projectWorld(p: [number, number, number]): { x: number; y: number } | null {
    const sEcef = geodeticToEcef(this.station.location);
    const dE: [number, number, number] = [p[0] - sEcef[0], p[1] - sEcef[1], p[2] - sEcef[2]];
    const dist = Math.hypot(dE[0], dE[1], dE[2]);
    const enu = ecefToEnuVec([dE[0] / dist, dE[1] / dist, dE[2] / dist], enuBasis(this.station.location));
    return projectEnu(this.rig, enu);
  }

  private renderMeteor(m: MeteorTruth, tMs: number, frameIndex: number) {
    const total = (m.endMs - m.startMs) / 1000;
    const q = Math.max(0, Math.min(1, (tMs - m.startMs) / 1000 / total));
    // 亮度包络：快升 + 中段峰值 + 尾段衰减，带确定性闪烁
    const attack = Math.min(1, q / 0.18);
    const body = Math.pow(Math.sin(Math.PI * Math.min(1, q * 1.02)), 0.55);
    const shimmer = 0.82 + 0.18 * Math.sin(frameIndex * 2.7 + m.seed);
    let env = Math.max(0, attack * body * shimmer);
    // 20% 概率末尾耀斑
    if (m.seed % 5 === 0 && q > 0.72) env *= 1 + 1.6 * Math.exp(-((q - 0.85) ** 2) / 0.004);
    const peak = Math.min(320, m.peakAdu * env);
    if (peak < 6) return;

    const half = 0.42 / this.sc.fps;
    const pA = this.meteorPosition(m, tMs - half * 1000);
    const pB = this.meteorPosition(m, tMs + half * 1000);
    const a = this.projectWorld(pA);
    const b = this.projectWorld(pB);
    if (!a || !b) {
      const p = this.projectWorld(this.meteorPosition(m, tMs));
      if (p) this.stamp(p.x, p.y, 1.5, peak);
      return;
    }
    // 外发光 + 亮核
    this.line(a.x, a.y, b.x, b.y, 3.2, peak * 0.22);
    this.line(a.x, a.y, b.x, b.y, 1.25, peak);
    this.stamp((a.x + b.x) / 2, (a.y + b.y) / 2, 1.1, peak * 0.9);
  }

  private renderNuisance(nz: NuisanceSpec, frame: number, tMs: number) {
    const span = nz.endFrame - nz.startFrame;
    const q = span > 0 ? (frame - nz.startFrame) / span : 0;
    const w = this.sc.width;

    if (nz.kind === 'aircraft') {
      const x = nz.x0! + (nz.x1! - nz.x0!) * q;
      const y = nz.y0! + (nz.y1! - nz.y0!) * q + Math.sin(q * 9 + (nz.phase ?? 0)) * 2;
      const period = 1.25;
      const ph = (((tMs / 1000) + (nz.phase ?? 0)) % period + period) % period;
      // 白色频闪双闪
      const strobe = ph < 0.07 || (ph > 0.2 && ph < 0.27);
      if (strobe) {
        this.stamp(x, y, 1.5, nz.peak ?? 180);
        this.stamp(x, y, 3.4, (nz.peak ?? 180) * 0.3);
      } else {
        // 暗淡常亮航行灯（接近阈值）
        this.stamp(x, y, 1.0, 34);
      }
      // 红色信标（灰度中较弱、慢闪）
      const redOn = ph > 0.55 && ph < 0.68;
      if (redOn) this.stamp(x - 7 * (w / 800), y + 1, 1.3, 95);
    } else if (nz.kind === 'satellite') {
      const x = nz.x0! + (nz.x1! - nz.x0!) * q;
      const y = nz.y0! + (nz.y1! - nz.y0!) * q;
      const vary = 0.85 + 0.15 * Math.sin(frame * 0.35 + (nz.phase ?? 0));
      this.stamp(x, y, nz.sigma ?? 1, (nz.peak ?? 60) * vary);
    } else if (nz.kind === 'insect' && nz.path) {
      const f = frame - nz.startFrame;
      const p0 = nz.path[Math.min(f, nz.path.length - 1)];
      const p1 = nz.path[Math.min(f + 1, nz.path.length - 1)];
      if (!p0) return;
      const sg = nz.sigma ?? 4.5;
      // 近距离飞虫：完全虚焦的大柔光团，没有致密亮核
      this.stamp(p0.x, p0.y, sg, (nz.peak ?? 80) * 0.55);
      this.stamp(p0.x, p0.y, sg * 0.62, (nz.peak ?? 80) * 0.5);
      if (p1) this.line(p0.x, p0.y, p1.x, p1.y, sg * 0.7, (nz.peak ?? 80) * 0.35);
    } else if (nz.kind === 'lightning') {
      const age = frame - nz.startFrame;
      const intensity = age === 0 ? (nz.peak ?? 70) : (nz.peak ?? 70) * 0.5;
      // 全域增亮（云反射）
      const d = this.buf;
      for (let i = 0; i < w * this.sc.height; i += 2) {
        d[i] = Math.min(255, d[i] + intensity * 0.55);
      }
      // 随机枝状亮线（由 phase 决定的确定性折线）
      const rng = new Rng(Math.floor(nz.phase ?? 1) * 1000 + nz.startFrame + age * 7);
      let x = rng.range(w * 0.2, w * 0.8);
      let y = -10;
      while (y < this.sc.height * 0.8) {
        const nx = x + rng.gauss(0, 26 * (w / 800));
        const ny = y + rng.range(18, 42) * (w / 800);
        this.line(x, y, nx, ny, 2.2, intensity * 2.2);
        if (rng.next() < 0.4) {
          this.line(nx, ny, nx + rng.gauss(0, 60), ny + rng.range(20, 60), 1.4, intensity * 1.3);
        }
        x = nx; y = ny;
      }
    }
  }
}
