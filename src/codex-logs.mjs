// Parser de los logs de Codex CLI (~/.codex/sessions/**/rollout-*.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import { listFiles, isDir, readJsonl, homeDir, projectName, newStats, addBad, num } from './util.mjs';

/** Carpetas de sesiones de Codex. Respeta CODEX_HOME. */
export function codexSessionDirs(env = process.env) {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : path.join(homeDir(env), '.codex');
  return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
}

const realPath = (f) => {
  try {
    return fs.realpathSync(f);
  } catch {
    return path.resolve(f);
  }
};

/** Cuenta las líneas + y - de un parche en formato apply_patch. */
export function patchLines(patch) {
  let added = 0;
  let removed = 0;
  const start = patch.indexOf('*** Begin Patch');
  const end = patch.indexOf('*** End Patch', start);
  const body = patch.slice(start < 0 ? 0 : start, end < 0 ? undefined : end);
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('***')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', "'": "'", '`': '`', '\\': '\\' };

/**
 * Codex Desktop llama a apply_patch desde código JS (herramienta `exec`); ahí el parche
 * puede ir en una cadena con los saltos de línea escritos como `\n`.
 */
function unescapePatch(text) {
  for (let i = 0; i < 2 && !text.includes('\n') && text.includes('\\n'); i++) {
    text = text.replace(/\\([nrt"'`\\])/g, (_, c) => ESCAPES[c]);
  }
  return text;
}

/** Busca textos de parche (*** Begin Patch) dentro de cualquier valor. */
function findPatches(value, out = []) {
  if (typeof value === 'string') {
    if (/^\s*[[{]/.test(value)) {
      // `arguments` de un function_call llega como JSON en texto.
      try {
        return findPatches(JSON.parse(value), out);
      } catch {
        /* no era JSON: se trata como texto */
      }
    }
    // Un mismo texto puede traer el parche envuelto en un heredoc de shell.
    let from = 0;
    while (true) {
      const s = value.indexOf('*** Begin Patch', from);
      if (s < 0) break;
      const e = value.indexOf('*** End Patch', s);
      out.push(unescapePatch(value.slice(s, e < 0 ? undefined : e + '*** End Patch'.length)));
      if (e < 0) break;
      from = e + 1;
    }
  } else if (Array.isArray(value)) {
    for (const v of value) findPatches(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) findPatches(v, out);
  }
  return out;
}

function failedOutput(output) {
  if (typeof output !== 'string') return false;
  try {
    const o = JSON.parse(output);
    const code = o && o.metadata && o.metadata.exit_code;
    return typeof code === 'number' && code !== 0;
  } catch {
    return false;
  }
}

const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const sig = (u) => USAGE_KEYS.map((k) => num(u && u[k])).join(',');
const usageTotal = (u) => num(u.total_tokens) || num(u.input_tokens) + num(u.output_tokens);

/**
 * Pasa un last_token_usage de Codex a las categorías del panel. En Codex `input_tokens`
 * incluye la parte en caché y `output_tokens` el razonamiento; la suma siempre da total_tokens.
 */
export function normalizeCodexUsage(last) {
  const inp = num(last.input_tokens);
  const total = num(last.total_tokens);
  const out = num(last.output_tokens);
  const reasoning = num(last.reasoning_output_tokens);
  const cached = Math.min(num(last.cached_input_tokens), inp);
  let cacheWrite = num(last.cache_write_input_tokens);
  // cache_write puede venir dentro de input_tokens o aparte: lo decide total_tokens.
  const writeApart = cacheWrite > 0 && total > 0 && (inp + cacheWrite + out === total || inp + cacheWrite + out + reasoning === total);
  if (!writeApart) cacheWrite = Math.min(cacheWrite, inp - cached);
  const inputAll = inp + (writeApart ? cacheWrite : 0);
  let output = out;
  if (total > 0 && total >= inputAll) output = total - inputAll;
  else if (last.last_usage_includes_reasoning === false) output = out + reasoning;
  return { input: inputAll - cached - cacheWrite, cacheWrite, cacheRead: cached, output, reasoning };
}

const isRollout = (n) => n.startsWith('rollout-') && (n.endsWith('.jsonl') || n.endsWith('.jsonl.zst'));

/**
 * Lee todas las sesiones de Codex de `dirs` (también las comprimidas .jsonl.zst).
 * Devuelve { usage: [...], edits: [...], stats }.
 */
export function parseCodex(dirs) {
  const stats = {
    ...newStats(),
    duplicates: 0,
    failedEdits: 0,
    compressedFiles: 0,
    sessionsWithTokens: 0,
    filesWithoutTokens: 0,
    filesWithoutTokensSamples: [],
    legacyJsonFiles: 0,
    checks: { sessions: 0, ok: 0, mismatches: [] },
  };
  const usage = [];
  const edits = new Map(); // call_id -> registro
  const failedCalls = new Set();
  // Un token_count se identifica por su total acumulado y su último uso. Así se descartan las
  // copias (sesión archivada) y el evento que repite cada continuación al empezar un fichero nuevo.
  const seenTokenEvents = new Set();
  const sessionsWithTokens = new Set();
  const seenFiles = new Set();

  for (const dir of dirs) {
    if (!isDir(dir)) continue;
    stats.dirs.push(dir);
    for (const file of listFiles(dir, isRollout)) {
      const real = realPath(file);
      if (seenFiles.has(real)) continue;
      seenFiles.add(real);
      if (file.endsWith('.zst')) stats.compressedFiles++;
      parseFile(file);
    }
    // Versiones de 2025 anteriores al formato JSONL: no traen tokens, solo se cuentan para avisar.
    stats.legacyJsonFiles += listFiles(dir, (n) => n.startsWith('rollout-') && n.endsWith('.json')).length;
  }

  function parseFile(file) {
    const base = path.basename(file).replace(/\.zst$/, '').replace(/\.jsonl$/, '');
    const idFromName = (base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || [])[1];
    const st = { sessionId: idFromName || base, cwd: null, model: 'desconocido', prevTotal: null, sawTokens: false };
    const check = { events: 0, diff: 0, delta: 0 };
    const fileUsage = [];
    const fileEdits = [];
    stats.files++;

    stats.lines += readJsonl(
      file,
      (o, lineNo) => handleLine(o, lineNo),
      (info) => addBad(stats, info),
    );

    function handleLine(o, lineNo) {
      const p = o.payload;
      if (o.type === 'session_meta') {
        if (p && typeof p === 'object') {
          if (p.id) st.sessionId = p.id;
          if (p.cwd) st.cwd = p.cwd;
          if (p.model) st.model = p.model;
        }
        return;
      }
      if (o.type === 'turn_context') {
        if (p && typeof p === 'object') {
          if (p.cwd) st.cwd = p.cwd;
          if (p.model) st.model = p.model;
        }
        return;
      }
      if (o.type === 'event_msg') {
        if (!p || typeof p !== 'object') {
          addBad(stats, { file, line: lineNo, reason: 'event_msg sin payload' });
          return;
        }
        if (p.type === 'token_count') return tokenCount(o, p, lineNo);
        if (p.type === 'patch_apply_end' && p.success === false && p.call_id) failedCalls.add(p.call_id);
        return;
      }
      if (o.type === 'response_item') {
        if (!p || typeof p !== 'object') {
          addBad(stats, { file, line: lineNo, reason: 'response_item sin payload' });
          return;
        }
        if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.call_id && failedOutput(p.output)) {
          failedCalls.add(p.call_id);
          return;
        }
        if (p.type !== 'function_call' && p.type !== 'custom_tool_call' && p.type !== 'local_shell_call') return;
        const patches = findPatches(p.type === 'custom_tool_call' ? p.input : p.type === 'local_shell_call' ? p.action : p.arguments);
        if (!patches.length) return;
        let added = 0;
        let removed = 0;
        for (const patch of patches) {
          const d = patchLines(patch);
          added += d.added;
          removed += d.removed;
        }
        const ts = o.timestamp;
        if (!ts || Number.isNaN(Date.parse(ts))) {
          addBad(stats, { file, line: lineNo, reason: 'apply_patch sin timestamp válido' });
          return;
        }
        fileEdits.push({ id: p.call_id || p.id || `${file}:${lineNo}`, ts, model: st.model, project: projectName(st.cwd) || 'desconocido', kind: 'apply_patch', added, removed });
      }
    }

    function tokenCount(o, p, lineNo) {
      const info = p.info;
      if (!info) return; // solo trae límites de uso
      const ts = o.timestamp;
      if (!ts || Number.isNaN(Date.parse(ts))) {
        addBad(stats, { file, line: lineNo, reason: 'token_count sin timestamp válido' });
        return;
      }
      const total = info.total_token_usage;
      let last = info.last_token_usage;
      const prev = st.prevTotal;
      if (total && prev && sig(total) === sig(prev)) {
        stats.duplicates++; // Codex repite el mismo token_count; el total no ha cambiado
        return;
      }
      if (!last && total) {
        // Versiones antiguas: sin last_token_usage, se calcula la diferencia con el total anterior.
        const from = prev && usageTotal(total) >= usageTotal(prev) ? prev : {};
        last = {};
        for (const k of USAGE_KEYS) last[k] = Math.max(0, num(total[k]) - num(from[k]));
      }
      if (!last || typeof last !== 'object') {
        addBad(stats, { file, line: lineNo, reason: 'token_count sin uso reconocible' });
        return;
      }
      if (total) st.prevTotal = total;
      st.sawTokens = true;

      const key = total ? `${sig(total)}|${sig(last)}` : `${st.sessionId}|${ts}|${lineNo}`;
      if (seenTokenEvents.has(key)) {
        stats.duplicates++;
        return;
      }
      seenTokenEvents.add(key);

      // Comprobación: lo que sube el total acumulado debe coincidir con el último uso.
      if (total && prev && usageTotal(total) >= usageTotal(prev)) {
        const delta = usageTotal(total) - usageTotal(prev);
        check.events++;
        check.delta += delta;
        check.diff += usageTotal(last) - delta;
      }
      fileUsage.push({ ts, model: st.model, project: projectName(st.cwd) || 'desconocido', ...normalizeCodexUsage(last) });
    }

    const tagged = { tool: 'codex', sessionId: st.sessionId };
    for (const u of fileUsage) usage.push({ ...tagged, ...u });
    for (const e of fileEdits) if (!edits.has(e.id)) edits.set(e.id, { ...tagged, ...e });
    if (fileUsage.length) sessionsWithTokens.add(st.sessionId);
    if (!st.sawTokens) {
      stats.filesWithoutTokens++;
      if (stats.filesWithoutTokensSamples.length < 10) stats.filesWithoutTokensSamples.push(file);
    }
    if (check.events) {
      stats.checks.sessions++;
      if (Math.abs(check.diff) <= Math.max(1, check.delta * 0.005)) stats.checks.ok++;
      else if (stats.checks.mismatches.length < 50) {
        stats.checks.mismatches.push({ sessionId: st.sessionId, file, counted: check.delta + check.diff, expected: check.delta, diff: check.diff });
      }
    }
  }

  stats.sessionsWithTokens = sessionsWithTokens.size;
  const editList = [];
  for (const e of edits.values()) {
    if (failedCalls.has(e.id)) stats.failedEdits++;
    else editList.push(e);
  }
  return { usage, edits: editList, stats };
}
