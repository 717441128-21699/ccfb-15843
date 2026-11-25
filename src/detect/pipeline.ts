// 流星检测管线：残差阈值 -> 连通域形状筛选 -> 多帧轨迹关联 -> 直线/速度/闪烁/虚焦分类
import type {
  GrayFrame, MeteorTrack, PixelObservation, RejectedTrack, RejectKind, DetectionResult,
} from '../core/types';
import { connectedComponents, componentShape, type Component } from './components';
import { MovingBackground } from './background';

interface Cand {
  x: number; y: number; flux: number; peak: number; area: number;
  length: number; width: number; ecc: number; angle: number; comp: Component;
}

interface InternalTrack {
  id: number;
  obs: PixelObservation[];
  frames: number[];
  misses: number;
  dead: boolean;
  vx: number; vy: number;
  flashFrames: number;
  sumWidth: number;
  widthN: number;
  maxWidth: number;
  velocityJitter: number;
  lastVx: number; lastVy: number;
}

export interface PipelineOptions {
  stationId: string;
  nightId: string;
  width: number;
  height: number;
  fps: number;
  /** 度/像素，用于速度分类；默认按 76° 水平视场估算 */
  degPerPx?: number;
  /** 严格程度微调，验证脚本调参用 */
  tuning?: Partial<Tuning>;
  onMeteor?: (t: MeteorTrack) => void;
  onReject?: (t: RejectedTrack) => void;
}

export interface Tuning {
  zThresh: number;
  minPathPx: number;
  minObs: number;
  maxRmsRatio: number;
  minSpeedDegS: number;
  maxSpeedDegS: number;
  maxBlobWidthPx: number;
  confirmScore: number;
}

const DEFAULT_TUNING: Tuning = {
  zThresh: 5.4,
  minPathPx: 15,
  minObs: 3,
  maxRmsRatio: 0.09,
  minSpeedDegS: 1.6,
  maxSpeedDegS: 95,
  maxBlobWidthPx: 11,
  confirmScore: 0.62,
};

let TRACK_SEQ = 1;

export class MeteorDetectionPipeline {
  bg: MovingBackground;
  residual: Float32Array;
  mask: Uint8Array;
  w: number; h: number; fps: number;
  opt: PipelineOptions;
  tuning: Tuning;
  tracks: InternalTrack[] = [];
  confirmed: MeteorTrack[] = [];
  rejected: RejectedTrack[] = [];
  framesProcessed = 0;
  flashFrame = false;
  flashCount = 0;
  private started = false;
  degPerPx: number;
  /** 已确认的静止热点/坏像素位置，其附近候选直接忽略 */
  private staticPoints: Array<{ x: number; y: number }> = [];

  constructor(opt: PipelineOptions) {
    this.opt = opt;
    this.w = opt.width; this.h = opt.height; this.fps = opt.fps;
    this.bg = new MovingBackground(opt.width, opt.height);
    this.residual = new Float32Array(opt.width * opt.height);
    this.mask = new Uint8Array(opt.width * opt.height);
    this.tuning = { ...DEFAULT_TUNING, ...(opt.tuning ?? {}) };
    this.degPerPx = opt.degPerPx ?? 76 / opt.width;
  }

  /** 处理一帧；返回本帧新结案的确认流星与排除轨迹 */
  process(frame: GrayFrame): { meteors: MeteorTrack[]; rejects: RejectedTrack[] } {
    if (frame.width !== this.w || frame.height !== this.h) {
      throw new Error('帧尺寸与管线不一致');
    }
    const newMeteors: MeteorTrack[] = [];
    const newRejects: RejectedTrack[] = [];
    this.framesProcessed++;

    if (!this.bg.ready) {
      const done = this.bg.initialize(frame);
      if (!done) return { meteors: [], rejects: [] };
      this.started = true;
      return { meteors: [], rejects: [] };
    }

    this.bg.updateRegistration(frame);
    const { threshold } = this.bg.diff(frame, this.residual);
    const thr = Math.max(threshold, this.tuning.zThresh * this.bg.noiseSigma);

    // 全局闪电检测：残差超阈值像素占比 / 天空亮度跳变
    let highCount = 0;
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      if (this.residual[i] > thr * 1.6) highCount++;
    }
    const fracHigh = highCount / n;
    const prevSky = this.bg.skyLevel;
    this.flashFrame = fracHigh > 0.12;
    if (this.flashFrame) this.flashCount++;

