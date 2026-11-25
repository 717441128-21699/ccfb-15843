// 流星群统计页：按群聚合辐射点/速度/高度，与 IMO 公布辐射点对比，Canvas 辐射点星图
import { h, mount } from '../dom';
import { store } from '../store';
import { SHOWERS, getShower } from '../../core/showers';
import { aggregateRadiants } from '../../calibration/reconstruct';
import { angularDistanceDeg } from '../../geo/astro';
import { drawStarMap } from '../star-map';
import type { MeteorRecord } from '../../core/types';

export function renderShowersPage(container: HTMLElement) {
  const all = store.meteors;
  const page = h('div');
  page.appendChild(h('div', { class: 'page-head' },
    h('div', {},
      h('h1', {}, '流星群统计'),
      h('p', {}, '同一晚多颗流星的三维速度方向聚合成实测辐射点，与流星群公布辐射点比较；验收要求偏差不超过 2°。'),
    ),
  ));

  // 总览 KPI
  const withRef = all.filter((m) => m.radiantOffsetDeg != null);
  const offsets = withRef.map((m) => m.radiantOffsetDeg!);
  const meanOff = offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : 0;
  page.appendChild(h('div', { class: 'grid cols-4 mb16' },
    kpi('入库流星', String(all.length), '颗已三维交会', 'accent'),
    kpi('归属流星群', `${new Set(all.map((m) => m.showerId).filter((s) => s && s !== 'SPO')).size}`, '个主要群'),
    kpi('单流星辐射点平均偏差', meanOff.toFixed(2) + '°', '相对公布辐射点', meanOff <= 2 ? 'good' : 'warn'),
    kpi('参与站点', String(store.stations.length), '个联网观测站'),
  ));

  // 辐射点总图
  const mapCard = h('div', { class: 'card mb16' },
    h('h2', {}, '辐射点天区图', h('span', { class: 'sub' }, '黄圈为本系统夜聚合辐射点，彩色十字为 IMO 公布位置')),
    h('canvas', { class: 'chart', id: 'radiant-map', style: 'height:440px' }),
  );
  page.appendChild(mapCard);

  // 各群卡片
  const grid = h('div', { class: 'grid cols-2' });
  for (const sh of SHOWERS) {
    if (sh.id === 'SPO') continue;
    const ms = all.filter((m) => m.showerId === sh.id);
    grid.appendChild(showerCard(sh, ms));
  }
  page.appendChild(grid);

  mount(container, page);

  requestAnimationFrame(() => {
    const cv = document.getElementById('radiant-map') as HTMLCanvasElement;
    if (!cv) return;
    // 以英仙/双子之间的天区为中心；若数据不同可自适应
    const aggs = SHOWERS.filter((s) => s.id !== 'SPO')
      .map((s) => ({ s, agg: aggregateRadiants(all.filter((m) => m.showerId === s.id)) }))
      .filter((x) => x.agg);
    const center = aggs.length
      ? aggs[0].agg!.radiant
      : { ra: 100, dec: 40 };
    drawStarMap(cv, {
      centerRa: center.ra, centerDec: center.dec, widthDeg: 120, heightPx: 440, maxMag: 4.2,
      showShowers: SHOWERS.filter((s) => s.id !== 'SPO').map((s) => ({ ra: s.ra, dec: s.dec, name: s.iau, color: s.color })),
      tracks: aggs.map(({ s, agg }) => ({
        points: [agg!.radiant], color: '#fde68a', label: `${s.iau} 实测 ${agg!.radiant.ra.toFixed(1)},${agg!.radiant.dec.toFixed(1)}`,
      })),
    });
    // 在实测点位置再画大标记由 tracks 单点不会画线 —— 用 radiant 仅支持一个；多群用 showShowers 已够，实测值在卡片中。
  });
}

function kpi(label: string, value: string, desc: string, cls = '') {
  return h('div', { class: 'card kpi' },
    h('div', { class: `v ${cls}` }, value), h('div', { class: 'l' }, label), h('div', { class: 'd' }, desc));
}

function showerCard(sh: ReturnType<typeof getShower>, ms: MeteorRecord[]) {
  if (!sh) return h('div');
  const agg = aggregateRadiants(ms);
  const catalog = { ra: sh.ra, dec: sh.dec };
  const aggOffset = agg ? angularDistanceDeg(agg.radiant, catalog) : null;
  const speeds = ms.map((m) => m.speedKms);
  const hBeg = ms.map((m) => m.beginHeightKm);
  const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

  return h('div', { class: 'card' },
    h('div', { class: 'flex' },
      h('span', { style: `width:12px;height:12px;border-radius:50%;background:${sh.color};box-shadow:0 0 10px ${sh.color}` }),
      h('h2', { style: 'margin:0' }, `${sh.nameZh}`, h('span', { class: 'sub' }, `${sh.nameEn} · ${sh.iau}`)),
      h('span', { class: 'spacer' }),
      h('span', { class: 'badge' }, `ZHR ${sh.zhr}`),
    ),
    h('div', { class: 'small dim mt8' }, `极大 ${sh.peak} · 活跃 ${sh.active[0]} ~ ${sh.active[1]} · 公布速度 ${sh.vg} km/s`),
    h('div', { class: 'hr' }),
    ms.length === 0
      ? h('div', { class: 'empty', style: 'padding:18px' }, '种子数据中该群暂无样本（可在每晚检测页生成更多夜晚）')
      : h('div', {},
        h('div', { class: 'metric-bar-row' },
          h('span', { class: 'dim' }, '样本流星'),
          h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, ms.length / 9 * 100)}%;background:${sh.color}` })),
          h('strong', {}, `${ms.length} 颗`),
        ),
        h('div', { class: 'metric-bar-row' },
          h('span', { class: 'dim' }, '夜聚合辐射偏差'),
          h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, (aggOffset ?? 0) / 2 * 100)}%;background:${(aggOffset ?? 9) <= 2 ? 'var(--good)' : 'var(--bad)'}` })),
          h('strong', { class: (aggOffset ?? 9) <= 2 ? 'flag-pass' : 'flag-fail' }, aggOffset != null ? `${aggOffset.toFixed(2)}°` : '—'),
        ),
        h('dl', { class: 'kv mt12' },
          h('dt', {}, '实测聚合辐射点'), h('dd', { class: 'mono' }, agg ? `RA ${agg.radiant.ra.toFixed(2)}° / Dec ${agg.radiant.dec.toFixed(2)}°（离散 ${agg.spreadDeg}°）` : '—'),
          h('dt', {}, '公布辐射点'), h('dd', { class: 'mono' }, `RA ${sh.ra}° / Dec ${sh.dec}°`),
          h('dt', {}, '平均速度'), h('dd', {}, `${avg(speeds).toFixed(1)} km/s（公布 ${sh.vg}）`),
          h('dt', {}, '平均进入高度'), h('dd', {}, `${avg(hBeg).toFixed(1)} km`),
        ),
        h('div', { class: 'mt12 flex wrap' },
          ...ms.slice(0, 6).map((m) => h('a', { class: 'badge accent', href: `#/meteor/${m.id}` }, m.id)),
          ms.length > 6 ? h('span', { class: 'badge' }, `+${ms.length - 6}`) : null,
        ),
      ),
  );
}
