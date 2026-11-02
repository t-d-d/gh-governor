# Spike: a markdown parser for the quote scanner

Trial code for issue 249. Nothing here is imported by governor, and this
folder is not meant for main.

- `compare.mjs` reads a set of named cases and generated bodies with the
  current scanner, commonmark.js and micromark, and compares each with
  GitHub's own parser. Its header says how to run it.
- `gfm.py` is the reference: cmark-gfm, through the `cmarkgfm` binding,
  with GitHub's extensions and footnotes on.
- `swap.patch` is the trial swap: `fillQuotes` in
  `dispatch/webhook/subscribe.mjs` reads quotes from commonmark.js, copied
  as `dispatch/webhook/vendor/commonmark.cjs` (the package's
  `dist/commonmark.js`, unchanged), with the copy excluded from tsc.
- `commonmark.d.cts` is the declaration that sits beside the copy.

The findings are in the comment on the issue.
