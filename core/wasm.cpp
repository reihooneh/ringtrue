// WebAssembly exports. The page writes a request into `rt_in`, audio into `rt_samples`, calls one
// function and reads `rt_out`. The module imports nothing, so it can't reach the network, the page
// or anything else: it only computes.
#include "api.hpp"
#include "spectrum.hpp"

namespace {
double g_in[rt::api::IN_SIZE];
double g_out[rt::api::OUT_SIZE];
float g_samples[rt::MAX_SAMPLES];
}  // namespace

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

EXPORT(rt_version) int rt_version() { return 1; }
EXPORT(rt_in) double* rt_in() { return g_in; }
EXPORT(rt_out) double* rt_out() { return g_out; }
EXPORT(rt_samples) float* rt_samples() { return g_samples; }
EXPORT(rt_samples_cap) int rt_samples_cap() { return rt::MAX_SAMPLES; }
EXPORT(rt_in_size) int rt_in_size() { return rt::api::IN_SIZE; }
EXPORT(rt_out_size) int rt_out_size() { return rt::api::OUT_SIZE; }
EXPORT(rt_design) int rt_design() { return rt::api::design(g_in, g_out); }
EXPORT(rt_analyse) int rt_analyse() { return rt::api::analyse(g_in, g_out); }
EXPORT(rt_advise) int rt_advise() { return rt::api::advise(g_in, g_out); }
EXPORT(rt_hear) int rt_hear() { return rt::api::hear(g_in, g_samples, g_out); }
