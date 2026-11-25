// 每晚检测页：夜列表、Worker 合成检测、真实视频上传抽帧检测、流星卡片与排除统计
import { h, mount, toast } from '../dom';
import { store } from '../store';
import { workerApi, onProgress } from '../worker-client';
import { getShower } from '../../core/showers';
import { fovDeg } from '../../geo/camera';
import type { NightRecord, Station } from '../../core/types';

const ui = {
  selectedId: store.nights[0]?.id ?? '',
  running: false,
  progress: 0,
  stage: '',
  liveSummary: null as null | { night: NightRecord; stationSummary: Record<string, any> },
  uploadBusy: false,
  uploadMsg: '',
};

export function renderNightsPage(container: HTMLElement) {
  if (!ui.selectedId || !store.nights.some((n) => n.id === ui.selectedId)) {
    ui.selectedId = store.nights[0]?.id ?? '';
  }
  const page = h('div');

  page.appendChild(h('div', { class: 'page-head' },
    h('div', {},
      h('h1', {}, '每晚视频检测'),
      h('p', {}, '逐帧与运动星空背景相减，连通域 + 多帧直线轨迹关联，自动排除飞机航灯、卫星反光、虚焦飞虫与闪电。重计算全部在 Web Worker 中进行，不阻塞界面。'),
    ),
    h('div', { class: 'flex wrap' },
      h('button', { class: 'btn', disabled: ui.running, onclick: runSynthNight },
        ui.running ? h('span', { class: 'spin' }) : '✨', ui.running ? '检测中…' : '合成并检测演示夜'),
      h('button', { class: 'btn ghost', onclick: () => document.getElementById('upload-input')?.click() }, '⬆ 上传真实视频'),
      h('input', { id: 'upload-input', type: 'file', accept: 'video/*', style: 'display:none', onchange: handleUpload } as any),
    ),
  ));

  if (ui.running) {
    page.appendChild(h('div', { class: 'card mb16' },
      h('div', { class: 'flex mb8' }, h('strong', {}, 'Worker 正在逐帧处理'), h('span', { class: 'spacer' }), h('span', { class: 'small mono' }, `${(ui.progress * 100) | 0}% · ${ui.stage}`)),
      h('div', { class: 'progress' }, h('i', { style: `width:${ui.progress * 100}%` })),
    ));
  }
  if (ui.uploadMsg) {
    page.appendChild(h('div', { class: 'card mb16 small' }, ui.uploadMsg));
  }

  const layout = h('div', { class: 'grid', style: 'grid-template-columns: 320px 1fr; gap:16px; align-items:start;' });
  // 夜列表
  const listCard = h('div', { class: 'card tight' }, h('h3', { style: 'padding:6px 8px' }, `夜晚列表（${store.nights.length}）`));
  for (const n of store.nights) listCard.appendChild(nightListItem(n));
  layout.appendChild(listCard);

  const detail = h('div', {});
  const night = store.nights.find((n) => n.id === ui.selectedId);
  if (night) detail.appendChild(nightDetail(night));
  else detail.appendChild(h('div', { class: 'card empty' }, h('div', { class: 'big' }, '🌌'), '还没有夜晚数据，点击右上角「合成并检测演示夜」开始。'));
  layout.appendChild(detail);
  page.appendChild(layout);

  mount(container, page);
}

function nightListItem(n: NightRecord) {
  const sh = getShower(n.showerId);
  const active = n.id === ui.selectedId;
  return h('div', {
    class: 'list-row clickable',
    style: active ? 'background:rgba(96,165,250,.12);border-radius:10px;' : 'border-radius:10px;',
    onclick: () => { ui.selectedId = n.id; ui.liveSummary = null; renderNightsPage(document.getElementById('page')!); },
  },
    h('div', {
      style: 'width:10px;height:38px;border-radius:4px;background:' + (sh?.color ?? '#64748b'),
    }),
    h('div', { class: 'list-main' },
      h('div', { class: 'list-title' }, n.label),
      h('div', { class: 'list-sub' }, `${n.date} · ${n.stationIds.length} 站 · ${n.meteorIds.length} 颗 · ${n.durationMin} min`),
    ),
    h('span', { class: `badge ${n.status === 'processed' ? 'accent' : 'good'}` }, n.status === 'processed' ? '新检测' : '种子'),
  );
}

