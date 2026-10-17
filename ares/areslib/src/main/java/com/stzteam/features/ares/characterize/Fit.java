package com.stzteam.features.ares.characterize;

/** A straight line through points, by least squares: y = intercept + slope · x. */
public record Fit(double intercept, double slope, double r2, int points) {
  public static Fit of(double[] x, double[] y) {
    int n = Math.min(x.length, y.length);
    double sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (int i = 0; i < n; i++) {
      sx += x[i];
      sy += y[i];
      sxx += x[i] * x[i];
      sxy += x[i] * y[i];
      syy += y[i] * y[i];
    }
    double dx = n * sxx - sx * sx, dy = n * syy - sy * sy;
    if (n < 2 || dx <= 0) return new Fit(Double.NaN, Double.NaN, 0, n);
    double slope = (n * sxy - sx * sy) / dx;
    double intercept = (sy - slope * sx) / n;
    double r = dy > 0 ? (n * sxy - sx * sy) / Math.sqrt(dx * dy) : 1;
    return new Fit(intercept, slope, r * r, n);
  }
}
