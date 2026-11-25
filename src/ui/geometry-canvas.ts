// 三维交会结果可视化：左侧视（沿轨迹方向距离-高度 + 各站视线），右俯视（ENU 站点与轨迹）
import type { MeteorRecord, Station } from '../core/types';
import { geodeticToEcef, enuBasis, ecefToEnuVec } from '../geo/astro';

interface Enu { e: number; n: number; u: number }

function prepare(rec: MeteorRecord, stations: Station[]) {
  const tr = rec.trajectory!;
  const origin = tr.begin;
  const originEcef = geodeticToEcef(origin);
  const basis = enuBasis(origin);
  const toEnu = (ecef: [number, number, number]): Enu => {
    const d: [number, number, number] = [ecef[0] - originEcef[0], ecef[1] - originEcef[1], ecef[2] - originEcef[2]];
    const v = ecefToEnuVec(d, basis);
    return { e: v[0] / 1000, n: v[1] / 1000, u: v[2] / 1000 };
  };
  const t0 = tr.t0;
  const pointAt = (timeMs: number): Enu => {
    const tau = (timeMs - t0) / 1000;
    return toEnu([tr.p0[0] + tr.vEcef[0] * tau, tr.p0[1] + tr.vEcef[1] * tau, tr.p0[2] + tr.vEcef[2] * tau]);
  };
  const tA = tr.begin.time, tB = tr.end.time;
  const path: Enu[] = [];
  for (let i = 0; i <= 24; i++) path.push(pointAt(tA + ((tB - tA) * i) / 24));
  const obsPoints = rec.equatorial.map((o) => ({ ...pointAt(o.time), stationId: o.stationId }));
  const stEnu = stations.map((s) => ({ s, p: toEnu(geodeticToEcef(s.location)) }));
  // 轨迹水平方向单位
  const a = path[0], b = path[path.length - 1];
  const hlen = Math.hypot(b.e - a.e, b.n - a.n) || 1;
  const he = (b.e - a.e) / hlen, hn = (b.n - a.n) / hlen;
  const alt0 = origin.alt / 1000;
  // 侧视坐标：x=沿轨迹水平距离(km)，y=绝对海拔(km)
  return {
    path, obsPoints, stEnu,
    projectSide: (p: Enu) => ({ x: (p.e - a.e) * he + (p.n - a.n) * hn, y: alt0 + p.u }),
  };
}

