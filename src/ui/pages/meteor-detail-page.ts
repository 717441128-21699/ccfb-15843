// 单颗流星详情：KPI、参考网络对比、Canvas 星图、三维交会几何、逐帧赤道坐标
import { h, mount } from '../dom';
import { store } from '../store';
import { getShower } from '../../core/showers';
import { drawStarMap } from '../star-map';
import { drawGeometry } from '../geometry-canvas';
import { raDecToEci, meanUnitVectors, eciToRaDec } from '../../geo/astro';
import type { EquatorialObservation } from '../../core/types';

export function renderMeteorDetail(container: HTMLElement, id: string) {
  const m = store.getMeteor(id);
  if (!m) {
    mount(container, h('div', { class: 'card empty' }, h('div', { class: 'big' }, '🔭'), '未找到该流星记录', h('div', { class: 'mt12' }, h('a', { href: '#/nights' }, '← 返回每晚检测'))));
    return;
  }
  const sh = getShower(m.showerId);
  const page = h('div');

  page.appendChild(h('div', { class: 'page-head' },
    h('div', {},
      h('div', { class: 'small mb8' }, h('a', { href: '#/nights' }, '← 返回每晚检测')),
      h('h1', { class: 'flex wrap' },
        h('span', {}, m.id),
        sh ? h('span', { class: 'badge accent', style: `color:${sh.color};border-color:${sh.color}66` }, `${sh.nameZh} ${sh.iau}`) : h('span', { class: 'badge' }, '偶发流星'),
        m.reference ? h('span', { class: 'badge good' }, '已有参考网络解对比') : null,
      ),
      h('p', {}, `所属夜晚 ${m.nightId} · 检测置信度 ${(m.score * 100) | 0} · ${m.stationCount} 站交会 · 交会角 ${m.convergenceDeg}°`),
    ),
  ));

  // KPI
  page.appendChild(h('div', { class: 'grid cols-4 mb16' },
    kpi('进入大气高度', `${m.beginHeightKm}`, 'km（首次观测）', 'accent'),
    kpi('熄灭高度', `${m.endHeightKm}`, 'km（末次观测）'),
    kpi('地心速度', `${m.speedKms}`, 'km/s', m.speedErrorPct != null && m.speedErrorPct <= 5 ? 'good' : ''),
    kpi('持续时间', `${m.durationS}`, `s · 视星等约 ${m.magnitude}`),
  ));

  // 参考对比
  if (m.reference) {
    page.appendChild(comparisonCard(m));
  }

  // 星图 + 信息
  const mid = h('div', { class: 'grid cols-2 mb16' });
  const starCard = h('div', { class: 'card' },
    h('h2', {}, '天文星图与辐射点', h('span', { class: 'sub' }, '像素→RA/Dec，各站颜色不同')),
    h('canvas', { class: 'chart', id: 'star-canvas' }),
    h('div', { class: 'canvas-legend' },
      legend('#5aa8ff', '兴隆'), legend('#34d399', '房山'), legend('#fbbf24', '青龙'),
      legend('#fde68a', '三维反推辐射点'), legend('#34d399', '流星群公布辐射点'),
    ),
  );
  const infoCard = h('div', { class: 'card' },
    h('h2', {}, '轨道与交会参数'),
    h('dl', { class: 'kv' },
      kv('反推辐射点 RA', `${m.radiant.ra.toFixed(3)}°`),
      kv('反推辐射点 Dec', `${m.radiant.dec.toFixed(3)}°`),
      kv('群公布辐射点', sh && !Number.isNaN(sh.ra) ? `RA ${sh.ra}° / Dec ${sh.dec}°` : '—'),
      kv('与公布辐射点偏差', m.radiantOffsetDeg != null ? `${m.radiantOffsetDeg}°` : '—'),
      kv('拟合视线残差 RMS', m.trajectory ? `${m.trajectory.rmsResidualM} m` : '—'),
      kv('最大残差', m.trajectory ? `${m.trajectory.maxResidualM} m` : '—'),
      kv('观测条数', `${m.equatorial.length}`),
      kv('参与站点', m.stations.join('、')),
    ),
    m.thumbnail ? h('img', { src: m.thumbnail, class: 'mt12', style: 'width:100%;border-radius:10px;border:1px solid var(--line)' }) : null,
  );
  mid.appendChild(starCard); mid.appendChild(infoCard);
  page.appendChild(mid);

  // 几何图
  page.appendChild(h('div', { class: 'card mb16' },
    h('h2', {}, '多站视线交会与三维轨迹'),
    h('canvas', { class: 'chart', id: 'geom-canvas' }),
  ));

  // 逐帧表
  page.appendChild(obsTable(m.equatorial));

  mount(container, page);

  // 绘制
  requestAnimationFrame(() => {
    const sc = document.getElementById('star-canvas') as HTMLCanvasElement;
    if (sc) {
      const center = meanRaDec(m.equatorial);
      const span = raDecSpan(m.equatorial, center);
      const stationColors: Record<string, string> = { 'ST-XL': '#5aa8ff', 'ST-FS': '#34d399', 'ST-QL': '#fbbf24' };
      const byStation = new Map<string, EquatorialObservation[]>();
      for (const o of m.equatorial) {
        if (!byStation.has(o.stationId)) byStation.set(o.stationId, []);
        byStation.get(o.stationId)!.push(o);
      }
      drawStarMap(sc, {
        centerRa: center.ra, centerDec: center.dec,
        widthDeg: Math.max(18, Math.min(70, span * 1.5)),
        heightPx: 400, maxMag: 4.8,
        tracks: [...byStation.entries()].map(([sid, obs]) => ({
          points: obs, color: stationColors[sid] ?? '#7dd3fc', label: sid,
        })),
        radiant: m.radiant, radiantLabel: '该流星辐射点',
        compareRadiant: sh && !Number.isNaN(sh.ra) ? { ra: sh.ra, dec: sh.dec } : null,
        compareLabel: `${sh?.iau} 公布`,
      });
    }
    const gc = document.getElementById('geom-canvas') as HTMLCanvasElement;
    if (gc) drawGeometry(gc, m, store.stations);
  });
}