    // 生成前景 mask
    this.mask.fill(0);
    if (!this.flashFrame) {
      for (let i = 0; i < n; i++) {
        if (this.residual[i] > thr) this.mask[i] = 1;
      }
      // 轻度膨胀，连接 1px 断裂
      dilate3(this.mask, this.w, this.h);
    }

    const comps = this.flashFrame
      ? []
      : connectedComponents(this.w, this.h, this.mask, this.residual as unknown as ArrayLike<number>, 2);

    const scale = this.w / 800;
    const cands: Cand[] = [];
    for (const c of comps) {
      const sh = componentShape(c);
      const len = Math.max(sh.length, Math.hypot(c.x1 - c.x0, c.y1 - c.y0));
      // 形状粗筛：去掉巨大连片（闪电/云）与单像素噪声
      if (c.area < 2) continue;
      if (len > 420 * scale) continue;
      if (sh.width > 26 * scale && c.area > 220 * scale * scale) continue;
      cands.push({
        x: c.cx, y: c.cy,
        flux: c.flux, peak: c.peak, area: c.area,
        length: len, width: Math.max(sh.width, 0.8), ecc: sh.eccentricity, angle: sh.angle, comp: c,
      });
    }

    // 忽略静止热点附近的候选
    const activeCands = this.staticPoints.length
      ? cands.filter((cd) => !this.staticPoints.some((p) => Math.hypot(cd.x - p.x, cd.y - p.y) < 5 * scale + 2))
      : cands;

    // 轨迹关联
    const used = new Set<number>();
    const dtF = 1; // 按帧计
    // 单帧间允许的最大位移（由最大流星角速度换算），用于新轨迹的第二次关联
    const maxStepPx = this.tuning.maxSpeedDegS / this.degPerPx / this.fps;
    for (const tr of this.tracks) {
      if (tr.dead) continue;
      const last = tr.obs[tr.obs.length - 1];
      const predX = last.x + tr.vx * dtF;
      const predY = last.y + tr.vy * dtF;
      const speed = Math.hypot(tr.vx, tr.vy);
      let gate: number;
      if (tr.obs.length === 1) {
        // 尚无速度估计：按最大可能角速度开放搜索，否则高速流星无法建轨
        gate = Math.max(26 * scale, 1.2 * maxStepPx);
      } else {
        gate = Math.max(15 * scale, speed * 1.35 + 6 * scale) * (1 + tr.misses * 0.5);
      }
      let best = -1;
      let bestD = gate * gate;
      activeCands.forEach((cd, i) => {
        if (used.has(i)) return;
        const dd = (cd.x - predX) ** 2 + (cd.y - predY) ** 2;
        if (dd < bestD) { bestD = dd; best = i; }
      });
      if (best >= 0) {
        used.add(best);
        const cd = activeCands[best];
        const prevVx = tr.vx, prevVy = tr.vy;
        tr.obs.push(this.toObs(frame, cd));
        tr.frames.push(frame.index);
        tr.misses = 0;
        tr.sumWidth += cd.width; tr.widthN++;
        tr.maxWidth = Math.max(tr.maxWidth, cd.width);
        // 用最近两帧速度做平滑
        if (tr.obs.length >= 2) {
          const o0 = tr.obs[tr.obs.length - 2];
          const o1 = tr.obs[tr.obs.length - 1];
          const nvx = o1.x - o0.x, nvy = o1.y - o0.y;
          if (tr.obs.length === 2) { tr.vx = nvx; tr.vy = nvy; }
          else {
            tr.vx = tr.vx * 0.55 + nvx * 0.45;
            tr.vy = tr.vy * 0.55 + nvy * 0.45;
            const jit = Math.hypot(tr.vx - prevVx, tr.vy - prevVy);
            tr.velocityJitter = tr.velocityJitter * 0.7 + jit * 0.3;
          }
        }
        if (this.flashFrame) tr.flashFrames++;
      } else {
        tr.misses++;
      }
    }

