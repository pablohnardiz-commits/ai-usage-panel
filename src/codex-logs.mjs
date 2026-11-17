// Parser de los logs de Codex CLI (~/.codex/sessions/**/rollout-*.jsonl).
import path from 'node:path';
import { listFiles, isDir, readJsonl, homeDir, projectName, newStats, addBad, num } from './util.mjs';

/** Carpetas de sesiones de Codex. Respeta CODEX_HOME. */
export function codexSessionDirs(env = process.env) {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : path.join(homeDir(env), '.codex');
  return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
}

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
      out.push(value.slice(s, e < 0 ? undefined : e + '*** End Patch'.length));
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

const sameUsage = (a, b) =>
  a && b && ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'].every((k) => num(a[k]) === num(b[k]));

const usageTotal = (u) => num(u.total_tokens) || num(u.input_tokens) + num(u.output_tokens);

/**
 * Lee todas las sesiones de Codex de `dirs`.
 * Devuelve { usage: [...], edits: [...], stats }.
 */
export function parseCodex(dirs) {
  const stats = { ...newStats(), duplicates: 0, failedEdits: 0, checks: { sessions: 0, ok: 0, mismatches: [] } };
  const usage = [];
  const edits = new Map(); // call_id -> registro
  const failedCalls = new Set();
  const seenSessions = new Set();

  for (const dir of dirs) {
    if (!isDir(dir)) continue;
    stats.dirs.push(dir);
    for (const file of listFiles(dir, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))) {
      parseFile(file);
    }
  }

  function parseFile(file) {
    const idFromName = (path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || [])[1];
    const st = {
      sessionId: idFromName || path.basename(file, '.jsonl'),
      cwd: null,
      model: 'desconocido',
      prevTotal: null,
      counted: 0, // suma de last_token_usage contados
      base: 0, // total acumulado de tramos anteriores (si el contador se reinicia)
      lastTotal: 0,
      hasTokens: false,
    };
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
      if (total && st.prevTotal && sameUsage(total, st.prevTotal)) {
        stats.duplicates++; // Codex repite el mismo token_count; el total no ha cambiado
        return;
      }
      if (total && st.prevTotal && usageTotal(total) < usageTotal(st.prevTotal)) {
        st.base += usageTotal(st.prevTotal); // el contador se reinició (sesión reanudada)
      }
      if (!last && total) {
        // Versiones antiguas: sin last_token_usage, se calcula la diferencia con el total anterior.
        const prev = st.prevTotal && usageTotal(total) >= usageTotal(st.prevTotal) ? st.prevTotal : {};
        last = {};
        for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) {
          last[k] = Math.max(0, num(total[k]) - num(prev[k]));
        }
      }
      if (!last || typeof last !== 'object') {
        addBad(stats, { file, line: lineNo, reason: 'token_count sin uso reconocible' });
        return;
      }
      if (total) {
        st.prevTotal = total;
        st.lastTotal = usageTotal(total);
      }
      st.hasTokens = true;
      const input = num(last.input_tokens);
      const cached = Math.min(num(last.cached_input_tokens), input);
      st.counted += usageTotal(last);
      fileUsage.push({
        ts,
        model: st.model,
        project: projectName(st.cwd) || 'desconocido',
        input: input - cached,
        cacheWrite: 0,
        cacheRead: cached,
        output: num(last.output_tokens), // incluye el razonamiento
        reasoning: num(last.reasoning_output_tokens),
      });
    }

    if (seenSessions.has(st.sessionId)) {
      // La misma sesión en sessions/ y archived_sessions/: se cuenta una vez.
      stats.duplicates += fileUsage.length;
      return;
    }
    seenSessions.add(st.sessionId);

    const base = { tool: 'codex', sessionId: st.sessionId };
    for (const u of fileUsage) usage.push({ ...base, ...u });
    for (const e of fileEdits) if (!edits.has(e.id)) edits.set(e.id, { ...base, ...e });

    if (st.hasTokens && st.prevTotal) {
      stats.checks.sessions++;
      const expected = st.base + st.lastTotal;
      const diff = st.counted - expected;
      if (Math.abs(diff) <= Math.max(1, expected * 0.005)) stats.checks.ok++;
      else if (stats.checks.mismatches.length < 50) {
        stats.checks.mismatches.push({ sessionId: st.sessionId, file, counted: st.counted, expected, diff });
      }
    }
  }

  const editList = [];
  for (const e of edits.values()) {
    if (failedCalls.has(e.id)) stats.failedEdits++;
    else editList.push(e);
  }
  return { usage, edits: editList, stats };
}
