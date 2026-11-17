#!/usr/bin/env node
// Genera un panel HTML con el uso de Claude Code y Codex a partir de sus logs locales.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { claudeProjectDirs, parseClaude } from '../src/claude-logs.mjs';
import { codexSessionDirs, parseCodex } from '../src/codex-logs.mjs';
import { readRepos } from '../src/git-lines.mjs';
import { buildData, summarize } from '../src/aggregate.mjs';
import { renderHtml } from '../src/render.mjs';

const HELP = `Uso: node bin/usage-panel.mjs [opciones]

  --out RUTA          HTML de salida (por defecto: panel-uso.html)
  --since AAAA-MM-DD  ignora el uso anterior a esa fecha
  --repo RUTA         repo git para contar líneas en commits (se puede repetir)
  --json RUTA         guarda también los datos agregados en JSON
  --claude-dir RUTA   carpeta "projects" de Claude Code (se puede repetir)
  --codex-dir RUTA    carpeta "sessions" de Codex (se puede repetir)
  -h, --help          muestra esta ayuda

Por defecto lee ~/.claude/projects (o CLAUDE_CONFIG_DIR) y ~/.codex/sessions (o CODEX_HOME).`;

export function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string', default: 'panel-uso.html' },
      since: { type: 'string' },
      repo: { type: 'string', multiple: true },
      json: { type: 'string' },
      'claude-dir': { type: 'string', multiple: true },
      'codex-dir': { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    log(HELP);
    return null;
  }
  if (values.since && !/^\d{4}-\d{2}-\d{2}$/.test(values.since)) {
    throw new Error(`--since debe tener el formato AAAA-MM-DD (recibido: ${values.since})`);
  }

  const claudeDirs = values['claude-dir'] || claudeProjectDirs(env);
  const codexDirs = values['codex-dir'] || codexSessionDirs(env);
  const claude = parseClaude(claudeDirs);
  const codex = parseCodex(codexDirs);
  const git = values.repo ? readRepos(values.repo, { since: values.since }) : null;

  const data = buildData({ claude, codex, git, since: values.since || null, sources: { claude: claudeDirs, codex: codexDirs } });
  const html = renderHtml(data);
  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  fs.writeFileSync(values.out, html);
  if (values.json) fs.writeFileSync(values.json, JSON.stringify(data, null, 2));

  const S = summarize(data, null, null);
  const f = (n) => new Intl.NumberFormat('es-ES').format(n);
  log(`Panel generado: ${path.resolve(values.out)}`);
  for (const [tool, name] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
    const t = S.totals[tool];
    log(
      `  ${name.padEnd(12)} tokens ${f(t.tokens)} (sin caché ${f(t.tokensNoCache)}) · sesiones ${f(t.sessions)} · ` +
        `días ${f(t.activeDays)} · líneas +${f(t.added)}/-${f(t.removed)}` + (git ? ` · commits +${f(t.gitAdded)}/-${f(t.gitRemoved)}` : ''),
    );
  }
  if (!data.rows.length) log('  Aviso: no se encontraron logs. Se ha generado un panel vacío.');
  const bad = claude.stats.bad + codex.stats.bad;
  if (bad) log(`  Aviso: ${f(bad)} líneas de log no se entendieron (ver «Diagnóstico» en el panel).`);
  if (codex.stats.checks.mismatches.length) log(`  Aviso: ${codex.stats.checks.mismatches.length} sesiones de Codex no cuadran con su total acumulado.`);
  for (const e of git?.errors || []) log(`  Aviso: git en ${e.repo}: ${e.reason}`);
  return data;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}
