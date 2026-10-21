// The vibration model: a Timoshenko beam (bending + shear + rotary inertia), finite elements,
// and subspace iteration for the lowest few partials.
#include "bar.hpp"

#include "mathlite.hpp"

namespace rt {
namespace {

constexpr int BW = 3;           // half-bandwidth: a node's two unknowns couple to the next node's
constexpr int Q = 10;           // vectors in the subspace (2 rigid-body motions + 8 bending)
constexpr double KAPPA = 5.0 / 6.0;  // shear correction factor for a rectangular section

// Symmetric banded matrix, lower part: a[i][d] = A(i, i - d).
struct Band {
  int n;
  double a[MAX_DOF][BW + 1];
};

// All working storage is static: no heap, the same in the native and WebAssembly builds.
Band g_K, g_M, g_A;
double g_X[Q][MAX_DOF];
double g_Y[Q][MAX_DOF];

void band_clear(Band& b, int n) {
  b.n = n;
  for (int i = 0; i < n; ++i)
    for (int d = 0; d <= BW; ++d) b.a[i][d] = 0;
}

void band_add(Band& b, int i, int j, double v) {
  if (i < j) { int t = i; i = j; j = t; }
  b.a[i][i - j] += v;
}

// y = B x
void band_mul(const Band& b, const double* x, double* y) {
  for (int i = 0; i < b.n; ++i) y[i] = 0;
  for (int i = 0; i < b.n; ++i) {
    y[i] += b.a[i][0] * x[i];
    for (int d = 1; d <= BW && i - d >= 0; ++d) {
      y[i] += b.a[i][d] * x[i - d];
      y[i - d] += b.a[i][d] * x[i];
    }
  }
}

// In-place Cholesky factorisation L L^T of a positive definite banded matrix.
bool band_cholesky(Band& b) {
  for (int i = 0; i < b.n; ++i) {
    for (int d = BW; d >= 0; --d) {
      int j = i - d;
      if (j < 0) continue;
      double s = b.a[i][d];
      for (int k = 1; k <= BW; ++k) {
        int c = j - k;  // column shared by rows i and j
        if (c < 0 || i - c > BW) continue;
        s -= b.a[i][i - c] * b.a[j][j - c];
      }
      if (d == 0) {
        if (!(s > 0)) return false;
        b.a[i][0] = m::sqrt(s);
      } else {
        b.a[i][d] = s / b.a[j][0];
      }
    }
  }
  return true;
}

// Solves L L^T x = rhs in place.
void band_solve(const Band& l, double* x) {
  for (int i = 0; i < l.n; ++i) {
    double s = x[i];
    for (int d = 1; d <= BW && i - d >= 0; ++d) s -= l.a[i][d] * x[i - d];
    x[i] = s / l.a[i][0];
  }
  for (int i = l.n - 1; i >= 0; --i) {
    double s = x[i];
    for (int d = 1; d <= BW && i + d < l.n; ++d) s -= l.a[i + d][d] * x[i + d];
    x[i] = s / l.a[i][0];
  }
}

double dot(const double* a, const double* b, int n) {
  double s = 0;
  for (int i = 0; i < n; ++i) s += a[i] * b[i];
  return s;
}

// Eigenvalues and vectors of a small symmetric matrix by cyclic Jacobi rotations.
// On return a's diagonal holds the eigenvalues and v's columns the vectors.
void jacobi(double a[Q][Q], double v[Q][Q], int n) {
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < n; ++j) v[i][j] = (i == j) ? 1.0 : 0.0;
  for (int sweep = 0; sweep < 60; ++sweep) {
    double off = 0, diag = 0;
    for (int i = 0; i < n; ++i) {
      diag += a[i][i] * a[i][i];
      for (int j = i + 1; j < n; ++j) off += a[i][j] * a[i][j];
    }
    if (off <= 1e-30 * diag) return;
    for (int p = 0; p < n; ++p) {
      for (int q = p + 1; q < n; ++q) {
        if (a[p][q] == 0) continue;
        double theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        double t = (theta >= 0 ? 1.0 : -1.0) / (m::abs(theta) + m::sqrt(theta * theta + 1));
        double c = 1 / m::sqrt(t * t + 1), s = t * c;
        for (int k = 0; k < n; ++k) {
          double akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (int k = 0; k < n; ++k) {
          double apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (int k = 0; k < n; ++k) {
          double vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
}

void assemble(const Bar& bar) {
  const int nodes = bar.elems + 1;
  const int n = 2 * nodes;
  band_clear(g_K, n);
  band_clear(g_M, n);
  const double le = bar.length / bar.elems;
  const double E = bar.mat.E, G = bar.mat.G, rho = bar.mat.rho, b = bar.width;
  for (int e = 0; e < bar.elems; ++e) {
    const double h = bar.h[e];
    const double A = b * h, I = b * h * h * h / 12.0;
    double k[4][4] = {};
    // Bending: EI/le acting on the change in rotation across the element.
    const double kb = E * I / le;
    k[1][1] += kb; k[1][3] -= kb; k[3][1] -= kb; k[3][3] += kb;
    // Shear: kappa G A le * gamma^2, with gamma = dw/dx - theta taken at the middle
    // (one-point "reduced" integration, which avoids shear locking in thin bars).
    const double bs[4] = {-1.0 / le, -0.5, 1.0 / le, -0.5};
    const double ks = KAPPA * G * A * le;
    for (int i = 0; i < 4; ++i)
      for (int j = 0; j < 4; ++j) k[i][j] += ks * bs[i] * bs[j];
    // Consistent mass: moving mass (rho A) and rotary inertia (rho I).
    const double mt = rho * A * le / 6.0, mr = rho * I * le / 6.0;
    double mm[4][4] = {};
    mm[0][0] = 2 * mt; mm[0][2] = mt; mm[2][0] = mt; mm[2][2] = 2 * mt;
    mm[1][1] = 2 * mr; mm[1][3] = mr; mm[3][1] = mr; mm[3][3] = 2 * mr;
    const int base = 2 * e;
    for (int i = 0; i < 4; ++i)
      for (int j = 0; j <= i; ++j) {
        band_add(g_K, base + i, base + j, k[i][j]);
        band_add(g_M, base + i, base + j, mm[i][j]);
      }
  }
}

}  // namespace

double undercut_depth(const Undercut& cut, double L, double u) {
  const double half = cut.half_span * L / 2;
  if (!(half > 0)) return 0;
  double s = m::abs(u) / half;
  if (s >= 1) return 0;
  // Monotone cubic (Fritsch-Carlson) through the five control depths, flat at the centre.
  const double y[5] = {cut.depth[0], cut.depth[1], cut.depth[2], cut.depth[3], 0.0};
  const double hstep = 0.25;
  double delta[4], slope[5];
  for (int i = 0; i < 4; ++i) delta[i] = (y[i + 1] - y[i]) / hstep;
  slope[0] = 0;
  for (int i = 1; i < 4; ++i) slope[i] = (delta[i - 1] * delta[i] <= 0) ? 0.0 : (delta[i - 1] + delta[i]) / 2;
  slope[4] = delta[3];
  for (int i = 0; i < 4; ++i) {
    if (delta[i] == 0) { slope[i] = 0; slope[i + 1] = 0; continue; }
    double a = slope[i] / delta[i], b = slope[i + 1] / delta[i];
    if (a < 0) { slope[i] = 0; a = 0; }
    if (b < 0) { slope[i + 1] = 0; b = 0; }
    double r = a * a + b * b;
    if (r > 9) {
      double t = 3 / m::sqrt(r);
      slope[i] = t * a * delta[i];
      slope[i + 1] = t * b * delta[i];
    }
  }
  int k = static_cast<int>(s / hstep);
  if (k > 3) k = 3;
  double t = (s - k * hstep) / hstep;
  double t2 = t * t, t3 = t2 * t;
  double v = (2 * t3 - 3 * t2 + 1) * y[k] + (t3 - 2 * t2 + t) * hstep * slope[k] + (-2 * t3 + 3 * t2) * y[k + 1] +
             (t3 - t2) * hstep * slope[k + 1];
  return v < 0 ? 0 : v;
}

bool apply_undercut(Bar& bar, const Undercut& cut, double min_thickness) {
  const double le = bar.length / bar.elems;
  bool ok = true;
  for (int e = 0; e < bar.elems; ++e) {
    double x = (e + 0.5) * le;
    double h = bar.thickness - undercut_depth(cut, bar.length, x - bar.length / 2);
    if (h < min_thickness - 1e-12) {
      ok = false;
      h = min_thickness;
    }
    bar.h[e] = h;
  }
  return ok;
}

void apply_table(Bar& bar, const double* samples, int count) {
  const double le = bar.length / bar.elems;
  for (int e = 0; e < bar.elems; ++e) {
    double s = (e + 0.5) * le / bar.length * (count - 1);
    int i = static_cast<int>(s);
    if (i >= count - 1) i = count - 2;
    double t = s - i;
    bar.h[e] = samples[i] * (1 - t) + samples[i + 1] * t;
  }
}

double thickness_at(const Bar& bar, double x) {
  int e = static_cast<int>(x / bar.length * bar.elems);
  if (e < 0) e = 0;
  if (e >= bar.elems) e = bar.elems - 1;
  return bar.h[e];
}

double bar_mass(const Bar& bar) {
  double s = 0;
  for (int e = 0; e < bar.elems; ++e) s += bar.h[e];
  return s * bar.length / bar.elems * bar.width * bar.mat.rho;
}

bool solve_modes(const Bar& bar, Modes& out, int wanted) {
  out.count = 0;
  if (wanted < 1) wanted = 1;
  if (wanted > MAX_MODES) wanted = MAX_MODES;
  if (bar.elems < 8 || bar.elems > MAX_ELEMS) return false;
  assemble(bar);
  const int n = g_K.n;
  const int nodes = bar.elems + 1;
  const int p = 2 + wanted;  // the two rigid-body motions come out first

  // Shift: A = K + s M is positive definite even though a free bar has zero-frequency motions.
  // s is a small fraction of the first partial of a plain (uncut) bar.
  double hmax = 0;
  for (int e = 0; e < bar.elems; ++e) hmax = m::max(hmax, bar.h[e]);
  const double beta = 4.730040745 / bar.length;
  const double w1 = beta * beta * hmax * m::sqrt(bar.mat.E / (12 * bar.mat.rho));
  const double shift = 0.02 * w1 * w1;
  for (int i = 0; i < n; ++i)
    for (int d = 0; d <= BW; ++d) g_A.a[i][d] = g_K.a[i][d] + shift * g_M.a[i][d];
  g_A.n = n;
  if (!band_cholesky(g_A)) return false;

  // Starting vectors: the two rigid motions, then cosine shapes with matching rotations.
  const double le = bar.length / bar.elems;
  for (int j = 0; j < Q; ++j) {
    for (int i = 0; i < nodes; ++i) {
      double x = i * le;
      double w, th;
      if (j == 0) { w = 1; th = 0; }
      else if (j == 1) { w = x - bar.length / 2; th = 1; }
      else {
        double k = j * m::PI / bar.length;
        double s, c;
        m::sincos(k * x, s, c);
        w = c; th = -k * s;
      }
      g_X[j][2 * i] = w;
      g_X[j][2 * i + 1] = th;
    }
  }

  double kt[Q][Q], mt[Q][Q], lc[Q][Q], c[Q][Q], v[Q][Q], qm[Q][Q];
  double prev[Q] = {}, mu[Q] = {};
  double tmp[MAX_DOF];
  bool converged = false;
  double change = 1;
  int iter = 0;
  for (; iter < 100 && !converged; ++iter) {
    // Y = A^-1 M X
    for (int j = 0; j < Q; ++j) {
      band_mul(g_M, g_X[j], g_Y[j]);
      band_solve(g_A, g_Y[j]);
    }
    // Rayleigh-Ritz on the subspace: Kt = Y^T K Y, Mt = Y^T M Y
    for (int j = 0; j < Q; ++j) {
      band_mul(g_K, g_Y[j], tmp);
      for (int i = 0; i <= j; ++i) kt[i][j] = kt[j][i] = dot(g_Y[i], tmp, n);
      band_mul(g_M, g_Y[j], tmp);
      for (int i = 0; i <= j; ++i) mt[i][j] = mt[j][i] = dot(g_Y[i], tmp, n);
    }
    // Mt = Lc Lc^T, C = Lc^-1 Kt Lc^-T: a standard symmetric problem.
    for (int i = 0; i < Q; ++i)
      for (int j = 0; j < Q; ++j) lc[i][j] = 0;
    for (int i = 0; i < Q; ++i) {
      for (int j = 0; j <= i; ++j) {
        double s = mt[i][j];
        for (int k = 0; k < j; ++k) s -= lc[i][k] * lc[j][k];
        if (i == j) {
          if (!(s > 0)) return false;
          lc[i][i] = m::sqrt(s);
        } else {
          lc[i][j] = s / lc[j][j];
        }
      }
    }
    double t1[Q][Q];
    for (int col = 0; col < Q; ++col)  // t1 = Lc^-1 Kt
      for (int i = 0; i < Q; ++i) {
        double s = kt[i][col];
        for (int k = 0; k < i; ++k) s -= lc[i][k] * t1[k][col];
        t1[i][col] = s / lc[i][i];
      }
    for (int row = 0; row < Q; ++row)  // c = t1 Lc^-T
      for (int i = 0; i < Q; ++i) {
        double s = t1[row][i];
        for (int k = 0; k < i; ++k) s -= lc[i][k] * c[row][k];
        c[row][i] = s / lc[i][i];
      }
    for (int i = 0; i < Q; ++i)
      for (int j = i + 1; j < Q; ++j) c[i][j] = c[j][i] = (c[i][j] + c[j][i]) / 2;
    jacobi(c, v, Q);
    // Sort eigenpairs ascending.
    int order[Q];
    for (int i = 0; i < Q; ++i) order[i] = i;
    for (int i = 1; i < Q; ++i)
      for (int j = i; j > 0 && c[order[j]][order[j]] < c[order[j - 1]][order[j - 1]]; --j) {
        int t = order[j]; order[j] = order[j - 1]; order[j - 1] = t;
      }
    // qm = Lc^-T V (sorted columns)
    for (int col = 0; col < Q; ++col) {
      mu[col] = c[order[col]][order[col]];
      for (int i = Q - 1; i >= 0; --i) {
        double s = v[i][order[col]];
        for (int k = i + 1; k < Q; ++k) s -= lc[k][i] * qm[k][col];
        qm[i][col] = s / lc[i][i];
      }
    }
    // X = Y qm
    for (int col = 0; col < Q; ++col)
      for (int i = 0; i < n; ++i) {
        double s = 0;
        for (int k = 0; k < Q; ++k) s += g_Y[k][i] * qm[k][col];
        g_X[col][i] = s;
      }
    change = 0;
    for (int i = 2; i < p; ++i) {
      double rc = m::abs(mu[i] - prev[i]) / m::abs(mu[i]);
      change = (rc == rc) ? m::max(change, rc) : 1.0;
    }
    converged = iter > 1 && (change <= 1e-11 || (iter > 25 && change <= 1e-9));
    for (int i = 0; i < Q; ++i) prev[i] = mu[i];
  }
  // Very slender bars with stiff shear are numerically noisy at about 1e-10; that is still far
  // more accurate than anything audible (1 cent is 6e-4).
  if (!converged && !(change <= 1e-8)) return false;
  // The two lowest must be the rigid-body motions (zero frequency).
  if (!(m::abs(mu[0]) < 1e-6 * mu[2] && m::abs(mu[1]) < 1e-6 * mu[2])) return false;
  for (int k = 0; k < wanted; ++k) {
    const double lambda = mu[k + 2];
    if (!(lambda > 0)) return false;
    out.freq[k] = m::sqrt(lambda) / (2 * m::PI);
    double big = 0;
    for (int i = 0; i < nodes; ++i) big = m::max(big, m::abs(g_X[k + 2][2 * i]));
    double sign = g_X[k + 2][0] < 0 ? -1.0 : 1.0;
    for (int i = 0; i < nodes; ++i) out.shape[k][i] = sign * g_X[k + 2][2 * i] / big;
  }
  out.count = wanted;
  out.iterations = iter;
  return true;
}

int node_positions(const Bar& bar, const Modes& modes, int k, double* out, int cap) {
  if (k < 0 || k >= modes.count) return 0;
  const double le = bar.length / bar.elems;
  int found = 0;
  for (int i = 0; i < bar.elems && found < cap; ++i) {
    double a = modes.shape[k][i], b = modes.shape[k][i + 1];
    if ((a > 0 && b <= 0) || (a < 0 && b >= 0)) {
      if (b == 0 && i + 1 < bar.elems) {
        out[found++] = (i + 1) * le;
        ++i;
        continue;
      }
      out[found++] = (i + a / (a - b)) * le;
    }
  }
  return found;
}

}  // namespace rt
