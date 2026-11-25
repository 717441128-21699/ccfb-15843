// 随地球自转移动的星空背景：
// 1) 亮星质心匹配估计整幅星场相对背景锚点的平移
// 2) 双线性采样做差分
// 3) 前景像素禁更新，其余像素 EMA  splat 回锚点背景
import { connectedComponents } from './components';
import type { GrayFrame } from '../core/types';

interface StarPt { x: number; y: number }

function bilinearSample(arr: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) {
    // 边缘 clamp
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
  }
  const x0 = x | 0, y0 = y | 0;
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = arr[y0 * w + x0];
  const b = arr[y0 * w + x1];
  const c = arr[y1 * w + x0];
  const d = arr[y1 * w + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

function extractStars(
  gray: Uint8Array | Uint8ClampedArray | Float32Array,
  w: number, h: number, thr: number,
): StarPt[] {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = gray[i] >= thr ? 1 : 0;
  const comps = connectedComponents(w, h, mask, undefined, 1);
  const pts: StarPt[] = [];
  for (const c of comps) {
    // 星点是致密小圆斑；过大的是光晕/云，不用于配准
    if (c.area <= 14 && c.x1 - c.x0 <= 6 && c.y1 - c.y0 <= 6) {
      pts.push({ x: c.cx, y: c.cy });
    }
  }
  return pts;
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  arr.sort((a, b) => a - b);
  const m = arr.length >> 1;
  return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
}

export class MovingBackground {
  w: number;
  h: number;
  bg: Float32Array;
  ready = false;
  private initCount = 0;
  private initSum: Float32Array;
  shiftX = 0;
  shiftY = 0;
  private velX = 0;
  private velY = 0;
  private lastEstimateFrame = -99;
  private bgStars: StarPt[] = [];
  private bgStarTimer = 0;
  /** 最近一次差分的稳健噪声 sigma */
  noiseSigma = 6;
  skyLevel = 24;

  constructor(w: number, h: number) {
    this.w = w; this.h = h;
    this.bg = new Float32Array(w * h);
    this.initSum = new Float32Array(w * h);
  }

  /** 初始若干帧直接平均（恒星位移可忽略） */
  initialize(frame: GrayFrame, initFrames = 12): boolean {
    const d = frame.data;
    for (let i = 0; i < d.length; i++) this.initSum[i] += d[i];
    this.initCount++;
    if (this.initCount >= initFrames) {
      for (let i = 0; i < this.bg.length; i++) this.bg[i] = this.initSum[i] / initFrames;
      this.ready = true;
      this.refreshBgStars();
      return true;
    }
    return false;
  }

  private refreshBgStars() {
    // 用背景自身的高位灰度找星
    let sum = 0;
    const n = this.bg.length;
    for (let i = 0; i < n; i++) sum += this.bg[i];
    const mean = sum / n;
    const pts = extractStars(this.bg, this.w, this.h, mean + 42);
    // 只保留较亮的前 120 颗
    this.bgStars = pts.slice(0, 120);
  }

  /** 估计当前帧相对锚点背景的累计平移 */
  updateRegistration(frame: GrayFrame) {
    const idx = frame.index;
    // 线性外推，保证非估计帧也有平滑位移
    if (idx - this.lastEstimateFrame >= 4) {
      const d = frame.data;
      // 天空中位数粗估：采样 4000 点
      let s = 0, cnt = 0;
      const step = Math.max(1, Math.floor(d.length / 4000));
      for (let i = 0; i < d.length; i += step) { s += d[i]; cnt++; }
      const mean = s / cnt;
      const stars = extractStars(d, this.w, this.h, mean + 46);
      const dxList: number[] = [];
      const dyList: number[] = [];
      const predX = this.shiftX + this.velX * (idx - this.lastEstimateFrame);
      const predY = this.shiftY + this.velY * (idx - this.lastEstimateFrame);
      for (const cur of stars) {
        let best: StarPt | null = null;
        let bestD = 8 * 8;
        for (const bs of this.bgStars) {
          const mx = bs.x + predX, my = bs.y + predY;
          const dd = (cur.x - mx) ** 2 + (cur.y - my) ** 2;
          if (dd < bestD) { bestD = dd; best = bs; }
        }
        if (best) {
          dxList.push(cur.x - best.x);
          dyList.push(cur.y - best.y);
        }
      }
      if (dxList.length >= 5) {
        const nx = median(dxList);
        const ny = median(dyList);
        if (this.lastEstimateFrame > 0) {
          const dt = Math.max(1, idx - this.lastEstimateFrame);
          // 低通速度
          this.velX = this.velX * 0.5 + ((nx - this.shiftX) / dt) * 0.5;
          this.velY = this.velY * 0.5 + ((ny - this.shiftY) / dt) * 0.5;
        }
        this.shiftX = nx;
        this.shiftY = ny;
        this.lastEstimateFrame = idx;
      } else {
        this.shiftX = predX; this.shiftY = predY;
        this.lastEstimateFrame = idx;
      }
    } else if (this.lastEstimateFrame >= 0) {
      this.shiftX += this.velX;
      this.shiftY += this.velY;
    }
  }

  /** 计算残差图与稳健阈值 */
  diff(frame: GrayFrame, residual: Float32Array): { threshold: number } {
    const d = frame.data;
    const n = this.w * this.h;
    const sx = this.shiftX, sy = this.shiftY;
    const hist = new Int32Array(512); // 残差 -256..255 映射 +256
    let skySum = 0;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        const b = bilinearSample(this.bg, this.w, this.h, x - sx, y - sy);
        const r = d[i] - b;
        residual[i] = r;
        let bin = (r + 256) | 0;
        if (bin < 0) bin = 0; else if (bin > 511) bin = 511;
        hist[bin]++;
        skySum += d[i];
      }
    }
    this.skyLevel = skySum / n;
    // 中位数与 MAD（在残差直方图上）
    const med = histQuantile(hist, n / 2) - 256;
    const madHist = new Int32Array(512);
    for (let i = 0; i < n; i++) {
      let bin = (Math.abs(residual[i] - med) + 0.5) | 0;
      if (bin > 511) bin = 511;
      madHist[bin]++;
    }
    const mad = histQuantile(madHist, n / 2);
    this.noiseSigma = Math.max(1.2, 1.4826 * mad);
    // 阈值：稳健 5.4σ，且不低于 18 ADU
    const threshold = Math.max(18, 5.4 * this.noiseSigma);
    return { threshold };
  }

  /**
   * EMA 更新背景（在锚点坐标系逐锚点像素反采样当前帧）。
   * forbidden 为当前帧前景 mask（255/1），其最近像素处不更新，避免流星拖尾印进背景。
   */
  update(frame: GrayFrame, forbidden: Uint8Array, alpha = 0.06) {
    const d = frame.data;
    const sx = this.shiftX, sy = this.shiftY;
    const w = this.w, h = this.h;
    for (let ay = 0; ay < h; ay++) {
      const fx = ay + sy;
      const y0 = Math.max(0, Math.min(h - 1, fx | 0));
      const y1 = Math.min(h - 1, y0 + 1);
      const fy = fx - (fx | 0);
      for (let ax = 0; ax < w; ax++) {
        const cx = ax + sx;
        const x0 = Math.max(0, Math.min(w - 1, cx | 0));
        const x1 = Math.min(w - 1, x0 + 1);
        const tx = cx - (cx | 0);
        const v =
          d[y0 * w + x0] * (1 - tx) * (1 - fy) +
          d[y0 * w + x1] * tx * (1 - fy) +
          d[y1 * w + x0] * (1 - tx) * fy +
          d[y1 * w + x1] * tx * fy;
        // 最近当前像素若为前景则跳过
        const nx = Math.max(0, Math.min(w - 1, Math.round(cx)));
        const ny = Math.max(0, Math.min(h - 1, Math.round(fx)));
        if (forbidden[ny * w + nx]) continue;
        const i = ay * w + ax;
        this.bg[i] += alpha * (v - this.bg[i]);
      }
    }
    this.bgStarTimer++;
    if (this.bgStarTimer % 240 === 239) this.refreshBgStars();
  }
}

function histQuantile(hist: Int32Array, target: number): number {
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return hist.length - 1;
}
