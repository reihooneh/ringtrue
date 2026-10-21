#include "spectrum.hpp"

#include "mathlite.hpp"

namespace rt {
namespace {

double g_re[MAX_FFT], g_im[MAX_FFT];
double g_db[MAX_FFT / 2];
double g_sorted[MAX_FFT / 2];
double g_cos[MAX_FFT / 2], g_sin[MAX_FFT / 2];
int g_twiddle_n = 0;

// k-th smallest of a[0..n) (quickselect; a is reordered).
double select_kth(double* a, int n, int k) {
  int lo = 0, hi = n - 1;
  while (lo < hi) {
    double pivot = a[(lo + hi) / 2];
    int i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) ++i;
      while (a[j] > pivot) --j;
      if (i <= j) { double t = a[i]; a[i] = a[j]; a[j] = t; ++i; --j; }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

double to_db(double re, double im) {
  double p = re * re + im * im;
  return 10 * m::log(p + 1e-300) / m::log(10.0);
}

}  // namespace

bool fft(double* re, double* im, int n) {
  if (n < 2 || n > MAX_FFT || (n & (n - 1)) != 0) return false;
  if (g_twiddle_n != n) {
    for (int k = 0; k < n / 2; ++k) m::sincos(-2 * m::PI * k / n, g_sin[k], g_cos[k]);
    g_twiddle_n = n;
  }
  // Bit-reversal permutation.
  for (int i = 1, j = 0; i < n; ++i) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      double t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (int len = 2; len <= n; len <<= 1) {
    const int step = n / len;
    for (int i = 0; i < n; i += len) {
      for (int k = 0; k < len / 2; ++k) {
        const double wr = g_cos[k * step], wi = g_sin[k * step];
        const int a = i + k, b = i + k + len / 2;
        const double xr = re[b] * wr - im[b] * wi;
        const double xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  return true;
}

void hear(const float* x, int count, double rate, const double* expect, Hearing& out) {
  out.ok = false;
  out.error = HEAR_BAD_INPUT;
  out.peak_count = 0;
  out.found = 0;
  out.onset = 0;
  out.peak_amplitude = 0;
  for (int i = 0; i < 3; ++i) { out.partial[i] = 0; out.partial_level[i] = 0; }
  if (!(rate >= 8000 && rate <= 192000) || x == nullptr) return;
  if (count < static_cast<int>(rate * 0.1) || count > MAX_SAMPLES) return;

  double big = 0;
  for (int i = 0; i < count; ++i) {
    double v = x[i];
    if (!m::finite(v)) return;
    big = m::max(big, m::abs(v));
  }
  out.peak_amplitude = m::min(big, 1.0);
  if (big < 1e-4) { out.error = HEAR_TOO_QUIET; return; }

  // The tap: the first sample at half the loudest level. Skip 5 ms of mallet click after it.
  int onset = 0;
  while (onset < count && m::abs(static_cast<double>(x[onset])) < 0.5 * big) ++onset;
  out.onset = onset / rate;
  int start = onset + static_cast<int>(0.005 * rate);
  int avail = count - start;
  int nw = 1;
  while (nw * 2 <= avail && nw * 2 <= MAX_FFT / 2) nw *= 2;
  if (nw < 2048) return;  // less than about 50 ms of sound after the tap
  const int n = nw * 2;   // zero-padded to twice the window: finer bins for the peak search

  for (int i = 0; i < n; ++i) {
    double v = 0;
    if (i < nw) {
      double hann = 0.5 - 0.5 * m::cos(2 * m::PI * i / (nw - 1));
      v = x[start + i] * hann;
    }
    g_re[i] = v;
    g_im[i] = 0;
  }
  fft(g_re, g_im, n);
  const int half = n / 2;
  const double bin = rate / n;
  const int kmin = static_cast<int>(30 / bin) + 1;
  const int kmax = static_cast<int>(0.45 * rate / bin);
  double top = -1e300;
  int m_count = 0;
  for (int k = 0; k < half; ++k) {
    g_db[k] = to_db(g_re[k], g_im[k]);
    if (k >= kmin && k <= kmax) {
      top = m::max(top, g_db[k]);
      g_sorted[m_count++] = g_db[k];
    }
  }
  if (m_count < 16) return;
  const double floor_db = select_kth(g_sorted, m_count, m_count / 2);
  if (top - floor_db < 20) { out.error = HEAR_TOO_QUIET; return; }

  // Local maxima well above the background, refined with a parabola through three bins.
  Peak found[MAX_PEAKS];
  int nf = 0;
  for (int k = kmin + 2; k <= kmax - 2; ++k) {
    double v = g_db[k];
    if (!(v > floor_db + 20 && v > top - 70)) continue;
    if (!(v >= g_db[k - 1] && v > g_db[k + 1] && v >= g_db[k - 2] && v > g_db[k + 2])) continue;
    double a = g_db[k - 1], c = g_db[k + 1];
    double denom = a - 2 * v + c;
    double p = denom < 0 ? 0.5 * (a - c) / denom : 0;
    p = m::clamp(p, -0.5, 0.5);
    Peak pk{(k + p) * bin, v - 0.25 * (a - c) * p};
    if (nf < MAX_PEAKS) {
      found[nf++] = pk;
    } else {  // replace the weakest if this is stronger
      int weakest = 0;
      for (int i = 1; i < nf; ++i)
        if (found[i].level < found[weakest].level) weakest = i;
      if (pk.level > found[weakest].level) found[weakest] = pk;
    }
  }
  if (nf == 0) { out.error = HEAR_NO_PEAKS; return; }
  double best_level = found[0].level;
  for (int i = 1; i < nf; ++i) best_level = m::max(best_level, found[i].level);
  for (int i = 1; i < nf; ++i)  // sort by frequency
    for (int j = i; j > 0 && found[j].freq < found[j - 1].freq; --j) {
      Peak t = found[j]; found[j] = found[j - 1]; found[j - 1] = t;
    }
  for (int i = 0; i < nf; ++i) {
    out.peaks[i] = found[i];
    out.peaks[i].level -= best_level;
  }
  out.peak_count = nf;

  auto strongest_in = [&](double lo, double hi, double min_level) -> int {
    int pick = -1;
    for (int i = 0; i < nf; ++i) {
      const Peak& p = out.peaks[i];
      if (p.freq > lo && p.freq < hi && p.level >= min_level && (pick < 0 || p.level > out.peaks[pick].level)) pick = i;
    }
    return pick;
  };
  bool have_expect = expect != nullptr && expect[0] > 0;
  double prev = 0;
  for (int i = 0; i < 3; ++i) {
    int pick = -1;
    if (have_expect) {
      if (!(expect[i] > 0)) break;
      pick = strongest_in(m::max(expect[i] * 0.8, prev * 1.3), expect[i] * 1.25, -70);
    } else if (i == 0) {
      for (int k = 0; k < nf; ++k)
        if (out.peaks[k].level >= -30 && out.peaks[k].freq >= 40) { pick = k; break; }
    } else if (i == 1) {
      pick = strongest_in(out.partial[0] * 1.8, out.partial[0] * 6, -60);
    } else {
      pick = strongest_in(out.partial[1] * 1.3, out.partial[0] * 14, -70);
    }
    if (pick < 0) break;
    out.partial[i] = out.peaks[pick].freq;
    out.partial_level[i] = out.peaks[pick].level;
    prev = out.partial[i];
    out.found = i + 1;
  }
  out.ok = out.found > 0;
  out.error = out.ok ? HEAR_OK : HEAR_NO_PEAKS;
}

}  // namespace rt
