import raw from './star-catalog.json';
import type { RaDec } from './types';

export interface CatalogStar extends RaDec {
  hip: number;
  mag: number;
  nameZh?: string;
}

type Row = [number, number, number, number];

// 按已知近似坐标匹配中文名（只用于界面标注，不参与解算）
const NAME_SEEDS: Array<[string, number, number]> = [
  ['天狼星', 101.29, -16.72],
  ['老人星', 95.99, -52.7],
  ['大角星', 213.92, 19.18],
  ['织女星', 279.23, 38.78],
  ['五车二', 79.17, 46.0],
  ['参宿七', 78.63, -8.2],
  ['南河三', 114.83, 5.22],
  ['参宿四', 88.79, 7.41],
  ['河鼓二', 297.7, 8.87],
  ['天津四', 310.36, 45.28],
  ['北落师门', 344.41, -29.62],
  ['角宿一', 201.3, -11.16],
  ['心宿二', 247.35, -26.43],
  ['北河三', 116.33, 28.03],
  ['毕宿五', 68.98, 16.51],
  ['轩辕十四', 152.09, 11.97],
  ['昴宿六', 56.87, 24.1],
  ['北极星', 37.95, 89.26],
  ['南门二', 219.9, -60.84],
  ['马腹一', 210.0, -60.37],
  ['十字架二', 186.65, -63.1],
  ['水委一', 24.43, -57.24],
  ['王良四', 10.13, 56.54],
  ['娄宿三', 31.79, 23.46],
  ['壁宿二', 2.1, 29.09],
  ['北河二', 113.65, 31.89],
];

function angular2(ra1: number, de1: number, ra2: number, de2: number) {
  const dr = (ra1 - ra2) * Math.cos(((de1 + de2) / 2) * (Math.PI / 180));
  const dd = de1 - de2;
  return dr * dr + dd * dd;
}

export const STARS: CatalogStar[] = (raw as Row[]).map(([hip, ra, dec, mag]) => ({
  hip, ra, dec, mag,
}));

for (const [name, ra0, de0] of NAME_SEEDS) {
  let best: CatalogStar | null = null;
  let bestD = 4; // 2 度以内
  for (const s of STARS) {
    const d = angular2(s.ra, s.dec, ra0, de0);
    if (d < bestD) { bestD = d; best = s; }
  }
  if (best) best.nameZh = name;
}

export function starsBrighterThan(mag: number): CatalogStar[] {
  return STARS.filter((s) => s.mag <= mag);
}
