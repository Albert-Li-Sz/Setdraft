# Setdraft licensing and corresponding source

The integrated Setdraft application, including its adapted XCPC contest template,
is distributed under the GNU Affero General Public License version 3
(AGPL-3.0-only). See `LICENSES/AGPL-3.0.txt`. You may copy, modify and redistribute
it under those terms. It is provided WITHOUT ANY WARRANTY, including implied
warranties of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

The original MIT notices remain in `LICENSE`; this does not revoke the MIT
permissions for the original code. Independently licensed dependencies retain
their own notices and terms. Fonts are separate assets, not relicensed as AGPL.

## XCPC template attribution

- Project: https://github.com/lihaoze123/xcpc-statement-generator
- Authors: lihaoze123 and the project's contributors.
- Pinned revision: `84d822305f32dac2e0ac61c25c22145fbfc1d8cd`.
- Original file: `typst-template/lib.typ`, preserved as
  `packages/hydro-server/assets/xcpc/upstream.typ` with its original license.
- Modified version: `packages/hydro-server/assets/xcpc/lib.typ`, adapted by
  Setdraft on 2026-09-29. Changes include offline package imports, restricted
  Markdown/image evaluation, interactive sections, explicit problem labels and
  optional cover notes. Original layout measurements and font files are retained.

Full dependency provenance and font notices are in
`packages/hydro-server/assets/README.md` and `assets/xcpc/FONT-NOTICES.md`.
The four Founder fonts carry separate proprietary notices. Upstream did not
provide a separate redistribution/embedding license for them. Their presence
in that repository is not proof of permission: operators/distributors must
verify the necessary font rights before publishing images, source bundles or PDFs.

## Network source offer

The application sidebar and PDF settings link to `/open-source/index.html`.
The web build runs `scripts/package-source.mjs` before compilation and includes
`/open-source/source.tgz`, containing the application sources used by that
build, pinned dependency lockfile, templates, license notices, build/install
scripts, deployment configuration and tests. No login or payment is required
to download it. Node/npm and locked public dependencies can be obtained using
`npm ci --ignore-scripts`; follow `README.md` for building and installation.

The archive deliberately excludes deployment secrets, `.env` files, user data,
version-control metadata, installed dependencies and generated output. Do not
put credentials or private data in source directories. Review the archive before
publishing. Any modified deployment must rebuild and keep the source offer
accessible to its network users as required by AGPL section 13. When distributing
images, also provide the matching archive to recipients under AGPL section 6;
do not replace it with a link to an unrelated/newer revision.

## Scope of generated documents

Author-written problem statements and test data are not automatically licensed
under AGPL merely because they are processed by this application. Rights in
submitted content and embedded fonts remain with their respective holders.
