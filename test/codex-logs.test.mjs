import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { CODEX_DIR } from './helpers.mjs';
import { parseCodex, patchLines, codexSessionDirs, normalizeCodexUsage } from '../src/codex-logs.mjs';
import zlib from 'node:zlib';

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

test('comprueba cada subida del total acumulado contra el último uso', () => {
  const { stats } = parseCodex([CODEX_DIR]);
  // La 2.ª sesión empieza con total 80 y last 60 (continuación): no se puede comprobar, no es un error.
  assert.equal(stats.checks.sessions, 1);
  assert.equal(stats.checks.ok, 1);
  assert.equal(stats.checks.mismatches.length, 0);
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

test('una carpeta leída dos veces no duplica nada', () => {
  const { usage, stats } = parseCodex([CODEX_DIR, CODEX_DIR]);
  assert.equal(usage.length, 3);
  assert.equal(stats.files, 2);
  assert.equal(stats.sessionsWithTokens, 2);
});

test('sesión reanudada en otro fichero: se descarta lo copiado y se suma lo nuevo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-codex-'));
  const src = path.join(CODEX_DIR, '2026', '11', '11');
  const name = fs.readdirSync(src)[0];
  const lines = fs.readFileSync(path.join(src, name), 'utf8').trim().split('\n');
  fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'archived_sessions'), { recursive: true });
  fs.copyFileSync(path.join(src, name), path.join(tmp, 'sessions', name));
  const extra = { timestamp: '2026-11-11T10:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 2600, cached_input_tokens: 1200, output_tokens: 310, reasoning_output_tokens: 100, total_tokens: 2910 },
    last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 } } } };
  fs.writeFileSync(path.join(tmp, 'archived_sessions', name.replace('09-00-00', '09-30-00')), [...lines, JSON.stringify(extra)].join('\n') + '\n');
  fs.writeFileSync(path.join(tmp, 'sessions', 'rollout-2026-11-13T00-00-00-sin-tokens.jsonl'), '{"type":"session_meta","payload":{"id":"x"}}\n');
  const { usage, stats } = parseCodex([path.join(tmp, 'sessions'), path.join(tmp, 'archived_sessions')]);
  assert.equal(usage.length, 3); // 2 del original + 1 nuevo
  assert.equal(sum(usage, 'input') + sum(usage, 'cacheRead') + sum(usage, 'output'), 2800 + 110);
  assert.equal(stats.filesWithoutTokens, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('patchLines', () => {
  assert.deepEqual(patchLines('*** Begin Patch\n*** Add File: a\n+1\n+2\n*** End Patch'), { added: 2, removed: 0 });
  assert.deepEqual(patchLines('*** Begin Patch\n*** Update File: a\n@@\n ctx\n-x\n+y\n+z\n*** End Patch'), { added: 2, removed: 1 });
});

test('respeta CODEX_HOME', () => {
  assert.equal(codexSessionDirs({ CODEX_HOME: '/c' })[0], path.join('/c', 'sessions'));
  assert.equal(codexSessionDirs({ HOME: '/h' })[0], path.join('/h', '.codex', 'sessions'));
});


// Formato de Codex Desktop 0.16x: continuaciones, cache_write, exec con JS y ficheros .zst.
const ev = (ts, type, payload) => JSON.stringify({ timestamp: ts, type, payload });
const usageOf = (input, cached, cw, out, r) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cw, output_tokens: out, reasoning_output_tokens: r, total_tokens: input + out });
const tcEv = (ts, total, last) => ev(ts, 'event_msg', { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, last_usage_includes_reasoning: true, model_context_window: 272000 } });

