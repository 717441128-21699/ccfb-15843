// 小型稠密线性代数工具：高斯消元（部分选主元）、法方程最小二乘

/** 解 n 阶线性方程组 A x = b（原地不修改入参），奇异时抛错 */
export function solveLinear(Ain: number[][], bin: number[]): number[] {
  const n = bin.length;
  const M: number[][] = Ain.map((row, i) => [...row, bin[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-12) throw new Error('线性方程组奇异');
    if (piv !== col) { const tmp = M[piv]; M[piv] = M[col]; M[col] = tmp; }
    const pv = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / pv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

export interface LeastSquares6 {
  ata: number[][]; // 6x6
  atb: number[];
}

export function createLS6(): LeastSquares6 {
  return {
    ata: Array.from({ length: 6 }, () => new Array(6).fill(0)),
    atb: new Array(6).fill(0),
  };
}

/** 累加一行观测：a · x = b，weight 为权重 */
export function addRow6(ls: LeastSquares6, a: number[], b: number, weight = 1): void {
  for (let i = 0; i < 6; i++) {
    const ai = a[i] * weight;
    ls.atb[i] += ai * b;
    for (let j = 0; j < 6; j++) ls.ata[i][j] += ai * a[j];
  }
}

export function solveLS6(ls: LeastSquares6): number[] {
  return solveLinear(ls.ata, ls.atb);
}

/** 二维点仿射拟合：src(x,y) -> dst(X,Y)，返回 [a,b,c,d,e,f] 使 X=a*x+b*y+c, Y=d*x+e*y+f */
export function fitAffine(
  pairs: Array<{ sx: number; sy: number; dx: number; dy: number }>,
): [number, number, number, number, number, number] {
  // 分别解两个 3 参数最小二乘
  const solve3 = (target: 'dx' | 'dy') => {
    const A: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const b = [0, 0, 0];
    for (const p of pairs) {
      const row = [p.sx, p.sy, 1];
      const v = p[target];
      for (let i = 0; i < 3; i++) {
        b[i] += row[i] * v;
        for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j];
      }
    }
    return solveLinear(A, b);
  };
  const px = solve3('dx');
  const py = solve3('dy');
  return [px[0], px[1], px[2], py[0], py[1], py[2]];
}

export function applyAffine(
  aff: [number, number, number, number, number, number],
  x: number,
  y: number,
): [number, number] {
  return [aff[0] * x + aff[1] * y + aff[2], aff[3] * x + aff[4] * y + aff[5]];
}

/** 由正向仿射求逆仿射（像素 -> 切平面坐标时使用） */
export function invertAffine(
  aff: [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  const [a, b, c, d, e, f] = aff;
  const det = a * e - b * d;
  // xi = A*x+B*y+C ; eta = D*x+E*y+F 是正向。逆：
  const ia = e / det, ib = -b / det;
  const id = -d / det, ie = a / det;
  const ic = (b * f - e * c) / det;
  const if_ = (d * c - a * f) / det;
  return [ia, ib, ic, id, ie, if_];
}
