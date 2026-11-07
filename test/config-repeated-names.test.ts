/**
 * A config file that repeats a name under periodics.sessions, hooks.sessions
 * or issueReviews.reviews. JSON.parse keeps the last of two equal keys
 * without a word, so `readConfig` reads the file's text for them and refuses
 * the file, naming the section and the key.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_PATH, readConfig } from '../dispatch/repo-config.mjs';
import { factoryFile } from './helpers/factory.ts';

const SECTIONS = [
  ['periodics', 'sessions'],
  ['hooks', 'sessions'],
  ['issueReviews', 'reviews'],
] as const;

const MARK = '"@@named@@"';

/**
 * The factory's file with the named entries at `section.key` written out by
 * hand, its first entry twice, so the text holds a repeated key.
 */
const repeating = (section: string, key: string) => {
  const config = JSON.parse(factoryFile(CONFIG_PATH));
  const entries = Object.entries(config[section][key] as Record<string, unknown>);
  assert.ok(entries.length > 0, `the factory names a ${section}.${key} entry`);
  const first = entries[0]!;
  config[section][key] = '@@named@@';
  const body = [first, ...entries].map(([name, entry]) => `${JSON.stringify(name)}: ${JSON.stringify(entry)}`).join(', ');
  return { name: first[0], text: JSON.stringify(config, null, 2).replace(MARK, `{ ${body} }`) };
};

describe('a config file that repeats a named entry', () => {
  for (const [section, key] of SECTIONS) {
    test(`a name repeated in ${section}.${key} is refused, naming the section and the name`, () => {
      const { name, text } = repeating(section, key);
      const read = readConfig(text);
      assert.ok(!read.ok, 'the file is refused');
      assert.ok(read.fault.includes(`${section}.${key}`), read.fault);
      assert.ok(read.fault.includes(JSON.stringify(name)), read.fault);
    });
  }

  test('the factory\'s file, with distinct names, reads as before', () => {
    assert.ok(readConfig(factoryFile(CONFIG_PATH)).ok);
  });

  test('a name written once plainly and once escaped is the same name', () => {
    const { name, text } = repeating('periodics', 'sessions');
    const escaped = [...name].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const once = text.replace(JSON.stringify(name), `"${escaped}"`);
    assert.notEqual(once, text);
    const read = readConfig(once);
    assert.ok(!read.ok);
    assert.ok(read.fault.includes('periodics.sessions'), read.fault);
  });

  test('a name repeated three times is named once', () => {
    const { name, text } = repeating('hooks', 'sessions');
    const entry = JSON.stringify(JSON.parse(factoryFile(CONFIG_PATH)).hooks.sessions[name]);
    const thrice = text.replace(`${JSON.stringify(name)}: ${entry}`, `${JSON.stringify(name)}: ${entry}, ${JSON.stringify(name)}: ${entry}`);
    const read = readConfig(thrice);
    assert.ok(!read.ok);
    assert.equal(read.fault.split(JSON.stringify(name)).length - 1, 1, read.fault);
  });

  test('a key repeated anywhere else is left to JSON.parse, as before', () => {
    const text = factoryFile(CONFIG_PATH).replace('"environment": "env_fakefactory",', '"environment": "env_other", "environment": "env_fakefactory",');
    assert.ok(text.includes('env_other'));
    assert.ok(readConfig(text).ok);
  });

  test('the same keys nested deeper are not a named section', () => {
    const text = factoryFile(CONFIG_PATH).replace(/^\{/, '{"x": {"periodics": {"sessions": {"a": 1, "a": 2}}},');
    // An unknown top-level key fails the schema, but not as a repeated name.
    const read = readConfig(text);
    assert.ok(!read.ok);
    assert.ok(!read.fault.includes('repeated'), read.fault);
  });

  test('a deeply nested value is a schema fault, and the read does not throw', () => {
    // JSON.parse accepts nesting deeper than a recursive scan's stack.
    const depth = 100_000;
    const text = factoryFile(CONFIG_PATH).replace(/^\{/, `{"x": ${'['.repeat(depth)}${']'.repeat(depth)},`);
    const read = readConfig(text);
    assert.ok(!read.ok);
    assert.ok(!read.fault.includes('repeated'), read.fault);
  });

  test('a top-level key holding a dot is not a named section', () => {
    const text = factoryFile(CONFIG_PATH).replace(/^\{/, '{"periodics.sessions": {"a": 1, "a": 2},');
    const read = readConfig(text);
    assert.ok(!read.ok);
    assert.ok(!read.fault.includes('repeated'), read.fault);
  });
});
