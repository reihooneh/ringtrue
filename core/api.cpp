#include "api.hpp"

#include "advise.hpp"
#include "bar.hpp"
#include "mathlite.hpp"
#include "spectrum.hpp"
#include "tune.hpp"

namespace rt::api {
namespace {

// Big structures live in static storage (the WebAssembly stack is small).
DesignSpec g_spec;
Design g_design;
Bar g_bar;
Modes g_modes;
Advice g_advice;
Hearing g_hearing;

bool get(const double* in, int i, double lo, double hi, double& v) {
  v = in[i];
  return m::finite(v) && v >= lo && v <= hi;
}

bool get_int(const double* in, int i, int lo, int hi, int& v) {
  double d = in[i];
  if (!m::finite(d) || d != m::floor(d) || d < lo || d > hi) return false;
  v = static_cast<int>(d);
  return true;
}

bool read_material(const double* in, Material& mat) {
  return get(in, I_E, 1e8, 5e11, mat.E) && get(in, I_G, 1e7, 2e11, mat.G) && get(in, I_RHO, 100, 25000, mat.rho) &&
         get(in, I_LOSS, 0, 0.2, mat.loss);
}

bool read_section(const double* in, double& width, double& thick, double& min_thick) {
  if (!get(in, I_WIDTH, 0.005, 0.3, width) || !get(in, I_THICK, 0.003, 0.1, thick)) return false;
  return get(in, I_MIN_THICK, 0.001, thick * 0.95, min_thick);
}

bool read_targets(const double* in, Targets& t) {
  if (!get(in, I_F1, 20, 8000, t.f1) || !get_int(in, I_COUNT, 1, 3, t.count)) return false;
  t.ratio[0] = 4;
  t.ratio[1] = 10;
  if (t.count >= 2 && !get(in, I_R2, 1.5, 12, t.ratio[0])) return false;
  if (t.count >= 3 && !get(in, I_R3, t.ratio[0] + 0.5, 40, t.ratio[1])) return false;
  return true;
}

// The bar as it is: length, section, wood and its profile (an undercut or a thickness table).
bool read_bar(const double* in, Bar& bar, double& min_thick) {
  if (!read_material(in, bar.mat)) return false;
  if (!read_section(in, bar.width, bar.thickness, min_thick)) return false;
  if (!get(in, I_LENGTH, 0.03, 2.0, bar.length)) return false;
  bar.elems = 300;
  int kind;
  if (!get_int(in, I_PROFILE_KIND, 0, 1, kind)) return false;
  if (kind == 0) {
    Undercut cut;
    if (!get(in, I_SPAN, 0, 1, cut.half_span)) return false;
    for (int k = 0; k < 4; ++k)
      if (!get(in, I_DEPTH0 + k, 0, bar.thickness - min_thick, cut.depth[k])) return false;
    apply_undercut(bar, cut, min_thick);
  } else {
    int n;
    if (!get_int(in, I_TABLE_COUNT, 2, TABLE_MAX, n)) return false;
    double tmp;
    for (int i = 0; i < n; ++i)
      if (!get(in, I_TABLE0 + i, 0.0005, bar.thickness * 1.0001, tmp)) return false;
    apply_table(bar, in + I_TABLE0, n);
  }
  return true;
}

void write_bar(const Bar& bar, const Modes& md, double* out) {
  out[O_LENGTH] = bar.length;
  out[O_MASS] = bar_mass(bar);
  for (int i = 0; i < PROFILE_POINTS; ++i) {
    double x = bar.length * i / (PROFILE_POINTS - 1);
    out[O_PROFILE + i] = thickness_at(bar, x);
  }
  for (int k = 0; k < MAX_MODES; ++k) {
    out[O_FREQ0 + k] = k < md.count ? md.freq[k] : 0;
    for (int i = 0; i < PROFILE_POINTS; ++i) {
      double v = 0;
      if (k < md.count) {
        double s = static_cast<double>(i) / (PROFILE_POINTS - 1) * bar.elems;
        int j = static_cast<int>(s);
        if (j >= bar.elems) j = bar.elems - 1;
        double t = s - j;
        v = md.shape[k][j] * (1 - t) + md.shape[k][j + 1] * t;
      }
      out[O_SHAPES + k * PROFILE_POINTS + i] = v;
    }
  }
  for (int k = 0; k < 3; ++k) {
    double pos[5];
    int n = node_positions(bar, md, k, pos, 5);
    out[O_NODES + k * 6] = n;
    for (int i = 0; i < 5; ++i) out[O_NODES + k * 6 + 1 + i] = i < n ? pos[i] : 0;
  }
}

int finish(double* out, int slot, int status) {
  out[slot] = status;
  return status;
}

void clear(double* out, int n) {
  for (int i = 0; i < n; ++i) out[i] = 0;
}

}  // namespace

int design(const double* in, double* out) {
  clear(out, OUT_SIZE);
  DesignSpec& s = g_spec;
  int fixed;
  if (!read_material(in, s.mat) || !read_section(in, s.width, s.thickness, s.min_thickness) || !read_targets(in, s.targets) ||
      !get_int(in, I_FIXED, 0, 1, fixed))
    return finish(out, O_STATUS, BAD_INPUT);
  s.fixed_length = fixed == 1;
  if (s.fixed_length) {
    if (!get(in, I_LENGTH, 0.03, 2.0, s.length)) return finish(out, O_STATUS, BAD_INPUT);
    s.min_length = s.max_length = s.length;
  } else {
    if (!get(in, I_MIN_LENGTH, 0.03, 2.0, s.min_length) || !get(in, I_MAX_LENGTH, s.min_length * 1.05, 2.0, s.max_length))
      return finish(out, O_STATUS, BAD_INPUT);
    s.length = s.min_length;
  }
  design_bar(s, g_design);
  out[O_EVALS] = g_design.evaluations;
  if (!g_design.ok) return finish(out, O_STATUS, NO_SOLUTION);
  write_bar(g_design.bar, g_design.modes, out);
  out[O_SPAN] = g_design.cut.half_span;
  for (int k = 0; k < 4; ++k) out[O_DEPTH0 + k] = g_design.cut.depth[k];
  bool all = true;
  for (int i = 0; i < 3; ++i) {
    out[O_ERR0 + i] = g_design.error[i];
    out[O_MET0 + i] = g_design.met[i] ? 1 : 0;
    if (i < s.targets.count && !g_design.met[i]) all = false;
  }
  return finish(out, O_STATUS, all ? OK : MISSED);
}

int analyse(const double* in, double* out) {
  clear(out, OUT_SIZE);
  double min_thick;
  if (!read_bar(in, g_bar, min_thick)) return finish(out, O_STATUS, BAD_INPUT);
  if (!solve_modes(g_bar, g_modes, MAX_MODES)) return finish(out, O_STATUS, NO_SOLUTION);
  write_bar(g_bar, g_modes, out);
  Targets t;
  if (read_targets(in, t)) {
    double err[3];
    target_errors(g_modes, t, err);
    for (int i = 0; i < 3; ++i) {
      out[O_ERR0 + i] = err[i];
      out[O_MET0 + i] = (i < t.count && m::abs(err[i]) <= 3) ? 1 : 0;
    }
  }
  return finish(out, O_STATUS, OK);
}

int advise(const double* in, double* out) {
  clear(out, OUT_SIZE);
  double min_thick;
  Targets t;
  Measured heard;
  if (!read_bar(in, g_bar, min_thick) || !read_targets(in, t) || !get_int(in, I_HEARD_COUNT, 1, 3, heard.count))
    return finish(out, A_STATUS, BAD_INPUT);
  for (int i = 0; i < heard.count; ++i) {
    double lo = i == 0 ? 20 : heard.f[i - 1] * 1.05;
    if (!get(in, I_HEARD0 + i, lo, 20000, heard.f[i])) return finish(out, A_STATUS, BAD_INPUT);
  }
  rt::advise(g_bar, min_thick, heard, t, g_advice);
  const Advice& a = g_advice;
  out[A_EVALS] = a.evaluations;
  if (!a.ok) return finish(out, A_STATUS, NO_SOLUTION);
  out[A_DONE] = a.done;
  out[A_FLAT] = a.flat;
  out[A_STIFF] = a.stiffness_scale;
  out[A_SHEAR] = a.shear_scale;
  for (int i = 0; i < 3; ++i) {
    out[A_FIT0 + i] = a.fit_error[i];
    out[A_NOW0 + i] = a.now_error[i];
  }
  out[A_STEPS] = a.steps;
  for (int s = 0; s < a.steps; ++s) {
    double* p = out + A_STEP0 + s * 7;
    p[0] = a.step[s].kind;
    p[1] = a.step[s].position;
    p[2] = a.step[s].width;
    p[3] = a.step[s].amount;
    for (int i = 0; i < 3; ++i) p[4 + i] = a.step[s].after[i];
  }
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < SENS_POINTS; ++j) out[A_SENS0 + i * SENS_POINTS + j] = a.sensitivity[i][j];
  for (int j = 0; j < SENS_POINTS; ++j) out[A_SENS_POS0 + j] = a.sens_position[j];
  // The bar after the whole plan, for drawing.
  for (int s = 0; s < a.steps; ++s) apply_step(g_bar, a.step[s], min_thick);
  for (int i = 0; i < PROFILE_POINTS; ++i) out[A_PROFILE + i] = thickness_at(g_bar, g_bar.length * i / (PROFILE_POINTS - 1));
  return finish(out, A_STATUS, OK);
}

