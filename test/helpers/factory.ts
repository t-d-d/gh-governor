/**
 * The factory: a fixture repo shaped like a served repo that turns every
 * feature on. Its config file and review checklist live under
 * test/fixtures/factory/, read here the way the turn reads a served repo's
 * default branch.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FACTORY_DIR = 'test/fixtures/factory';

/** A file of the factory's, by its path in the repo. */
export const factoryFile = (path: string) => readFileSync(join(FACTORY_DIR, path), 'utf8');
