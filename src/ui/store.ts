// 全局数据仓库：内置种子数据集 + 用户站点(localStorage) + 实时检测成果
import datasetJson from '../seed/dataset.json';
import reportJson from '../seed/validation-report.json';
import { STATIONS as BUILTIN_STATIONS } from '../core/stations';
import type { MeteorRecord, NightRecord, Station, ValidationReport } from '../core/types';

interface Dataset {
  version: number;
  generatedAt: string | null;
  nights: NightRecord[];
  meteors: MeteorRecord[];
  validation: ValidationReport | null;
}

const dataset = datasetJson as unknown as Dataset;
export const validationReport = reportJson as unknown as ValidationReport;

const STATION_KEY = 'mo.stations.v1';

type Listener = () => void;

class Store {
  stations: Station[];
  nights: NightRecord[];
  meteors: MeteorRecord[];
  private listeners = new Set<Listener>();

  constructor() {
    this.stations = this.loadStations();
    this.nights = dataset.nights ?? [];
    this.meteors = dataset.meteors ?? [];
  }

  private loadStations(): Station[] {
    try {
      const raw = localStorage.getItem(STATION_KEY);
      if (raw) {
        const custom = JSON.parse(raw) as Station[];
        // 内置站始终保留，自定义站追加
        const ids = new Set(BUILTIN_STATIONS.map((s) => s.id));
        return [...BUILTIN_STATIONS, ...custom.filter((s) => !ids.has(s.id))];
      }
    } catch { /* ignore */ }
    return BUILTIN_STATIONS.slice();
  }

  private persistStations() {
    try {
      const custom = this.stations.filter((s) => !BUILTIN_STATIONS.some((b) => b.id === s.id));
      localStorage.setItem(STATION_KEY, JSON.stringify(custom));
    } catch { /* ignore */ }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() { this.listeners.forEach((fn) => fn()); }

  getStation(id: string): Station | undefined { return this.stations.find((s) => s.id === id); }
  getMeteor(id: string): MeteorRecord | undefined { return this.meteors.find((m) => m.id === id); }
  nightMeteors(nightId: string): MeteorRecord[] {
    return this.meteors.filter((m) => m.nightId === nightId);
  }

  addStation(s: Station) {
    const i = this.stations.findIndex((x) => x.id === s.id);
    if (i >= 0) this.stations[i] = s; else this.stations.push(s);
    this.persistStations();
    this.emit();
  }

  removeStation(id: string) {
    if (BUILTIN_STATIONS.some((s) => s.id === id)) return;
    this.stations = this.stations.filter((s) => s.id !== id);
    this.persistStations();
    this.emit();
  }

  addProcessedNight(night: NightRecord, records: MeteorRecord[]) {
    // 同 id 覆盖
    this.nights = [night, ...this.nights.filter((n) => n.id !== night.id)];
    this.meteors = [...records, ...this.meteors.filter((m) => m.nightId !== night.id)];
    this.emit();
  }
}

export const store = new Store();

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}