    // 未匹配候选开新轨迹
    activeCands.forEach((cd, i) => {
      if (used.has(i)) return;
      // 单个过大虚焦斑先不开轨迹（虫子下一帧仍会进来并连续）
      const tr: InternalTrack = {
        id: TRACK_SEQ++,
        obs: [this.toObs(frame, cd)],
        frames: [frame.index],
        misses: 0, dead: false,
        vx: 0, vy: 0,
        flashFrames: this.flashFrame ? 1 : 0,
        sumWidth: cd.width, widthN: 1, maxWidth: cd.width,
        velocityJitter: 0, lastVx: 0, lastVy: 0,
      };
      this.tracks.push(tr);
    });

    // 结案丢失过久、过长或确认为静止热点的轨迹
    for (const tr of this.tracks) {
      if (tr.dead) continue;
      const age = frame.index - tr.frames[0];
      const sp = Math.hypot(tr.vx, tr.vy);
      const frozen = tr.obs.length >= 12 && age >= 24 && sp < 0.4;
      if (frozen) {
        const tail = tr.obs.slice(-10);
        const mx = tail.reduce((a, o) => a + o.x, 0) / tail.length;
        const my = tail.reduce((a, o) => a + o.y, 0) / tail.length;
        this.staticPoints.push({ x: mx, y: my });
        tr.dead = true;
        const out = this.finalize(tr);
        if (out?.reject) { this.rejected.push(out.reject); newRejects.push(out.reject); this.opt.onReject?.(out.reject); }
        continue;
      }
      if (tr.misses > 3 || age > 120) {
        tr.dead = true;
        const out = this.finalize(tr);
        if (out?.meteor) {
          this.confirmed.push(out.meteor);
          newMeteors.push(out.meteor);
          this.opt.onMeteor?.(out.meteor);
        } else if (out?.reject) {
          this.rejected.push(out.reject);
          newRejects.push(out.reject);
          this.opt.onReject?.(out.reject);
        }
      }
    }
    this.tracks = this.tracks.filter((t) => !t.dead);

    // 更新背景（闪电帧整帧禁更新，避免污染）
    if (!this.flashFrame) this.bg.update(frame, this.mask, 0.05);
    void prevSky;