function kpi(label: string, value: string, unit: string, cls = '') {
  return h('div', { class: 'card kpi' },
    h('div', { class: `v ${cls}` }, value),
    h('div', { class: 'l' }, label),
    h('div', { class: 'd' }, unit),
  );
}
function kv(k: string, v: string) { return [h('dt', {}, k), h('dd', { class: 'mono' }, v)]; }
function legend(color: string, text: string) {
  return h('span', { class: 'li' }, h('span', { class: 'swatch', style: `background:${color}` }), text);
}

function comparisonCard(m: NonNullable<ReturnType<typeof store.getMeteor>>) {
  const r = m.reference!;
  const hErr = m.heightErrorPct ?? 0, vErr = m.speedErrorPct ?? 0;
  return h('div', { class: 'card mb16' },
    h('h2', {}, '与公开流星网络参考解对比', h('span', { class: 'sub' }, r.network)),
    h('div', { class: 'grid cols-2 mt12' },
      errorBar('进入高度', m.beginHeightKm, r.beginHeightKm, hErr, 'km'),
      errorBar('速度', m.speedKms, r.speedKms, vErr, 'km/s'),
    ),
    h('p', { class: 'tiny muted mt12', style: 'margin-bottom:0' },
      '验证体系中参考解由带真值的多群流星合成视频给出，等价于公开网络（GMN/CAMS/EDMOND）对同一颗流星的联合解；验收线为相对偏差 ≤5%。'),
  );
}

function errorBar(label: string, ours: number, ref: number, errPct: number, unit: string) {
  const pass = errPct <= 5;
  return h('div', {},
    h('div', { class: 'flex small' },
      h('strong', {}, label), h('span', { class: 'spacer' }),
      h('span', { class: pass ? 'flag-pass' : 'flag-fail' }, `${errPct.toFixed(2)}% ${pass ? '✓ ≤5%' : '✗'}`)),
    h('div', { class: 'tiny dim mt8' }, `本系统 ${ours} ${unit} · 参考 ${ref} ${unit}`),
    h('div', { class: 'bar mt8' }, h('i', { style: `width:${Math.min(100, errPct * 12)}%;background:${pass ? 'var(--good)' : 'var(--bad)'}` })),
  );
}

function obsTable(obs: EquatorialObservation[]) {
  const rows = obs.slice(0, 60);
  return h('div', { class: 'card' },
    h('h2', {}, '逐帧赤道坐标观测', h('span', { class: 'sub' }, `展示前 ${rows.length} / ${obs.length} 条`)),
    h('div', { style: 'overflow-x:auto' },
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '站'), h('th', {}, '帧'), h('th', {}, 'RA (°)'), h('th', {}, 'Dec (°)'), h('th', {}, '像素 x,y'), h('th', {}, 'UTC'),
        )),
        h('tbody', {},
          ...rows.map((o) => h('tr', {},
            h('td', {}, o.stationId),
            h('td', { class: 'mono' }, String(o.frame)),
            h('td', { class: 'mono' }, o.ra.toFixed(4)),
            h('td', { class: 'mono' }, o.dec.toFixed(4)),
            h('td', { class: 'mono tiny' }, `${o.x.toFixed(1)}, ${o.y.toFixed(1)}`),
            h('td', { class: 'mono tiny' }, new Date(o.time).toISOString().slice(11, 23)),
          )),
        ),
      ),
    ),
  );
}

function meanRaDec(obs: EquatorialObservation[]) {
  const vecs = obs.map((o) => raDecToEci(o.ra, o.dec));
  const mean = meanUnitVectors(vecs);
  return eciToRaDec(mean);
}

function raDecSpan(obs: EquatorialObservation[], c: { ra: number; dec: number }): number {
  let m = 4;
  for (const o of obs) {
    let dra = Math.abs(o.ra - c.ra);
    if (dra > 180) dra = 360 - dra;
    m = Math.max(m, dra * Math.cos(c.dec * Math.PI / 180), Math.abs(o.dec - c.dec));
  }
  return m * 2.2;
}
