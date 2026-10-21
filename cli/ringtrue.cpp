// ringtrue: design tuned bars from the command line.
//
//   ringtrue design --note C4                       a rosewood marimba bar for middle C
//   ringtrue design --note A3 --wood jarrah --tuning xylophone --width 45 --thickness 20
//   ringtrue design --note F4 --length 380          keep this length, tune with the cut alone
//   ringtrue set --from C4 --to C5 --json           a whole range (the site's built-in keyboard)
//   ringtrue materials --json                       the wood table, for the site
//
// Exit codes: 0 done, 1 designed but some partials missed their targets, 2 bad usage or input.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "api.hpp"
#include "materials.hpp"

namespace {

using namespace rt;

int usage(const char* msg) {
  if (msg) std::fprintf(stderr, "ringtrue: %s\n", msg);
  std::fprintf(stderr,
               "usage: ringtrue design --note NOTE [--wood ID] [--tuning marimba|xylophone|vibraphone|R2[,R3]]\n"
               "                       [--width MM] [--thickness MM] [--min MM] [--length MM] [--json]\n"
               "       ringtrue set --from NOTE --to NOTE [--wood ID] [--json]\n"
               "       ringtrue materials [--json]\n");
  return 2;
}

// "C4", "F#3", "Bb5" -> MIDI number. Returns false for anything else.
bool parse_note(const char* s, int& midi) {
  static const int base[7] = {9, 11, 0, 2, 4, 5, 7};  // A B C D E F G
  if (!s || std::strlen(s) < 2 || std::strlen(s) > 4) return false;
  char letter = s[0];
  if (letter >= 'a' && letter <= 'g') letter = static_cast<char>(letter - 'a' + 'A');
  if (letter < 'A' || letter > 'G') return false;
  int pc = base[letter - 'A'];
  const char* p = s + 1;
  if (*p == '#') { ++pc; ++p; } else if (*p == 'b') { --pc; ++p; }
  if (*p < '0' || *p > '8' || p[1] != '\0') return false;
  midi = (*p - '0' + 1) * 12 + pc;
  return midi >= 24 && midi <= 108;
}

double note_hz(int midi) { return 440.0 * std::pow(2.0, (midi - 69) / 12.0); }

void note_name(int midi, char* out, size_t n) {
  static const char* names[12] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
  std::snprintf(out, n, "%s%d", names[midi % 12], midi / 12 - 1);
}

// A plain decimal within [lo, hi]: no hex, no exponents, nothing trailing.
bool parse_number(const char* s, double lo, double hi, double& v) {
  if (!s || !*s || std::strlen(s) > 16) return false;
  for (const char* p = s; *p; ++p)
    if (!((*p >= '0' && *p <= '9') || *p == '.')) return false;
  char* end = nullptr;
  v = std::strtod(s, &end);
  return end && *end == '\0' && std::isfinite(v) && v >= lo && v <= hi;
}

const MaterialInfo* find_material(const char* id) {
  for (const auto& m : MATERIALS)
    if (std::strcmp(m.id, id) == 0) return &m;
  return nullptr;
}

struct Options {
  int midi = -1, from = -1, to = -1;
  const MaterialInfo* mat = &MATERIALS[0];
  bool mat_given = false;
  double r2 = 4, r3 = 10;
  int count = 3;
  bool tuning_given = false;
  double width = -1, thick = -1, min_thick = -1, length = -1;
  bool json = false;
};

bool parse_tuning(const char* s, Options& o) {
  o.tuning_given = true;
  if (std::strcmp(s, "marimba") == 0) { o.r2 = 4; o.r3 = 10; o.count = 3; return true; }
  if (std::strcmp(s, "xylophone") == 0) { o.r2 = 3; o.r3 = 6; o.count = 3; return true; }
  if (std::strcmp(s, "vibraphone") == 0) {
    o.r2 = 4; o.count = 2;
    if (!o.mat_given) o.mat = find_material("aluminium");
    return true;
  }
  if (std::strlen(s) > 20) return false;
  char buf[24];
  std::snprintf(buf, sizeof buf, "%s", s);
  char* comma = std::strchr(buf, ',');
  if (comma) *comma = '\0';
  if (!parse_number(buf, 1.5, 12, o.r2)) return false;
  o.count = 2;
  if (comma) {
    if (!parse_number(comma + 1, o.r2 + 0.5, 40, o.r3)) return false;
    o.count = 3;
  }
  return true;
}

// Graded sizes, like a real keyboard: low bars wider and thicker than high ones.
void default_section(int midi, double& width, double& thick) {
  double t = (midi - 36) / 60.0;  // C2 .. C7
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  width = 0.064 - t * (0.064 - 0.038);
  thick = 0.025 - t * (0.025 - 0.018);
}

void fill_request(const Options& o, int midi, double* in) {
  for (int i = 0; i < api::IN_SIZE; ++i) in[i] = 0;
  double w, h;
  default_section(midi, w, h);
  if (o.width > 0) w = o.width;
  if (o.thick > 0) h = o.thick;
  double hmin = o.min_thick > 0 ? o.min_thick : std::fmax(0.004, h * 0.25);
  in[api::I_E] = o.mat->E;
  in[api::I_G] = o.mat->G;
  in[api::I_RHO] = o.mat->rho;
  in[api::I_LOSS] = o.mat->loss;
  in[api::I_WIDTH] = w;
  in[api::I_THICK] = h;
  in[api::I_MIN_THICK] = hmin;
  in[api::I_F1] = note_hz(midi);
  in[api::I_R2] = o.r2;
  in[api::I_R3] = o.r3;
  in[api::I_COUNT] = o.count;
  if (o.length > 0) {
    in[api::I_FIXED] = 1;
    in[api::I_LENGTH] = o.length;
  } else {
    in[api::I_FIXED] = 0;
    in[api::I_MIN_LENGTH] = 0.06;
    in[api::I_MAX_LENGTH] = 1.2;
  }
}

double g_in[api::IN_SIZE], g_out[api::OUT_SIZE];

void print_json_bar(int midi, const Options& o) {
  char name[16];
  note_name(midi, name, sizeof name);
  std::printf("{\"note\":\"%s\",\"midi\":%d,\"status\":%d,\"targets\":[%.4f,%.4f,%.4f],\"count\":%d,", name, midi,
              static_cast<int>(g_out[api::O_STATUS]), g_in[api::I_F1], g_in[api::I_F1] * o.r2, g_in[api::I_F1] * o.r3, o.count);
  std::printf("\"width\":%.6f,\"thickness\":%.6f,\"minThickness\":%.6f,\"length\":%.6f,\"span\":%.6f,\"depths\":[%.6f,%.6f,%.6f,%.6f],",
              g_in[api::I_WIDTH], g_in[api::I_THICK], g_in[api::I_MIN_THICK], g_out[api::O_LENGTH], g_out[api::O_SPAN],
              g_out[api::O_DEPTH0], g_out[api::O_DEPTH0 + 1], g_out[api::O_DEPTH0 + 2], g_out[api::O_DEPTH0 + 3]);
  std::printf("\"freq\":[");
  for (int k = 0; k < 5; ++k) std::printf("%s%.4f", k ? "," : "", g_out[api::O_FREQ0 + k]);
  std::printf("],\"error\":[%.3f,%.3f,%.3f],\"mass\":%.5f}", g_out[api::O_ERR0], g_out[api::O_ERR0 + 1], g_out[api::O_ERR0 + 2],
              g_out[api::O_MASS]);
}

void print_text_bar(int midi, const Options& o) {
  char name[16];
  note_name(midi, name, sizeof name);
  const double L = g_out[api::O_LENGTH];
  std::printf("RINGTRUE  %s bar in %s  (%s tuning 1 : %g%s%g)\n\n", name, o.mat->name, o.count == 3 ? "three-partial" : "two-partial",
              o.r2, o.count == 3 ? " : " : "", o.count == 3 ? o.r3 : 0.0);
  std::printf("Bar     %.1f mm long, %.1f mm wide, %.1f mm thick, %.0f g\n", L * 1000, g_in[api::I_WIDTH] * 1000,
              g_in[api::I_THICK] * 1000, g_out[api::O_MASS] * 1000);
  double thinnest = 1;
  for (int i = 0; i < api::PROFILE_POINTS; ++i) thinnest = std::fmin(thinnest, g_out[api::O_PROFILE + i]);
  std::printf("Cut     arch from the underside, %.1f mm long, deepest %.1f mm (leaves %.1f mm)\n", g_out[api::O_SPAN] * L * 1000,
              (g_in[api::I_THICK] - thinnest) * 1000, thinnest * 1000);
  std::printf("\nPartial   Target Hz   Bar Hz      Cents off\n");
  for (int k = 0; k < 3; ++k) {
    double target = k == 0 ? g_in[api::I_F1] : g_in[api::I_F1] * (k == 1 ? o.r2 : o.r3);
    if (k < o.count)
      std::printf("  %d      %9.2f   %9.2f   %+7.2f %s\n", k + 1, target, g_out[api::O_FREQ0 + k], g_out[api::O_ERR0 + k],
                  g_out[api::O_MET0 + k] > 0 ? "ok" : "MISSED");
    else
      std::printf("  %d          -       %9.2f      (not tuned)\n", k + 1, g_out[api::O_FREQ0 + k]);
  }
  int nn = static_cast<int>(g_out[api::O_NODES]);
  std::printf("\nSupport holes (nodes of the first partial): ");
  for (int i = 0; i < nn; ++i) std::printf("%s%.1f mm", i ? " and " : "", g_out[api::O_NODES + 1 + i] * 1000);
  std::printf(" from the left end\n\nThickness along the bar (mm), every %.1f mm:\n", L * 1000 / 12);
  for (int i = 0; i <= 12; ++i) {
    int idx = (api::PROFILE_POINTS - 1) * i / 12;
    std::printf("%s%.1f", i ? " " : "  ", g_out[api::O_PROFILE + idx] * 1000);
  }
  std::printf("\n");
}

int run_design(const Options& o, int midi) {
  fill_request(o, midi, g_in);
  int st = api::design(g_in, g_out);
  if (st == api::BAD_INPUT) return usage("those dimensions are out of range");
  if (st == api::NO_SOLUTION) {
    std::fprintf(stderr, "ringtrue: no workable bar found for these settings\n");
    return 1;
  }
  return st;
}

int cmd_design(const Options& o) {
  if (o.midi < 0) return usage("give --note");
  int st = run_design(o, o.midi);
  if (st < 0 || st > 1) return st;
  if (o.json) {
    print_json_bar(o.midi, o);
    std::printf("\n");
  } else {
    print_text_bar(o.midi, o);
  }
  return st;
}

// A range of notes. High bars can't reach 1:4:10 at sensible thicknesses, so unless a tuning was
// given, the set follows common practice: three partials low down, two in the upper middle, and
// just the note at the very top.
int cmd_set(Options o) {
  if (o.from < 0 || o.to < 0 || o.to < o.from || o.to - o.from > 60) return usage("give --from and --to, at most 5 octaves apart");
  bool any_missed = false;
  if (o.json) std::printf("[");
  for (int midi = o.from; midi <= o.to; ++midi) {
    Options n = o;
    if (!o.tuning_given) {
      if (midi >= 91) n.count = 1;        // above G6
      else if (midi >= 80) n.count = 2;   // G#5 and up
    }
    int st = run_design(n, midi);
    if (st < 0 || st > 1) return st;
    any_missed = any_missed || st == 1;
    if (o.json) {
      if (midi > o.from) std::printf(",\n");
      print_json_bar(midi, n);
    } else {
      char name[16];
      note_name(midi, name, sizeof name);
      std::printf("%-4s %6.1f mm  cents %+6.1f %+6.1f %+6.1f\n", name, g_out[api::O_LENGTH] * 1000, g_out[api::O_ERR0],
                  g_out[api::O_ERR0 + 1], g_out[api::O_ERR0 + 2]);
    }
  }
  if (o.json) std::printf("]\n");
  return any_missed ? 1 : 0;
}

int cmd_materials(bool json) {
  if (json) std::printf("[");
  for (int i = 0; i < MATERIAL_COUNT; ++i) {
    const auto& m = MATERIALS[i];
    if (json)
      std::printf("%s{\"id\":\"%s\",\"name\":\"%s\",\"E\":%.6g,\"G\":%.6g,\"rho\":%.6g,\"loss\":%.6g,\"source\":\"%s\"}", i ? ",\n" : "",
                  m.id, m.name, m.E, m.G, m.rho, m.loss, m.source);
    else
      std::printf("%-10s %-22s E %5.1f GPa  %5.0f kg/m3\n", m.id, m.name, m.E / 1e9, m.rho);
  }
  if (json) std::printf("]\n");
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) return usage(nullptr);
  const char* cmd = argv[1];
  Options o;
  for (int i = 2; i < argc; ++i) {
    const char* a = argv[i];
    const char* v = i + 1 < argc ? argv[i + 1] : nullptr;
    double mm;
    if (std::strcmp(a, "--json") == 0) { o.json = true; continue; }
    if (!v) return usage("an option is missing its value");
    ++i;
    if (std::strcmp(a, "--note") == 0) { if (!parse_note(v, o.midi)) return usage("notes look like C4, F#3 or Bb5 (C1 to C8)"); }
    else if (std::strcmp(a, "--from") == 0) { if (!parse_note(v, o.from)) return usage("bad --from note"); }
    else if (std::strcmp(a, "--to") == 0) { if (!parse_note(v, o.to)) return usage("bad --to note"); }
    else if (std::strcmp(a, "--wood") == 0) {
      o.mat = find_material(v);
      if (!o.mat) return usage("unknown --wood (see: ringtrue materials)");
      o.mat_given = true;
    }
    else if (std::strcmp(a, "--tuning") == 0) { if (!parse_tuning(v, o)) return usage("--tuning is marimba, xylophone, vibraphone, or ratios like 4,10"); }
    else if (std::strcmp(a, "--width") == 0) { if (!parse_number(v, 5, 300, mm)) return usage("--width is 5 to 300 mm"); o.width = mm / 1000; }
    else if (std::strcmp(a, "--thickness") == 0) { if (!parse_number(v, 3, 100, mm)) return usage("--thickness is 3 to 100 mm"); o.thick = mm / 1000; }
    else if (std::strcmp(a, "--min") == 0) { if (!parse_number(v, 1, 95, mm)) return usage("--min is 1 to 95 mm"); o.min_thick = mm / 1000; }
    else if (std::strcmp(a, "--length") == 0) { if (!parse_number(v, 30, 2000, mm)) return usage("--length is 30 to 2000 mm"); o.length = mm / 1000; }
    else return usage("unknown option");
  }
  if (std::strcmp(cmd, "design") == 0) return cmd_design(o);
  if (std::strcmp(cmd, "set") == 0) return cmd_set(o);
  if (std::strcmp(cmd, "materials") == 0) return cmd_materials(o.json);
  return usage("unknown command");
}