function desktopFixture(dir, { compress = false } = {}) {
  const day = path.join(dir, 'sessions', '2026', '11', '14');
  fs.mkdirSync(day, { recursive: true });
  const a = '019a0000-0000-7000-8000-00000000000a';
  const b = '019a0000-0000-7000-8000-00000000000b';
  const js = 'const r = await tools.apply_patch("*** Begin Patch\\n*** Update File: a.js\\n@@\\n-viejo\\n+nuevo\\n+otra\\n*** End Patch");\nconsole.log(r);';
  const fileA = [
    ev('2026-11-14T10:00:00Z', 'session_meta', { id: a, cwd: 'C:\\Users\\p\\web', cli_version: '0.169.0-alpha.11.1', originator: 'Codex Desktop' }),
    ev('2026-11-14T10:00:00Z', 'turn_context', { cwd: 'C:\\Users\\p\\web', model: 'gpt-5.5-codex' }),
    tcEv('2026-11-14T10:00:05Z', usageOf(1000, 0, 800, 100, 20), usageOf(1000, 0, 800, 100, 20)),
    ev('2026-11-14T10:00:06Z', 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'exec_1', input: js }),
    tcEv('2026-11-14T10:00:09Z', usageOf(3000, 900, 100, 150, 30), usageOf(2000, 900, 100, 50, 10)),
  ].join('\n') + '\n';
  // Continuación en otro fichero: repite el último token_count y sigue sumando.
  const fileB = [
    ev('2026-11-14T10:30:00Z', 'session_meta', { id: b, cwd: 'C:\\Users\\p\\web', cli_version: '0.169.0-alpha.11.1', originator: 'Codex Desktop' }),
    ev('2026-11-14T10:30:00Z', 'turn_context', { cwd: 'C:\\Users\\p\\web', model: 'gpt-5.5-codex' }),
    tcEv('2026-11-14T10:30:01Z', usageOf(3000, 900, 100, 150, 30), usageOf(2000, 900, 100, 50, 10)),
    tcEv('2026-11-14T10:30:05Z', usageOf(3500, 1300, 0, 175, 30), usageOf(500, 400, 0, 25, 0)),
  ].join('\n') + '\n';
  const write = (name, text) => {
    if (compress) fs.writeFileSync(path.join(day, `${name}.zst`), zlib.zstdCompressSync(Buffer.from(text)));
    else fs.writeFileSync(path.join(day, name), text);
  };
  write(`rollout-2026-11-14T10-00-00-${a}.jsonl`, fileA);
  write(`rollout-2026-11-14T10-30-00-${b}.jsonl`, fileB);
  return path.join(dir, 'sessions');
}

for (const compress of [false, true]) {
  test(`Codex Desktop${compress ? ' comprimido (.zst)' : ''}: continuación, cache_write y parche en exec`, { skip: compress && typeof zlib.zstdCompressSync !== 'function' }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-desktop-'));
    const { usage, edits, stats } = parseCodex([desktopFixture(tmp, { compress })]);
    assert.equal(usage.length, 3); // el evento repetido al empezar la continuación no se suma
    const total = usage.reduce((a, u) => a + u.input + u.cacheWrite + u.cacheRead + u.output, 0);
    assert.equal(total, 3675); // = total_tokens final (3500 + 175)
    assert.equal(sum(usage, 'cacheRead'), 1300);
    assert.equal(sum(usage, 'cacheWrite'), 900);
    assert.equal(sum(usage, 'input'), 1300);
    assert.equal(sum(usage, 'output'), 175);
    assert.deepEqual([sum(edits, 'added'), sum(edits, 'removed')], [2, 1]);
    assert.equal(stats.checks.mismatches.length, 0);
    assert.equal(stats.compressedFiles, compress ? 2 : 0);
    assert.equal(usage[0].project, 'web');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

test('normalizeCodexUsage: cache_write dentro o fuera de input_tokens', () => {
  const dentro = normalizeCodexUsage({ input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 50, output_tokens: 10, total_tokens: 110 });
  assert.deepEqual(dentro, { input: 20, cacheWrite: 50, cacheRead: 30, output: 10, reasoning: 0 });
  const fuera = normalizeCodexUsage({ input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 50, output_tokens: 10, total_tokens: 160 });
  assert.deepEqual(fuera, { input: 70, cacheWrite: 50, cacheRead: 30, output: 10, reasoning: 0 });
});
