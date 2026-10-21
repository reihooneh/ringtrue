// Designing a bar: choose its length and undercut so its partials land on chosen notes.
#pragma once

#include "bar.hpp"

namespace rt {

// What the bar should sound like: the first partial's frequency, and the next partials as
// multiples of it. A concert marimba is tuned 1 : 4 : 10, a xylophone 1 : 3 : 6.
struct Targets {
  double f1;        // Hz
  double ratio[2];  // f2/f1 and f3/f1
  int count;        // how many partials to tune: 1, 2 or 3
};

struct DesignSpec {
  Material mat;
  double width;          // m
  double thickness;      // uncut thickness, m
  double min_thickness;  // the cut may not go thinner than this, m
  bool fixed_length;     // true: keep `length`; false: choose it within [min_length, max_length]
  double length;         // m (used when fixed_length)
  double min_length, max_length;  // m
  Targets targets;
};

struct Design {
  bool ok;               // a valid bar was found (it may still miss some targets: see error)
  Bar bar;
  Undercut cut;
  Modes modes;
  double error[3];       // cents away from each target (f1, f2, f3), positive = sharp
  bool met[3];           // within 3 cents
  int evaluations;       // vibration solves used
};

// Cents error of each targeted partial for these modes.
void target_errors(const Modes& modes, const Targets& t, double* err);

// The optimiser: a few starting shapes, then Levenberg-Marquardt on the cut and length.
// Deterministic: the same spec always gives the same design.
void design_bar(const DesignSpec& spec, Design& out);

}  // namespace rt
