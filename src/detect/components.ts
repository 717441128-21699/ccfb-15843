// 单遍扫描 + 并查集的连通域统计（4 邻接），输出面积/包围盒/强度加权矩

export interface Component {
  id: number;
  area: number;
  flux: number; // 阈值以上超出量之和（或灰度加权，取决于调用）
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mxx: number; // 强度加权二阶矩（已除以权重和，中心化在 PCA 时做）
  myy: number;
  mxy: number;
  peak: number;
}

class UnionFind {
  parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(a: number): number {
    let r = a;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[a] !== a) { const p = this.parent[a]; this.parent[a] = r; a = p; }
    return r;
  }
  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

export interface CCOptions {
  /** 与 data 同尺寸；>0 表示前景。若不提供则用 mask */
  mask?: Uint8Array;
  /** 用于强度加权的灰度/余量数据 */
  weights?: Float32Array | Uint8Array | Uint8ClampedArray;
  /** 最小面积 */
  minArea?: number;
}

/**
 * 对二值 mask 做连通域。mask 由调用方生成（避免本函数关心阈值）。
 * 坐标均为像素。
 */
export function connectedComponents(
  width: number,
  height: number,
  mask: Uint8Array,
  weights?: ArrayLike<number>,
  minArea = 1,
): Component[] {
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const uf = new UnionFind(Math.ceil(n / 2) + 1);
  let nextLabel = 0;

  // 第一遍：标号 + union
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!mask[idx]) continue;
      const up = y > 0 ? labels[idx - width] : -1;
      const left = x > 0 ? labels[idx - 1] : -1;
      if (up < 0 && left < 0) {
        labels[idx] = nextLabel;
        nextLabel++;
      } else if (up >= 0 && left < 0) {
        labels[idx] = up;
      } else if (up < 0 && left >= 0) {
        labels[idx] = left;
      } else {
        labels[idx] = up;
        if (up !== left) uf.union(up, left);
      }
    }
  }

  if (nextLabel === 0) return [];

  interface Acc {
    area: number; flux: number; sx: number; sy: number;
    x0: number; y0: number; x1: number; y1: number;
    sxx: number; syy: number; sxy: number; peak: number;
  }
  const accs = new Map<number, Acc>();
  const getAcc = (l: number): Acc => {
    let a = accs.get(l);
    if (!a) {
      a = {
        area: 0, flux: 0, sx: 0, sy: 0,
        x0: width, y0: height, x1: -1, y1: -1,
        sxx: 0, syy: 0, sxy: 0, peak: 0,
      };
      accs.set(l, a);
    }
    return a;
  };

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      const lab0 = labels[idx];
      if (lab0 < 0) continue;
      const lab = uf.find(lab0);
      labels[idx] = lab;
      const a = getAcc(lab);
      const w = weights ? Math.max(0, weights[idx]) : 1;
      a.area++;
      a.flux += w;
      a.sx += w * x;
      a.sy += w * y;
      a.sxx += w * x * x;
      a.syy += w * y * y;
      a.sxy += w * x * y;
      if (x < a.x0) a.x0 = x;
      if (x > a.x1) a.x1 = x;
      if (y < a.y0) a.y0 = y;
      if (y > a.y1) a.y1 = y;
      if (weights && weights[idx] > a.peak) a.peak = weights[idx];
      else if (!weights) a.peak = 1;
    }
  }

  const out: Component[] = [];
  let id = 0;
  for (const [root, a] of accs) {
    if (a.area < minArea) continue;
    const f = a.flux || a.area;
    const cx = a.sx / f;
    const cy = a.sy / f;
    out.push({
      id: id++,
      area: a.area,
      flux: a.flux,
      cx, cy,
      x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1,
      mxx: a.sxx / f - cx * cx,
      myy: a.syy / f - cy * cy,
      mxy: a.sxy / f - cx * cy,
      peak: a.peak,
    });
    void root;
  }
  return out;
}

/** 由二阶矩求 PCA 主轴方向、长/短半轴（像素，约 1 sigma）与偏心率 */
export function componentShape(c: Component) {
  // 协方差矩阵 [[mxx,mxy],[mxy,myy]]
  const tr = c.mxx + c.myy;
  const disc = Math.sqrt(Math.max(0, (c.mxx - c.myy) ** 2 + 4 * c.mxy * c.mxy));
  const l1 = Math.max(0, (tr + disc) / 2);
  const l2 = Math.max(0, (tr - disc) / 2);
  let angle = 0;
  if (c.mxy !== 0 || c.mxx !== c.myy) {
    angle = 0.5 * Math.atan2(2 * c.mxy, c.mxx - c.myy);
  } else {
    angle = 0;
  }
  return {
    majorSigma: Math.sqrt(l1),
    minorSigma: Math.sqrt(l2),
    /** 等效长度（约 4 sigma，覆盖大部分拖尾） */
    length: 4 * Math.sqrt(l1),
    width: 4 * Math.sqrt(l2),
    eccentricity: l1 > 1e-6 ? 1 - l2 / l1 : 0,
    angle,
  };
}
