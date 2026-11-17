// §11 — fixture-driven end-to-end tests: saved HTML before/after pairs run
// through extraction → parsing → diff, asserting the classification and the
// field-level diff. Each fixture directory holds after.html, expected.json,
// and (unless it's a first-scan case) before.html.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanHtml } from '../src/scan.js';
import { diffOffer } from '../src/diff-engine.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function assertSubset(actual, expectedSubset, label) {
  for (const [key, value] of Object.entries(expectedSubset)) {
    assert.deepEqual(actual?.[key], value, `${label}.${key}`);
  }
}

const fixtureNames = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const name of fixtureNames) {
  const dir = join(fixturesDir, name);
  const manifest = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));

  test(`fixture ${name} → ${manifest.expected.classification}`, async () => {
    const beforePath = join(dir, 'before.html');
    const previous = existsSync(beforePath)
      ? await scanHtml(readFileSync(beforePath, 'utf8'), manifest.selector)
      : null;
    const current = await scanHtml(readFileSync(join(dir, 'after.html'), 'utf8'), manifest.selector);

    const record = diffOffer({ sourceId: manifest.sourceId, previous, current });

    assert.equal(
      record.classification,
      manifest.expected.classification,
      `classification (notes: ${record.notes || 'none'})`
    );
    if (manifest.expected.changedFields) {
      assert.deepEqual(record.changedFields, manifest.expected.changedFields, 'changedFields');
    }
    if (manifest.expected.previous) {
      assertSubset(record.previous, manifest.expected.previous, 'previous');
    }
    if (manifest.expected.current) {
      assertSubset(record.current, manifest.expected.current, 'current');
    }
    if (manifest.expected.notesInclude) {
      assert.match(record.notes, new RegExp(manifest.expected.notesInclude, 'i'));
    }
    if (manifest.expected.parsedOfferChecks?.current) {
      assertSubset(current.parsedOffer, manifest.expected.parsedOfferChecks.current, 'parsedOffer');
    }
  });
}
