// Canvas 星图：gnomonic 切平面投影，画真实亮星、流星赤道轨迹、辐射点
import { STARS } from '../core/catalog';
import { D2R } from '../geo/astro';
import type { RaDec } from '../core/types';

export interface StarMapTrack {
  points: RaDec[];
  color?: string;
  label?: string;
  dashed?: boolean;
}

export interface StarMapOptions {
  centerRa: number;
  centerDec: number;
  widthDeg?: number;
  heightPx?: number;
  tracks?: StarMapTrack[];
  radiant?: RaDec | null;
  radiantLabel?: string;
  compareRadiant?: RaDec | null;
  compareLabel?: string;
  showShowers?: Array<{ ra: number; dec: number; name: string; color: string }>;
  maxMag?: number;
  title?: string;
}

interface Proj { x: number; y: number; visible: boolean }

export function drawStarMap(canvas: HTMLCanvasElement, opts: StarMapOptions) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 640;
  const cssH = opts.heightPx ?? 380;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const ra0 = opts.centerRa * D2R;
  const de0 = opts.centerDec * D2R;
  const widthDeg = opts.widthDeg ?? 46;
  const k = cssW / (widthDeg * D2R); // px / rad
  const cx = cssW / 2, cy = cssH / 2;

  const project = (raD: number, decD: number): Proj => {
    const ra = raD * D2R, de = decD * D2R;
    const dra = ra - ra0;
    const cosc = Math.sin(de0) * Math.sin(de) + Math.cos(de0) * Math.cos(de) * Math.cos(dra);
    if (cosc <= 0.02) return { x: 0, y: 0, visible: false };
    const xi = (Math.cos(de) * Math.sin(dra)) / cosc;
    const eta = (Math.cos(de0) * Math.sin(de) - Math.sin(de0) * Math.cos(de) * Math.cos(dra)) / cosc;
    return { x: cx - k * xi, y: cy - k * eta, visible: true }; // 东在左
  };

  // 赤经/赤纬网格
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(130,170,255,0.10)';
  ctx.fillStyle = 'rgba(160,190,240,0.55)';
  ctx.font = '10px ui-monospace, monospace';
  for (let ra = 0; ra < 360; ra += 15) {
    ctx.beginPath();
    let started = false;
    for (let dec = -80; dec <= 80; dec += 4) {
      const p = project(ra, dec);
      if (!p.visible || p.x < -20 || p.x > cssW + 20) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  for (let dec = -60; dec <= 80; dec += 20) {
    ctx.beginPath();
    let started = false;
    for (let ra = opts.centerRa - widthDeg; ra <= opts.centerRa + widthDeg; ra += 2) {
      const p = project(((ra % 360) + 360) % 360, dec);
      if (!p.visible) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  // 恒星
  const maxMag = opts.maxMag ?? 4.6;
  for (const s of STARS) {
    if (s.mag > maxMag) continue;
    const p = project(s.ra, s.dec);
    if (!p.visible || p.x < -8 || p.x > cssW + 8 || p.y < -8 || p.y > cssH + 8) continue;
    const r = Math.max(0.6, (4.8 - s.mag) * 0.62);
    const alpha = Math.max(0.25, Math.min(1, (5.2 - s.mag) / 4));
    ctx.beginPath();
    ctx.fillStyle = s.mag < 1.2 ? `rgba(210,230,255,${alpha})` : `rgba(180,205,250,${alpha * 0.85})`;
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (s.nameZh && s.mag < 1.6) {
      ctx.fillStyle = 'rgba(190,210,255,0.75)';
      ctx.font = '11px "PingFang SC", sans-serif';
      ctx.fillText(s.nameZh, p.x + r + 3, p.y + 3);
    }
  }

  // 流星群辐射点标注
  if (opts.showShowers) {
    for (const s of opts.showShowers) {
      const p = project(s.ra, s.dec);
      if (!p.visible) continue;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.globalAlpha = 0.9;
      drawRadiantMark(ctx, p.x, p.y, 7);
      ctx.font = '11.5px "PingFang SC", sans-serif';
      ctx.fillText(s.name, p.x + 10, p.y - 8);
      ctx.globalAlpha = 1;
    }
  }

  // 轨迹
  for (const tr of opts.tracks ?? []) {
    const pts = tr.points.map((rd) => project(rd.ra, rd.dec)).filter((p) => p.visible);
    if (pts.length === 1) {
      const color = tr.color ?? '#fde68a';
      ctx.save();
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 10;
      drawRadiantMark(ctx, pts[0].x, pts[0].y, 9);
      ctx.restore();
      if (tr.label) { ctx.fillStyle = color; ctx.font = '11.5px "PingFang SC", sans-serif'; ctx.fillText(tr.label, pts[0].x + 12, pts[0].y + 4); }
      continue;
    }
    if (pts.length < 2) continue;
    const color = tr.color ?? '#7dd3fc';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (tr.dashed) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.restore();
    // 观测点
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.fillStyle = i === 0 ? '#34d399' : i === pts.length - 1 ? '#fb7185' : 'rgba(180,225,255,0.9)';
      ctx.arc(p.x, p.y, i === 0 || i === pts.length - 1 ? 3.4 : 2.1, 0, Math.PI * 2);
      ctx.fill();
    });
    if (tr.label) {
      ctx.fillStyle = color;
      ctx.font = '12px "PingFang SC", sans-serif';
      ctx.fillText(tr.label, pts[0].x + 8, pts[0].y + 4);
    }
  }

  // 本次辐射点（三维轨迹反推）
  if (opts.radiant) {
    const p = project(opts.radiant.ra, opts.radiant.dec);
    if (p.visible) {
      ctx.save();
      ctx.strokeStyle = '#fde68a';
      ctx.fillStyle = '#fde68a';
      ctx.shadowColor = '#fbbf24'; ctx.shadowBlur = 12;
      drawRadiantMark(ctx, p.x, p.y, 11);
      ctx.restore();
      ctx.font = 'bold 12.5px "PingFang SC", sans-serif';
      ctx.fillStyle = '#fde68a';
      ctx.fillText(opts.radiantLabel ?? '反推辐射点', p.x + 13, p.y + 4);
    }
  }
  if (opts.compareRadiant) {
    const p = project(opts.compareRadiant.ra, opts.compareRadiant.dec);
    if (p.visible) {
      ctx.strokeStyle = '#34d399';
      ctx.fillStyle = '#34d399';
      drawRadiantMark(ctx, p.x, p.y, 9, true);
      ctx.font = '12px "PingFang SC", sans-serif';
      ctx.fillText(opts.compareLabel ?? '公布辐射点', p.x + 12, p.y + 16);
    }
  }

  // 标题
  if (opts.title) {
    ctx.fillStyle = 'rgba(220,232,255,0.9)';
    ctx.font = 'bold 13px "PingFang SC", sans-serif';
    ctx.fillText(opts.title, 14, 22);
  }
}

function drawRadiantMark(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, circleOnly = false) {
  ctx.beginPath();
  ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
  ctx.stroke();
  if (circleOnly) return;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7);
    ctx.lineTo(x + Math.cos(a) * r * 1.5, y + Math.sin(a) * r * 1.5);
    ctx.stroke();
  }
}
