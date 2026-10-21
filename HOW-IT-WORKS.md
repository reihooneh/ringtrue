# How Ringtrue works

A walkthrough so you can explain every part of it, from the physics to the page.

## 1. Architecture

```
   site/*.html  (built from src/pages + one layout; strict CSP)
        │
   page modules: home.js, designer.js, workshop.js, set.js, method.js
        │  draw.js (SVG via createElement), stage3d.js (three.js), audio.js (Web Audio)
        │
   engine.js ── postMessage ──▶ worker.js ──▶ core.js ──▶ ringtrue.wasm
                                                (flat Float64 arrays at fixed positions)
                                                        │
   ┌────────────────────────────── C++ core (core/) ────┴──────────────────────────────┐
   │ api.cpp       validates every request field, packs results                       │
   │ bar.cpp       Timoshenko beam finite elements, banded Cholesky, subspace iteration│
   │ tune.cpp      the cut and length: Levenberg-Marquardt, multi-start, priorities    │
   │ spectrum.cpp  FFT, peak refinement, picking the bar's partials                    │
   │ advise.cpp    calibrate E and G to the heard bar, plan the round's cuts           │
   │ mathlite.hpp  sqrt / sin / cos / log / exp without a C library                    │
   └───────────────────────────────────────────────────────────────────────────────────┘
        │
   cli/ringtrue.cpp  the same core, natively: designs and the site's generated data
```

The same C++ is compiled twice: natively with g++ (the CLI, and the tests under sanitizers) and with clang to `wasm32` for the browser. The WebAssembly module has **no imports**, so it can't call anything in the page. It only reads its input buffer and writes its output buffer.

## 2. File tour

| File | Job |
|---|---|
| `core/bar.hpp/.cpp` | The beam model: element matrices, banded storage, Cholesky, subspace iteration, nodes |
| `core/tune.hpp/.cpp` | The designer: undercut parameters, residuals in cents, Levenberg–Marquardt, final pitch fix |
| `core/spectrum.hpp/.cpp` | Finding the tap, windowing, FFT, peak interpolation, choosing partials |
| `core/advise.hpp/.cpp` | Calibration, sensitivities, box-constrained least squares, at most four cuts per round |
| `core/api.hpp/.cpp` | The one interface: request and result layouts, validation, status codes |
| `core/wasm.cpp` | Exports for the browser (static buffers) |
| `core/mathlite.hpp` | Maths functions for a build with no libm |
| `core/materials.hpp` | Wood and aluminium properties, with sources |
| `cli/ringtrue.cpp` | Command-line designer and set generator |
| `site/assets/js/core.js` | The JavaScript mirror of the request and result layouts |
| `site/assets/js/stage3d.js` | The 3D bar: geometry from the profile, bending by mode shapes, WebGL-off fallback |
| `site/assets/js/workshop.js` | The tap → calibrate → cut loop, and the hidden "real" practice board |
| `site/assets/js/cuts.js` | The page's copy of the two cut operations (tested against the core) |
| `tests/core_test.cpp` | 9,000+ checks against independent answers |
| `tests/web/*.test.mjs` | WebAssembly in Node; every page in Chromium at three sizes |

## 3. Key ideas, simply

### Partials and why bars need an arch
Hit a bar and it vibrates in several patterns at once, each with its own frequency: the **partials**. The lowest is the note. For a plain bar the next ones are at about 2.76 and 5.40 times the note, which isn't a chord, so the sound is clangy. Removing wood from the middle of the underside makes the middle more flexible. That lowers the note a lot and the upper partials less, so the gaps between them can be stretched out to 4 and 10.

### The Timoshenko beam
The simple beam theory (Euler–Bernoulli) assumes cross-sections stay perpendicular to the bent centre line. That's fine for a ruler, but a marimba bar is stubby: it also **shears** (cross-sections slide past each other), and each slice has to **rotate**, which takes energy. Both make the bar effectively softer for the higher partials. Ignoring them would be wrong by a semitone or more on the upper partials of a middle-C bar.

### Finite elements
Cut the bar into 300 short pieces. Inside each piece, assume the deflection `w` and the rotation `θ` vary linearly. The strain energy (bending `EI·θ'²` plus shear `κGA·(w' − θ)²`) and the kinetic energy (`ρA·ẇ²` plus `ρI·θ̇²`) then become small 4×4 matrices per piece. Adding them up gives `K` (stiffness) and `M` (mass), and the partials solve `K φ = ω² M φ`.

*Shear locking.* With linear pieces, a thin bar can't bend without the shear term being wrongly non-zero, and it becomes far too stiff. Measuring shear only at the middle of each piece (**reduced integration**) fixes it.

### Banded matrices
A joint only connects to its neighbours, so in `K` and `M` every row has at most four non-zeros next to the diagonal. Storing just that band makes the Cholesky factorisation O(n) instead of O(n³).

### Subspace iteration
To get the lowest few eigenpairs: start with 10 vectors and repeatedly solve `(K + sM) Y = M X`, which amplifies the low-frequency parts. Then find the best combination of the 10 by solving a tiny 10×10 eigenproblem (Rayleigh–Ritz, with Jacobi rotations). A free bar has two zero-frequency motions (sliding and rocking), which makes `K` singular; the shift `s` makes `K + sM` positive definite, and those two motions simply come out as the first two answers and are skipped.