    return { meteors: newMeteors, rejects: newRejects };
  }

  private toObs(frame: GrayFrame, cd: Cand): PixelObservation {
    return {
      frame: frame.index,
      time: frame.time,
      x: cd.x, y: cd.y,
      flux: cd.flux, peak: cd.peak, area: cd.area,
      width: cd.width, ecc: cd.ecc,
    };
  }

  /** 结束所有未结轨迹并产出最终结果 */
  finish(): DetectionResult {
    for (const tr of this.tracks) {
      if (tr.dead) continue;
      tr.dead = true;
      const out = this.finalize(tr);
      if (out?.meteor) this.confirmed.push(out.meteor);
      else if (out?.reject) this.rejected.push(out.reject);
    }
    this.tracks = [];
    return {
      stationId: this.opt.stationId,
      nightId: this.opt.nightId,
      tracks: this.confirmed.slice(),
      rejected: this.rejected,
      framesProcessed: this.framesProcessed,
    };
  }

  private finalize(tr: InternalTrack): { meteor?: MeteorTrack; reject?: RejectedTrack } | null {
    let obs = tr.obs;
    const scale = this.w / 800;
    if (obs.length === 0) return null;

    // 稳健去野点：大搜索波门可能偶发关联到亮星残差，按直线残差剔除野值
    {
      const t0x = obs[0].time;
      const ts0 = obs.map((o) => (o.time - t0x) / 1000);
      const f0 = fitLine(ts0, obs.map((o) => o.x), obs.map((o) => o.y));
      const res = obs.map((o, i) => {
        const t = ts0[i];
        return Math.hypot(o.x - (f0.x0 + f0.vx * t), o.y - (f0.y0 + f0.vy * t));
      });
      const medRes = medianNum(res);
      const cut = Math.max(4.2 * scale, 3.2 * medRes + 0.9);
      const keepIdx = res.map((r, i) => (r <= cut ? i : -1)).filter((i) => i >= 0);
      if (keepIdx.length >= 3 && keepIdx.length < obs.length) {
        obs = keepIdx.map((i) => tr.obs[i]);
        tr.frames = keepIdx.map((i) => tr.frames[i]);
        tr.obs = obs;
      }
    }

    const t0 = obs[0].time;
    const ts = obs.map((o) => (o.time - t0) / 1000);
    const xs = obs.map((o) => o.x);
    const ys = obs.map((o) => o.y);
    const fit = fitLine(ts, xs, ys);
    const duration = ts[ts.length - 1];
    const pathLen = Math.hypot(fit.vx * duration, fit.vy * duration);
    const speedPxS = Math.hypot(fit.vx, fit.vy);
    const speedDegS = speedPxS * this.degPerPx;
    const rms = fit.rms;
    const meanWidth = tr.widthN ? tr.sumWidth / tr.widthN : 2;
    const meanEcc = obs.reduce((a, o) => a + (o.ecc ?? 0), 0) / Math.max(1, obs.length);
    const spanFrames = tr.frames[tr.frames.length - 1] - tr.frames[0] + 1;
    const fillRatio = obs.length / spanFrames;
    const missingRatio = 1 - fillRatio;

    // 亮度序列的闪烁/周期性
    const flux = obs.map((o) => o.flux);
    const fluxCv = cv(flux);
    const blink = blinkScore(tr.frames, flux, spanFrames);

    const straightOk = rms <= Math.max(2.0 * scale, this.tuning.maxRmsRatio * pathLen + 0.6);
    // 更严格的“完美直线”：远站慢流星 rms 通常 <0.8px
    const linearExcellent = rms <= Math.max(1.5 * scale, 0.05 * pathLen + 0.5);
    const lengthOk = pathLen >= this.tuning.minPathPx * scale;
    const obsOk = obs.length >= this.tuning.minObs;
    // 仅 3 帧的候选必须有足够亮度/面积/位移，防止大搜索波门把噪声串成链
    const medPeak = medianNum(obs.map((o) => o.peak));
    const medArea = medianNum(obs.map((o) => o.area));
    const shortStrong = obs.length >= 4 ||
      (obs.length === 3 && medPeak >= 42 && medArea >= 4 && pathLen >= 24 * scale);
    const signalOk = medPeak >= 33;
    // 开头多帧静止、随后跳走的是热点拼接，不是流星（流星从首帧起就在运动）
    const stationaryStart =
      obs.length >= 3 && Math.hypot(obs[2].x - obs[0].x, obs[2].y - obs[0].y) < 1.2 * scale;
    const evidenceOk = obsOk && shortStrong && signalOk && !stationaryStart;
    const speedOk = speedDegS >= this.tuning.minSpeedDegS && speedDegS <= this.tuning.maxSpeedDegS;
    // 流星（含火流星）极少超过 3.5s；更长的连续光点轨迹属于飞机/卫星
    const durationOk = duration >= 0.1 && duration <= 3.5;
    // 飞虫：极大面积、大短轴、近圆形的虚焦斑（慢流星虽圆但不会同时这么肥）
    const widthNorm = meanWidth / scale;
    const areaNorm = medArea / (scale * scale);
    const fatBlob = widthNorm > 11 && areaNorm > 170 && meanEcc < 0.42;
    // 形状门限对“极直线匀速”轨迹放宽，避免误杀远站慢流星
    const focusOk =
      meanWidth <= this.tuning.maxBlobWidthPx * scale + 1.5 &&
      tr.maxWidth <= 19 * scale + 4 &&
      !fatBlob;
    const notBlink =
      !(blink.score >= 0.52 && missingRatio >= 0.2) &&
      !(missingRatio > 0.4 && spanFrames >= 7);
    const jitterOk = tr.velocityJitter <= Math.max(12 * scale, speedPxS * 0.55);
    // 弯曲/抖动的大斑一律按飞虫排除，哪怕总分过线
    const kinematicShapeClash =
      (!linearExcellent && meanWidth > 6.5 * scale + 1 && meanEcc < 0.55) ||
      (!jitterOk && tr.maxWidth > 6 * scale);

    // 综合评分（0..1）
    let score = 0;
    score += evidenceOk ? 0.16 : 0;
    score += lengthOk ? 0.15 : 0;
    score += straightOk ? 0.19 : Math.max(0, 0.19 - rms / (20 * scale));
    score += speedOk ? 0.15 : 0;
    score += durationOk ? 0.1 : 0;
    score += focusOk ? 0.1 : 0;
    score += notBlink ? 0.08 : 0;
    score += jitterOk ? 0.07 : 0;

    const isMeteor =
      score >= this.tuning.confirmScore &&
      evidenceOk &&
      lengthOk && straightOk && speedOk && durationOk && focusOk && notBlink && jitterOk &&
      !kinematicShapeClash &&
      tr.flashFrames === 0;

    const base = {
      id: `TR-${tr.id}`,
      start: obs[0].time,
      end: obs[obs.length - 1].time,
      frames: obs.length,
      observations: obs,
      speedDegS,
    };

    if (isMeteor) {
      const meteor: MeteorTrack = {
        id: `M-${this.opt.stationId}-${tr.id}`,
        stationId: this.opt.stationId,
        observations: obs,
        speedPxS,
        angle: Math.atan2(fit.vy, fit.vx),
        score: +score.toFixed(3),
      };
      return { meteor };
    }

    // ---- 排除分类 ----
    let kind: RejectKind = 'unknown';
    let reason = '综合特征未达到流星确认条件';
    if (tr.flashFrames > 0 || this.flashCount > 0 && obs.length <= 3 && meanWidth > 5 * scale) {
      kind = 'lightning';
      reason = '位于闪电高亮帧，伴随全画面亮度突增';
    } else if (
      (blink.score >= 0.55 && missingRatio >= 0.2) ||
      (missingRatio > 0.35 && spanFrames >= 7 && speedDegS < 4)
    ) {
      kind = 'aircraft';
      reason = `灯光周期性闪烁/断续（闪烁指数 ${blink.score.toFixed(2)}，缺帧 ${(missingRatio * 100) | 0}%）`;
    } else if (speedDegS < 1.7 && duration >= 1.6 && meanWidth < 5 * scale && fluxCv < 0.55) {
      kind = 'satellite';
      reason = '缓慢匀速移动的致密光点、亮度稳定，符合卫星反光';
    } else if (!focusOk || (!straightOk && meanWidth > 5 * scale) || (!jitterOk && tr.maxWidth > 6 * scale)) {
      kind = 'insect';
      reason = `虚焦大斑/轨迹抖动（平均斑宽 ${meanWidth.toFixed(1)}px，拟合残差 ${rms.toFixed(1)}px），符合近距离飞虫`;
    } else if (!obsOk || !lengthOk || duration < 0.12) {
      kind = 'noise';
      reason = `持续帧数或位移不足（${obs.length} 帧，路径 ${pathLen.toFixed(1)}px）`;
    } else if (!straightOk || !jitterOk) {
      kind = 'insect';
      reason = `轨迹弯曲/速度抖动过大（残差 ${rms.toFixed(1)}px）`;
    } else if (!speedOk && speedDegS < this.tuning.minSpeedDegS) {
      kind = 'satellite';
      reason = `角速度过慢（${speedDegS.toFixed(2)}°/s）`;
    } else if (!speedOk) {
      kind = 'unknown';
      reason = `角速度超出流星范围（${speedDegS.toFixed(1)}°/s）`;
    }

    // 太短的单帧噪声不进 rejected 列表，避免淹没界面
    if (obs.length < 2 && kind === 'noise') return null;

    const reject: RejectedTrack = { ...base, id: `R-${tr.id}`, kind, reason, blinkScore: blink.score };
    return { reject };
  }
}

