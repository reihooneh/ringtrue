#include "advise.hpp"

#include "mathlite.hpp"

namespace rt {
namespace {

constexpr int ADV_ELEMS = 200;
constexpr double PROBE_DEPTH = 0.0003;  // 0.3 mm test cut for the sensitivities
constexpr double PROBE_TRIM = 0.0005;   // 0.5 mm off each end
constexpr double PITCH_WEIGHT = 4;      // the note itself matters most
// "In tune": the note within 3 cents, the overtones within 5 and 8 (the ear is less exact up there).
constexpr double DONE_CENTS[3] = {3, 5, 8};

Bar g_base, g_work, g_probe, g_tmp;
Modes g_md;

double cut_width(const Bar& b) { return m::clamp(b.length / 16, 0.006, 0.03); }

bool model_cents(const Bar& b, const Targets& t, double* err, int& evals) {
  ++evals;
  if (!solve_modes(b, g_md, t.count)) return false;
  target_errors(g_md, t, err);
  return true;
}

void resample(const Bar& from, Bar& to, int elems) {
  to = from;
  to.elems = elems;
  const double le = from.length / elems;
  for (int e = 0; e < elems; ++e) to.h[e] = thickness_at(from, (e + 0.5) * le);
}

// Ratio f2/f1 of the bar with its shear modulus multiplied by g.
bool ratio_with_shear(const Bar& b, double g, double& ratio, int& evals) {
  g_tmp = b;
  g_tmp.mat.G = b.mat.G * g;
  ++evals;
  if (!solve_modes(g_tmp, g_md, 2)) return false;
  ratio = g_md.freq[1] / g_md.freq[0];
  return true;
}

}  // namespace

void apply_step(Bar& bar, const CutStep& step, double min_thickness) {
  if (step.kind == CUT_TRIM_ENDS) {
    g_tmp = bar;
    const double a = m::clamp(step.amount, 0.0, bar.length * 0.2);
    bar.length = g_tmp.length - 2 * a;
    const double le = bar.length / bar.elems;
    for (int e = 0; e < bar.elems; ++e) bar.h[e] = thickness_at(g_tmp, (e + 0.5) * le + a);
    return;
  }
  const double le = bar.length / bar.elems;
  const double half = step.width / 2;
  for (int e = 0; e < bar.elems; ++e) {
    double dist = m::abs((e + 0.5) * le - bar.length / 2);
    // dist is measured from the centre, so this one test covers the cut on both sides.
    double off = dist - step.position;
    if (m::abs(off) >= half) continue;
    double depth = step.amount * 0.5 * (1 + m::cos(m::PI * off / half));
    bar.h[e] = m::max(min_thickness, bar.h[e] - depth);
  }
}

void advise(const Bar& bar, double min_thickness, const Measured& heard, const Targets& t, Advice& out) {
  out.ok = false;
  out.done = false;
  out.flat = false;
  out.steps = 0;
  out.evaluations = 0;
  out.stiffness_scale = 1;
  out.shear_scale = 1;
  for (int i = 0; i < 3; ++i) { out.fit_error[i] = 0; out.now_error[i] = 0; }
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < SENS_POINTS; ++j) out.sensitivity[i][j] = 0;
  int& ev = out.evaluations;
  const int n_heard = heard.count < 1 ? 1 : (heard.count > 3 ? 3 : heard.count);

  resample(bar, g_base, ADV_ELEMS);