function nightDetail(night: NightRecord): HTMLElement {
  const mets = store.nightMeteors(night.id);
  const sh = getShower(night.showerId);
  const wrap = h('div', {});

  const headCard = h('div', { class: 'card mb16' },
    h('div', { class: 'flex wrap' },
      h('h2', { style: 'margin:0' }, night.label),
      sh ? h('span', { class: 'badge accent' }, sh.nameZh) : null,
      h('span', { class: 'badge' }, `${night.stationIds.length} 站联合`),
      h('span', { class: 'badge good' }, `${mets.length} 颗三维成果`),
      h('span', { class: 'spacer' }),
      h('span', { class: 'dim small' }, `${night.date} · ${night.frames} 帧/站`),
    ),
    night.notes ? h('p', { class: 'dim small mt8', style: 'margin-bottom:0' }, night.notes) : null,
  );
  wrap.appendChild(headCard);

  // 实时检测的各站摘要
  if (ui.liveSummary && ui.liveSummary.night.id === night.id) {
    wrap.appendChild(liveSummaryCard(ui.liveSummary.stationSummary));
  } else if (night.rejectKinds) {
    wrap.appendChild(rejectKindsCard(night.rejectKinds));
  }

  if (!mets.length) {
    wrap.appendChild(h('div', { class: 'card empty' }, h('div', { class: 'big' }, '☄️'), '这一夜没有达到多站交会条件的流星。'));
    return wrap;
  }

  const grid = h('div', { class: 'grid cols-2' });
  for (const m of mets) {
    const msh = getShower(m.showerId);
    grid.appendChild(h('div', {
      class: 'card clickable',
      style: 'cursor:pointer;display:flex;gap:14px;',
      onclick: () => { location.hash = `#/meteor/${m.id}`; },
    },
      m.thumbnail
        ? h('img', { class: 'meteor-thumb', src: m.thumbnail, alt: m.id })
        : h('div', { class: 'thumb-placeholder' }, '无缩略图'),
      h('div', { style: 'min-width:0;flex:1' },
        h('div', { class: 'list-title' },
          h('span', {}, m.id),
          msh ? h('span', { class: 'badge', style: `color:${msh.color};border-color:${msh.color}55` }, msh.iau) : null,
          m.reference ? h('span', { class: 'badge good' }, `高度误差 ${m.heightErrorPct}%`) : null,
        ),
        h('div', { class: 'small dim mt8' },
          `进入 ${m.beginHeightKm} km · 熄灭 ${m.endHeightKm} km`, h('br'),
          `速度 ${m.speedKms} km/s · 辐射 ${m.radiant.ra.toFixed(1)}°,${m.radiant.dec.toFixed(1)}°`, h('br'),
          `${m.stationCount} 站 · 交会角 ${m.convergenceDeg}° · 时长 ${m.durationS}s`,
        ),
      ),
    ));
  }
  wrap.appendChild(grid);
  return wrap;
}

function rejectKindsCard(kinds: Record<string, number>) {
  const total = Object.values(kinds).reduce((a, b) => a + b, 0);
  const labels: Record<string, string> = {
    aircraft: '飞机航灯', satellite: '卫星反光', insect: '飞虫', lightning: '闪电', noise: '噪声/短轨迹', short: '过短', unknown: '其他',
  };
  return h('div', { class: 'card mb16' },
    h('h3', {}, '自动排除目标统计', h('span', { class: 'sub' }, `共 ${total} 条候选轨迹未认定为流星`)),
    h('div', { class: 'pill-kinds mt8' },
      ...Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
        h('span', { class: `kind-chip ${k}` }, `${labels[k] ?? k} × ${v}`)),
    ),
  );
}

function liveSummaryCard(sum: Record<string, any>) {
  const card = h('div', { class: 'card mb16' }, h('h3', {}, '本次 Worker 检测详情'));
  for (const [sid, s] of Object.entries(sum)) {
    const st = store.getStation(sid);
    card.appendChild(h('div', { class: 'mt12' },
      h('div', { class: 'flex' },
        h('strong', {}, st?.name ?? sid),
        h('span', { class: 'badge good' }, `标定 ${s.matchedStars} 星 / ${s.rmsArcsec}"`),
        h('span', { class: 'badge accent' }, `流星轨迹 ${s.tracks}`),
        h('span', { class: 'badge' }, `排除 ${s.rejected}`),
      ),
      h('div', { class: 'pill-kinds mt8' },
        ...Object.entries(s.rejectKinds).map(([k, v]) => h('span', { class: `kind-chip ${k}` }, `${rejectLabel(k)} × ${v}`))),
    ));
  }
  return card;
}

function rejectLabel(k: string) {
  return ({ aircraft: '飞机', satellite: '卫星', insect: '飞虫', lightning: '闪电', noise: '噪声', short: '过短', unknown: '其他' } as Record<string, string>)[k] ?? k;
}

