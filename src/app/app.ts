import { CommonModule } from '@angular/common';
import { Component, signal, ViewChild } from '@angular/core';
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
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

  file?: File;
  groups: Groups = {};
  medians: { svc: string; val: number }[] = [];
  boxes: Box[] = [];
  rows: Array<[string, number, number]> = [];

  totalLines = 0; // tổng số dòng trong file
  totalMatched = 0; // số dòng match filter (có object JSON)
  totalValid = 0; // số record hợp lệ có numeric ở field

  @ViewChild('histogramCanvas') histogramCanvas?: { nativeElement: HTMLCanvasElement };
  @ViewChild('boxplotCanvas') boxplotCanvas?: { nativeElement: HTMLCanvasElement };
  private histChart?: Chart;
  private boxChart?: Chart;

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
    const pctList = parsePercentiles(this.percentiles);
    const picker = this.method === 'nearest' ? nearestRank : linearInterp;

    const groups: Groups = {};

    for (const line of lines) {
      const obj = extractJson(line);
      if (!obj) continue;
      this.totalMatched++;
      if (svcF && obj.serviceCode !== svcF) continue;
      if (errF && String(obj.errorCode) !== errF) continue;
      if (from && new Date(obj.timestamp) < from) continue;
      if (to && new Date(obj.timestamp) > to) continue;
      const val = Number(obj[field]);
      if (!Number.isFinite(val)) continue;
      const key = obj.serviceCode || 'unknown';
      (groups[key] ||= []).push(val);
      this.totalValid++;
    }

    this.groups = groups;
    this.rows = [];
    this.medians = [];
    this.boxes = [];

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
