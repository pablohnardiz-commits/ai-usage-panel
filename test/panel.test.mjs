import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { CLAUDE_DIR, CODEX_DIR } from './helpers.mjs';
import { parseClaude } from '../src/claude-logs.mjs';
import { parseCodex } from '../src/codex-logs.mjs';
import { buildData, summarize } from '../src/aggregate.mjs';
import { renderHtml } from '../src/render.mjs';
import { main } from '../bin/usage-panel.mjs';

const NOW = new Date('2026-11-17T12:00:00Z');
const data = () => buildData({ claude: parseClaude([CLAUDE_DIR]), codex: parseCodex([CODEX_DIR]), now: NOW, sources: {} });

test('totales por herramienta', () => {
  const { totals } = summarize(data(), null, null);
  assert.equal(totals.claude.tokens, 2600);
  assert.equal(totals.claude.tokensNoCache, 400);
  assert.equal(totals.codex.tokens, 2860);
  assert.equal(totals.codex.tokensNoCache, 1660);
  assert.deepEqual([totals.claude.sessions, totals.codex.sessions], [2, 2]);
  assert.deepEqual([totals.claude.activeDays, totals.codex.activeDays], [2, 2]);
  assert.deepEqual([totals.claude.added, totals.claude.removed], [7, 4]);
  assert.deepEqual([totals.codex.added, totals.codex.removed], [4, 3]);
});

test('filtro de rango, por día, modelo y proyecto', () => {
  const S = summarize(data(), '2026-11-11', '2026-11-12');
  assert.equal(S.totals.claude.tokens, 300); // solo sess-b
  assert.equal(S.totals.codex.tokens, 2860);
  assert.deepEqual(S.days.map((d) => d.date), ['2026-11-11', '2026-11-12']);
  assert.deepEqual(S.models.map((m) => m.model), ['gpt-5-codex', 'claude-opus-x', 'gpt-5']);
  assert.equal(S.projects[0].project, 'proj-a');
});

test('--since descarta el uso anterior', () => {
  const d = buildData({ claude: parseClaude([CLAUDE_DIR]), codex: parseCodex([CODEX_DIR]), since: '2026-11-12', now: NOW, sources: {} });
  const { totals } = summarize(d, null, null);
  assert.equal(totals.claude.tokens, 300);
  assert.equal(totals.codex.tokens, 60);
});

test('el HTML es autónomo y lleva los datos incrustados', () => {
  const html = renderHtml(data());
  assert.ok(!/<script[^>]+src=|<link[^>]+href=/.test(html), 'sin recursos externos');
  const json = html.match(/<script type="application\/json" id="usage-data">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).rows.length, data().rows.length);
  // El script del cliente debe ser JavaScript válido.
  const js = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(js));
  assert.match(html, /líneas de log no se entendieron/);
});

test('sin logs: panel vacío con aviso, no un error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-empty-'));
  const out = path.join(tmp, 'panel.html');
  const lines = [];
  const d = main(['--out', out, '--json', path.join(tmp, 'd.json')], { HOME: tmp }, (l) => lines.push(l));
  assert.equal(d.rows.length, 0);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /No se encontraron datos de uso/);
  assert.ok(lines.some((l) => l.includes('panel vacío')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'd.json'), 'utf8')).rows.length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('--since con formato incorrecto da un error claro', () => {
  assert.throws(() => main(['--since', '17/11/2026'], {}, () => {}), /AAAA-MM-DD/);
});
