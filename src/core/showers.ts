import type { Shower } from '../core/types';

// 主要流星群公布辐射点 / 速度（IMO 常用参考值）
export const SHOWERS: Shower[] = [
  {
    id: 'PER', nameZh: '英仙座流星雨', nameEn: 'Perseids', iau: 'PER',
    ra: 48.0, dec: 58.0, vg: 59, zhr: 100, peak: '08-12', active: ['07-17', '08-24'],
    color: '#7dd3fc',
  },
  {
    id: 'GEM', nameZh: '双子座流星雨', nameEn: 'Geminids', iau: 'GEM',
    ra: 112.0, dec: 33.0, vg: 35, zhr: 150, peak: '12-14', active: ['12-04', '12-20'],
    color: '#fcd34d',
  },
  {
    id: 'LEO', nameZh: '狮子座流星雨', nameEn: 'Leonids', iau: 'LEO',
    ra: 152.0, dec: 22.0, vg: 71, zhr: 15, peak: '11-17', active: ['11-06', '11-30'],
    color: '#fca5a5',
  },
  {
    id: 'ORI', nameZh: '猎户座流星雨', nameEn: 'Orionids', iau: 'ORI',
    ra: 95.0, dec: 16.0, vg: 66, zhr: 20, peak: '10-21', active: ['10-02', '11-07'],
    color: '#fdba74',
  },
  {
    id: 'QUA', nameZh: '象限仪座流星雨', nameEn: 'Quadrantids', iau: 'QUA',
    ra: 230.0, dec: 49.0, vg: 41, zhr: 110, peak: '01-03', active: ['12-28', '01-12'],
    color: '#c4b5fd',
  },
  {
    id: 'TAU', nameZh: '金牛座流星雨', nameEn: 'Taurids', iau: 'STA',
    ra: 52.0, dec: 15.0, vg: 27, zhr: 10, peak: '11-05', active: ['10-20', '12-10'],
    color: '#86efac',
  },
  {
    id: 'SPO', nameZh: '偶发流星', nameEn: 'Sporadic', iau: 'SPO',
    ra: NaN, dec: NaN, vg: 40, zhr: 0, peak: '', active: ['', ''],
    color: '#94a3b8',
  },
];

export function getShower(id: string | null | undefined): Shower | undefined {
  if (!id) return undefined;
  return SHOWERS.find((s) => s.id === id);
}
