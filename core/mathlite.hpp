// Small maths library for the core.
//
// The WebAssembly build has no C library at all (no libm), so the few functions the core needs are
// written here. Square root is a single WebAssembly instruction; the rest use range reduction and
// short polynomial series, accurate to about 1e-15 relative, which the tests check against libm.
#pragma once

#include <stdint.h>

namespace rt::m {

inline constexpr double PI = 3.14159265358979323846;
inline constexpr double LN2 = 0.69314718055994530942;

inline double sqrt(double x) { return __builtin_sqrt(x); }
inline double abs(double x) { return x < 0 ? -x : x; }
inline double min(double a, double b) { return a < b ? a : b; }
inline double max(double a, double b) { return a > b ? a : b; }
inline double clamp(double x, double lo, double hi) { return x < lo ? lo : (x > hi ? hi : x); }
inline bool finite(double x) { return x == x && x - x == 0.0; }  // false for NaN and ±infinity

inline double floor(double x) {
  // Values this large are already whole numbers.
  if (!(abs(x) < 4503599627370496.0)) return x;
  double t = static_cast<double>(static_cast<int64_t>(x));
  return t > x ? t - 1.0 : t;
}
inline double round(double x) { return floor(x + 0.5); }

// sin and cos: reduce to |r| <= pi/4 using quadrant k, then a Taylor series.
inline void sincos(double x, double& s, double& c) {
  double k = round(x / (PI / 2));
  // Two-part pi/2 (Cody-Waite) keeps the reduction accurate for |x| up to about 1e6.
  double r = (x - k * 1.5707963267341256) - k * 6.077100506506192e-11;
  double r2 = r * r;
  double ps = r, ts = r;
  double pc = 1, tc = 1;
  for (int n = 1; n <= 11; ++n) {
    ts *= -r2 / ((2.0 * n) * (2.0 * n + 1));
    ps += ts;
    tc *= -r2 / ((2.0 * n - 1) * (2.0 * n));
    pc += tc;
  }
  int64_t q = static_cast<int64_t>(k) & 3;
  if (q == 0) { s = ps; c = pc; }
  else if (q == 1) { s = pc; c = -ps; }
  else if (q == 2) { s = -ps; c = -pc; }
  else { s = -pc; c = ps; }
}
inline double sin(double x) { double s, c; sincos(x, s, c); return s; }
inline double cos(double x) { double s, c; sincos(x, s, c); return c; }

// Natural log: split x = mantissa * 2^e with mantissa in [sqrt(1/2), sqrt(2)), then the series
// ln(m) = 2 atanh((m-1)/(m+1)).
inline double log(double x) {
  if (!(x > 0) || !finite(x)) return x == 0 ? -1.0 / 0.0 : (x > 0 ? x : 0.0 / 0.0);
  uint64_t bits = __builtin_bit_cast(uint64_t, x);
  int e = static_cast<int>((bits >> 52) & 0x7ff);
  if (e == 0) {  // subnormal: scale up first
    return log(x * 18014398509481984.0) - 54 * LN2;
  }
  e -= 1023;
  bits = (bits & 0x000fffffffffffffULL) | 0x3ff0000000000000ULL;
  double mant = __builtin_bit_cast(double, bits);
  if (mant > 1.4142135623730951) { mant *= 0.5; e += 1; }
  double z = (mant - 1) / (mant + 1);
  double z2 = z * z;
  double sum = 0, term = z;
  for (int n = 1; n <= 41; n += 2) {
    sum += term / n;
    term *= z2;
  }
  return 2 * sum + e * LN2;
}
inline double log2(double x) { return log(x) / LN2; }

// exp: x = k ln2 + r with |r| <= ln2/2, then a Taylor series and a power-of-two scale.
inline double exp(double x) {
  if (x != x) return x;
  if (x > 709.7) return 1.0 / 0.0;
  if (x < -745.0) return 0.0;
  double k = round(x / LN2);
  double r = x - k * LN2;
  double sum = 1, term = 1;
  for (int n = 1; n <= 18; ++n) {
    term *= r / n;
    sum += term;
  }
  int64_t ki = static_cast<int64_t>(k);
  // Scale in two steps so very small results stay accurate.
  while (ki > 1000) { sum *= 1.0715086071862673e301; ki -= 1000; }
  while (ki < -1000) { sum *= 9.332636185032189e-302; ki += 1000; }
  uint64_t b = static_cast<uint64_t>(ki + 1023) << 52;
  if (ki + 1023 <= 0) return sum * __builtin_bit_cast(double, static_cast<uint64_t>(ki + 1023 + 100) << 52) * 7.888609052210118e-31;
  return sum * __builtin_bit_cast(double, b);
}

// Musical cents: 1200 * log2(a / b).
inline double cents(double a, double b) { return 1200.0 * log2(a / b); }

}  // namespace rt::m