### Fitting the cut: Levenberg–Marquardt
The unknowns are four control depths, the arch's reach and the bar's length. Each is written as a squashed variable (a sigmoid), so the optimiser can try any number and still get a bar that can be built. The residuals are each partial's error in **cents** (1/100 of a semitone, the unit the ear works in), plus small terms that prefer shallow, simple arches. Levenberg–Marquardt blends Gauss–Newton steps, which are fast near the answer, with gradient-descent steps, which are safe far from it, and adjusts the blend each time a step succeeds or fails.

### Monotone cubic interpolation
The arch passes smoothly through the control depths. An ordinary spline can overshoot between points, which would cut deeper than intended and through the minimum thickness. Fritsch–Carlson slopes stop that: on each interval the curve stays between its two end values.

### Hearing a tap
The FFT turns a recording into frequency content. Most windows start at zero weight, but a wooden bar's upper partials die within a few hundredths of a second, so the falling half of a Hann window is used: full weight right after the tap. Each peak is refined by fitting a parabola through three FFT bins in decibels, which gives far better than one-bin accuracy.

### Calibration, then a plan
The model has the book's wood values. One heard partial pins the overall stiffness (frequencies scale with √E). A second pins the shear stiffness, because shear changes the *ratio* between partials. With the model matching this board, it tries removing 0.3 mm at 24 places and records cents per mm for each partial. Choosing amounts is then a least-squares problem with a constraint: **amounts can't be negative**, because wood can't be added. Projected coordinate descent solves it. The plan is trimmed to four cuts, scaled to at most 2 mm in a round, and checked with full non-linear solves.

### Language and platform features you met here
- **Freestanding C++20 for WebAssembly:**
  - No standard library, no exceptions or RTTI, no heap.
  - `__builtin_sqrt` becomes a single WebAssembly instruction.
  - `__builtin_bit_cast` reads a float's exponent for `log`.
  - `-mbulk-memory` lets struct copies use `memory.copy`.
- **`export_name` attributes** to give the module a clean API with no glue code.
- **Strict warnings** (`-Wconversion -Wsign-conversion -Wshadow -Wold-style-cast -Werror`), **AddressSanitizer/UBSan**, and **clang-tidy** (bugprone, CERT and clang-analyzer checks).
- **Web Workers with ES modules**, **AudioWorklet** for raw microphone samples, and **Web Audio** synthesis from the computed partials.
- **three.js BufferGeometry** with per-vertex sample indices, so the mesh bends by the computed mode shapes.

## 4. Trade-offs

- **1D beam rather than 3D finite elements.** It runs fast enough to optimise in a browser (about 700 solves per design), at the cost of missing twisting and sideways modes. Those are listed as a known limit.
- **Static buffers.** A hard upper size (400 elements, 1M samples) in exchange for no allocation failures, no leaks, and code the sanitizers can fully check.
- **Validation in the core as well as the page.** Duplicated effort, but the CLI, the tests and any future front end are protected by the same checks.
- **A gentle round (≤ 2 mm) rather than the full plan.** More taps, but a wrong model can never ruin a bar in one go.
- **Generated data is committed and checked in CI.** The site works without building C++ locally, and CI fails if it drifts from the core.

## 5. Interview questions you might get

**Q: Why did you need Timoshenko theory rather than the textbook beam?**
A: Marimba bars are thick relative to their length. Shear and rotary inertia lower the upper partials significantly: the plain middle-C blank's ratios are 2.55 and 4.52, not 2.76 and 5.40. Since the whole point is to put partials within a few cents, the simpler model would design bars that are audibly out. The tests check that the model matches Euler–Bernoulli when shear is stiff and the bar is slender, so the extra physics doesn't hide errors.

**Q: How do you find only the lowest eigenvalues efficiently, and what about the zero-frequency modes?**
A: Subspace iteration on a banded system: each iteration is a banded Cholesky solve per vector, which is O(n), plus a 10×10 Rayleigh–Ritz problem. The free bar's rigid-body modes make K singular, so I shift to K + sM. Those modes come out with zero frequency, and I check that before discarding them. Very slender bars hit a round-off floor around 1e-10, so the convergence test accepts that rather than failing.

**Q: The optimiser can be given impossible targets. What happens?**
A: First it fits everything with equal weight from several starting shapes. If the best fit is still off, it re-fits with the note weighted ten times more, so the compromise goes into the overtones and not the pitch. A final rescale of the length makes the note exact. The result reports which partials missed, and the page suggests a thinner blank or fewer tuned partials. A test covers this case.

**Q: How do you keep a WebAssembly module safe with untrusted input?**
A: Give it nothing it could misuse. It imports nothing, has fixed-size static buffers, and every field is validated in C++ (finite, in range, integer where needed) before use. The page also validates, but the core doesn't rely on that. Under ASan and UBSan the tests feed it a table of bad values for every field and 400 random requests. The JS side never builds HTML from strings, and the CSP blocks inline code.

**Q: How do you know the workshop advice actually converges?**
A: It's tested end to end on a simulated bar whose true stiffness and shear differ from the book and whose arch was cut too shallow. The test synthesises a tap, hears it with the real FFT code, takes the advice, applies the cuts to the hidden "real" bar and repeats. It goes from 256 cents sharp to within a cent by the fourth tap. A browser test does the same through the actual UI.

## 6. Ideas to extend it

1. **Twisting and sideways modes:** a 2D plate model of the bar to warn when a torsional mode lands near a tuned partial.
2. **Resonators:** design each bar's tube for a chosen temperature, with a proper end correction, and add its effect to the sound.
3. **Photo measurement:** read the underside profile from a phone photo of the bar beside a ruler, so the workshop model stays exact after each round.
