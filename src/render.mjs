// Genera el HTML autónomo del panel con los datos incrustados.
import fs from 'node:fs';
import { summarize } from './aggregate.mjs';

const css = () => fs.readFileSync(new URL('./panel.css', import.meta.url), 'utf8');
const clientJs = () => fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => new Intl.NumberFormat('es-ES').format(n);

/** JSON seguro dentro de <script>. */
function jsonForScript(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

const WARN_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="var(--warning)"/><path d="M8 6v3.5M8 11.5v.5" stroke="#0b0b0b" stroke-width="1.6" stroke-linecap="round"/></svg>';

function banners(data) {
  const out = [];
  const d = data.diagnostics;
  if (!data.rows.length) {
    const dirs = [...(d.sources.claude || []), ...(d.sources.codex || [])];
    out.push(
      `<div class="banner" role="status">${WARN_ICON}<p><strong>No se encontraron datos de uso.</strong> ` +
        `Se buscaron logs en: ${dirs.map((p) => `<code>${esc(p)}</code>`).join(', ') || '—'}. ` +
        'Si usas otra carpeta, indica <code>CLAUDE_CONFIG_DIR</code>, <code>CODEX_HOME</code>, <code>--claude-dir</code> o <code>--codex-dir</code>.</p></div>',
    );
  }
  const bad = (d.claude?.bad || 0) + (d.codex?.bad || 0);
  if (bad) {
    out.push(
      `<div class="banner" role="status">${WARN_ICON}<p><strong>${fmt(bad)} líneas de log no se entendieron</strong> y no se han contado ` +
        '(los detalles están en «Diagnóstico», al final). El resto del panel sí se ha generado.</p></div>',
    );
  }
  if (d.git?.errors?.length) {
    out.push(
      `<div class="banner" role="status">${WARN_ICON}<p><strong>No se pudo leer git en:</strong> ` +
        d.git.errors.map((e) => `<code>${esc(e.repo)}</code> (${esc(e.reason)})`).join(', ') + '</p></div>',
    );
  }
  return out.join('\n');
}

function diagnostics(data) {
  const d = data.diagnostics;
  const block = (title, s, extra = '') => {
    if (!s) return '';
    const samples = s.badSamples.length
      ? `<pre>${esc(s.badSamples.map((b) => `${b.file}:${b.line} — ${b.reason}`).join('\n'))}</pre>`
      : '';
    return (
      `<h3>${title}</h3><ul>` +
      `<li>Carpetas leídas: ${s.dirs.length ? s.dirs.map((p) => `<code>${esc(p)}</code>`).join(', ') : 'ninguna encontrada'}</li>` +
      `<li>Ficheros: ${fmt(s.files)} · líneas: ${fmt(s.lines)}</li>` +
      `<li>Líneas no entendidas: ${fmt(s.bad)}</li>` +
      `<li>Duplicados descartados: ${fmt(s.duplicates || 0)}</li>` +
      `<li>Ediciones fallidas no contadas: ${fmt(s.failedEdits || 0)}</li>` +
      extra +
      `</ul>${samples}`
    );
  };
  const checks = d.codex?.checks;
  const codexExtra = checks
    ? `<li>Comprobación con el total acumulado: ${fmt(checks.ok)} de ${fmt(checks.sessions)} sesiones cuadran` +
      (checks.mismatches.length
        ? `; no cuadran: ${checks.mismatches
            .slice(0, 5)
            .map((m) => `<code>${esc(m.sessionId)}</code> (${m.diff > 0 ? '+' : ''}${fmt(m.diff)})`)
            .join(', ')}`
        : '') +
      '</li>'
    : '';
  const git = d.git
    ? `<h3>Git</h3><ul><li>Repos: ${d.git.repos.map((r) => `<code>${esc(r)}</code>`).join(', ')}</li><li>Commits leídos: ${fmt(d.git.commits)}</li></ul>`
    : '';
  return block('Claude Code', d.claude) + block('Codex', d.codex, codexExtra) + git;
}

export function renderHtml(data) {
  const generated = new Date(data.generatedAt).toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' });
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Uso Claude y Codex</title>
<style>
${css()}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <h1>Uso de Claude Code y Codex</h1>
      <p class="sub"><span id="range-text"></span> · generado el ${esc(generated)}</p>
    </div>
    <div class="controls">
      <div class="seg" role="group" aria-label="Rango de fechas">
        <button type="button" data-range="7">7 días</button>
        <button type="button" data-range="30">30 días</button>
        <button type="button" data-range="90">90 días</button>
        <button type="button" data-range="all">Todo</button>
      </div>
      <div class="seg" role="group" aria-label="Qué tokens contar">
        <button type="button" data-metric="total" title="Entrada + caché escrita + caché leída + salida">Con caché</button>
        <button type="button" data-metric="nocache" title="Entrada nueva + salida">Sin caché</button>
      </div>
      <button type="button" class="btn" id="theme">Tema</button>
    </div>
  </header>

  ${banners(data)}

  <section class="grid2" aria-label="Cifras por herramienta">
    <article class="card" id="card-claude"></article>
    <article class="card" id="card-codex"></article>
  </section>

  <section class="card full">
    <div class="card-head">
      <h2 id="tokens-title">Tokens por día</h2>
      <div class="legend"><span><i class="key claude"></i>Claude Code</span><span><i class="key codex"></i>Codex</span></div>
    </div>
    <div class="chart" id="chart-tokens" data-label="Tokens por día, Claude Code y Codex apilados"></div>
  </section>

  <section class="grid2">
    <div class="card">
      <div class="card-head">
        <h2>Líneas escritas por día <span class="muted">(estimación)</span></h2>
        <div class="legend"><span><i class="key claude"></i>Claude Code</span><span><i class="key codex"></i>Codex</span></div>
      </div>
      <div class="chart" id="chart-lines" data-label="Líneas añadidas por día, estimadas a partir de las ediciones"></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Reparto por modelo</h2></div>
      <div class="models" id="models"></div>
    </div>
  </section>

  <section class="card full">
    <div class="card-head"><h2>Proyectos con más uso</h2></div>
    <div class="table-wrap" id="projects"></div>
  </section>

  <section class="card full">
    <div class="card-head"><h2>Sesiones recientes</h2></div>
    <div class="table-wrap" id="sessions"></div>
  </section>

  <section class="card full note">
    <h3>Qué es medido y qué es estimado</h3>
    <ul>
      <li><strong>Medido:</strong> tokens, sesiones, días activos y modelos. Salen tal cual de los logs locales de cada herramienta (en Claude Code se quitan los duplicados del streaming; en Codex se suman los <code>token_count</code> y se cuadran con el total de cada sesión).</li>
      <li><strong>Medido, con atribución aproximada:</strong> líneas en commits. Las cuenta <code>git log --numstat</code>; el commit se atribuye a una herramienta por su autor o por la línea <code>Co-Authored-By</code>.</li>
      <li><strong>Estimado:</strong> líneas escritas. Se calculan a partir de cada Write, Edit y MultiEdit (Claude Code) y de cada <code>apply_patch</code> (Codex), no de un diff real: no ven cambios hechos desde la terminal, ediciones que luego se deshicieron ni el contenido anterior de un fichero sobrescrito.</li>
      <li><strong>Con caché / sin caché:</strong> Claude Code relee el contexto desde la caché en cada respuesta, así que su total con caché es mucho mayor. Para comparar trabajo nuevo entre las dos, usa «Sin caché».</li>
      <li>No se muestran costes en dólares: con suscripción no se paga por token.</li>
    </ul>
    <details>
      <summary>Diagnóstico</summary>
      ${diagnostics(data)}
    </details>
  </section>
</div>
<div class="tip" id="tip" role="tooltip"></div>
<script type="application/json" id="usage-data">${jsonForScript(data)}</script>
<script>
var summarize = ${summarize.toString()};
${clientJs()}
</script>
</body>
</html>
`;
}
