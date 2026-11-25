import type { CameraSpec, LngLatAlt, Station } from './types';
import { ecefToEnuVec, enuBasis, geodeticToEcef, enuToAzAlt } from '../geo/astro';

/** 求从测站看某大地坐标点的方位/高度角 */
export function lookAtAzAlt(from: LngLatAlt, target: LngLatAlt) {
  const a = geodeticToEcef(from);
  const b = geodeticToEcef(target);
  const d: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  const dn: [number, number, number] = [d[0] / n, d[1] / n, d[2] / n];
  const enu = ecefToEnuVec(dn, enuBasis(from));
  return enuToAzAlt(enu[0], enu[1], enu[2]);
}

/** 三站公共观测区中心（冀北高空 96km） */
export const COMMON_VOLUME: LngLatAlt = { lat: 40.28, lng: 117.45, alt: 96_000 };

export const VIDEO_W = 800;
export const VIDEO_H = 450;
export const VIDEO_FPS = 15;

function cameraFor(id: string, from: LngLatAlt, hFovDeg = 76): CameraSpec {
  const { az, alt } = lookAtAzAlt(from, COMMON_VOLUME);
  const fx = VIDEO_W / 2 / Math.tan((hFovDeg * Math.PI) / 180 / 2);
  return {
    width: VIDEO_W,
    height: VIDEO_H,
    fps: VIDEO_FPS,
    fx,
    fy: fx,
    cx: VIDEO_W / 2,
    cy: VIDEO_H / 2,
    az: +az.toFixed(3),
    alt: +alt.toFixed(3),
  };
}

export const STATIONS: Station[] = [
  {
    id: 'ST-XL',
    name: '兴隆观测站',
    city: '河北承德',
    location: { lat: 40.3959, lng: 117.5774, alt: 890 },
    camera: cameraFor('xl', { lat: 40.3959, lng: 117.5774, alt: 890 }),
    installed: '2025-06-18',
    note: '国家天文台兴隆基地楼顶，全天候防护壳',
  },
  {
    id: 'ST-FS',
    name: '房山站',
    city: '北京房山',
    location: { lat: 39.7167, lng: 115.75, alt: 120 },
    camera: cameraFor('fs', { lat: 39.7167, lng: 115.75, alt: 120 }),
    installed: '2025-07-02',
    note: '西南基线站，与兴隆构成约 170 km 基线',
  },
  {
    id: 'ST-QL',
    name: '青龙站',
    city: '河北秦皇岛',
    location: { lat: 40.403, lng: 118.95, alt: 260 },
    camera: cameraFor('ql', { lat: 40.403, lng: 118.95, alt: 260 }),
    installed: '2025-07-20',
    note: '东侧基线站',
  },
];

export function getStation(id: string): Station | undefined {
  return STATIONS.find((s) => s.id === id);
}
