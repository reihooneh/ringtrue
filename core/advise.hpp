// The workshop assistant: you tap a real bar, the app hears its partials, and this decides where
// to take wood off next.
//
// Wood varies a lot from board to board, so the model is first calibrated to the bar in your hands
// (its stiffness, and the stiffness in shear if two or more partials were heard). Then it works
// out, for each place you could cut, how many cents each partial would move per millimetre, and
// picks the cut that brings everything closest to the targets. You can only ever remove wood, so
// it suggests doing a little less than the full amount and tapping again.
#pragma once

#include "bar.hpp"
#include "tune.hpp"

namespace rt {

inline constexpr int SENS_POINTS = 24;  // places along half the bar where a cut is considered
inline constexpr int MAX_STEPS = 4;  // cuts in one round, before tapping again
inline constexpr double MAX_STEP_DEPTH = 0.002;  // never suggest more than 2 mm deeper at once
inline constexpr double MAX_STEP_TRIM = 0.003;   // or more than 3 mm off each end at once

struct Measured {
  double f[3];
  int count;  // 1 to 3
};

enum CutKind : int { CUT_DEEPEN = 0, CUT_TRIM_ENDS = 1 };

struct CutStep {
  int kind;          // CutKind
  double position;   // deepen: distance from the centre to the middle of the cut, m (cut both sides)
  double width;      // deepen: width of each cut, m
  double amount;     // deepen: extra depth at the middle of the cut, m; trim: length off EACH end, m
  double after[3];   // predicted cents from target after this step (re-solved, not estimated)
};

struct Advice {
  bool ok;
  bool done;                 // already within 3 cents on every measured, targeted partial
  bool flat;                 // the note is too low: the ends must be trimmed to raise it
  double stiffness_scale;    // multiply the wood's E by this to match the bar
  double shear_scale;        // and its G by this (1 if only one partial was heard)
  double fit_error[3];       // cents: calibrated model vs what was heard (how well the model fits)
  double now_error[3];       // cents: what was heard vs the targets
  int steps;                 // cuts to make this round (then tap again)
  CutStep step[MAX_STEPS];   // each step's `after` is the prediction once it and those before it are done
  // Cents each partial moves per millimetre of extra depth cut at each place (both sides).
  double sensitivity[3][SENS_POINTS];
  double sens_position[SENS_POINTS];  // m from the centre
  int evaluations;
};

// bar: the bar as it is now (its thickness profile and the wood's nominal properties).
void advise(const Bar& bar, double min_thickness, const Measured& heard, const Targets& t, Advice& out);

// Applies a step to a bar (used by advise, the tests and the demo's "make this cut" button).
void apply_step(Bar& bar, const CutStep& step, double min_thickness);

}  // namespace rt
