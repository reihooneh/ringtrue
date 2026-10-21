// Core tests, run natively under AddressSanitizer and UndefinedBehaviorSanitizer.
// Each check compares against an independent answer: textbook beam theory, libm, a naive DFT,
// or a simulated bar whose true properties we know.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "advise.hpp"
#include "api.hpp"
#include "bar.hpp"
#include "mathlite.hpp"
#include "materials.hpp"
#include "spectrum.hpp"
#include "tune.hpp"

using namespace rt;

static int g_checks = 0, g_failed = 0;
#define CHECK(cond, ...)                                       \
  do {                                                         \
    ++g_checks;                                                \
    if (!(cond)) {                                             \
      ++g_failed;                                              \
      std::printf("FAIL %s:%d: %s  ", __FILE__, __LINE__, #cond); \
      std::printf(__VA_ARGS__);                                \
      std::printf("\n");                                       \
    }                                                          \
  } while (0)

static double rel(double a, double b) { return std::fabs(a - b) / std::fabs(b); }

// Deterministic random numbers for the tests.
static unsigned long long g_rng = 0x9e3779b97f4a7c15ULL;
static double rnd() {
  g_rng ^= g_rng << 13;
  g_rng ^= g_rng >> 7;
  g_rng ^= g_rng << 17;
  return static_cast<double>(g_rng >> 11) / 9007199254740992.0;
}

static Bar g_bar, g_bar2;
static Modes g_md, g_md2;
static Design g_d, g_d2;
static Advice g_adv;
static Hearing g_hear;

static void uniform_bar(Bar& b, double L, double w, double h, Material mat, int elems) {
  b.length = L;
  b.width = w;
  b.thickness = h;
  b.mat = mat;
  b.elems = elems;
  for (int e = 0; e < elems; ++e) b.h[e] = h;
}

static const Material ROSE = {22e9, 22e9 / 16, 1025, 0.006};

static void test_mathlite() {
  double worst = 0;
  for (int i = 0; i < 20000; ++i) {
    double x = (rnd() - 0.5) * 200;
    worst = std::fmax(worst, std::fabs(m::sin(x) - std::sin(x)));
    worst = std::fmax(worst, std::fabs(m::cos(x) - std::cos(x)));
  }
  CHECK(worst < 1e-13, "sin/cos worst %.3g", worst);
  worst = 0;
  for (int i = 0; i < 20000; ++i) {
    double x = std::exp((rnd() - 0.5) * 80);
    worst = std::fmax(worst, std::fabs(m::log(x) - std::log(x)) / std::fmax(1.0, std::fabs(std::log(x))));
  }
  CHECK(worst < 1e-14, "log worst %.3g", worst);
  worst = 0;
  for (int i = 0; i < 20000; ++i) {
    double x = (rnd() - 0.5) * 1400;
    worst = std::fmax(worst, rel(m::exp(x), std::exp(x)));
  }
  CHECK(worst < 1e-13, "exp worst %.3g", worst);
  CHECK(std::fabs(m::cents(2, 1) - 1200) < 1e-9, "octave");
  CHECK(!m::finite(NAN) && !m::finite(INFINITY) && m::finite(1e308), "finite");
  CHECK(m::floor(-2.5) == -3 && m::floor(2.5) == 2 && m::floor(1e300) == 1e300, "floor");
}

static void test_beam_theory() {
  // A slender bar with very stiff shear behaves like an Euler-Bernoulli beam, whose free-free
  // frequencies are known exactly: beta_n L = 4.7300, 7.8532, 10.9956, 14.1372.
  Material eb = {70e9, 70e9 * 10, 2700, 0};
  uniform_bar(g_bar, 0.5, 0.04, 0.002, eb, 300);
  CHECK(solve_modes(g_bar, g_md, 4), "solve slender bar");
  const double betas[4] = {4.730040745, 7.853204624, 10.99560784, 14.13716549};
  const double I = 0.04 * 0.002 * 0.002 * 0.002 / 12, A = 0.04 * 0.002;
  for (int k = 0; k < 4; ++k) {
    double b = betas[k] / 0.5;
    double f = b * b * std::sqrt(70e9 * I / (2700 * A)) / (2 * M_PI);
    CHECK(rel(g_md.freq[k], f) < 3e-4, "mode %d: %.4f vs %.4f", k + 1, g_md.freq[k], f);
  }
  CHECK(std::fabs(g_md.freq[1] / g_md.freq[0] - 2.7565) < 2e-3, "ratio 2 %.4f", g_md.freq[1] / g_md.freq[0]);
  CHECK(std::fabs(g_md.freq[2] / g_md.freq[0] - 5.4039) < 5e-3, "ratio 3 %.4f", g_md.freq[2] / g_md.freq[0]);
  // The first mode's nodes sit 22.4% in from each end.
  double nodes[4];
  int n = node_positions(g_bar, g_md, 0, nodes, 4);
  CHECK(n == 2 && std::fabs(nodes[0] / 0.5 - 0.22416) < 2e-4 && std::fabs(nodes[1] / 0.5 - 0.77584) < 2e-4, "nodes %d %.5f",
        n, nodes[0] / 0.5);
  // Mode k has k+1 nodes, and shapes alternate symmetric / antisymmetric about the centre.
  for (int k = 0; k < 4; ++k) {
    double pos[8];
    CHECK(node_positions(g_bar, g_md, k, pos, 8) == k + 2, "mode %d nodes", k + 1);
    double a = g_md.shape[k][30], b = g_md.shape[k][270];
    CHECK(std::fabs(a - (k % 2 == 0 ? b : -b)) < 1e-6, "mode %d symmetry %.6f %.6f", k + 1, a, b);
  }
}

static void test_scaling_and_shear() {
  uniform_bar(g_bar, 0.4, 0.05, 0.02, ROSE, 200);
  CHECK(solve_modes(g_bar, g_md, 3), "base");
  // Frequencies scale with sqrt(stiffness) when E and G scale together, and not with width.
  g_bar2 = g_bar;
  g_bar2.mat.E *= 2;
  g_bar2.mat.G *= 2;
  CHECK(solve_modes(g_bar2, g_md2, 3), "stiffer");
  for (int k = 0; k < 3; ++k) CHECK(rel(g_md2.freq[k], g_md.freq[k] * std::sqrt(2.0)) < 1e-9, "sqrt2 mode %d", k);
  g_bar2 = g_bar;
  g_bar2.width *= 3;
  CHECK(solve_modes(g_bar2, g_md2, 3), "wider");
  for (int k = 0; k < 3; ++k) CHECK(rel(g_md2.freq[k], g_md.freq[k]) < 1e-9, "width-free mode %d", k);
  // Shear and rotary inertia lower a thick bar's partials, the higher ones most (Timoshenko).
  double beta = 4.730040745 / 0.4;
  double f_eb = beta * beta * 0.02 * std::sqrt(22e9 / (12 * 1025)) / (2 * M_PI);
  CHECK(g_md.freq[0] < f_eb * 0.985 && g_md.freq[0] > f_eb * 0.95, "Timoshenko f1 %.2f vs EB %.2f", g_md.freq[0], f_eb);
  CHECK(g_md.freq[1] / g_md.freq[0] < 2.70 && g_md.freq[2] / g_md.freq[0] < 5.2, "shear lowers ratios");
  // Mesh convergence: doubling the elements changes the answer by much less than a cent.
  g_bar2 = g_bar;
  uniform_bar(g_bar2, 0.4, 0.05, 0.02, ROSE, 400);
  CHECK(solve_modes(g_bar2, g_md2, 3), "fine mesh");
  for (int k = 0; k < 3; ++k) CHECK(std::fabs(m::cents(g_md.freq[k], g_md2.freq[k])) < 1.0, "converged mode %d", k);
}

static void test_undercut() {
  Undercut cut = {0.6, {0.010, 0.009, 0.006, 0.003}};
  const double L = 0.4;
  double prev = undercut_depth(cut, L, 0), top = 0;
  bool continuous = true;
  for (int i = 0; i <= 4000; ++i) {
    double u = 0.2 * i / 4000;
    double d = undercut_depth(cut, L, u);
    if (std::fabs(d - prev) > 1e-4) continuous = false;
    prev = d;
    top = std::fmax(top, d);
    CHECK(d >= 0, "never negative");
    CHECK(std::fabs(d - undercut_depth(cut, L, -u)) < 1e-15, "symmetric");
  }
  CHECK(continuous, "smooth");
  CHECK(top <= 0.010 + 1e-12, "no overshoot %.6f", top);
  CHECK(undercut_depth(cut, L, 0.6 * L / 2 + 1e-6) == 0, "zero past the cut");
  CHECK(std::fabs(undercut_depth(cut, L, 0) - 0.010) < 1e-15, "centre depth");
  uniform_bar(g_bar, L, 0.05, 0.02, ROSE, 200);
  CHECK(apply_undercut(g_bar, cut, 0.008), "fits");
  CHECK(!apply_undercut(g_bar, cut, 0.012), "too deep is reported");
  for (int e = 0; e < 200; ++e) CHECK(g_bar.h[e] >= 0.012 - 1e-12, "clamped");
}

static DesignSpec spec_for(double f1, double r2, double r3, int count, double w, double h, double hmin) {
  DesignSpec s{};
  s.mat = ROSE;
  s.width = w;
  s.thickness = h;
  s.min_thickness = hmin;
  s.fixed_length = false;
  s.min_length = 0.06;
  s.max_length = 1.2;
  s.targets = {f1, {r2, r3}, count};
  return s;
}

static void test_design() {
  DesignSpec s = spec_for(261.63, 4, 10, 3, 0.05, 0.022, 0.0055);
  design_bar(s, g_d);
  CHECK(g_d.ok, "C4 marimba");
  for (int i = 0; i < 3; ++i) CHECK(std::fabs(g_d.error[i]) < 1.0 && g_d.met[i], "partial %d off by %.2f", i + 1, g_d.error[i]);
  CHECK(g_d.bar.length > 0.3 && g_d.bar.length < 0.5, "a sensible length %.3f", g_d.bar.length);
  for (int e = 0; e < g_d.bar.elems; ++e) CHECK(g_d.bar.h[e] >= 0.0055 - 1e-12, "min thickness kept");
  // An independent re-solve of the designed bar agrees.
  CHECK(solve_modes(g_d.bar, g_md, 3), "resolve");
  CHECK(std::fabs(m::cents(g_md.freq[0], 261.63)) < 1.0, "re-solve");
  // The same request gives the same answer every time.
  design_bar(s, g_d2);
  CHECK(g_d2.bar.length == g_d.bar.length && g_d2.cut.depth[0] == g_d.cut.depth[0], "deterministic");

  s = spec_for(523.25, 3, 6, 3, 0.04, 0.022, 0.008);  // xylophone C5
  design_bar(s, g_d);
  for (int i = 0; i < 3; ++i) CHECK(g_d.ok && std::fabs(g_d.error[i]) < 1.5, "xylophone partial %d: %.2f", i + 1, g_d.error[i]);

  s = spec_for(329.63, 4, 10, 2, 0.05, 0.02, 0.005);  // fixed length: the cut alone sets the pitch
  s.fixed_length = true;
  s.length = 0.36;
  design_bar(s, g_d);
  CHECK(g_d.ok && std::fabs(g_d.bar.length - 0.36) < 1e-12, "length kept");
  CHECK(std::fabs(g_d.error[0]) < 1.5 && std::fabs(g_d.error[1]) < 1.5, "fixed length errors %.2f %.2f", g_d.error[0], g_d.error[1]);

  // Impossible: a short thick bar can't reach 1:4:10 without going below 9 mm. The note itself
  // must stay in tune and the misses must be reported.
  s = spec_for(1568, 4, 10, 3, 0.038, 0.018, 0.009);
  design_bar(s, g_d);
  CHECK(g_d.ok, "compromise found");
  CHECK(std::fabs(g_d.error[0]) < 10, "note kept in tune: %.2f", g_d.error[0]);
  CHECK(!g_d.met[1] || !g_d.met[2], "misses reported");
}

// A tap recording: decaying partials plus a little noise.
static std::vector<float> synth_tap(const double* f, const double* amp, int nf, double rate, double seconds, double noise,
                                    double delay) {
  int n = static_cast<int>(rate * seconds);
  std::vector<float> x(static_cast<size_t>(n));
  for (int i = 0; i < n; ++i) {
    double t = i / rate - delay, v = 0;
    if (t >= 0)
      for (int k = 0; k < nf; ++k) v += amp[k] * std::exp(-t * (2 + 4 * k)) * std::sin(2 * M_PI * f[k] * t + k);
    v += (rnd() - 0.5) * 2 * noise;
    x[static_cast<size_t>(i)] = static_cast<float>(v);
  }
  return x;
}

static void test_fft_and_hearing() {
  // FFT against a naive DFT.
  static double re[64], im[64], r0[64], i0[64];
  for (int i = 0; i < 64; ++i) { re[i] = r0[i] = rnd() - 0.5; im[i] = i0[i] = rnd() - 0.5; }
  CHECK(fft(re, im, 64), "fft");
  double worst = 0;
  for (int k = 0; k < 64; ++k) {
    double sr = 0, si = 0;
    for (int n = 0; n < 64; ++n) {
      double a = -2 * M_PI * k * n / 64;
      sr += r0[n] * std::cos(a) - i0[n] * std::sin(a);
      si += r0[n] * std::sin(a) + i0[n] * std::cos(a);
    }
    worst = std::fmax(worst, std::hypot(sr - re[k], si - im[k]));
  }
  CHECK(worst < 1e-12, "fft vs dft %.3g", worst);
  CHECK(!fft(re, im, 48), "not a power of two");

  const double f[3] = {261.9, 1043.7, 2621.4}, amp[3] = {0.5, 0.2, 0.08};
  for (double rate : {44100.0, 48000.0}) {
    auto x = synth_tap(f, amp, 3, rate, 2.0, 0.002, 0.3);
    hear(x.data(), static_cast<int>(x.size()), rate, nullptr, g_hear);
    CHECK(g_hear.ok && g_hear.found == 3, "heard %d", g_hear.found);
    for (int k = 0; k < 3; ++k) CHECK(std::fabs(m::cents(g_hear.partial[k], f[k])) < 0.3, "partial %d: %.3f", k, g_hear.partial[k]);
    CHECK(std::fabs(g_hear.onset - 0.3) < 0.01, "onset %.4f", g_hear.onset);
  }
  // With a prediction, a strong out-of-place peak doesn't fool it.
  const double f4[4] = {261.9, 1043.7, 1900, 2621.4}, a4[4] = {0.5, 0.2, 0.3, 0.08};
  auto y = synth_tap(f4, a4, 4, 48000, 2.0, 0.001, 0.1);
  const double expect[3] = {262, 1050, 2600};
  hear(y.data(), static_cast<int>(y.size()), 48000, expect, g_hear);
  CHECK(g_hear.found == 3 && std::fabs(g_hear.partial[2] - 2621.4) < 1, "guided pick %.1f", g_hear.partial[2]);
  // Silence, noise only, NaN and too-short input are refused, never misread.
  std::vector<float> quiet(48000, 0.0f);
  hear(quiet.data(), 48000, 48000, nullptr, g_hear);
  CHECK(!g_hear.ok && g_hear.error == HEAR_TOO_QUIET, "silence");
  std::vector<float> noise(48000);
  for (auto& v : noise) v = static_cast<float>(rnd() - 0.5);
  hear(noise.data(), 48000, 48000, nullptr, g_hear);
  CHECK(!g_hear.ok || g_hear.partial_level[0] < 0, "noise isn't a clean tap");
  auto bad = synth_tap(f, amp, 3, 48000, 1.0, 0, 0.1);
  bad[1000] = NAN;
  hear(bad.data(), static_cast<int>(bad.size()), 48000, nullptr, g_hear);
  CHECK(!g_hear.ok && g_hear.error == HEAR_BAD_INPUT, "NaN refused");
  hear(bad.data(), 100, 48000, nullptr, g_hear);
  CHECK(!g_hear.ok && g_hear.error == HEAR_BAD_INPUT, "too short");
  hear(bad.data(), 48000, 1000, nullptr, g_hear);
  CHECK(!g_hear.ok && g_hear.error == HEAR_BAD_INPUT, "bad rate");
}

// The full workshop loop on a simulated bar whose wood differs from the book values and whose
// maker didn't cut quite deep enough: tap, advise, cut, tap again.
static void test_workshop_loop() {
  DesignSpec s = spec_for(261.63, 4, 10, 3, 0.05, 0.022, 0.0055);
  design_bar(s, g_d);
  Undercut partial = g_d.cut;
  for (double& d : partial.depth) d *= 0.93;
  Bar& real = g_bar;
  real = g_d.bar;
  real.mat.E *= 1.07;
  real.mat.G *= 1.07 * 1.25;
  apply_undercut(real, partial, 0.0055);
  Bar& model = g_bar2;  // what the maker knows: the book wood and the cut they made
  model = g_d.bar;
  apply_undercut(model, partial, 0.0055);

  double first_error = 0;
  for (int round = 0; round < 12; ++round) {
    CHECK(solve_modes(real, g_md, 3), "real bar");
    const double amp[3] = {0.5, 0.2, 0.08};
    auto x = synth_tap(g_md.freq, amp, 3, 48000, 2.0, 0.001, 0.05);
    hear(x.data(), static_cast<int>(x.size()), 48000, nullptr, g_hear);
    CHECK(g_hear.found == 3, "round %d heard", round);
    Measured heard = {{g_hear.partial[0], g_hear.partial[1], g_hear.partial[2]}, 3};
    advise(model, 0.0055, heard, s.targets, g_adv);
    CHECK(g_adv.ok, "advice");
    double worst = 0;
    for (int i = 0; i < 3; ++i) worst = std::fmax(worst, std::fabs(g_adv.now_error[i]));
    if (round == 0) {
      first_error = worst;
      CHECK(std::fabs(g_adv.stiffness_scale - 1.07) < 0.01, "stiffness found %.4f", g_adv.stiffness_scale);
      CHECK(std::fabs(g_adv.shear_scale - 1.25) < 0.03, "shear found %.4f", g_adv.shear_scale);
      CHECK(!g_adv.flat && !g_adv.done, "sharp, not done");
      CHECK(g_adv.steps >= 1, "a cut is suggested");
    }
    if (std::getenv("RT_VERBOSE"))
      std::printf("round %d: now %+.1f %+.1f %+.1f  step kind %d at %.1f mm, %.2f mm\n", round, g_adv.now_error[0],
                  g_adv.now_error[1], g_adv.now_error[2], g_adv.step[0].kind, g_adv.step[0].position * 1000,
                  g_adv.step[0].amount * 1000);
    if (g_adv.done) break;
    // The maker makes this round's cuts, on both the real bar and their model.
    CHECK(g_adv.steps >= 1, "round %d has cuts", round);
    for (int k = 0; k < g_adv.steps; ++k) {
      apply_step(real, g_adv.step[k], 0.0055);
      apply_step(model, g_adv.step[k], 0.0055);
    }
  }
  CHECK(solve_modes(real, g_md, 3), "final");
  double e[3];
  target_errors(g_md, s.targets, e);
  double worst = std::fmax(std::fabs(e[0]), std::fmax(std::fabs(e[1]), std::fabs(e[2])));
  CHECK(worst < first_error / 3, "workshop loop: %.1f -> %.1f cents", first_error, worst);
  CHECK(std::fabs(e[0]) < 5, "note in tune: %.2f", e[0]);

  // A bar that is too low can only be raised by trimming its ends.
  Bar& low = g_bar;
  low = g_d.bar;
  low.mat.E *= 0.94;
  low.mat.G *= 0.94;
  CHECK(solve_modes(low, g_md, 3), "low bar");
  Measured heard = {{g_md.freq[0], g_md.freq[1], g_md.freq[2]}, 3};
  advise(g_d.bar, 0.0055, heard, s.targets, g_adv);
  CHECK(g_adv.ok && g_adv.flat, "flat detected");
  CHECK(g_adv.steps >= 1 && g_adv.step[0].kind == CUT_TRIM_ENDS, "trim the ends first");
  CHECK(g_adv.step[0].after[0] > g_adv.now_error[0], "trimming raises the note");
}

static void test_api_validation() {
  static double in[api::IN_SIZE], out[api::OUT_SIZE];
  static float samples[48000];
  auto base = [&] {
    for (double& v : in) v = 0;
    in[api::I_E] = 22e9; in[api::I_G] = 22e9 / 16; in[api::I_RHO] = 1025; in[api::I_LOSS] = 0.006;
    in[api::I_WIDTH] = 0.05; in[api::I_THICK] = 0.022; in[api::I_MIN_THICK] = 0.006;
    in[api::I_F1] = 440; in[api::I_R2] = 4; in[api::I_R3] = 10; in[api::I_COUNT] = 2;
    in[api::I_FIXED] = 0; in[api::I_MIN_LENGTH] = 0.06; in[api::I_MAX_LENGTH] = 1.2; in[api::I_LENGTH] = 0.3;
    in[api::I_PROFILE_KIND] = 0; in[api::I_SPAN] = 0.5;
    in[api::I_HEARD_COUNT] = 1; in[api::I_HEARD0] = 450;
  };
  base();
  CHECK(api::analyse(in, out) == api::OK, "analyse ok");
  CHECK(api::advise(in, out) == api::OK, "advise ok");
  // Each field is refused by the entry point that reads it, for every kind of bad value.
  struct Field { int index; int entry; };  // entry: 0 analyse, 1 advise, 2 design
  const Field fields[] = {{api::I_E, 0}, {api::I_G, 0}, {api::I_RHO, 0}, {api::I_LOSS, 0}, {api::I_WIDTH, 0},
                          {api::I_THICK, 0}, {api::I_MIN_THICK, 0}, {api::I_LENGTH, 0}, {api::I_PROFILE_KIND, 0},
                          {api::I_SPAN, 0}, {api::I_DEPTH0, 0}, {api::I_F1, 1}, {api::I_COUNT, 1},
                          {api::I_HEARD_COUNT, 1}, {api::I_HEARD0, 1}, {api::I_FIXED, 2}, {api::I_MIN_LENGTH, 2},
                          {api::I_MAX_LENGTH, 2}, {api::I_F1, 2}, {api::I_WIDTH, 2}};
  const double bad[] = {NAN, INFINITY, -INFINITY, -1, 1e30};
  for (const Field& f : fields)
    for (double v : bad) {
      base();
      in[f.index] = v;
      int st = f.entry == 0 ? api::analyse(in, out) : (f.entry == 1 ? api::advise(in, out) : api::design(in, out));
      CHECK(st == api::BAD_INPUT, "field %d value %g accepted (entry %d)", f.index, v, f.entry);
    }
  base();
  in[api::I_MIN_THICK] = 0.03;  // thicker than the bar
  CHECK(api::analyse(in, out) == api::BAD_INPUT, "min thickness above thickness");
  base();
  in[api::I_COUNT] = 2.5;
  CHECK(api::design(in, out) == api::BAD_INPUT, "fractional count");
  base();
  in[api::I_PROFILE_KIND] = 1;
  in[api::I_TABLE_COUNT] = 500;
  CHECK(api::analyse(in, out) == api::BAD_INPUT, "table too long");
  base();
  in[api::I_HEARD_COUNT] = 2;
  in[api::I_HEARD0 + 1] = 300;  // below the first partial
  CHECK(api::advise(in, out) == api::BAD_INPUT, "partials out of order");
  base();
  in[api::I_RATE] = 48000;
  in[api::I_SAMPLES] = MAX_SAMPLES + 1;
  CHECK(api::hear(in, samples, out) == api::BAD_INPUT, "too many samples");
  in[api::I_SAMPLES] = 48000;
  in[api::I_EXPECT0] = 30000;
  CHECK(api::hear(in, samples, out) == api::BAD_INPUT, "expectation above Nyquist");

  // Random requests: every call must return a known status and never misbehave (the sanitizers
  // watch for out-of-bounds access and undefined behaviour).
  int ok = 0;
  for (int it = 0; it < 400; ++it) {
    base();
    for (int k = 0; k < 6; ++k) {
      int f = fields[static_cast<int>(rnd() * (sizeof fields / sizeof fields[0]))].index;
      double r = rnd();
      in[f] = r < 0.2 ? (rnd() - 0.5) * 1e6 : (r < 0.4 ? in[f] * (0.2 + rnd() * 3) : (r < 0.5 ? NAN : in[f]));
    }
    in[api::I_TABLE_COUNT] = std::floor(rnd() * 260);
    for (int i = 0; i < api::TABLE_MAX; ++i) in[api::I_TABLE0 + i] = rnd() * 0.03;
    int st = (it % 2) ? api::analyse(in, out) : api::advise(in, out);
    CHECK(st == api::OK || st == api::BAD_INPUT || st == api::NO_SOLUTION, "status %d", st);
    if (st == api::OK) ++ok;
  }
  CHECK(ok > 10, "some random requests are valid (%d)", ok);
}

static void test_materials() {
  for (const auto& mt : MATERIALS) {
    CHECK(mt.E > 5e9 && mt.E < 1e11 && mt.rho > 300 && mt.rho < 3000 && mt.G < mt.E, "%s plausible", mt.id);
    CHECK(std::strlen(mt.source) > 10, "%s has a source", mt.id);
  }
}

int main() {
  test_mathlite();
  test_beam_theory();
  test_scaling_and_shear();
  test_undercut();
  test_design();
  test_fft_and_hearing();
  test_workshop_loop();
  test_api_validation();
  test_materials();
  std::printf("%d checks, %d failed\n", g_checks, g_failed);
  return g_failed ? 1 : 0;
}
