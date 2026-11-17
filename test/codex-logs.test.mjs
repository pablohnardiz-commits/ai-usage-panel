import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CODEX_DIR } from './helpers.mjs';
import { parseCodex, patchLines, codexSessionDirs } from '../src/codex-logs.mjs';

const sum = (list, k) => list.reduce((a, x) => a + x[k], 0);

test('suma last_token_usage de varios token_count y salta los repetidos', () => {
  const { usage, stats } = parseCodex([CODEX_DIR]);
  assert.equal(usage.length, 3);
  assert.equal(stats.duplicates, 1);
  assert.equal(sum(usage, 'input'), 1350); // sin la parte en caché
  assert.equal(sum(usage, 'cacheRead'), 1200);
  assert.equal(sum(usage, 'output'), 310);
  assert.equal(sum(usage, 'reasoning'), 100);
  assert.equal(sum(usage, 'cacheWrite'), 0);
});

test('comprueba la suma con el total acumulado de cada sesión', () => {
  const { stats } = parseCodex([CODEX_DIR]);
  assert.equal(stats.checks.sessions, 2);
  assert.equal(stats.checks.ok, 1);
  assert.equal(stats.checks.mismatches.length, 1);
  assert.equal(stats.checks.mismatches[0].diff, -20);
});

test('modelo y proyecto salen de turn_context y session_meta', () => {
  const { usage } = parseCodex([CODEX_DIR]);
  assert.deepEqual([...new Set(usage.map((u) => `${u.model}@${u.project}`))].sort(), ['gpt-5-codex@proj-a', 'gpt-5@proj-c']);
});

test('cuenta las líneas de apply_patch y descarta los parches fallidos', () => {
  const { edits, stats } = parseCodex([CODEX_DIR]);
  assert.equal(edits.length, 2);
  assert.equal(sum(edits, 'added'), 4);
  assert.equal(sum(edits, 'removed'), 3);
  assert.equal(stats.failedEdits, 1);
});

test('líneas corruptas', () => {
  const { stats } = parseCodex([CODEX_DIR]);
  assert.equal(stats.bad, 1);
  assert.equal(stats.files, 2);
});

test('una sesión archivada repetida se cuenta una vez', () => {
  const { usage, stats } = parseCodex([CODEX_DIR, CODEX_DIR]);
  assert.equal(usage.length, 3);
  assert.equal(stats.files, 4);
});

test('patchLines', () => {
  assert.deepEqual(patchLines('*** Begin Patch\n*** Add File: a\n+1\n+2\n*** End Patch'), { added: 2, removed: 0 });
  assert.deepEqual(patchLines('*** Begin Patch\n*** Update File: a\n@@\n ctx\n-x\n+y\n+z\n*** End Patch'), { added: 2, removed: 1 });
});

test('respeta CODEX_HOME', () => {
  assert.equal(codexSessionDirs({ CODEX_HOME: '/c' })[0], path.join('/c', 'sessions'));
  assert.equal(codexSessionDirs({ HOME: '/h' })[0], path.join('/h', '.codex', 'sessions'));
});