async function runSynthNight() {
  ui.running = true; ui.progress = 0; ui.stage = '排队中';
  renderNightsPage(document.getElementById('page')!);
  const off = onProgress((p) => { ui.progress = p.pct; ui.stage = p.stage; updateProgressOnly(); });
  try {
    const showerPool = ['PER', 'GEM', 'LEO', 'ORI', 'QUA'];
    const showerId = showerPool[Math.floor(Math.random() * showerPool.length)];
    const nightId = `live-${Date.now()}`;
    const res = await workerApi.runSynth({
      nightId, showerId,
      epochMs: Date.UTC(2025, 7, 12, 18, 0, 0),
      durationS: 60, count: 6, seed: (Date.now() % 99991) | 0,
      width: 640, height: 360, fps: 15,
      label: `实时合成夜 · ${getShower(showerId)?.nameZh ?? showerId}`,
    });
    res.night.id = nightId;
    store.addProcessedNight(res.night, res.records);
    ui.selectedId = nightId;
    ui.liveSummary = { night: res.night, stationSummary: res.stationSummary };
    toast(`检测完成：${res.records.length} 颗流星完成多站交会（真值 ${res.truthCount}）`, 'good', 5000);
  } catch (e) {
    toast(`合成检测失败：${(e as Error).message}`, 'bad', 6000);
  } finally {
    off();
    ui.running = false;
    renderNightsPage(document.getElementById('page')!);
  }
}

function updateProgressOnly() {
  const bar = document.querySelector('.progress > i') as HTMLElement | null;
  const txt = document.querySelector('.card .mono');
  if (bar) bar.style.width = `${ui.progress * 100}%`;
  if (txt) txt.textContent = `${(ui.progress * 100) | 0}% · ${ui.stage}`;
}

async function handleUpload(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  // 选择站点
  const station = await pickStationModal();
  if (!station) return;
  ui.uploadBusy = true;
  ui.uploadMsg = `正在读取视频 ${file.name}…`;
  renderNightsPage(document.getElementById('page')!);
  try {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url; video.muted = true; video.playsInline = true;
    await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = rej; });
    const VW = 640;
    const scale = VW / video.videoWidth;
    const W = VW, H = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const cctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const fov = fovDeg(station.camera);
    await workerApi.initDetect({
      stationId: station.id, nightId: ui.selectedId || 'upload', width: W, height: H,
      fps: 15, degPerPx: fov.h / W,
    });
    await video.play();
    let index = 0;
    let lastT = -1;
    await new Promise<void>((resolve) => {
      const tick = async () => {
        if (video.ended || video.paused) { resolve(); return; }
        if (video.currentTime - lastT >= 1 / 15) {
          lastT = video.currentTime;
          cctx.drawImage(video, 0, 0, W, H);
          const data = cctx.getImageData(0, 0, W, H).data;
          const buf = data.buffer.slice(0);
          await workerApi.pushRgbaFrame(buf, W, H, video.currentTime * 1000, index++);
          ui.uploadMsg = `正在抽帧检测：${video.currentTime.toFixed(1)}s / ${video.duration.toFixed(0)}s，已处理 ${index} 帧`;
          const el = document.querySelector('.card.mb16.small');
          if (el) el.textContent = ui.uploadMsg;
        }
        requestAnimationFrame(() => void tick());
      };
      void tick();
    });
    const { result } = await workerApi.finishDetect();
    URL.revokeObjectURL(url);
    const kinds: Record<string, number> = {};
    for (const r of result.rejected) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    ui.uploadMsg = `视频处理完成：${result.framesProcessed} 帧，确认流星轨迹 ${result.tracks.length} 条，排除 ${result.rejected.length} 条（${Object.entries(kinds).map(([k, v]) => `${rejectLabel(k)}×${v}`).join('，')}）。上传视频为单站观测，多站交会请在对应夜晚再处理其他站点。`;
    toast(`检出 ${result.tracks.length} 条流星轨迹`, result.tracks.length ? 'good' : '');
  } catch (e) {
    ui.uploadMsg = `视频处理失败：${(e as Error).message}`;
    toast(ui.uploadMsg, 'bad');
  } finally {
    ui.uploadBusy = false;
    renderNightsPage(document.getElementById('page')!);
  }
}

function pickStationModal(): Promise<Station | null> {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const choose = (s: Station | null) => { back.remove(); resolve(s); };
    const modal = h('div', { class: 'card modal' },
      h('h2', {}, '选择视频所属站点'),
      h('p', { class: 'dim small' }, '抽帧尺寸会缩放到宽 640，检测在 Worker 中运行。'),
      h('div', { class: 'grid mt12', style: 'gap:8px' },
        ...store.stations.map((s) => h('button', { class: 'btn ghost', style: 'justify-content:flex-start', onclick: () => choose(s) },
          `${s.name}（${s.id}）`))),
      h('div', { class: 'mt16 right' }, h('button', { class: 'btn ghost', onclick: () => choose(null) }, '取消')),
    );
    back.appendChild(modal);
    back.addEventListener('click', (e) => { if (e.target === back) choose(null); });
    document.body.appendChild(back);
  });
}
