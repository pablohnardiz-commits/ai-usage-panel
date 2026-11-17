// Parser de los logs de Claude Code (~/.claude/projects/**/*.jsonl).
import path from 'node:path';
import { listFiles, isDir, readJsonl, homeDir, projectName, diffEstimate, countLines, newStats, addBad, num } from './util.mjs';

/**
 * Carpetas `projects` de Claude Code. Respeta CLAUDE_CONFIG_DIR (admite varias
 * separadas por comas); si no está, mira ~/.config/claude y ~/.claude.
 */
export function claudeProjectDirs(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()) {
    return env.CLAUDE_CONFIG_DIR.split(',').map((d) => d.trim()).filter(Boolean).map((d) => path.join(d, 'projects'));
  }
  const home = homeDir(env);
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(xdg, 'claude', 'projects'), path.join(home, '.claude', 'projects')];
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/** Estimación de líneas de un uso de Write/Edit/MultiEdit. */
export function editLines(name, input) {
  if (!input || typeof input !== 'object') return null;
  if (name === 'Write') {
    if (typeof input.content !== 'string') return null;
    return { added: countLines(input.content), removed: 0 };
  }
  if (name === 'Edit') {
    if (typeof input.new_string !== 'string' && typeof input.old_string !== 'string') return null;
    return diffEstimate(input.old_string ?? '', input.new_string ?? '');
  }
  if (name === 'MultiEdit') {
    if (!Array.isArray(input.edits)) return null;
    let added = 0;
    let removed = 0;
    for (const e of input.edits) {
      if (!e || typeof e !== 'object') continue;
      const d = diffEstimate(e.old_string ?? '', e.new_string ?? '');
      added += d.added;
      removed += d.removed;
    }
    return { added, removed };
  }
  return null;
}

/**
 * Lee todos los logs de Claude Code de `dirs`.
 * Devuelve { usage: [...], edits: [...], stats }.
 */
export function parseClaude(dirs) {
  const stats = { ...newStats(), duplicates: 0, failedEdits: 0, syntheticSkipped: 0 };
  const usageByKey = new Map(); // message.id + requestId -> registro (el streaming repite el mensaje)
  const edits = new Map(); // tool_use.id -> registro
  const errorToolIds = new Set();
  const seenFiles = new Set();

  for (const dir of dirs) {
    if (!isDir(dir)) continue;
    stats.dirs.push(dir);
    for (const file of listFiles(dir, (n) => n.endsWith('.jsonl'))) {
      const real = path.resolve(file);
      if (seenFiles.has(real)) continue;
      seenFiles.add(real);
      stats.files++;
      const fallbackProject = projectName(path.basename(path.dirname(file)));
      stats.lines += readJsonl(
        file,
        (o, lineNo) => handleLine(o, lineNo, file, fallbackProject),
        (info) => addBad(stats, info),
      );
    }
  }

  function handleLine(o, lineNo, file, fallbackProject) {
    if (o.type === 'user') {
      const c = o.message && o.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b && b.type === 'tool_result' && b.is_error === true && b.tool_use_id) errorToolIds.add(b.tool_use_id);
        }
      }
      return;
    }
    if (o.type !== 'assistant') return;
    const m = o.message;
    if (!m || typeof m !== 'object') {
      addBad(stats, { file, line: lineNo, reason: 'línea assistant sin message' });
      return;
    }
    const model = typeof m.model === 'string' ? m.model : 'desconocido';
    if (model === '<synthetic>') {
      stats.syntheticSkipped++;
      return;
    }
    const ts = o.timestamp;
    if (!ts || Number.isNaN(Date.parse(ts))) {
      addBad(stats, { file, line: lineNo, reason: 'línea assistant sin timestamp válido' });
      return;
    }
    const base = {
      tool: 'claude',
      ts,
      sessionId: o.sessionId || path.basename(file, '.jsonl'),
      model,
      project: projectName(o.cwd) || fallbackProject || 'desconocido',
    };

    const u = m.usage;
    if (u && typeof u === 'object') {
      const rec = {
        ...base,
        input: num(u.input_tokens),
        cacheWrite: num(u.cache_creation_input_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        output: num(u.output_tokens),
        reasoning: 0,
      };
      const key = m.id && o.requestId ? `${m.id}:${o.requestId}` : m.id ? `${m.id}` : `uuid:${o.uuid || `${file}:${lineNo}`}`;
      const prev = usageByKey.get(key);
      if (prev) {
        stats.duplicates++;
        // Nos quedamos con el máximo de cada campo: las líneas parciales del streaming nunca superan a la final.
        for (const f of ['input', 'cacheWrite', 'cacheRead', 'output']) prev[f] = Math.max(prev[f], rec[f]);
      } else {
        usageByKey.set(key, rec);
      }
    }

    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue;
        const id = b.id || `${file}:${lineNo}:${b.name}`;
        if (edits.has(id)) continue;
        const lines = editLines(b.name, b.input);
        if (!lines) {
          addBad(stats, { file, line: lineNo, reason: `${b.name} sin entrada reconocible` });
          continue;
        }
        edits.set(id, { ...base, id, kind: b.name, ...lines });
      }
    }
  }

  const editList = [];
  for (const e of edits.values()) {
    if (errorToolIds.has(e.id)) stats.failedEdits++;
    else editList.push(e);
  }
  return { usage: [...usageByKey.values()], edits: editList, stats };
}
