/**
 * The session rules (dispatch/session-rules.mjs): the three rules every
 * session in a served repo follows, which governor puts at the end of every
 * launch's prompt where the repo's file turns `sessionRules` on, and the
 * marked block a served repo copies into its `CLAUDE.md` for the sessions a
 * person starts. The block in the docs and in the starter kit is the
 * module's own, so the two cannot drift.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SESSION_RULES, SESSION_RULES_BLOCK, SESSION_RULES_END, SESSION_RULES_FILE, SESSION_RULES_VERSION, blockIn, brokenRule, rulesFile } from '../dispatch/session-rules.mjs';
import { GENERIC_SWITCHES, readConfig, turnsOn } from '../dispatch/repo-config.mjs';
import { configJsonSchema } from '../scripts/export-config-schema.mjs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('the three rules', () => {
  test('are numbered one to three, and rule 1 is the signing rule', () => {
    const numbered = SESSION_RULES.split('\n').filter((line) => /^\d\. /.test(line));
    assert.deepEqual(numbered.map((line) => line.slice(0, 2)), ['1.', '2.', '3.']);
    assert.match(numbered[0]!, /Sign everything you write on GitHub/);
    assert.match(numbered[0]!, /https:\/\/claude\.ai\/code\/session_… URL, alone on the line just above the Claude Code footer/);
  });

  test('the rule a correction names by its number is the rule of that number', () => {
    const numbered = SESSION_RULES.split('\n').filter((line) => /^\d\. /.test(line));
    for (const rule of [1, 2] as const) {
      const name = /session rule \d: (.+)\.$/.exec(brokenRule(rule))![1]!;
      assert.ok(numbered[rule - 1]!.startsWith(`${rule}. ${name[0]!.toUpperCase()}${name.slice(1)}`), `${brokenRule(rule)} / ${numbered[rule - 1]}`);
    }
  });

  test('say who edits a body and pushes to a branch, and that signing off gives up the issues a session owns', () => {
    assert.match(SESSION_RULES, /Only an issue's or a PR's owner edits its body, and only a PR's owner pushes to its branch\./);
    assert.match(SESSION_RULES, /Signing off gives up the issues you own\./);
    assert.match(SESSION_RULES, /While you own an open PR, do not sign off until governor asks\./);
  });

  test('rule 3 says to comment, and takes an issue only where governor says nobody owns it', () => {
    assert.match(SESSION_RULES, /To change an issue or a PR you do not own, comment on it\./);
    assert.match(SESSION_RULES, /Where governor tells you nobody owns an issue, you may take it by editing its body so your link ends it\./);
  });
});

describe('the CLAUDE.md block', () => {
  test('runs from the versioned marker to the end marker, around the rules', () => {
    assert.equal(SESSION_RULES_VERSION, 1);
    assert.equal(SESSION_RULES_BLOCK, `<!-- governor:session-rules v1 -->\n${SESSION_RULES}\n${SESSION_RULES_END}`);
    assert.equal(SESSION_RULES_END, '<!-- governor:session-rules-end -->');
  });

  test('is current where a file carries it, whatever surrounds it', () => {
    assert.equal(blockIn(SESSION_RULES_BLOCK), 'current');
    assert.equal(blockIn(`# Working here\n\nBuild with make.\n\n${SESSION_RULES_BLOCK}\n\nMore.\n`), 'current');
  });

  test('is missing where a file has no marker, or only the end marker', () => {
    assert.equal(blockIn(''), 'missing');
    assert.equal(blockIn('# Working here\n\nSign your posts.\n'), 'missing');
    assert.equal(blockIn(`Some text.\n${SESSION_RULES_END}\n`), 'missing');
  });

  test('is old where its marker names another version', () => {
    assert.equal(blockIn('<!-- governor:session-rules v0 -->\nOld rules.\n<!-- governor:session-rules-end -->'), 'old');
    assert.equal(blockIn(SESSION_RULES_BLOCK.replace('v1', 'v2')), 'old');
  });

  test('a marker of another prefix is text, not the block', () => {
    assert.equal(blockIn(SESSION_RULES_BLOCK.replaceAll('governor:', 'other:')), 'missing');
  });
});

describe('the sessionRules section', () => {
  const parse = (sessionRules: unknown) => readConfig(JSON.stringify({ environment: 'my-env', sessionRules }));

  test('is a generic switch, on with {} and with a file, off with enabled false or no section', () => {
    assert.ok(GENERIC_SWITCHES.includes('sessionRules'));
    for (const on of [{}, { file: 'docs/AGENTS.md' }]) {
      const got = parse(on);
      assert.ok(got.ok, JSON.stringify(got));
      assert.equal(turnsOn(got.config, 'sessionRules'), true, JSON.stringify(on));
    }
    const off = parse({ enabled: false });
    assert.ok(off.ok);
    assert.equal(turnsOn(off.config, 'sessionRules'), false);
    const none = readConfig(JSON.stringify({ environment: 'my-env' }));
    assert.ok(none.ok);
    assert.equal(turnsOn(none.config, 'sessionRules'), false);
  });

  test('refuses an unknown key, and a file that is no path in the repo', () => {
    for (const bad of [{ files: 'CLAUDE.md' }, { prompt: 'Sign.' }, { file: '/CLAUDE.md' }, { file: '../CLAUDE.md' }, { file: '' }, { file: 3 }]) {
      assert.equal(parse(bad).ok, false, JSON.stringify(bad));
    }
  });

  test('the exported JSON Schema lists it, with file', () => {
    const schema = configJsonSchema() as { properties: Record<string, { properties?: Record<string, unknown>, additionalProperties?: unknown }> };
    assert.ok(schema.properties.sessionRules?.properties?.file !== undefined);
    assert.equal(schema.properties.sessionRules?.additionalProperties, false);
  });
});

describe('the file the block is looked for in', () => {
  const base = { environment: 'my-env' };
  const config = (file: Record<string, unknown>) => {
    const got = readConfig(JSON.stringify({ ...base, ...file }));
    assert.ok(got.ok, JSON.stringify(got));
    return got.config;
  };

  test('is CLAUDE.md at the root unless sessionRules.file names another', () => {
    assert.equal(SESSION_RULES_FILE, 'CLAUDE.md');
    assert.equal(rulesFile(config({ sessionRules: {} })), 'CLAUDE.md');
    assert.equal(rulesFile(config({ sessionRules: { file: 'docs/AGENTS.md' } })), 'docs/AGENTS.md');
  });
});

describe('the published block', () => {
  test('the starter kit\'s CLAUDE.md carries the module\'s block', () => {
    assert.ok(read('examples/starter/CLAUDE.md').includes(SESSION_RULES_BLOCK), 'copy SESSION_RULES_BLOCK into examples/starter/CLAUDE.md');
  });

  test('docs/serving-a-repo.md carries the module\'s block, and says where to copy it', () => {
    const doc = read('docs/serving-a-repo.md');
    assert.ok(doc.includes(`\`\`\`\n${SESSION_RULES_BLOCK}\n\`\`\``), 'copy SESSION_RULES_BLOCK into docs/serving-a-repo.md, in a fenced block');
    assert.match(doc, /`sessionRules\.file`/);
  });
});

describe('the session rules switch and the block\'s markers', () => {
  test('the switch list names the session rules, and both markers are governor: markers', () => {
    assert.ok(GENERIC_SWITCHES.includes('sessionRules'));
    assert.ok(SESSION_RULES_BLOCK.startsWith(`<!-- governor:session-rules v${SESSION_RULES_VERSION} -->`));
    assert.equal(SESSION_RULES_END, '<!-- governor:session-rules-end -->');
  });
});
