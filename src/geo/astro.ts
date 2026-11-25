// WGS84 大地坐标 <-> ECEF <-> ENU，以及赤道/地平坐标、GMST
import type { LngLatAlt, RaDec } from '../core/types';

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

const A = 6378137.0; // WGS84 长半轴
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

export function geodeticToEcef(p: LngLatAlt): [number, number, number] {
  const lat = p.lat * D2R;
  const lng = p.lng * D2R;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    (n + p.alt) * cosLat * Math.cos(lng),
    (n + p.alt) * cosLat * Math.sin(lng),
    (n * (1 - E2) + p.alt) * sinLat,
  ];
}

export function ecefToGeodetic(x: number, y: number, z: number): LngLatAlt {
  // Bowring 迭代
  const lng = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 8; i++) {
    const sinLat = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return { lng: lng * R2D, lat: lat * R2D, alt: h };
}

/** 测站 ENU 基向量在 ECEF 中的旋转矩阵（行：E,N,U 与 ECEF 轴的点积） */
export function enuBasis(p: LngLatAlt) {
  const lat = p.lat * D2R;
  const lng = p.lng * D2R;
  const sL = Math.sin(lat), cL = Math.cos(lat), sO = Math.sin(lng), cO = Math.cos(lng);
  // 每一列是 ENU 单位轴的 ECEF 分量
  const east: [number, number, number] = [-sO, cO, 0];
  const north: [number, number, number] = [-sL * cO, -sL * sO, cL];
  const up: [number, number, number] = [cL * cO, cL * sO, sL];
  return { east, north, up };
}

export function enuToEcefVec(
  enu: [number, number, number],
  basis: ReturnType<typeof enuBasis>,
): [number, number, number] {
  const [e, n, u] = enu;
  return [
    e * basis.east[0] + n * basis.north[0] + u * basis.up[0],
    e * basis.east[1] + n * basis.north[1] + u * basis.up[1],
    e * basis.east[2] + n * basis.north[2] + u * basis.up[2],
  ];
}

export function ecefToEnuVec(
  v: [number, number, number],
  basis: ReturnType<typeof enuBasis>,
): [number, number, number] {
  return [
    v[0] * basis.east[0] + v[1] * basis.east[1] + v[2] * basis.east[2],
    v[0] * basis.north[0] + v[1] * basis.north[1] + v[2] * basis.north[2],
    v[0] * basis.up[0] + v[1] * basis.up[1] + v[2] * basis.up[2],
  ];
}

/** 地平 az/alt（北为 0，东为 90）-> ENU 单位向量 */
export function azAltToEnu(azDeg: number, altDeg: number): [number, number, number] {
  const az = azDeg * D2R;
  const alt = altDeg * D2R;
  return [
    Math.cos(alt) * Math.sin(az),
    Math.cos(alt) * Math.cos(az),
    Math.sin(alt),
  ];
}

/** ENU 单位向量 -> az/alt（度） */
export function enuToAzAlt(e: number, n: number, u: number) {
  const alt = Math.asin(Math.max(-1, Math.min(1, u))) * R2D;
  let az = Math.atan2(e, n) * R2D;
  if (az < 0) az += 360;
  return { az, alt };
}

export function julianDate(tMs: number): number {
  return tMs / 86400000 + 2440587.5;
}

/** 格林尼治平恒星时，弧度 [0,2pi) */
export function gmstRad(tMs: number): number {
  const jd = julianDate(tMs);
  const t = (jd - 2451545.0) / 36525;
  // IAU 1982
  let theta =
    67310.54841 +
    (876600 * 3600 + 8640184.812866) * t +
    0.093104 * t * t -
    6.2e-6 * t * t * t; // 秒
  theta = ((theta % 86400) + 86400) % 86400;
  return (theta / 240) * D2R; // 秒 -> 度(15 arcsec/s ... /240 给出度) -> 弧度
}

/** 赤道单位矢量（ECI，J2000 近似当作当日平位置；合成与解算用同一框架） */
export function raDecToEci(raDeg: number, decDeg: number): [number, number, number] {
  const ra = raDeg * D2R;
  const dec = decDeg * D2R;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}

export function eciToRaDec(v: [number, number, number]): RaDec {
  const dec = Math.asin(Math.max(-1, Math.min(1, v[2] / Math.hypot(v[0], v[1], v[2])))) * R2D;
  let ra = Math.atan2(v[1], v[0]) * R2D;
  if (ra < 0) ra += 360;
  return { ra, dec };
}

/** ECI -> ECEF：Rz(-GMST)。ECEF 中固定经度 λ 的方向对应 RA = GMST + λ */
export function eciToEcef(v: [number, number, number], gmst: number): [number, number, number] {
  const c = Math.cos(gmst), s = Math.sin(gmst);
  // Rz(-gmst): [c s 0; -s c 0; 0 0 1]
  return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
}

/** ECEF -> ECI：Rz(+GMST) */
export function ecefToEci(v: [number, number, number], gmst: number): [number, number, number] {
  const c = Math.cos(gmst), s = Math.sin(gmst);
  // Rz(gmst): [c -s 0; s c 0; 0 0 1]
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}

/** 某时刻恒星在测站 ENU 中的方向 */
export function raDecToEnuAt(
  rd: RaDec,
  tMs: number,
  station: LngLatAlt,
): [number, number, number] {
  const gmst = gmstRad(tMs);
  const ecef = eciToEcef(raDecToEci(rd.ra, rd.dec), gmst);
  const stationEcef = geodeticToEcef(station);
  // 方向只需要旋转，用测站基
  const basis = enuBasis(station);
  return ecefToEnuVec(ecef, basis);
}

/** 球面角距离（度） */
export function angularDistanceDeg(a: RaDec, b: RaDec): number {
  const ra1 = a.ra * D2R, de1 = a.dec * D2R;
  const ra2 = b.ra * D2R, de2 = b.dec * D2R;
  const cosD =
    Math.sin(de1) * Math.sin(de2) + Math.cos(de1) * Math.cos(de2) * Math.cos(ra1 - ra2);
  return Math.acos(Math.max(-1, Math.min(1, cosD))) * R2D;
}

/** 单位矢量夹角（度） */
export function vecAngleDeg(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < 3; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return Math.acos(Math.max(-1, Math.min(1, dot / Math.sqrt(na * nb)))) * R2D;
}

/** 对一组单位矢量做平均（辐射点聚合），返回归一化方向 */
export function meanUnitVectors(vectors: Array<[number, number, number]>): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (const v of vectors) {
    x += v[0]; y += v[1]; z += v[2];
  }
  const n = Math.hypot(x, y, z) || 1;
  return [x / n, y / n, z / n];
}

/** 本地 ENU 切平面上两点距离（米），用于几何统计的近似 */
export function enuDistance(a: LngLatAlt, b: LngLatAlt): number {
  const ea = geodeticToEcef(a);
  const eb = geodeticToEcef(b);
  return Math.hypot(ea[0] - eb[0], ea[1] - eb[1], ea[2] - eb[2]);
}