int hear(const double* in, const float* samples, double* out) {
  clear(out, OUT_SIZE);
  double rate;
  int n;
  if (!get(in, I_RATE, 8000, 192000, rate) || !get_int(in, I_SAMPLES, 1, MAX_SAMPLES, n)) return finish(out, H_STATUS, BAD_INPUT);
  double expect[3];
  bool any = false;
  for (int i = 0; i < 3; ++i) {
    double v = in[I_EXPECT0 + i];
    if (!m::finite(v) || v < 0 || v > rate / 2) return finish(out, H_STATUS, BAD_INPUT);
    if (v != 0 && v < 20) return finish(out, H_STATUS, BAD_INPUT);
    expect[i] = v;
    any = any || v > 0;
  }
  rt::hear(samples, n, rate, any ? expect : nullptr, g_hearing);
  const Hearing& h = g_hearing;
  out[H_ONSET] = h.onset;
  out[H_PEAK_AMP] = h.peak_amplitude;
  out[H_FOUND] = h.found;
  for (int i = 0; i < 3; ++i) {
    out[H_PARTIAL0 + i] = h.partial[i];
    out[H_LEVEL0 + i] = h.partial_level[i];
  }
  out[H_PEAKS] = h.peak_count;
  for (int i = 0; i < h.peak_count; ++i) {
    out[H_PEAK0 + 2 * i] = h.peaks[i].freq;
    out[H_PEAK0 + 2 * i + 1] = h.peaks[i].level;
  }
  if (!h.ok) {
    int code = h.error == HEAR_TOO_QUIET ? TOO_QUIET : (h.error == HEAR_NO_PEAKS ? NO_PEAKS : BAD_INPUT);
    return finish(out, H_STATUS, code);
  }
  return finish(out, H_STATUS, OK);
}

}  // namespace rt::api
