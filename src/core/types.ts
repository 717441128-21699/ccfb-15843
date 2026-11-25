// 共享领域类型 —— 检测、标定、交会、UI 全链路使用

export interface LngLatAlt {
  lng: number; // 经度 度
  lat: number; // 纬度 度
  alt: number; // 海拔 米
}

export interface CameraSpec {
  width: number;
  height: number;
  fps: number;
  fx: number; // 像素焦距
  fy: number;
  cx: number;
  cy: number;
  roll?: number; // 度，合成用
  az: number; // 光轴方位角（北=0，东=90）度
  alt: number; // 光轴高度角 度
}

export interface Station {
  id: string;
  name: string;
  city: string;
  location: LngLatAlt;
  camera: CameraSpec;
  installed: string;
  note?: string;
}

/** 单帧灰度图，检测管线的统一输入（浏览器里由 ImageData 转换，Node 里合成器直接生成） */
export interface GrayFrame {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  /** 帧时间戳，毫秒（UTC unix） */
  time: number;
  index: number;
}

/** 一条候选轨迹上的单帧观测（像素坐标 + 光度） */
export interface PixelObservation {
  frame: number;
  time: number;
  x: number;
  y: number;
  /** 沿运动方向拟合出的线段端点（若帧内有拖尾） */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  flux: number;
  peak: number;
  area: number;
  /** 二阶矩估计的短轴全宽（像素） */
  width?: number;
  ecc?: number;
}

export type RejectKind =
  | 'aircraft'
  | 'satellite'
  | 'insect'
  | 'lightning'
  | 'noise'
  | 'short'
  | 'unknown';

export interface RejectedTrack {
  id: string;
  kind: RejectKind;
  reason: string;
  start: number;
  end: number;
  frames: number;
  speedDegS?: number;
  blinkScore?: number;
  thumbnail?: string;
  observations: PixelObservation[];
}

export interface DetectionResult {
  stationId: string;
  nightId: string;
  /** 确认的流星候选（尚未做天文/交会） */
  tracks: MeteorTrack[];
  rejected: RejectedTrack[];
  framesProcessed: number;
  startedAt?: number;
  elapsedMs?: number;
}

export interface MeteorTrack {
  id: string;
  stationId: string;
  observations: PixelObservation[];
  /** 像素/秒 */
  speedPxS: number;
  /** 像面运动方向角（弧度） */
  angle: number;
  score: number;
  thumbnail?: string;
}

/** 天文标定解：像素 <-> ENU 射线（相机固定于地面，仪器坐标系不随时间变） */
export interface PlateSolution {
  stationId: string;
  calibratedAt: number;
  matchedStars: number;
  rmsPx: number;
  rmsArcsec: number;
  plateScaleArcsecPx: number;
  /** 切平面仿射系数：xi = a*x+b*y+c ; eta = d*x+e*y+f */
  affine: [number, number, number, number, number, number];
  boresightAz: number;
  boresightAlt: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export interface RaDec {
  ra: number; // 度 [0,360)
  dec: number; // 度
}

export interface EquatorialObservation extends RaDec {
  time: number;
  frame: number;
  x: number;
  y: number;
  stationId: string;
}

/** WGS84 大地坐标点 */
export interface GeoPoint extends LngLatAlt {}

export interface TrajectorySolution {
  /** 参考时刻 ms */
  t0: number;
  /** ECEF 位置（米） p(t) = p0 + v * (t-t0)/1000 */
  p0: [number, number, number];
  /** ECEF 速度 米/秒 */
  vEcef: [number, number, number];
  speedMS: number;
  begin: GeoPoint & { time: number };
  end: GeoPoint & { time: number };
  /** 入射方向辐射点（由 -v 转到惯性系） */
  radiant: RaDec;
  /** 各观测点到拟合直线的平均/最大垂距 米 */
  rmsResidualM: number;
  maxResidualM: number;
  stationCount: number;
  observationCount: number;
  /** 交会角（度） */
  convergenceDeg: number;
}

export interface Shower {
  id: string;
  nameZh: string;
  nameEn: string;
  iau: string;
  ra: number;
  dec: number;
  /** 地心速度 km/s */
  vg: number;
  zhr: number;
  peak: string; // MM-DD
  active: [string, string];
  color: string;
}

export interface MeteorRecord {
  id: string;
  nightId: string;
  showerId: string | null;
  showerName?: string;
  /** 聚合辐射点（多站轨迹），度 */
  radiant: RaDec;
  radiantErrorDeg?: number;
  speedKms: number;
  beginHeightKm: number;
  endHeightKm: number;
  durationS: number;
  magnitude: number;
  stations: string[];
  stationCount: number;
  convergenceDeg: number;
  /** 与流星群公布辐射点角距离 度 */
  radiantOffsetDeg?: number;
  /** 与参考流星网络（合成真值）对比 */
  reference?: {
    beginHeightKm: number;
    speedKms: number;
    radiant: RaDec;
    network: string;
  };
  heightErrorPct?: number;
  speedErrorPct?: number;
  /** 每站的赤道坐标观测，供星图绘制 */
  equatorial: EquatorialObservation[];
  trajectory?: TrajectorySolution;
  /** 检测置信度 */
  score: number;
  thumbnail?: string;
}

export interface NightRecord {
  id: string;
  date: string; // YYYY-MM-DD
  label: string;
  showerId: string | null;
  stationIds: string[];
  videoKind: 'synthetic' | 'upload';
  durationMin: number;
  frames: number;
  status: 'seeded' | 'processed' | 'processing';
  meteorIds: string[];
  falseAlarms: number;
  rejectKinds?: Record<string, number>;
  notes?: string;
}

export interface ValidationReport {
  generatedAt: string;
  seeds: number[];
  meteorTruth: number;
  meteorDetectedEvents: number;
  eventRecallPct: number;
  stationObservationRecallPct: number;
  falseAlarms: number;
  falseAlarmHours: number;
  falseAlarmsPerHour: number;
  radiantMeanOffsetDeg: number;
  radiantMaxOffsetDeg: number;
  heightMeanAbsErrorPct: number;
  heightMaxAbsErrorPct: number;
  speedMeanAbsErrorPct: number;
  speedMaxAbsErrorPct: number;
  within5PctHeight: number;
  within5PctSpeed: number;
  totalTriangulated: number;
  perShower: Array<{
    showerId: string;
    truth: number;
    detected: number;
    radiantOffsetDeg: number;
  }>;
  acceptance: Array<{
    key: string;
    label: string;
    target: string;
    actual: string;
    pass: boolean;
  }>;
}
