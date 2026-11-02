# Copied code

The receiver is packaged straight from `dispatch/webhook/`, with no install
step, so the one package it uses is copied in here. The copy and its
notices are never edited by hand.

## commonmark.js

- `commonmark.cjs` is `dist/commonmark.js` from the
  [commonmark](https://www.npmjs.com/package/commonmark) npm package,
  version 0.31.2, unchanged: sha256 `4d124568b8d4490df72fea8aa0f9a144c5b581b0de0eb63d3a996104b2797edc`.
  It is a UMD bundle, named `.cjs` so that ESM imports it as
  `import commonmark from './vendor/commonmark.cjs'`.
- It bundles two packages of its own: entities 3.0.1 and mdurl 1.0.1. Their
  notices sit beside commonmark's: `LICENSE.commonmark` (BSD-2-Clause),
  `LICENSE.entities` (BSD-2-Clause) and `LICENSE.mdurl` (MIT).
- `commonmark.d.cts` declares the part of it `subscribe.mjs` uses, so tsc
  reads the declaration and not the copy. `tsconfig.json` excludes the copy,
  and `eslint.config.js` ignores this folder.

`subscribe.mjs` reads which lines of a comment are quoted from it: a line
is quoted when it lies in the source range of a blockquote, or of any block
inside one. It matched cmark-gfm, GitHub's own parser, on 100,000 generated
bodies (issue #249). One known gap: GitHub reads a footnote definition as a
container, so `[^1]: > x` renders a quote there, and commonmark.js has no
footnotes.

### Updating it

1. Take `dist/commonmark.js` from the new version's npm tarball
   (`npm pack commonmark@<version>`) and replace `commonmark.cjs` with it.
2. Put the new sha256 and version above, and the versions of entities and
   mdurl its `package.json` depends on. Replace each `LICENSE.*` from its
   package's tarball at that version.
3. Run the comparison with cmark-gfm from the spike again
   (`spike/quote-parser/compare.mjs` on the branch
   `claude/quote-scanner-markdown-parser-z11iqy`), then the gate.
