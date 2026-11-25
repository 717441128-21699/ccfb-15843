// 系统验证页：展示 scripts/validate 对合成真值视频的完整指标
import { h, mount } from '../dom';
import { validationReport } from '../store';

export function renderValidationPage(container: HTMLElement) {
  const r = validationReport;
  const has = !!r.generatedAt;
  const page = h('div');
  page.appendChild(h('div', { class: 'page-head' },
    h('div', {},
      h('h1', {}, '精度验证与验收指标'),
      h('p', {}, '按象限仪、英仙、猎户、狮子、双子五个流星群合成带真值的多站视频，跑与线上完全相同的检测—标定—交会代码，统计召回率、误报/小时、辐射点偏差和高度/速度相对真值误差。'),
    ),
    h('span', { class: has ? 'badge good' : 'badge warn' }, has ? `报告生成于 ${new Date(r.generatedAt!).toLocaleString()}` : '尚未运行完整验证'),
  ));

  if (!has) {
    page.appendChild(h('div', { class: 'card empty' },
      h('div', { class: 'big' }, '🧪'),
      h('div', {}, '还没有验证报告。在项目目录运行'),
      h('p', { class: 'mono mt12' }, 'npm run validate'),
      h('div', { class: 'dim small' }, '快速模式：npx tsx scripts/validate.ts --quick'),
    ));
    mount(container, page);
    return;
  }

  const allPass = r.acceptance.every((a) => a.pass);
  page.appendChild(h('div', { class: 'card mb16', style: allPass ? 'border-color:rgba(52,211,153,.5)' : 'border-color:rgba(251,191,36,.5)' },
    h('div', { class: 'flex' },
      h('span', { style: 'font-size:26px' }, allPass ? '✅' : '⚠️'),
      h('div', {}, h('h2', { style: 'margin:0' }, allPass ? '全部验收指标通过' : '部分指标尚未达标'),
        h('div', { class: 'dim small' }, `真值流星 ${r.meteorTruth} · 种子 ${r.seeds.join(', ')} · 误报测试 ${r.falseAlarmHours} 站时`)),
    ),
  ));

  page.appendChild(h('div', { class: 'grid cols-4 mb16' },
    kpi('事件召回率', `${r.eventRecallPct}%`, `${r.meteorDetectedEvents}/${r.meteorTruth}`, r.eventRecallPct >= 90 ? 'good' : 'bad'),
    kpi('误报率', `${r.falseAlarmsPerHour}/h`, `${r.falseAlarms} 个 / ${r.falseAlarmHours} 站时`, r.falseAlarmsPerHour <= 3 ? 'good' : 'bad'),
    kpi('辐射点平均偏差', `${r.radiantMeanOffsetDeg}°`, `最大 ${r.radiantMaxOffsetDeg}°`, r.radiantMaxOffsetDeg <= 2 ? 'good' : 'warn'),
    kpi('高度/速度 ≤5%', `${r.within5PctHeight}/${r.totalTriangulated} · ${r.within5PctSpeed}/${r.totalTriangulated}`, '高度 / 速度达标数', 'accent'),
  ));

  const acc = h('div', { class: 'card mb16' }, h('h2', {}, '验收条款'));
  for (const a of r.acceptance) {
    acc.appendChild(h('div', { class: 'list-row', style: 'align-items:flex-start' },
      h('span', { style: 'font-size:18px' }, a.pass ? '✅' : '❌'),
      h('div', { class: 'list-main' },
        h('div', { class: 'list-title' }, a.label, h('span', { class: 'badge' }, `目标 ${a.target}`)),
        h('div', { class: 'list-sub' }, `实测：${a.actual}`),
      ),
    ));
  }
  page.appendChild(acc);

  // 分群表 + 误差
  page.appendChild(h('div', { class: 'grid cols-2' },
    h('div', { class: 'card' },
      h('h2', {}, '分流星群召回与辐射偏差'),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '群'), h('th', {}, '真值'), h('th', {}, '检出'), h('th', {}, '夜辐射偏差'))),
        h('tbody', {}, ...r.perShower.map((p) => h('tr', {},
          h('td', {}, p.showerId), h('td', {}, String(p.truth)), h('td', {}, String(p.detected)),
          h('td', { class: p.radiantOffsetDeg <= 2 ? 'flag-pass' : 'flag-fail' }, `${p.radiantOffsetDeg || '—'}°`),
        ))),
      ),
    ),
    h('div', { class: 'card' },
      h('h2', {}, '交会误差统计'),
      h('dl', { class: 'kv' },
        h('dt', {}, '站级观测召回率'), h('dd', {}, `${r.stationObservationRecallPct}%`),
        h('dt', {}, '高度平均相对误差'), h('dd', {}, `${r.heightMeanAbsErrorPct}%（最大 ${r.heightMaxAbsErrorPct}%）`),
        h('dt', {}, '速度平均相对误差'), h('dd', {}, `${r.speedMeanAbsErrorPct}%（最大 ${r.speedMaxAbsErrorPct}%）`),
        h('dt', {}, '高度 ≤5% 占比'), h('dd', {}, `${r.within5PctHeight}/${r.totalTriangulated}`),
        h('dt', {}, '速度 ≤5% 占比'), h('dd', {}, `${r.within5PctSpeed}/${r.totalTriangulated}`),
      ),
      h('p', { class: 'tiny muted mt12' }, '几何上三站基线 40–180 km、流星高度 75–120 km，交会角普遍 20–110°；亚像素质心与仿射标定使视线残差保持在百米量级。'),
    ),
  ));

  mount(container, page);
}

function kpi(label: string, value: string, desc: string, cls = '') {
  return h('div', { class: 'card kpi' },
    h('div', { class: `v ${cls}` }, value), h('div', { class: 'l' }, label), h('div', { class: 'd' }, desc));
}
