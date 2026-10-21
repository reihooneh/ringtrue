# Security

## What there is to protect

Ringtrue is a static site plus a command-line tool. It has no server, accounts, database, cookies or analytics. What's worth protecting is:

- **The visitor's browser and privacy:** the page must not run injected code, leak data to other sites, or keep microphone access.
- **Recordings:** sound captured from the microphone or opened from a file.
- **The integrity of the published site and its build.**

## Threat model

| What an attacker could try | How Ringtrue defends |
|---|---|
| A crafted link (`#note=<script>…`, huge numbers, `__proto__`) to inject markup or odd values | Links are read against a fixed schema: known keys only, values matched by strict patterns and ranges, the hash capped at 600 characters. Anything else is ignored. A test opens such links and checks nothing changes. |
| Getting HTML or script into the page | No `innerHTML`, `eval` or `new Function` anywhere (a test fails the build if they appear). The DOM is built with `createElement` and `textContent`. CSP: `default-src 'none'`, scripts only from the site, no inline scripts, styles or event handlers. |
| Malformed numbers sent to the C++ core (NaN, infinity, negative sizes, fractional counts, out-of-order partials) | `api.cpp` validates every field before the model sees it. The core is tested with a table of bad values for each field and 400 random requests under AddressSanitizer and UBSan. |
| Memory corruption in the C++ core | No heap, fixed-size static buffers with explicit bounds, strict warnings as errors, clang-tidy (bugprone, CERT, clang-analyzer), and sanitizer tests. In the browser the module also runs inside WebAssembly's sandbox and **imports nothing**. |
| A hostile sound file (huge, endless, not audio) | Files over 20 MB or 20 seconds are refused. Decoding uses the browser's own decoder, and a failure gives a plain message. Samples are copied into a fixed buffer, and the core refuses lengths above its limit and any non-finite sample. |
| Keeping or leaking recordings | Recordings are analysed in a worker and dropped. Nothing is uploaded: `connect-src 'self'` (needed only to load the module), and there are no third-party scripts. The microphone is requested only when you press "Listen", and the stream is stopped right after. |
| Downloaded files carrying something unexpected | The template SVG and CSV contain only numbers and fixed names, and the SVG's text is stripped of markup characters. A test checks the SVG has no script or event attributes. |
| Unsafe local preview server | `scripts/serve.mjs` (development only) serves files inside `site/` only, rejects path traversal, uses a fixed list of content types and sends `nosniff`. |
| Supply-chain attacks | No runtime dependencies. Dev dependencies (three.js, two fonts, Playwright) are pinned and audited in CI, and three.js and the fonts are self-hosted. CI runs with a read-only token, and only the deploy job can write to Pages. |

**Known limits:**
- GitHub Pages can't send custom HTTP headers, so the CSP is a `<meta>` tag. That means `frame-ancestors` (clickjacking protection) isn't available; the site has no actions worth hijacking that way.
- The sound decoders belong to the browser.
- No software is perfectly secure. Ringtrue keeps the attack surface small and checks what's left.

## Reporting a problem

Please open a private report through GitHub's **Security → Report a vulnerability** on this repository, or email reihaneh26686@gmail.com with "Ringtrue security" in the subject. Include what you did, what happened, and the browser you used. I'll reply within a week. Please don't open a public issue for security problems.
