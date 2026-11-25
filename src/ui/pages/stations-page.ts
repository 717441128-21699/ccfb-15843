// 站点管理页：站网列表、相机参数、天文标定、新增站点
import { h, mount, toast } from '../dom';
import { store } from '../store';
import { workerApi } from '../worker-client';
import { fovDeg } from '../../geo/camera';
import { D2R } from '../../geo/astro';
import { drawStarMap } from '../star-map';
import type { CalibrationResult } from '../../calibration/plate';
import type { Station } from '../../core/types';

const calCache = new Map<string, CalibrationResult>();

export function renderStationsPage(container: HTMLElement) {
  const page = h('div', {});

  const head = h('div', { class: 'page-head' },
    h('div', {},
      h('h1', {}, '观测站点管理'),
      h('p', {}, '每个站点按画面中的真实恒星位置完成天文标定（gnomonic 底片模型 + 迭代离群剔除），像素轨迹由此转换为赤经赤纬。三站构成 40–180 km 基线网。'),
    ),
    h('div', { class: 'flex' },
      h('button', { class: 'btn', onclick: () => openStationModal(() => renderStationsPage(container)) }, '＋ 新增站点'),
    ),
  );
  page.appendChild(head);

  // KPI
  const baseline = baselineStats();
  const kpis = h('div', { class: 'grid cols-4 mb16' },
    kpi('站点数量', String(store.stations.length), '个楼顶观测点', 'accent'),
    kpi('基线范围', `${baseline.min.toFixed(0)}–${baseline.max.toFixed(0)} km`, '站间距离'),
    kpi('公共观测区高度', '96 km', '冀北高空流星层'),
    kpi('标定星表', '1627 颗', 'Hipparcos 亮星 mag≤5.0'),
  );
  page.appendChild(kpis);

  const grid = h('div', { class: 'grid cols-2' });
  for (const st of store.stations) grid.appendChild(stationCard(st));
  page.appendChild(grid);

  mount(container, page);

  // 自动标定未缓存的站
  for (const st of store.stations) {
    if (!calCache.has(st.id)) runCalibration(st, () => {
      if (container.isConnected) renderStationsPage(container);
    });
  }
}

function kpi(label: string, value: string, desc: string, cls = '') {
  return h('div', { class: 'card kpi' },
    h('div', { class: `v ${cls}` }, value),
    h('div', { class: 'l' }, label),
    h('div', { class: 'd' }, desc),
  );
}

function baselineStats() {
  const ds: number[] = [];
  for (let i = 0; i < store.stations.length; i++)
    for (let j = i + 1; j < store.stations.length; j++)
      ds.push(haversineKm(store.stations[i], store.stations[j]));
  return { min: ds.length ? Math.min(...ds) : 0, max: ds.length ? Math.max(...ds) : 0 };
}

