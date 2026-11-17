import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CLAUDE_DIR } from './helpers.mjs';
import { parseClaude, editLines, claudeProjectDirs } from '../src/claude-logs.mjs';
import { diffEstimate } from '../src/util.mjs';

const sum = (list, k) => list.reduce((a, x) => a + x[k], 0);

test('quita los duplicados del streaming y de sesiones reanudadas', () => {
  const { usage, stats } = parseClaude([CLAUDE_DIR]);
  // msg_1 aparece 3 veces (2 en streaming + 1 en la copia reanudada), msg_2 dos veces.
  assert.equal(usage.length, 5);
  assert.equal(stats.duplicates, 3);
  assert.equal(sum(usage, 'input'), 117);
  assert.equal(sum(usage, 'cacheWrite'), 100);
  assert.equal(sum(usage, 'cacheRead'), 2100);
  // De msg_2 se toma la salida final (30), no la parcial (20).
  assert.equal(sum(usage, 'output'), 283);
});

test('ignora los mensajes <synthetic>', () => {
  const { usage, stats } = parseClaude([CLAUDE_DIR]);
  assert.equal(stats.syntheticSkipped, 1);
  assert.ok(usage.every((u) => u.model !== '<synthetic>'));
});

test('cuenta Write, Edit y MultiEdit y descarta las ediciones fallidas', () => {
  const { edits, stats } = parseClaude([CLAUDE_DIR]);
  const by = Object.fromEntries(edits.map((e) => [e.kind, e]));
  assert.deepEqual([by.Write.added, by.Write.removed], [3, 0]);
  assert.deepEqual([by.Edit.added, by.Edit.removed], [3, 2]);
  assert.deepEqual([by.MultiEdit.added, by.MultiEdit.removed], [1, 2]);
  assert.equal(edits.length, 3); // el Write repetido en la copia reanudada no se cuenta dos veces
  assert.equal(stats.failedEdits, 1);
});

test('las líneas corruptas se cuentan aparte y no detienen la lectura', () => {
  const { stats } = parseClaude([CLAUDE_DIR]);
  assert.equal(stats.bad, 2);
  assert.equal(stats.files, 3);
  assert.ok(stats.badSamples.some((b) => b.reason === 'JSON inválido'));
});

test('proyecto a partir del cwd, también con rutas de Windows', () => {
  const { usage } = parseClaude([CLAUDE_DIR]);
  assert.deepEqual([...new Set(usage.map((u) => u.project))].sort(), ['proj-a', 'proj-b']);
});

test('carpetas inexistentes no son un error', () => {
  const r = parseClaude([path.join(CLAUDE_DIR, 'no-existe')]);
  assert.deepEqual([r.usage.length, r.edits.length, r.stats.files], [0, 0, 0]);
});

test('respeta CLAUDE_CONFIG_DIR', () => {
  assert.deepEqual(claudeProjectDirs({ CLAUDE_CONFIG_DIR: '/a,/b', HOME: '/h' }), [path.join('/a', 'projects'), path.join('/b', 'projects')]);
  assert.deepEqual(claudeProjectDirs({ HOME: '/h' }), [path.join('/h', '.config', 'claude', 'projects'), path.join('/h', '.claude', 'projects')]);
  assert.ok(claudeProjectDirs({ USERPROFILE: 'C:\\Users\\u' })[1].endsWith('projects'));
});

test('estimación de líneas', () => {
  assert.deepEqual(diffEstimate('a\nb\nc', 'a\nX\nc'), { added: 1, removed: 1 });
  assert.deepEqual(diffEstimate('', 'a\nb\n'), { added: 2, removed: 0 });
  assert.deepEqual(diffEstimate('a\r\nb', 'a\nb'), { added: 0, removed: 0 });
  assert.equal(editLines('Write', { content: '' }).added, 0);
  assert.equal(editLines('Edit', null), null);
});

test('lectura por trozos: multibyte partido, CRLF, BOM y sin salto final', async () => {
  const { forEachLine } = await import('../src/util.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-lines-')), 'a.txt');
  fs.writeFileSync(f, '﻿añá€😀\r\nsegunda línea\n\núltima');
  for (const size of [1, 2, 3, 5, 64]) {
    const got = [];
    forEachLine(f, (l, n) => got.push(`${n}:${l}`), size);
    assert.deepEqual(got, ['1:añá€😀', '2:segunda línea', '3:', '4:última'], `trozo ${size}`);
  }
});