export function drawGeometry(canvas: HTMLCanvasElement, rec: MeteorRecord, stations: Station[]) {
  if (!rec.trajectory) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 720;
  const cssH = 400;
  canvas.style.height = `${cssH}px`;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const data = prepare(rec, stations);
  const split = Math.round(cssW * 0.64);

  // ============ 侧视图 ============
  const padL = 52, padR = 16, padT = 34, padB = 40;
  const plotW = split - padL - padR, plotH = cssH - padT - padB;
  const sidePts = data.path.map((p) => data.projectSide(p));
  const sideStations = data.stEnu.map((x) => ({ ...x, side: data.projectSide(x.p) }));
  let xmin = Math.min(0, ...sidePts.map((p) => p.x), ...sideStations.map((p) => p.side.x));
  let xmax = Math.max(...sidePts.map((p) => p.x), ...sideStations.map((p) => p.side.x));
  let ymin = Math.min(0, ...sideStations.map((p) => p.side.y)) - 6;
  let ymax = Math.max(...sidePts.map((p) => p.y)) + 8;
  if (xmax - xmin < 10) xmax = xmin + 10;
  const xpad = (xmax - xmin) * 0.08; xmin -= xpad; xmax += xpad;

  const X = (x: number) => padL + ((x - xmin) / (xmax - xmin)) * plotW;
  const Y = (u: number) => padT + plotH - ((u - ymin) / (ymax - ymin)) * plotH;

  ctx.fillStyle = 'rgba(10,18,38,0.5)';
  ctx.fillRect(0, 0, split, cssH);
  ctx.strokeStyle = 'rgba(140,180,255,0.14)';
  ctx.fillStyle = 'rgba(170,195,240,0.75)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.lineWidth = 1;
  // y 网格（高度 km）
  for (let u = Math.ceil(ymin / 10) * 10; u <= ymax; u += 10) {
    ctx.beginPath(); ctx.moveTo(padL, Y(u)); ctx.lineTo(padL + plotW, Y(u)); ctx.stroke();
    ctx.fillText(`${u | 0}`, 14, Y(u) + 4);
  }
  // x 网格
  const xStep = niceStep(xmax - xmin, 6);
  for (let x = Math.ceil(xmin / xStep) * xStep; x <= xmax; x += xStep) {
    ctx.beginPath(); ctx.moveTo(X(x), padT); ctx.lineTo(X(x), padT + plotH); ctx.stroke();
    ctx.fillText(`${x | 0} km`, X(x) - 14, padT + plotH + 18);
  }
  ctx.fillStyle = 'rgba(215,230,255,0.92)';
  ctx.font = 'bold 13px "PingFang SC", sans-serif';
  ctx.fillText('侧视：高度 — 沿轨迹水平距离（含各站视线）', padL, 20);
  ctx.fillStyle = 'rgba(170,195,240,0.7)';
  ctx.font = '11px "PingFang SC", sans-serif';
  ctx.fillText('高度 km', 12, padT - 12);

  // 视线
  const colorFor = (id: string) => {
    const palette = ['#5aa8ff', '#34d399', '#fbbf24', '#f472b6'];
    return palette[stations.findIndex((s) => s.id === id) % palette.length] ?? '#5aa8ff';
  };
  for (const op of data.obsPoints) {
    const st = data.stEnu.find((x) => x.s.id === op.stationId);
    if (!st) continue;
    const a = data.projectSide(st.p), b = data.projectSide(op);
    ctx.strokeStyle = colorFor(op.stationId) + '55';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(a.x), Y(a.y)); ctx.lineTo(X(b.x), Y(b.y)); ctx.stroke();
  }
  // 轨迹
  const grad = ctx.createLinearGradient(0, Y(ymax), 0, Y(ymin));
  grad.addColorStop(0, '#fb7185'); grad.addColorStop(0.5, '#fbbf24'); grad.addColorStop(1, '#7dd3fc');
  ctx.strokeStyle = grad; ctx.lineWidth = 3; ctx.shadowColor = '#7dd3fc'; ctx.shadowBlur = 10;
  ctx.beginPath();
  sidePts.forEach((p, i) => {
    if (i === 0) ctx.moveTo(X(p.x), Y(p.y));
    else ctx.lineTo(X(p.x), Y(p.y));
  });
  ctx.stroke(); ctx.shadowBlur = 0;
  // 站点
  for (const st of data.stEnu) {
    const p = data.projectSide(st.p);
    ctx.fillStyle = colorFor(st.s.id);
    ctx.beginPath(); ctx.arc(X(p.x), Y(Math.max(p.y, ymin)), 5, 0, Math.PI * 2); ctx.fill();
    ctx.font = '11.5px "PingFang SC", sans-serif';
    ctx.fillText(st.s.name, X(p.x) + 8, Y(Math.max(p.y, ymin)) - 8);
  }
  // 起点/终点高度标注
  const fp = sidePts[0], lp = sidePts[sidePts.length - 1];
  ctx.fillStyle = '#7dd3fc';
  ctx.fillText(`进入 ${rec.beginHeightKm} km`, X(fp.x) + 8, Y(fp.y) - 6);
  ctx.fillStyle = '#fb7185';
  ctx.fillText(`熄灭 ${rec.endHeightKm} km`, X(lp.x) + 8, Y(lp.y) + 16);

  // ============ 俯视图 ============
  const tx0 = split + 10, txW = cssW - split - 24;
  const tPadT = 34, tPadB = 30;
  const allE = [...data.path.map((p) => p.e), ...data.stEnu.map((s) => s.p.e)];
  const allN = [...data.path.map((p) => p.n), ...data.stEnu.map((s) => s.p.n)];
  let eMin = Math.min(...allE), eMax = Math.max(...allE), nMin = Math.min(...allN), nMax = Math.max(...allN);
  const span = Math.max(eMax - eMin, nMax - nMin, 20) * 1.15;
  const eC = (eMin + eMax) / 2, nC = (nMin + nMax) / 2;
  const TS = Math.min(txW, cssH - tPadT - tPadB);
  const tX = (e: number) => tx0 + (txW - TS) / 2 + TS / 2 + ((e - eC) / span) * TS;
  const tY = (n: number) => tPadT + TS / 2 - ((n - nC) / span) * TS;

  ctx.fillStyle = 'rgba(8,14,32,0.55)';
  ctx.fillRect(split, 0, cssW - split, cssH);
  ctx.strokeStyle = 'rgba(140,180,255,0.12)';
  ctx.strokeRect(tx0 + (txW - TS) / 2, tPadT, TS, TS);
  ctx.fillStyle = 'rgba(215,230,255,0.92)';
  ctx.font = 'bold 13px "PingFang SC", sans-serif';
  ctx.fillText('俯视：站点与地面轨迹 (ENU)', split + 16, 20);
  // 指北
  ctx.strokeStyle = 'rgba(200,220,255,0.7)';
  ctx.beginPath(); ctx.moveTo(tX(eC), tY(nC + span * 0.42)); ctx.lineTo(tX(eC), tY(nC + span * 0.34)); ctx.stroke();
  ctx.fillStyle = 'rgba(200,220,255,0.85)';
  ctx.fillText('N', tX(eC) - 4, tY(nC + span * 0.46));
  // 轨迹
  ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2.6;
  ctx.beginPath();
  data.path.forEach((p, i) => { const xx = tX(p.e), yy = tY(p.n); if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy); });
  ctx.stroke();
  const pStart = data.path[0], pEnd = data.path[data.path.length - 1];
  ctx.fillStyle = '#7dd3fc'; ctx.beginPath(); ctx.arc(tX(pStart.e), tY(pStart.n), 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fb7185'; ctx.beginPath(); ctx.arc(tX(pEnd.e), tY(pEnd.n), 4, 0, Math.PI * 2); ctx.fill();
  // 站
  for (const st of data.stEnu) {
    ctx.fillStyle = colorFor(st.s.id);
    ctx.fillRect(tX(st.p.e) - 4, tY(st.p.n) - 4, 8, 8);
    ctx.font = '11.5px "PingFang SC", sans-serif';
    ctx.fillText(st.s.name, tX(st.p.e) + 8, tY(st.p.n) + 4);
  }
}

function niceStep(range: number, ticks: number): number {
  const raw = range / ticks;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}