function haversineKm(a: Station, b: Station): number {
  const R = 6371;
  const dLat = (b.location.lat - a.location.lat) * D2R;
  const dLng = (b.location.lng - a.location.lng) * D2R;
  const la1 = a.location.lat * D2R, la2 = b.location.lat * D2R;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function stationCard(st: Station): HTMLElement {
  const fov = fovDeg(st.camera);
  const cached = calCache.get(st.id);

  const statusLine = h('div', { class: 'flex wrap mt8' },
    cached
      ? h('span', { class: 'badge good' }, h('span', { class: 'dot' }), `已标定 ${cached.solution.matchedStars} 星`)
      : h('span', { class: 'badge warn' }, h('span', { class: 'spin' }), '标定中…'),
    cached ? h('span', { class: 'badge' }, `RMS ${cached.solution.rmsArcsec}"`) : null,
    cached ? h('span', { class: 'badge' }, `${cached.solution.plateScaleArcsecPx}"/px`) : null,
  );

  const card = h('div', { class: 'card' },
    h('div', { class: 'flex' },
      h('div', { class: 'spacer' },
        h('h2', {}, st.name, h('span', { class: 'sub' }, st.id)),
        h('div', { class: 'dim small' }, `${st.city} · ${st.installed} 安装`),
      ),
      store.stations.find((x) => x.id === st.id) && !['ST-XL', 'ST-FS', 'ST-QL'].includes(st.id)
        ? h('button', {
          class: 'btn sm danger',
          onclick: () => { store.removeStation(st.id); toast('站点已删除', ''); location.hash = '#/stations'; },
        }, '删除')
        : null,
    ),
    h('dl', { class: 'kv mt12' },
      h('dt', {}, '坐标'), h('dd', { class: 'mono' }, `${st.location.lat.toFixed(4)}°N, ${st.location.lng.toFixed(4)}°E, ${st.location.alt}m`),
      h('dt', {}, '光轴'), h('dd', {}, `方位 ${st.camera.az.toFixed(1)}° / 高度 ${st.camera.alt.toFixed(1)}°`),
      h('dt', {}, '相机'), h('dd', {}, `${st.camera.width}×${st.camera.height} @${st.camera.fps}fps · 水平视场 ${fov.h.toFixed(1)}° × 垂直 ${fov.v.toFixed(1)}°`),
      st.note ? [h('dt', {}, '备注'), h('dd', { class: 'dim' }, st.note)] : null,
    ),
    statusLine,
  );

  if (cached) {
    const canvas = h('canvas', { class: 'chart mt12' }) as HTMLCanvasElement;
    canvas.style.height = '230px';
    card.appendChild(canvas);
    const m = cached.matches;
    const raC = m.reduce((a, x) => a + x.ra, 0) / m.length;
    const deC = m.reduce((a, x) => a + x.dec, 0) / m.length;
    requestAnimationFrame(() => drawStarMap(canvas, {
      centerRa: raC, centerDec: deC, widthDeg: fov.h + 6, heightPx: 230, maxMag: 5,
      title: `标定星场（${m.length} 颗匹配，残差 ${cached.solution.rmsPx}px）`,
    }));
    card.appendChild(h('div', { class: 'tiny muted mt8' },
      `仿射底片模型已写入：像素 ↔ ENU 射线；标定时刻 ${new Date(cached.solution.calibratedAt).toISOString().slice(11, 19)} UTC。`,
    ));
    card.appendChild(h('div', { class: 'mt12 flex' },
      h('button', {
        class: 'btn sm ghost',
        onclick: () => {
          calCache.delete(st.id);
          renderStationsPage(document.getElementById('page')!);
          runCalibration(st, () => renderStationsPage(document.getElementById('page')!));
        },
      }, '重新标定'),
    ));
  }
  return card;
}

async function runCalibration(st: Station, done: () => void) {
  try {
    const timeMs = Date.UTC(2025, 7, 12, 22, 0, 0);
    const { result } = await workerApi.calibrate(st, timeMs);
    calCache.set(st.id, result);
  } catch (e) {
    toast(`标定失败：${(e as Error).message}`, 'bad');
  } finally {
    done();
  }
}

function openStationModal(onSaved: () => void) {
  const back = h('div', { class: 'modal-back' });
  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });

  const id = `ST-CUSTOM-${Date.now() % 100000}`;
  const fields = {
    name: textField('站点名称', '例如：大同站'),
    city: textField('城市', '山西大同'),
    lat: numField('纬度 °N', '40.08'),
    lng: numField('经度 °E', '113.30'),
    alt: numField('海拔 m', '1050'),
    az: numField('光轴方位角（北=0）', '180'),
    camAlt: numField('光轴高度角', '52'),
    hFov: numField('水平视场 °', '76'),
    fps: numField('帧率', '15'),
  };

  const modal = h('div', { class: 'card modal' },
    h('h2', {}, '新增观测站点'),
    h('p', { class: 'dim small' }, '相机统一为 800×450，像素焦距由水平视场换算。保存后可在检测/交会中使用。'),
    h('div', { class: 'form-row mt12' },
      fields.name.wrap, fields.city.wrap,
      fields.lat.wrap, fields.lng.wrap,
      fields.alt.wrap, fields.fps.wrap,
      fields.az.wrap, fields.camAlt.wrap,
      fields.hFov.wrap,
    ),
    h('div', { class: 'flex mt16' },
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onclick: close }, '取消'),
      h('button', {
        class: 'btn',
        onclick: () => {
          const name = fields.name.input.value.trim();
          if (!name) { toast('请填写站点名称', 'bad'); return; }
          const hFov = Number(fields.hFov.input.value) || 76;
          const fx = 800 / 2 / Math.tan(hFov * D2R / 2);
          const st: Station = {
            id, name, city: fields.city.input.value.trim() || '未填写',
            location: {
              lat: Number(fields.lat.input.value), lng: Number(fields.lng.input.value),
              alt: Number(fields.alt.input.value) || 0,
            },
            camera: {
              width: 800, height: 450, fps: Number(fields.fps.input.value) || 15,
              fx, fy: fx, cx: 400, cy: 225,
              az: Number(fields.az.input.value), alt: Number(fields.camAlt.input.value),
            },
            installed: new Date().toISOString().slice(0, 10),
            note: '用户新增站点',
          };
          store.addStation(st);
          close();
          toast(`站点「${name}」已保存`, 'good');
          onSaved();
        },
      }, '保存站点'),
    ),
  );
  back.appendChild(modal);
  document.body.appendChild(back);
}

function textField(label: string, ph: string) {
  const input = h('input', { placeholder: ph, value: '' }) as HTMLInputElement;
  return { wrap: h('label', { class: 'field' }, label, input), input };
}
function numField(label: string, value: string) {
  const input = h('input', { type: 'number', value }) as HTMLInputElement;
  return { wrap: h('label', { class: 'field' }, label, input), input };
}
