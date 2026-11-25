import './ui/styles.css';
import { h } from './ui/dom';
import { store } from './ui/store';
import { renderStationsPage } from './ui/pages/stations-page';
import { renderNightsPage } from './ui/pages/nights-page';
import { renderMeteorDetail } from './ui/pages/meteor-detail-page';
import { renderShowersPage } from './ui/pages/showers-page';
import { renderValidationPage } from './ui/pages/validation-page';

const NAV = [
  { hash: '#/nights', ico: '🎞️', label: '每晚检测' },
  { hash: '#/stations', ico: '📡', label: '站点管理' },
  { hash: '#/showers', ico: '☄️', label: '流星群统计' },
  { hash: '#/validation', ico: '📐', label: '精度验证' },
];

function currentRoute(): { name: string; param?: string } {
  const hash = location.hash || '#/nights';
  const parts = hash.replace(/^#\//, '').split('/');
  return { name: parts[0] || 'nights', param: parts[1] ? decodeURIComponent(parts[1]) : undefined };
}

function renderShell() {
  const app = document.getElementById('app')!;
  const route = currentRoute();

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand-logo' }),
      h('div', {},
        h('div', { class: 'brand-name' }, '流星三维监测网'),
        h('div', { class: 'brand-sub' }, 'Meteor Triangulation'),
      ),
    ),
    ...NAV.map((n) => h('a', {
      class: `nav-item ${route.name === n.hash.slice(2) ? 'active' : ''}`,
      href: n.hash,
    }, h('span', { class: 'ico' }, n.ico), n.label)),
    h('div', { class: 'nav-foot' },
      'TypeScript · Web Worker · Canvas',
      h('br'),
      'WGS84 / GMST / gnomonic',
    ),
  );

  const page = h('main', { class: 'main', id: 'page' });
  app.innerHTML = '';
  app.appendChild(h('div', { class: 'app' }, sidebar, page));
  routePage(page, route);
}

function routePage(page: HTMLElement, route: { name: string; param?: string }) {
  switch (route.name) {
    case 'stations': renderStationsPage(page); break;
    case 'meteor': renderMeteorDetail(page, route.param ?? ''); break;
    case 'showers': renderShowersPage(page); break;
    case 'validation': renderValidationPage(page); break;
    case 'nights':
    default: renderNightsPage(page); break;
  }
}

window.addEventListener('hashchange', renderShell);
store.subscribe(() => {
  // 数据变化时仅在列表/统计类页面整体刷新；详情页内部自行取最新
  const route = currentRoute();
  if (route.name === 'nights' || route.name === 'showers') renderShell();
});
renderShell();