  // 1. Calibrate. Shear first (it changes the ratio of partials), then overall stiffness.
  double g = 1;
  if (n_heard >= 2) {
    const double want = heard.f[1] / heard.f[0];
    double lo = m::log(0.2), hi = m::log(5.0), rlo, rhi;
    if (!ratio_with_shear(g_base, m::exp(lo), rlo, ev) || !ratio_with_shear(g_base, m::exp(hi), rhi, ev)) return;
    if (want <= rlo) g = m::exp(lo);
    else if (want >= rhi) g = m::exp(hi);
    else {
      for (int it = 0; it < 30; ++it) {
        double mid = (lo + hi) / 2, r;
        if (!ratio_with_shear(g_base, m::exp(mid), r, ev)) return;
        if (r < want) lo = mid; else hi = mid;
      }
      g = m::exp((lo + hi) / 2);
    }
  }
  g_base.mat.G *= g;
  ++ev;
  if (!solve_modes(g_base, g_md, 3)) return;
  const double s = (heard.f[0] / g_md.freq[0]) * (heard.f[0] / g_md.freq[0]);
  g_base.mat.E *= s;
  g_base.mat.G *= s;
  out.stiffness_scale = s;
  out.shear_scale = g;
  ++ev;
  if (!solve_modes(g_base, g_md, 3)) return;
  for (int i = 0; i < n_heard; ++i) out.fit_error[i] = m::cents(g_md.freq[i], heard.f[i]);

  // 2. Where we are now. Heard partials use what was heard; the rest use the model.
  double model0[3];
  target_errors(g_md, t, model0);
  double offset[3] = {0, 0, 0};
  for (int i = 0; i < t.count; ++i) {
    if (i < n_heard) {
      double target = i == 0 ? t.f1 : t.f1 * t.ratio[i - 1];
      out.now_error[i] = m::cents(heard.f[i], target);
      offset[i] = out.now_error[i] - model0[i];
    } else {
      out.now_error[i] = model0[i];
    }
  }
  out.done = true;
  for (int i = 0; i < t.count; ++i)
    if (m::abs(out.now_error[i]) > DONE_CENTS[i]) out.done = false;
  out.flat = out.now_error[0] < -3;
  out.ok = true;
  if (out.done) return;

  // 3. This round's cuts. Linearise: how many cents each partial moves per mm at each place.
  g_work = g_base;
  const double w = cut_width(g_work);
  const double maxu = g_work.length / 2 - w / 2 - 0.003;
  constexpr int NC = SENS_POINTS + 1;  // SENS_POINTS places to deepen, plus "trim the ends"
  double S[3][NC] = {}, cap[NC] = {}, err[3] = {0, 0, 0}, cur[3];
  if (!model_cents(g_work, t, cur, ev)) return;
  for (int i = 0; i < t.count; ++i) err[i] = cur[i] + offset[i];
  auto candidate = [&](int j, double amount_mm) {
    CutStep st{};
    if (j < SENS_POINTS) {
      st.kind = CUT_DEEPEN;
      st.position = maxu * j / (SENS_POINTS - 1);
      st.width = w;
    } else {
      st.kind = CUT_TRIM_ENDS;
    }
    st.amount = amount_mm / 1000;
    return st;
  };
  for (int j = 0; j < NC; ++j) {
    const bool trim = j == SENS_POINTS;
    CutStep probe = candidate(j, (trim ? PROBE_TRIM : PROBE_DEPTH) * 1000);
    if (!trim) out.sens_position[j] = probe.position;
    cap[j] = trim ? 0.1 * g_work.length * 1000 : (thickness_at(g_work, g_work.length / 2 + probe.position) - min_thickness) * 1000;
    if (cap[j] <= 0.01) { cap[j] = 0; continue; }
    g_probe = g_work;
    apply_step(g_probe, probe, min_thickness);
    double after[3];
    if (!model_cents(g_probe, t, after, ev)) { cap[j] = 0; continue; }
    for (int i = 0; i < t.count; ++i) {
      S[i][j] = (after[i] - cur[i]) / (probe.amount * 1000);
      if (!trim) out.sensitivity[i][j] = S[i][j];
    }
  }

