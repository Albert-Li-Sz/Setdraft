# Contest PDF dependencies

## Original XCPC template and fonts

`xcpc/upstream.typ` is the unmodified `typst-template/lib.typ` from
https://github.com/lihaoze123/xcpc-statement-generator at revision
`84d822305f32dac2e0ac61c25c22145fbfc1d8cd`, by lihaoze123 and contributors.
Its SHA-256 is `c130ad6e5b30c4315e5373ffec1bd95d7058dc731954611d3a6e56f945d8759f`.
The upstream AGPL-3.0 license is retained in `xcpc/LICENSE` and
`../../../LICENSES/AGPL-3.0.txt`. See the repository `COPYING.md` for the
integrated application's licensing and network corresponding-source offer.

`xcpc/lib.typ` is the Setdraft adaptation (2026-09-29). It retains the original
font lists, dimensions, cover, problem list, headers/footers, sample tables and
section order. Imports use vendored packages. Markdown disables raw Typst,
images are restricted to validated attachments, and links allow HTTP(S) or
internal labels only. It accepts only Markdown statements. Additions are an
interaction section and sample labels, explicit contest problem labels, and
optional cover notes. Empty cover notes leave the upstream layout unchanged.
The application does not accept user-supplied Typst or a complete LaTeX document.

`xcpc/fonts` contains the eight unmodified upstream font files. The compiler
loads those exact files explicitly; missing files fail rather than silently
substituting system fonts. The WASM compiler and driver are pinned to the
upstream lockfile's `@myriaddreamin/typst-ts-web-compiler` / `typst.ts`
`0.6.1-rc5`. Default font assets are explicitly disabled as in the upstream
worker: no native embedded fonts, OS font discovery or remote font downloads.
Font notices and checksums are in
`xcpc/FONT-NOTICES.md`; fonts do not inherit the template's AGPL license.

The regression test `test/contest-pdf-template.test.ts` verifies template/font
hashes and compares page counts and complete PDF bytes against the original
template with the same compiler and fonts, with creation dates disabled for
deterministic comparisons. It covers Chinese/English, multiple
samples, multipage problems, cover/list/header switches and single-problem PDFs.
`test/contest-pdf.test.ts` also checks the actual worker's embedded font names
against the eight original fonts, including Chinese interactive sample labels.
Interactive headings and nonempty cover notes are Setdraft extensions, not
features of the upstream template. Raw samples intentionally do not auto-wrap.

## Offline Markdown and numbering

- `cmarker`: 0.1.6, MIT; https://github.com/SabrinaJewson/cmarker.typ.
  Archive https://packages.typst.org/preview/cmarker-0.1.6.tar.gz,
  SHA-256 `1f5bf42c28579a8c8d9f05f6b60d4328a5f31fa907585cdab703294c0e4744e6`.
- `numbly`: 0.1.0, MIT; https://github.com/flaribbit/numbly.
  Archive https://packages.typst.org/preview/numbly-0.1.0.tar.gz,
  SHA-256 `e349be2ff133f3b7154f97462e73862ee31de613e506ef06964069a35756ff12`.

Their package files, WASM where applicable, and license texts are preserved.

## Hardened formula conversion

The `mitex` directory vendors the official MiTeX 0.2.6 Typst package for offline
LaTeX math rendering. Its Apache-2.0 license is retained in `mitex/LICENSE`.

- Upstream: https://github.com/mitex-rs/mitex
- Archive: https://packages.typst.org/preview/mitex-0.2.6.tar.gz
- SHA-256: `e45b8341f774e11036a9092b9217a95b7656d11acea9c4d24dc028e4dc849838`

Local security modification (2026-09-29): `mitex/specs/latex/standard.typ`
replaces dynamic evaluation of `hspace`, `vspace`, and `raisebox` dimensions with
strict signed-decimal parsing. Supported units are `pt`, `bp`, `pc`, `mm`, `cm`,
`in`, `em`, `ex`, `mu`, and `sp`; `ex` uses `0.5em`. Numeric magnitude is limited
to 10000. Typst expressions, function calls, arithmetic, and unitless dimensions
are rejected. The archive checksum above identifies the unmodified upstream
archive, not this locally hardened copy.

`mitex/mitex.typ` also rejects LaTeX `includegraphics` before conversion and
rejects generated image expressions before evaluating converter output. This
prevents unescaped image filenames from becoming executable Typst code. Images
must use the application's Markdown attachment mapping. Both math and text
conversion use a restricted evaluation scope that disables image loading,
file/data readers, plugins, nested evaluation, bibliography loading, and
document queries. Fixed imports and the bundled WASM plugin remain trusted.

The compiler sees only explicitly mapped template/package files, validated
images and generated sources in a memory-only filesystem. Host files, job JSON
and font files are not exposed as Typst-readable paths; the package registry
rejects resolution requests. PDF export does not fetch Typst packages, fonts,
or remote statement images at runtime.
