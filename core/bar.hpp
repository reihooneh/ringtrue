// A tuned percussion bar (marimba, xylophone, vibraphone) as a beam that is free at both ends.
//
// The bar is cut into small elements along its length. Each element has its own thickness, so any
// undercut profile can be described. Solving the vibration problem gives the bar's partials
// (natural frequencies) and how it bends in each one (mode shapes).
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace rt {

inline constexpr int MAX_ELEMS = 400;
inline constexpr int MAX_NODES = MAX_ELEMS + 1;
inline constexpr int MAX_DOF = 2 * MAX_NODES;  // deflection and rotation at every node
inline constexpr int MAX_MODES = 5;            // bending partials we report
inline constexpr int DEFAULT_ELEMS = 240;

struct Material {
  double E;     // Young's modulus along the grain, Pa
  double G;     // shear modulus, Pa
  double rho;   // density, kg/m^3
  double loss;  // loss factor (how quickly the sound dies away); only used for the sound
};

// The undercut: a smooth arch cut from the underside, symmetric about the centre.
// depth[k] is the depth of the cut at s = k/4 of the way from the centre to the end of the cut
// (s = 1 is the end, where the depth is 0). half_span is the cut's half-length as a fraction of
// half the bar, so 1.0 would run right to the ends.
struct Undercut {
  double half_span;
  double depth[4];  // metres
};

struct Bar {
  double length;     // m
  double width;      // m
  double thickness;  // uncut thickness, m
  Material mat;
  int elems;
  double h[MAX_ELEMS];  // thickness of each element, m
};

struct Modes {
  int count;                          // bending partials found (up to MAX_MODES)
  int iterations;                     // subspace iterations used (for diagnostics)
  double freq[MAX_MODES];             // Hz
  double shape[MAX_MODES][MAX_NODES]; // deflection at each node, scaled so the largest is 1
};

// Depth of the undercut at distance u from the centre (metres), for a bar of length L.
double undercut_depth(const Undercut& cut, double L, double u);

// Fills bar.h from an undercut. Returns false if the cut would leave the bar thinner than
// min_thickness anywhere.
bool apply_undercut(Bar& bar, const Undercut& cut, double min_thickness);

// Fills bar.h by linear interpolation of thickness samples taken evenly from one end to the other.
void apply_table(Bar& bar, const double* samples, int count);

// Thickness at position x (metres from one end).
double thickness_at(const Bar& bar, double x);

// Solves for the first bending partials. Returns false if the solver failed to converge.
bool solve_modes(const Bar& bar, Modes& out, int wanted = MAX_MODES);

// Positions (metres from the left end) where mode k doesn't move. Returns how many were found.
int node_positions(const Bar& bar, const Modes& modes, int k, double* out, int cap);

// Mass of the bar (kg).
double bar_mass(const Bar& bar);

}  // namespace rt