  // Box-constrained least squares (0 <= amount <= what's left), by projected coordinate descent:
  //   minimise  sum_i w_i (err_i + sum_j S_ij a_j)^2 + mu sum_j a_j^2
  // Several cuts together can fix what no single cut can (for example lowering the third
  // partial without dragging the second down with it).
  double wt[3] = {PITCH_WEIGHT, 1, 1};
  double a[NC] = {};
  bool use[NC];
  for (int j = 0; j < NC; ++j) use[j] = cap[j] > 0;
  double col[NC] = {}, biggest = 0;
  for (int j = 0; j < NC; ++j) {
    for (int i = 0; i < t.count; ++i) col[j] += wt[i] * S[i][j] * S[i][j];
    biggest = m::max(biggest, col[j]);
  }
  const double mu = 1e-4 * biggest + 1e-12;
  auto solve_ls = [&]() {
    double r[3];
    for (int i = 0; i < 3; ++i) {
      r[i] = err[i];
      for (int j = 0; j < NC; ++j) r[i] += S[i][j] * a[j];
    }
    for (int sweep = 0; sweep < 600; ++sweep) {
      double moved = 0;
      for (int j = 0; j < NC; ++j) {
        if (!use[j]) { if (a[j] != 0) { for (int i = 0; i < 3; ++i) r[i] -= S[i][j] * a[j]; a[j] = 0; } continue; }
        double grad = mu * a[j];
        for (int i = 0; i < t.count; ++i) grad += wt[i] * S[i][j] * r[i];
        double na = m::clamp(a[j] - grad / (col[j] + mu), 0.0, cap[j]);
        double d = na - a[j];
        if (d != 0) {
          for (int i = 0; i < 3; ++i) r[i] += S[i][j] * d;
          a[j] = na;
          moved = m::max(moved, m::abs(d));
        }
      }
      if (moved < 1e-7) break;
    }
  };
  solve_ls();
  // Keep at most MAX_STEPS cuts (the ones doing the most work), then re-fit with just those.
  for (int keep = 0; keep < NC; ++keep) {
    int count = 0;
    for (int j = 0; j < NC; ++j) if (use[j] && a[j] > 0.02) ++count;
    if (count <= MAX_STEPS) break;
    int weakest = -1;
    double wv = 1e300;
    for (int j = 0; j < NC; ++j) {
      if (!use[j] || a[j] <= 0.02) continue;
      double v = a[j] * m::sqrt(col[j]);
      if (v < wv) { wv = v; weakest = j; }
    }
    use[weakest] = false;
    solve_ls();
  }
  for (int j = 0; j < NC; ++j) if (a[j] <= 0.02) { use[j] = false; a[j] = 0; }

  // One round should be gentle: no cut deeper than MAX_STEP_DEPTH, no trim longer than
  // MAX_STEP_TRIM. Check the round with full solves and back off if it doesn't help.
  double scale = 1;
  for (int j = 0; j < NC; ++j) {
    if (!use[j]) continue;
    double limit = (j == SENS_POINTS ? MAX_STEP_TRIM : MAX_STEP_DEPTH) * 1000;
    if (a[j] * scale > limit) scale = limit / a[j];
  }
  double start_cost = 0;
  for (int i = 0; i < t.count; ++i) start_cost += wt[i] * err[i] * err[i];
  for (int attempt = 0; attempt < 4; ++attempt) {
    if (attempt > 0) scale /= 2;
    g_probe = g_work;
    int n = 0;
    CutStep plan[MAX_STEPS];
    // Trim first (it changes where everything is measured from), then the cuts from the centre out.
    for (int o = 0; o < NC && n < MAX_STEPS; ++o) {
      const int j = o == 0 ? NC - 1 : o - 1;
      if (use[j]) {
        plan[n] = candidate(j, a[j] * scale);
        apply_step(g_probe, plan[n], min_thickness);
        double after[3];
        if (!model_cents(g_probe, t, after, ev)) { n = -1; break; }
        for (int i = 0; i < 3; ++i) plan[n].after[i] = i < t.count ? after[i] + offset[i] : 0;
        ++n;
      }
    }
    if (n <= 0) break;
    double c = 0;
    for (int i = 0; i < t.count; ++i) c += wt[i] * plan[n - 1].after[i] * plan[n - 1].after[i];
    if (c < start_cost - 1.0) {
      for (int k = 0; k < n; ++k) out.step[k] = plan[k];
      out.steps = n;
      break;
    }
  }
}

}  // namespace rt
