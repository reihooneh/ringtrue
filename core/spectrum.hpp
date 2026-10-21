// Hearing a bar: find its partials in a recording of one tap.
#pragma once

#include <stdint.h>

namespace rt {

inline constexpr int MAX_SAMPLES = 1 << 20;  // about 22 seconds at 48 kHz
inline constexpr int MAX_FFT = 1 << 17;
inline constexpr int MAX_PEAKS = 24;

struct Peak {
  double freq;   // Hz, refined between FFT bins
  double level;  // dB relative to the strongest peak (0 = strongest)
};

struct Hearing {
  bool ok;
  int error;            // why not, when !ok (see HearError)
  double onset;         // seconds into the recording where the tap was
  double peak_amplitude;  // loudest sample, 0..1 (1 means the recording clipped)
  int peak_count;
  Peak peaks[MAX_PEAKS];  // strongest peaks, sorted by frequency
  int found;              // partials identified, 0..3
  double partial[3];      // Hz
  double partial_level[3];
};

enum HearError : int {
  HEAR_OK = 0,
  HEAR_BAD_INPUT = 1,  // sample rate or length out of range, or non-finite samples
  HEAR_TOO_QUIET = 2,  // nothing louder than the background
  HEAR_NO_PEAKS = 3,
};

// samples: mono, -1..1. expect: the partials the model predicts (Hz), or null/zeros to guess.
// With a prediction each partial is looked for within -20% / +25% of it; without one the lowest
// strong peak is taken as the note and the next two strong peaks above it as partials 2 and 3.
void hear(const float* samples, int count, double rate, const double* expect, Hearing& out);

// The plain FFT, exposed for the tests: in-place, n a power of two up to MAX_FFT.
bool fft(double* re, double* im, int n);

}  // namespace rt
