// 把各站确认的像素轨迹按时间重叠 + 几何一致性分组，交会解算，
// 转换赤道坐标、估计星等、归属流星群。
import type {
  MeteorRecord, MeteorTrack, PlateSolution, RaDec, Station, EquatorialObservation,
} from '../core/types';
import { solveTrajectory, type RayObs } from './triangulate';
import { trackToEquatorial } from './plate';
import { SHOWERS } from '../core/showers';
import { angularDistanceDeg, raDecToEci, meanUnitVectors, eciToRaDec } from '../geo/astro';

export interface StationBundle {
  station: Station;
  solution: PlateSolution;
  tracks: MeteorTrack[];
}

class UF {
  p: number[];
  constructor(n: number) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(a: number): number { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a: number, b: number) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[rb] = ra; }
}

export interface ReconstructOptions {
  nightId: string;
  dateMs: number;
  maxRmsM?: number;
  /** 生成 id 的前缀 */
  idPrefix?: string;
}

let REC_SEQ = 1;

export function reconstructMeteors(bundles: StationBundle[], opt: ReconstructOptions): MeteorRecord[] {
  interface FlatTrack {
    bundle: StationBundle;
    track: MeteorTrack;
    t0: number; t1: number;
  }
  const flat: FlatTrack[] = [];
  for (const b of bundles) {
    for (const t of b.tracks) {
      if (!t.observations.length) continue;
      flat.push({
        bundle: b, track: t,
        t0: t.observations[0].time,
        t1: t.observations[t.observations.length - 1].time,
      });
    }
  }
  const uf = new UF(flat.length);

  // 按站点分组，站点对之间做贪心一一匹配（按交会残差排序），避免轨迹串组
  const byStation = new Map<string, number[]>();
  flat.forEach((f, i) => {
    const id = f.bundle.station.id;
    if (!byStation.has(id)) byStation.set(id, []);
    byStation.get(id)!.push(i);
  });
  const stationIds = [...byStation.keys()];

  for (let ai = 0; ai < stationIds.length; ai++) {
    for (let bi = ai + 1; bi < stationIds.length; bi++) {
      const pairs: Array<{ i: number; j: number; rms: number }> = [];
      for (const i of byStation.get(stationIds[ai])!) {
        for (const j of byStation.get(stationIds[bi])!) {
          const A = flat[i], B = flat[j];
          const overlap = Math.min(A.t1, B.t1) - Math.max(A.t0, B.t0);
          const gap = Math.max(A.t0, B.t0) - Math.min(A.t1, B.t1);
          const midDt = Math.abs((A.t0 + A.t1) / 2 - (B.t0 + B.t1) / 2);
          if (overlap < 0 && gap > 280) continue;
          if (midDt > 850) continue;
          const rays = buildRays([A, B]);
          try {
            const sol = solveTrajectory(rays);
            if (solutionPlausible(sol, 2500)) pairs.push({ i, j, rms: sol.rmsResidualM });
          } catch { /* 奇异解忽略 */ }
        }
      }
      pairs.sort((p, q) => p.rms - q.rms);
      const usedI = new Set<number>(), usedJ = new Set<number>();
      for (const p of pairs) {
        if (usedI.has(p.i) || usedJ.has(p.j)) continue;
        usedI.add(p.i); usedJ.add(p.j);
        uf.union(p.i, p.j);
      }
    }
  }

  const groups = new Map<number, FlatTrack[]>();
  flat.forEach((f, i) => {
    const r = uf.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(f);
  });

  const records: MeteorRecord[] = [];
  for (const group of groups.values()) {
    const stationIds = new Set(group.map((g) => g.bundle.station.id));
    if (stationIds.size < 2) continue; // 单站轨迹不做三维成果
    const rays = buildRays(group);
    let sol;
    try { sol = solveTrajectory(rays); } catch { continue; }
    if (!solutionPlausible(sol, opt.maxRmsM ?? 1500)) continue;

    const equatorial: EquatorialObservation[] = [];
    let peak = 0;
    let scoreSum = 0, scoreN = 0;
    for (const g of group) {
      equatorial.push(...trackToEquatorial(g.bundle.solution, g.bundle.station, g.track.observations));
      for (const o of g.track.observations) peak = Math.max(peak, o.peak);
      scoreSum += g.track.score; scoreN++;
    }
    equatorial.sort((a, b) => a.time - b.time);

    const speedKms = sol.speedMS / 1000;
    const radiant = sol.radiant;
    const shower = attributeShower(radiant, new Date(opt.dateMs), speedKms);
    const mag = estimateMagnitude(peak);

    const rec: MeteorRecord = {
      id: `${opt.idPrefix ?? 'MET'}-${String(REC_SEQ++).padStart(4, '0')}`,
      nightId: opt.nightId,
      showerId: shower?.id ?? 'SPO',
      showerName: shower?.nameZh,
      radiant,
      speedKms: +speedKms.toFixed(2),
      beginHeightKm: +(sol.begin.alt / 1000).toFixed(2),
      endHeightKm: +(sol.end.alt / 1000).toFixed(2),
      durationS: +((sol.end.time - sol.begin.time) / 1000).toFixed(3),
      magnitude: +mag.toFixed(1),
      stations: [...stationIds],
      stationCount: stationIds.size,
      convergenceDeg: sol.convergenceDeg,
      radiantOffsetDeg: shower && !Number.isNaN(shower.ra)
        ? +angularDistanceDeg(radiant, { ra: shower.ra, dec: shower.dec }).toFixed(2)
        : undefined,
      equatorial,
      trajectory: sol,
      score: +(scoreSum / Math.max(1, scoreN)).toFixed(3),
    };
    records.push(rec);
  }

  records.sort((a, b) => a.trajectory!.t0 - b.trajectory!.t0);
  return records;
}