function medianNum(arr: number[]): number {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[a.length >> 1];
}

function cv(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  if (m < 1e-6) return 0;
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
  return Math.sqrt(v) / m;
}

/** 闪烁评分：把观测亮度按帧序排列，统计亮-灭交替的规则程度，0..1 */
function blinkScore(frames: number[], flux: number[], spanFrames: number): { score: number } {
  if (frames.length < 3 || spanFrames < 5) return { score: 0 };
  const first = frames[0];
  const series = new Array(spanFrames).fill(0);
  frames.forEach((f, i) => { series[f - first] = flux[i]; });
  const maxF = Math.max(...flux, 1);
  const onOff = series.map((v) => (v > maxF * 0.28 ? 1 : 0));
  let transitions = 0;
  for (let i = 1; i < onOff.length; i++) if (onOff[i] !== onOff[i - 1]) transitions++;
  // 周期性：尝试 2..6 帧周期，计算自相关峰值
  let bestPeriod = 0;
  let bestCorr = 0;
  for (let p = 2; p <= 8; p++) {
    let agree = 0, tot = 0;
    for (let i = p; i < onOff.length; i++) {
      if (onOff[i] === onOff[i - p]) agree++;
      tot++;
    }
    const c = tot ? agree / tot : 0;
    if (c > bestCorr) { bestCorr = c; bestPeriod = p; }
  }
  const alternation = Math.min(1, transitions / Math.max(3, spanFrames * 0.5));
  const periodic = bestCorr > 0.72 && bestPeriod > 0 ? (bestCorr - 0.5) * 2 : 0;
  const score = Math.min(1, alternation * 0.55 + periodic * 0.45);
  return { score: +score.toFixed(3) };
}

function fitLine(t: number[], x: number[], y: number[]) {
  // x = x0 + vx*t ; y = y0 + vy*t
  const n = t.length;
  let st = 0, st2 = 0, sx = 0, sy = 0, stx = 0, sty = 0;
  for (let i = 0; i < n; i++) {
    st += t[i]; st2 += t[i] * t[i];
    sx += x[i]; sy += y[i];
    stx += t[i] * x[i]; sty += t[i] * y[i];
  }
  const det = n * st2 - st * st || 1e-9;
  const vx = (n * stx - st * sx) / det;
  const x0 = (sx - vx * st) / n;
  const vy = (n * sty - st * sy) / det;
  const y0 = (sy - vy * st) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - (x0 + vx * t[i]);
    const dy = y[i] - (y0 + vy * t[i]);
    ss += dx * dx + dy * dy;
  }
  return { x0, y0, vx, vy, rms: Math.sqrt(ss / n) };
}

/** 3x3 十字膨胀一圈 */
function dilate3(mask: Uint8Array, w: number, h: number) {
  const orig = mask.slice();
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      if (orig[i]) {
        mask[i - 1] = 1; mask[i + 1] = 1;
        mask[i - w] = 1; mask[i + w] = 1;
      }
    }
  }
}
