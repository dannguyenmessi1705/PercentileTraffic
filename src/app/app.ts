import { CommonModule } from '@angular/common';
import { Component, signal, ViewChild } from '@angular/core';
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
} from 'chart.js';
import { extractJson, linearInterp, nearestRank, parsePercentiles } from './utils';
import { BoxPlotController, BoxAndWiskers } from '@sgratzl/chartjs-chart-boxplot';
import { FormsModule } from '@angular/forms';

Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Title,
  Tooltip,
  Legend,
  LineController,
  LineElement,
  PointElement,
  BoxPlotController,
  BoxAndWiskers
);

type Groups = Record<string, number[]>;

type Box = {
  svc: string;
  min: number;
  q1: number;
  q2: number;
  q3: number;
  max: number;
};

type TimelinePoint = {
  ts: number;
  val: number;
};

type TimeBucket = {
  label: string;
  value: number;
  count: number;
};

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly title = signal('Percentile Tool');

  fieldName = 'duration';
  serviceFilter = '';
  errorFilter = '';
  fromDate = '';
  toDate = '';
  percentiles = '50, 80, 90, 95, 99, 99.5, 99.7';
  method: 'nearest' | 'linear' = 'nearest';
  timeBucketMinutes = 5;
  timePercentile = 99;

  file?: File;
  groups: Groups = {};
  medians: { svc: string; val: number }[] = [];
  boxes: Box[] = [];
  rows: Array<[string, number, number]> = [];
  timeBuckets: TimeBucket[] = [];

  totalLines = 0; // tổng số dòng trong file
  totalMatched = 0; // số dòng match filter (có object JSON)
  totalValid = 0; // số record hợp lệ có numeric ở field

  @ViewChild('histogramCanvas') histogramCanvas?: { nativeElement: HTMLCanvasElement };
  @ViewChild('boxplotCanvas') boxplotCanvas?: { nativeElement: HTMLCanvasElement };
  @ViewChild('timeseriesCanvas') timeseriesCanvas?: { nativeElement: HTMLCanvasElement };
  private histChart?: Chart;
  private boxChart?: Chart;
  private timeChart?: Chart;
  private filteredPoints: TimelinePoint[] = [];

  setFile(f?: File) {
    this.file = f;
  }

  async analyze() {
    if (!this.file) {
      alert('Chưa chọn file .txt');
      return;
    }

    const text = await this.file.text();
    const lines = text.split(/\r?\n/);

    this.totalLines = lines.filter((l) => l.trim().length > 0).length;
    this.totalMatched = 0;
    this.totalValid = 0;

    const field = (this.fieldName || 'duration').trim();
    const svcF = this.serviceFilter.trim();
    const errF = this.errorFilter.trim();
    const from = this.fromDate ? new Date(this.fromDate) : null;
    const to = this.toDate ? new Date(this.toDate) : null;
    const fromMs = this.getValidTime(from);
    const toMs = this.getValidTime(to);
    const pctList = parsePercentiles(this.percentiles);
    const picker = this.getPicker();

    const groups: Groups = {};
    const timeline: TimelinePoint[] = [];

    for (const line of lines) {
      const obj = extractJson(line);
      if (!obj) continue;
      this.totalMatched++;
      if (svcF && obj.serviceCode !== svcF) continue;
      if (errF && String(obj.errorCode) !== errF) continue;
      const tsMs = this.extractTimestampMs(obj);
      if (fromMs !== null && tsMs !== null && tsMs < fromMs) continue;
      if (toMs !== null && tsMs !== null && tsMs > toMs) continue;
      const val = Number(obj[field]);
      if (!Number.isFinite(val)) continue;
      const key = obj.serviceCode || 'unknown';
      (groups[key] ||= []).push(val);
      this.totalValid++;
      if (tsMs !== null) {
        timeline.push({ ts: tsMs, val });
      }
    }

    this.groups = groups;
    this.rows = [];
    this.medians = [];
    this.boxes = [];
    this.filteredPoints = timeline;

    Object.entries(groups).forEach(([svc, arr]) => {
      arr.sort((a, b) => a - b);
      const q1 = nearestRank(arr, 25),
        q2 = nearestRank(arr, 50),
        q3 = nearestRank(arr, 75);
      this.boxes.push({ svc, min: arr[0], q1, q2, q3, max: arr[arr.length - 1] });
      for (const p of pctList) {
        const v = picker(arr, p);
        this.rows.push([svc, p, Number(v.toFixed(6))]);
        if (p === 50) this.medians.push({ svc, val: v });
      }
    });
    this.renderCharts();
    this.refreshTimeSeries(true);
  }

  refreshTimeSeries(silent = false) {
    const bucketMinutes = Number(this.timeBucketMinutes);
    const percentile = Number(this.timePercentile);

    if (!Number.isFinite(bucketMinutes) || bucketMinutes <= 0) {
      if (!silent) alert('Độ dài block (phút) phải lớn hơn 0.');
      this.timeBuckets = [];
      this.renderTimeChart();
      return;
    }

    if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
      if (!silent) alert('Percentile phải nằm trong (0, 100].');
      this.timeBuckets = [];
      this.renderTimeChart();
      return;
    }

    if (!this.filteredPoints.length) {
      this.timeBuckets = [];
      this.renderTimeChart();
      return;
    }

    this.timeBuckets = this.computeTimeBuckets(bucketMinutes, percentile);
    this.renderTimeChart();
  }

  private computeTimeBuckets(bucketMinutes: number, percentile: number): TimeBucket[] {
    if (!this.filteredPoints.length) return [];
    const bucketMs = bucketMinutes * 60_000;
    const picker = this.getPicker();
    const buckets = new Map<number, number[]>();

    for (const point of this.filteredPoints) {
      const start = Math.floor(point.ts / bucketMs) * bucketMs;
      const arr = buckets.get(start);
      if (arr) {
        arr.push(point.val);
      } else {
        buckets.set(start, [point.val]);
      }
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([start, vals]) => {
        vals.sort((a, b) => a - b);
        const raw = picker(vals, percentile);
        return {
          label: this.formatBucketLabel(start),
          value: Number(raw.toFixed(6)),
          count: vals.length,
        };
      })
      .filter((bucket) => Number.isFinite(bucket.value));
  }

  private formatBucketLabel(startMs: number): string {
    const d = new Date(startMs);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private getPicker() {
    return this.method === 'nearest' ? nearestRank : linearInterp;
  }

  private extractTimestampMs(obj: any): number | null {
    if (!obj || typeof obj !== 'object') return null;
    const candidates = [
      'timestamp',
      'time',
      'eventTime',
      'eventTimestamp',
      'startTime',
      'endTime',
      'requestTime',
      'responseTime',
    ];
    for (const key of candidates) {
      if (!(key in obj)) continue;
      const ms = this.normalizeTimestamp(obj[key]);
      if (ms !== null) return ms;
    }
    return null;
  }

  private normalizeTimestamp(val: unknown): number | null {
    if (val == null) return null;
    if (typeof val === 'number') return this.normalizeEpoch(val);
    if (typeof val === 'string') {
      const asNum = Number(val);
      if (Number.isFinite(asNum)) {
        const normalized = this.normalizeEpoch(asNum);
        if (normalized !== null) return normalized;
      }
      const parsed = Date.parse(val);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  private normalizeEpoch(num: number): number | null {
    if (!Number.isFinite(num)) return null;
    if (num > 1e12) return num;
    if (num > 1e9) return num * 1000;
    return null;
  }

  private getValidTime(date: Date | null): number | null {
    if (!date) return null;
    const ms = date.getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  private renderCharts() {
    this.histChart?.destroy();
    this.boxChart?.destroy();

    this.histChart = new Chart(this.histogramCanvas!.nativeElement.getContext('2d')!, {
      type: 'bar',
      data: {
        labels: this.medians.map((m) => m.svc),
        datasets: [
          {
            label: 'Median (p50)',
            data: this.medians.map((m) => m.val),
          },
        ],
      },
      options: {
        scales: {
          y: {
            beginAtZero: true,
          },
        },
      },
    });

    this.boxChart = new Chart(this.boxplotCanvas!.nativeElement.getContext('2d')!, {
      type: 'bar' as any,
      data: {
        labels: this.boxes.map((b) => b.svc),
        datasets: [
          {
            label: 'Min',
            data: this.boxes.map((b) => b.min),
            backgroundColor: 'rgba(59,130,246,0.2)',
          },
          {
            label: 'Q1',
            data: this.boxes.map((b) => b.q1),
            backgroundColor: 'rgba(59,130,246,0.35)',
          },
          {
            label: 'Median',
            data: this.boxes.map((b) => b.q2),
            backgroundColor: 'rgba(59,130,246,0.5)',
          },
          {
            label: 'Q3',
            data: this.boxes.map((b) => b.q3),
            backgroundColor: 'rgba(59,130,246,0.7)',
          },
          {
            label: 'Max',
            data: this.boxes.map((b) => b.max),
            backgroundColor: 'rgba(59,130,246,0.9)',
          },
        ],
      },
      options: {
        scales: { y: { beginAtZero: true } },
        plugins: { title: { display: true, text: 'Boxplot (min-Q1-median-Q3-max)' } },
      },
    });

    this.renderTimeChart();
  }

  private renderTimeChart() {
    this.timeChart?.destroy();
    this.timeChart = undefined;
    if (!this.timeseriesCanvas || !this.timeBuckets.length) return;

    this.timeChart = new Chart(this.timeseriesCanvas.nativeElement.getContext('2d')!, {
      type: 'line',
      data: {
        labels: this.timeBuckets.map((b) => b.label),
        datasets: [
          {
            label: `p${this.timePercentile} (${this.timeBucketMinutes}p block)`,
            data: this.timeBuckets.map((b) => b.value),
            borderColor: '#f97316',
            backgroundColor: 'rgba(249,115,22,0.15)',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          },
        ],
      },
      options: {
        scales: {
          y: { beginAtZero: true },
        },
        plugins: {
          title: {
            display: true,
            text: `Percentile theo block ${this.timeBucketMinutes} phút`,
          },
          tooltip: {
            callbacks: {
              afterLabel: (ctx) => {
                const bucket = this.timeBuckets[ctx.dataIndex];
                if (!bucket) return '';
                return `N = ${bucket.count}`;
              },
            },
          },
        },
      },
    });
  }

  saveChart(which: 'hist' | 'box') {
    const chart = which === 'hist' ? this.histChart : this.boxChart;
    if (!chart) return;
    const a = document.createElement('a');
    a.download = (which === 'hist' ? 'histogram' : 'boxplot') + '.png';
    a.href = chart.toBase64Image('image/png', 1);
    a.click();
  }
}
