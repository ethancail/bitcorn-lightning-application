export interface Stats {
  mean: number;
  stdev: number; // sample (Bessel-corrected) standard deviation
}

export function computeStats(values: number[]): Stats {
  if (values.length === 0) {
    throw new Error("computeStats: empty input");
  }
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  if (values.length < 2) {
    return { mean, stdev: 0 };
  }
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, stdev: Math.sqrt(variance) };
}

export function toZScore(value: number, stats: Stats): number {
  if (stats.stdev === 0) return 0;
  return (value - stats.mean) / stats.stdev;
}

// For a whole-series Z-score pass (used for display history — accepts the
// look-ahead bias per spec §4.3).
export function zScoreSeries(values: number[]): number[] {
  const stats = computeStats(values);
  return values.map((v) => toZScore(v, stats));
}