function buildRays(group: Array<{ bundle: StationBundle; track: MeteorTrack }>): RayObs[] {
  const rays: RayObs[] = [];
  for (const g of group) {
    for (const o of g.track.observations) {
      rays.push({
        stationId: g.bundle.station.id,
        station: g.bundle.station,
        sol: g.bundle.solution,
        x: o.x, y: o.y, time: o.time,
      });
    }
  }
  return rays;
}

export function solutionPlausible(sol: ReturnType<typeof solveTrajectory>, maxRms: number): boolean {
  if (sol.stationCount < 2) return false;
  if (sol.rmsResidualM > maxRms) return false;
  const v = sol.speedMS / 1000;
  if (v < 10.5 || v > 73.5) return false;
  const hb = sol.begin.alt / 1000, he = sol.end.alt / 1000;
  if (hb < 55 || hb > 140 || he < 50 || he > 135) return false;
  if (sol.convergenceDeg < 6) return false;
  return true;
}

function estimateMagnitude(peakAdu: number): number {
  // 以合成/典型 0 等星峰值 ~210 ADU 为基准的经验关系
  return 0.0 - 2.5 * Math.log10(Math.max(8, peakAdu) / 210);
}

/** 按辐射点角距离 + 日期 + 速度归属流星群 */
export function attributeShower(radiant: RaDec, date: Date, speedKms: number) {
  const mmdd = `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  let best: (typeof SHOWERS)[number] | null = null;
  let bestScore = Infinity;
  for (const s of SHOWERS) {
    if (s.id === 'SPO' || Number.isNaN(s.ra)) continue;
    const dist = angularDistanceDeg(radiant, { ra: s.ra, dec: s.dec });
    const speedPenalty = Math.abs(s.vg - speedKms) * 0.12;
    // 活跃期内容差更大
    const active = isBetweenMMDD(mmdd, s.active[0], s.active[1]);
    const gate = active ? 16 : 9;
    if (dist > gate) continue;
    const score = dist + speedPenalty;
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return best;
}

function isBetweenMMDD(x: string, lo: string, hi: string): boolean {
  if (!lo || !hi) return false;
  if (lo <= hi) return x >= lo && x <= hi;
  return x >= lo || x <= hi; // 跨年
}

/** 多颗流星辐射点矢量加权平均，返回聚合辐射点与离散度 */
export function aggregateRadiants(meteors: MeteorRecord[]): {
  radiant: RaDec;
  spreadDeg: number;
  meanOffsetCatalogDeg?: number;
} | null {
  if (!meteors.length) return null;
  const vecs = meteors.map((m) => {
    const v = raDecToEci(m.radiant.ra, m.radiant.dec);
    const w = Math.max(0.2, Math.min(3, m.stationCount - 1 + (m.convergenceDeg / 30)));
    return { v, w };
  });
  let sx = 0, sy = 0, sz = 0, wsum = 0;
  for (const { v, w } of vecs) { sx += v[0] * w; sy += v[1] * w; sz += v[2] * w; wsum += w; }
  const mean = meanUnitVectors([[sx / wsum, sy / wsum, sz / wsum]]);
  const radiant = eciToRaDec(mean);
  const dists = meteors.map((m) => angularDistanceDeg(m.radiant, radiant));
  const spreadDeg = +Math.sqrt(dists.reduce((a, d) => a + d * d, 0) / dists.length).toFixed(2);
  return { radiant, spreadDeg };
}
