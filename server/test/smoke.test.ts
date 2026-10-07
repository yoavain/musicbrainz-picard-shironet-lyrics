import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import pkg from '../package.json' with { type: 'json' };

test('node:sqlite loads without a flag', () => {
  const db = new DatabaseSync(':memory:');
  const row = db.prepare('SELECT 1 + 1 AS two').get() as { two: number };
  db.close();
  assert.equal(row.two, 2);
});

test('package.json is readable as JSON', () => {
  assert.equal(pkg.name, 'shironet-lyrics-server');
});
