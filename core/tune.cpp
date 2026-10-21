// The bar optimiser.
//
// Unknowns: four control depths of the undercut, how far along the bar it reaches, and (unless the
// length is fixed) the bar's length. Each unknown is written as a squashed variable z, so any z
// gives a buildable bar: depths stay between 0 and (thickness - minimum thickness), the length
// between its limits. The goal is to make every targeted partial's error, in cents, zero.
#include "tune.hpp"

#include "mathlite.hpp"

namespace rt {
namespace {

constexpr int MAXP = 6;   // unknowns
constexpr int MAXR = 10;  // residuals: 3 partials + 4 "don't cut more than needed" + 3 "keep it an arch"
constexpr int COARSE = 120;
constexpr int FINE = 300;
constexpr double REG = 0.5;  // 100% of the allowed depth costs as much as half a cent of error
constexpr double ARCH = 3;  // a bump in the middle costs a little, so it only appears when it helps
constexpr double PITCH = 10;  // the first partial (the note you hear) matters most when not everything fits

double sigmoid(double z) { return 1.0 / (1.0 + m::exp(-z)); }
double logit(double p) {
  p = m::clamp(p, 1e-6, 1 - 1e-6);
  return m::log(p / (1 - p));
}

struct Problem {
  const DesignSpec* spec;
  int P;       // 5 (fixed length) or 6
  int elems;
  int evals;
  double pitch_weight;
};

void decode(const Problem& pr, const double* z, Undercut& cut, double& L) {
  const DesignSpec& s = *pr.spec;
  const double dmax = s.thickness - s.min_thickness;
  for (int k = 0; k < 4; ++k) cut.depth[k] = dmax * sigmoid(z[k]);
  cut.half_span = 0.30 + 0.62 * sigmoid(z[4]);
  if (pr.P == 6) {
    L = s.min_length * m::exp(m::log(s.max_length / s.min_length) * sigmoid(z[5]));
  } else {
    L = s.length;
  }
}

void build(const Problem& pr, const Undercut& cut, double L, int elems, Bar& bar) {
  const DesignSpec& s = *pr.spec;
  bar.length = L;
  bar.width = s.width;
  bar.thickness = s.thickness;
  bar.mat = s.mat;
  bar.elems = elems;
  apply_undercut(bar, cut, s.min_thickness);
}

Bar g_bar;
Modes g_modes;

// Residuals for z. Returns false if the bar couldn't be solved.
bool residuals(Problem& pr, const double* z, double* r, int& nr) {
  Undercut cut;
  double L;
  decode(pr, z, cut, L);
  build(pr, cut, L, pr.elems, g_bar);
  const Targets& t = pr.spec->targets;
  ++pr.evals;
  if (!solve_modes(g_bar, g_modes, t.count)) return false;
  double err[3];
  target_errors(g_modes, t, err);
  nr = 0;
  const int count = t.count < 1 ? 1 : (t.count > 3 ? 3 : t.count);
  for (int i = 0; i < count; ++i) r[nr++] = (i == 0 ? pr.pitch_weight : 1.0) * err[i];
  const double dmax = pr.spec->thickness - pr.spec->min_thickness;
  for (int k = 0; k < 4; ++k) r[nr++] = REG * cut.depth[k] / dmax;
  // Prefer a simple arch, deepest in the middle: easier to cut and to check with a template.
  for (int k = 0; k < 3; ++k) r[nr++] = ARCH * m::max(0.0, cut.depth[k + 1] - cut.depth[k]) / dmax;
  return true;
}

double cost_of(const double* r, int nr) {
  double c = 0;
  for (int i = 0; i < nr; ++i) c += r[i] * r[i];
  return c;
}

// Solves the small system a x = b (Gaussian elimination, partial pivoting).
bool solve_small(double a[MAXP][MAXP], double* b, int n) {
  if (n < 1 || n > MAXP) return false;
  for (int c = 0; c < n; ++c) {
    int piv = c;
    for (int r = c + 1; r < n; ++r)
      if (m::abs(a[r][c]) > m::abs(a[piv][c])) piv = r;
    if (!(m::abs(a[piv][c]) > 1e-300)) return false;
    if (piv != c) {
      for (int k = 0; k < n; ++k) { double t = a[c][k]; a[c][k] = a[piv][k]; a[piv][k] = t; }
      double t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    for (int r = c + 1; r < n; ++r) {
      double f = a[r][c] / a[c][c];
      for (int k = c; k < n; ++k) a[r][k] -= f * a[c][k];
      b[r] -= f * b[c];
    }
  }
  for (int r = n - 1; r >= 0; --r) {
    double s = b[r];
    for (int k = r + 1; k < n; ++k) s -= a[r][k] * b[k];
    b[r] = s / a[r][r];
  }
  return true;
}

// Levenberg-Marquardt from z (updated in place). Returns the final cost.
double levenberg_marquardt(Problem& pr, double* z, int max_iter) {
  double r[MAXR] = {}, rt[MAXR] = {}, J[MAXR][MAXP] = {};
  int nr = 0, nt = 0;
  if (pr.P < 1 || pr.P > MAXP) return 1e300;
  if (!residuals(pr, z, r, nr)) return 1e300;
  double cost = cost_of(r, nr);
  double lambda = 1e-2;
  const double h = 1e-4;
  for (int it = 0; it < max_iter && cost > 1e-3; ++it) {
    // Jacobian by forward differences.
    for (int j = 0; j < pr.P; ++j) {
      double zj = z[j];
      z[j] = zj + h;
      bool ok = residuals(pr, z, rt, nt);
      z[j] = zj;
      if (!ok) return cost;
      for (int i = 0; i < nr; ++i) J[i][j] = (rt[i] - r[i]) / h;
    }
    bool improved = false;
    for (int tries = 0; tries < 8 && !improved; ++tries) {
      double a[MAXP][MAXP] = {}, g[MAXP] = {};
      for (int i = 0; i < pr.P; ++i) {
        g[i] = 0;
        for (int k = 0; k < nr; ++k) g[i] -= J[k][i] * r[k];
        for (int j = 0; j < pr.P; ++j) {
          double s = 0;
          for (int k = 0; k < nr; ++k) s += J[k][i] * J[k][j];
          a[i][j] = s;
        }
      }
      for (int i = 0; i < pr.P; ++i) a[i][i] += lambda * (a[i][i] + 1e-6);
      if (!solve_small(a, g, pr.P)) { lambda *= 10; continue; }
      double zn[MAXP] = {};
      double step = 0;
      for (int i = 0; i < pr.P; ++i) {
        double d = m::clamp(g[i], -2.0, 2.0);  // keep each step modest
        zn[i] = m::clamp(z[i] + d, -12.0, 12.0);
        step += d * d;
      }
      if (residuals(pr, zn, rt, nt)) {
        double cn = cost_of(rt, nt);
        if (cn < cost) {
          for (int i = 0; i < pr.P; ++i) z[i] = zn[i];
          for (int i = 0; i < nr; ++i) r[i] = rt[i];
          improved = cost - cn > 1e-12 * cost || step > 1e-16;
          cost = cn;
          lambda = m::max(lambda / 3, 1e-9);
          if (!improved) return cost;
          continue;
        }
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return cost;
}

}  // namespace

void target_errors(const Modes& modes, const Targets& t, double* err) {
  for (int i = 0; i < 3; ++i) err[i] = 0;
  if (modes.count < 1) return;
  err[0] = m::cents(modes.freq[0], t.f1);
  for (int i = 1; i < t.count && i < modes.count; ++i) err[i] = m::cents(modes.freq[i], t.f1 * t.ratio[i - 1]);
}

void design_bar(const DesignSpec& spec, Design& out) {
  out.ok = false;
  out.evaluations = 0;
  for (int i = 0; i < 3; ++i) { out.error[i] = 0; out.met[i] = false; }
  Problem pr{&spec, spec.fixed_length ? 5 : 6, COARSE, 0, 1.0};

  // Starting shapes (as fractions of the allowed depth) and reaches, like a maker's first tries.
  static const double starts[4][5] = {
      {0.75, 0.70, 0.55, 0.30, 0.60},
      {0.50, 0.45, 0.35, 0.20, 0.80},
      {0.85, 0.80, 0.60, 0.25, 0.45},
      {0.60, 0.65, 0.60, 0.40, 0.70},
  };
  double best_z[MAXP] = {};
  double best_cost = 1e301;
  for (const auto& st : starts) {
    double z[MAXP];
    for (int k = 0; k < 4; ++k) z[k] = logit(st[k]);
    z[4] = logit((st[4] - 0.30) / 0.62);
    if (pr.P == 6) {
      // Pick the length that puts the first partial on target for this shape: f1 ~ 1/L^2.
      double L = m::sqrt(spec.min_length * spec.max_length);
      z[5] = 0;
      for (int k = 0; k < 4; ++k) {
        Undercut cut;
        double Lc;
        z[5] = logit(m::log(L / spec.min_length) / m::log(spec.max_length / spec.min_length));
        decode(pr, z, cut, Lc);
        build(pr, cut, Lc, pr.elems, g_bar);
        ++pr.evals;
        if (!solve_modes(g_bar, g_modes, 1)) break;
        L = m::clamp(Lc * m::sqrt(g_modes.freq[0] / spec.targets.f1), spec.min_length, spec.max_length);
      }
      z[5] = logit(m::log(L / spec.min_length) / m::log(spec.max_length / spec.min_length));
    }
    double c = levenberg_marquardt(pr, z, 30);
    if (c < best_cost) {
      best_cost = c;
      for (int i = 0; i < pr.P; ++i) best_z[i] = z[i];
    }
    if (best_cost < 0.5) break;  // already within a fraction of a cent: no need for more starts
  }
  if (!(best_cost < 1e300)) {
    out.evaluations = pr.evals;
    return;
  }
  // If not every partial fits (a short, thick bar can't reach 1:4:10), keep the note itself in
  // tune and let the upper partials take the compromise.
  if (best_cost > 0.5) {
    pr.pitch_weight = PITCH;
    levenberg_marquardt(pr, best_z, 30);
  }
  // Polish on a finer mesh, so the reported frequencies are accurate to well under a cent.
  pr.elems = FINE;
  levenberg_marquardt(pr, best_z, 8);
  decode(pr, best_z, out.cut, out.bar.length);
  build(pr, out.cut, out.bar.length, FINE, out.bar);
  // Last, put the note itself exactly in tune: rescale the length (or, if the length is fixed,
  // the depth of the cut). The upper partials barely move.
  const double dmax = spec.thickness - spec.min_thickness;
  for (int it = 0; it < 6; ++it) {
    ++pr.evals;
    if (!solve_modes(out.bar, out.modes, 1)) break;
    double ratio = out.modes.freq[0] / spec.targets.f1;
    if (m::abs(m::cents(out.modes.freq[0], spec.targets.f1)) < 0.05) break;
    if (!spec.fixed_length) {
      double L = m::clamp(out.bar.length * m::sqrt(ratio), spec.min_length, spec.max_length);
      if (L == out.bar.length) break;
      build(pr, out.cut, L, FINE, out.bar);
    } else {
      // Deeper cut -> lower note. Depth scale by the square of the miss is a good first guess.
      double scale = m::clamp(ratio * ratio, 0.8, 1.25), top = 0;
      for (int k = 0; k < 4; ++k) top = m::max(top, out.cut.depth[k] * scale);
      if (top > dmax) scale *= dmax / top;
      bool changed = false;
      for (int k = 0; k < 4; ++k) {
        double d = out.cut.depth[k] * scale;
        changed = changed || d != out.cut.depth[k];
        out.cut.depth[k] = d;
      }
      if (!changed) break;
      build(pr, out.cut, out.bar.length, FINE, out.bar);
    }
  }
  ++pr.evals;
  out.evaluations = pr.evals;
  if (!solve_modes(out.bar, out.modes, MAX_MODES)) return;
  target_errors(out.modes, spec.targets, out.error);
  for (int i = 0; i < spec.targets.count; ++i) out.met[i] = m::abs(out.error[i]) <= 3.0;
  out.ok = true;
}

}  // namespace rt
