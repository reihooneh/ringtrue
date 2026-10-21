// The one interface both front ends use: the WebAssembly page and the native command line.
//
// Requests and results are flat arrays of doubles at fixed positions (listed below and mirrored in
// site/assets/js/core.js). That keeps the boundary simple to check: every value is validated here
// before the model sees it, whichever front end it came from.
#pragma once

namespace rt::api {

inline constexpr int IN_SIZE = 512;
inline constexpr int OUT_SIZE = 2048;
inline constexpr int PROFILE_POINTS = 121;  // thickness samples along the bar, end to end
inline constexpr int TABLE_MAX = 201;

// Request fields
enum In : int {
  I_E = 0, I_G, I_RHO, I_LOSS, I_WIDTH, I_THICK, I_MIN_THICK,
  I_F1 = 7, I_R2, I_R3, I_COUNT,
  I_FIXED = 11, I_LENGTH, I_MIN_LENGTH, I_MAX_LENGTH,
  I_PROFILE_KIND = 15,  // 0 = undercut (span + 4 depths), 1 = thickness table
  I_SPAN = 16, I_DEPTH0 = 17,  // 17..20
  I_TABLE_COUNT = 21, I_TABLE0 = 22,  // 22 .. 22 + TABLE_MAX - 1
  I_HEARD_COUNT = 230, I_HEARD0 = 231,  // 231..233
  I_RATE = 240, I_SAMPLES = 241, I_EXPECT0 = 242,  // 242..244
};

// Result fields (design and analyse)
enum Out : int {
  O_STATUS = 0, O_LENGTH, O_SPAN, O_DEPTH0,  // 3..6
  O_EVALS = 7, O_FREQ0 = 8,                  // 8..12
  O_ERR0 = 13, O_MET0 = 16, O_MASS = 19,
  O_NODES = 20,  // 3 modes x (count + 5 positions): 20..37
  O_PROFILE = 40,  // PROFILE_POINTS thickness samples: 40..160
  O_SHAPES = 170,  // 5 x PROFILE_POINTS deflections: 170..774
};

// Result fields (advise)
enum OutAdvice : int {
  A_STATUS = 0, A_DONE, A_FLAT, A_STIFF, A_SHEAR, A_FIT0 = 5, A_NOW0 = 8, A_STEPS = 11,
  A_STEP0 = 12,  // 8 steps x 7: kind, position, width, amount, after0..2 -> 12..67
  A_SENS0 = 70,  // 3 x 24 -> 70..141
  A_SENS_POS0 = 150,  // 24 -> 150..173
  A_EVALS = 180,
  A_PROFILE = 200,  // the bar after the whole plan: 200..320
};

// Result fields (hear)
enum OutHear : int {
  H_STATUS = 0, H_ONSET, H_PEAK_AMP, H_FOUND, H_PARTIAL0 = 4, H_LEVEL0 = 7, H_PEAKS = 10,
  H_PEAK0 = 11,  // 24 x (freq, level) -> 11..58
};

// Status codes
enum Status : int {
  OK = 0,
  MISSED = 1,        // solved, but at least one target couldn't be reached within the limits
  BAD_INPUT = -1,    // a value was missing, not finite or out of range
  NO_SOLUTION = -2,  // the solver did not converge
  TOO_QUIET = -3,
  NO_PEAKS = -4,
};

// Entry points. Each reads `in` and writes `out`.
int design(const double* in, double* out);
int analyse(const double* in, double* out);
int advise(const double* in, double* out);
int hear(const double* in, const float* samples, double* out);

}  // namespace rt::api
