/**
 * Spike for the quote scanner: which lines of a body each reader takes as
 * quoted, compared with GitHub's own parser, cmark-gfm. Not part of the
 * receiver. Run from the repo root with the candidates installed beside it:
 *
 *   npm install --prefix "$DIR" commonmark@0.31.2 micromark@4.0.3
 *   pip install cmarkgfm
 *   NODE_PATH="$DIR/node_modules" node spike/quote-parser/compare.mjs
 *
 * It prints each named case, then the share of generated bodies on which
 * each reader differs from GitHub on some non-blank line.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { withoutQuotes } from '../../dispatch/webhook/subscribe.mjs';

const require = createRequire(join(process.env.NODE_PATH ?? '.', 'x.js'));
const { Parser } = require('commonmark');
/** @type {any} */
const micromark = await import(require.resolve('micromark/stream').replace(/stream\.js$/, 'index.js').replace(/index\.js$/, 'lib/parse.js'));
const { preprocess } = await import(require.resolve('micromark/stream').replace(/stream\.js$/, 'lib/preprocess.js'));
const { postprocess } = await import(require.resolve('micromark/stream').replace(/stream\.js$/, 'lib/postprocess.js'));

/** @param {string} body */
const lineCount = (body) => body.split('\n').length;

/** The current scanner: the lines withoutQuotes blanks. @param {string} body */
const scanner = (body) => {
  const before = body.split('\n');
  const after = withoutQuotes(body).split('\n');
  return before.flatMap((line, i) => (/\S/.test(line) && !/\S/.test(after[i] ?? '') ? [i] : []));
};

/** commonmark.js: every line inside a block_quote's range, or a block's in one. @param {string} body */
const commonmark = (body) => {
  const lines = new Set();
  const walker = new Parser().parse(body).walker();
  let depth = 0;
  for (let step = walker.next(); step; step = walker.next()) {
    const { node, entering } = step;
    if (node.type === 'block_quote') depth += entering ? 1 : -1;
    if (entering && (depth > 0) && node.sourcepos) {
      const [[start], [end]] = node.sourcepos;
      for (let n = start; n <= end; n++) lines.add(n - 1);
    }
  }
  return [...lines].sort((a, b) => a - b);
};

/** micromark: every line a token inside a blockQuote token spans. @param {string} body */
const micromarkLines = (body) => {
  const lines = new Set();
  const events = postprocess(micromark.parse().document().write(preprocess()(body, undefined, true)));
  let depth = 0;
  for (const [kind, token] of events) {
    if (token.type === 'blockQuote') depth += kind === 'enter' ? 1 : -1;
    if (kind === 'enter' && (depth > 0 || token.type === 'blockQuote')) {
      for (let n = token.start.line; n <= token.end.line; n++) lines.add(n - 1);
    }
  }
  return [...lines].sort((a, b) => a - b);
};

/** GitHub, through spike/quote-parser/gfm.py. @param {string[]} bodies @returns {number[][]} */
const github = (bodies) =>
  JSON.parse(execFileSync('python3', [new URL('gfm.py', import.meta.url).pathname], { input: JSON.stringify(bodies), maxBuffer: 1 << 28 }).toString());

/** Only the non-blank lines matter: a blank line carries no link or mention. @param {string} body @param {number[]} lines */
const meaningful = (body, lines) => {
  const text = body.split('\n');
  return lines.filter((i) => i < lineCount(body) && /\S/.test(text[i] ?? '')).join(',');
};

const READERS = { scanner, commonmark, micromark: micromarkLines };

const CASES = {
  // #249
  'bare - then quote': '-\n  > x',
  'bare 1. then quote': '1.\n    > x',
  'quote then bare -': '> x\n-',
  '1. then 2. > x': '1. a\n2. > x',
  'quote then 10)': '> x\n10) a',
  'list in quote then list': '> - a\n- b',
  'indented line in quote': '> a\n>     b\nfoo',
  // #209
  'tab after marker': '-\t> link',
  'nested list then indented code': '- a\n  - b\n\n      > x',
  'quote in details': '<details>\n> x\n</details>',
  'quote in multi-line comment': '<!--\n> x\n-->',
};

const names = Object.keys(CASES);
const bodies = Object.values(CASES);
const truth = github(bodies);
console.log('case | github | ' + Object.keys(READERS).join(' | '));
bodies.forEach((body, i) => {
  const want = meaningful(body, truth[i] ?? []);
  const cells = Object.values(READERS).map((read) => {
    const got = meaningful(body, read(body));
    return got === want ? 'same' : `[${got}]`;
  });
  console.log(`${names[i]} | [${want}] | ${cells.join(' | ')}`);
});

// Generated bodies, from a seeded generator so a run repeats.
let seed = 249;
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};
const pick = (list) => list[rand(list.length)];
const INDENTS = ['', '', '', ' ', '  ', '   ', '    ', '\t', '      '];
const MARKS = ['', '', '> ', '>', '> > ', '- ', '-', '* ', '1. ', '1.', '2. ', '10) ', '-\t', '- > ', '1. > ', '> - ', '> 1. ', '```', '~~~', '<details>', '</details>', '<!--', '-->', '# ', '---', '| a | b |', '|---|---|', '> | a |', '- [ ] '];
const TEXT = ['x', '', 'a b', '[l](u)', '@who', '> y'];
const generated = Array.from({ length: Number(process.env.BODIES ?? 20000) }, () =>
  Array.from({ length: 2 + rand(5) }, () => (rand(6) === 0 ? '' : pick(INDENTS) + pick(MARKS) + pick(TEXT))).join('\n'),
);
const want = github(generated).map((lines, i) => meaningful(generated[i] ?? '', lines));
for (const [name, read] of Object.entries(READERS)) {
  const wrong = generated.filter((body, i) => meaningful(body, read(body)) !== want[i]);
  console.log(`${name}: differs from GitHub on ${wrong.length} of ${generated.length} bodies`);
  for (const body of wrong.slice(0, Number(process.env.SHOW ?? 0))) console.log('  ' + JSON.stringify(body));
}
