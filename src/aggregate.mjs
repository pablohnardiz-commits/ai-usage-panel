// Agrega los eventos de cada fuente en filas por día, herramienta, modelo y proyecto.
import { localDate } from './util.mjs';

export const TOOLS = ['claude', 'codex'];

/**
 * Construye el objeto de datos que se incrusta en el panel y se exporta con --json.
 * `claude` y `codex` son la salida de los parsers; `git` la de readRepos (o null).
 */
export function buildData({ claude, codex, git = null, since = null, now = new Date(), sources = {} }) {
  const rows = new Map();
  const sessions = new Map();
  const keep = (date) => date && (!since || date >= since);

  const rowFor = (e, date) => {
    const key = [date, e.tool, e.model, e.project].join('\u0000');
    let r = rows.get(key);
    if (!r) {
      r = { date, tool: e.tool, model: e.model, project: e.project, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, requests: 0, added: 0, removed: 0, edits: 0 };
      rows.set(key, r);
    }
    return r;
  };
  const sessionFor = (e) => {
    const key = `${e.tool}:${e.sessionId}`;
    let s = sessions.get(key);
    if (!s) {
      s = { id: e.sessionId, tool: e.tool, project: e.project, start: e.ts, end: e.ts, models: [], tokens: 0, tokensNoCache: 0, added: 0, removed: 0, requests: 0 };
      sessions.set(key, s);
    }
    if (e.ts < s.start) s.start = e.ts;
    if (e.ts > s.end) s.end = e.ts;
    if (e.model && !s.models.includes(e.model)) s.models.push(e.model);
    return s;
  };

  for (const src of [claude, codex]) {
    if (!src) continue;
    for (const u of src.usage) {
      const date = localDate(u.ts);
      if (!keep(date)) continue;
      const r = rowFor(u, date);
      r.input += u.input;
      r.cacheWrite += u.cacheWrite;
      r.cacheRead += u.cacheRead;
      r.output += u.output;
      r.reasoning += u.reasoning;
      r.requests++;
      const s = sessionFor(u);
      s.tokens += u.input + u.cacheWrite + u.cacheRead + u.output;
      s.tokensNoCache += u.input + u.output;
      s.requests++;
    }
    for (const e of src.edits) {
      const date = localDate(e.ts);
      if (!keep(date)) continue;
      const r = rowFor(e, date);
      r.added += e.added;
      r.removed += e.removed;
      r.edits++;
      const s = sessionFor(e);
      s.added += e.added;
      s.removed += e.removed;
    }
  }

  const gitRows = new Map();
  if (git) {
    for (const c of git.commits) {
      if (!keep(c.date)) continue;
      for (const tool of c.tools.length ? c.tools : ['otro']) {
        const key = `${c.date}:${tool}`;
        let g = gitRows.get(key);
        if (!g) {
          g = { date: c.date, tool, added: 0, removed: 0, commits: 0 };
          gitRows.set(key, g);
        }
        g.added += c.added;
        g.removed += c.removed;
        g.commits++;
      }
    }
  }

  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return {
    version: 1,
    generatedAt: now.toISOString(),
    today: localDate(now.toISOString()),
    since,
    rows: [...rows.values()].sort(byDate),
    sessions: [...sessions.values()]
      .map((s) => ({ ...s, startDate: localDate(s.start), endDate: localDate(s.end) }))
      .sort((a, b) => (a.end < b.end ? 1 : -1)),
    git: git ? [...gitRows.values()].sort(byDate) : null,
    diagnostics: {
      claude: claude ? claude.stats : null,
      codex: codex ? codex.stats : null,
      git: git ? { repos: git.repos, commits: git.commits.length, errors: git.errors } : null,
      sources,
    },
  };
}

/**
 * Resume los datos entre `from` y `to` (AAAA-MM-DD, inclusive; null = sin límite).
 * Esta función se incrusta tal cual en el HTML, así que no puede usar nada de fuera.
 */
export function summarize(data, from, to) {
  const tools = ['claude', 'codex'];
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const blank = () => ({ tokens: 0, tokensNoCache: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, requests: 0, added: 0, removed: 0, edits: 0, sessions: 0, activeDays: 0, gitAdded: 0, gitRemoved: 0, commits: 0 });
  const totals = { claude: blank(), codex: blank() };
  const days = new Map();
  const models = new Map();
  const projects = new Map();
  const active = { claude: new Set(), codex: new Set() };

  for (const r of data.rows) {
    if (!inRange(r.date) || !totals[r.tool]) continue;
    const t = totals[r.tool];
    const tok = r.input + r.cacheWrite + r.cacheRead + r.output;
    const noCache = r.input + r.output;
    t.tokens += tok;
    t.tokensNoCache += noCache;
    for (const k of ['input', 'cacheWrite', 'cacheRead', 'output', 'reasoning', 'requests', 'added', 'removed', 'edits']) t[k] += r[k];
    active[r.tool].add(r.date);

    let d = days.get(r.date);
    if (!d) {
      d = { date: r.date };
      for (const tl of tools) d[tl] = { tokens: 0, tokensNoCache: 0, added: 0, removed: 0 };
      days.set(r.date, d);
    }
    d[r.tool].tokens += tok;
    d[r.tool].tokensNoCache += noCache;
    d[r.tool].added += r.added;
    d[r.tool].removed += r.removed;

    if (tok > 0) {
      const mk = `${r.tool}\u0000${r.model}`;
      let m = models.get(mk);
      if (!m) {
        m = { model: r.model, tool: r.tool, tokens: 0, tokensNoCache: 0 };
        models.set(mk, m);
      }
      m.tokens += tok;
      m.tokensNoCache += noCache;
    }

    let p = projects.get(r.project);
    if (!p) {
      p = { project: r.project, total: 0, totalNoCache: 0 };
      for (const tl of tools) p[tl] = { tokens: 0, tokensNoCache: 0, added: 0, removed: 0 };
      projects.set(r.project, p);
    }
    p[r.tool].tokens += tok;
    p[r.tool].tokensNoCache += noCache;
    p[r.tool].added += r.added;
    p[r.tool].removed += r.removed;
    p.total += tok;
    p.totalNoCache += noCache;
  }
  for (const tl of tools) totals[tl].activeDays = active[tl].size;

  const sessions = data.sessions.filter((s) => {
    return (!from || s.endDate >= from) && (!to || s.startDate <= to);
  });
  for (const s of sessions) if (totals[s.tool]) totals[s.tool].sessions++;

  if (data.git) {
    for (const g of data.git) {
      if (!inRange(g.date) || !totals[g.tool]) continue;
      totals[g.tool].gitAdded += g.added;
      totals[g.tool].gitRemoved += g.removed;
      totals[g.tool].commits += g.commits;
    }
  }

  return {
    totals,
    days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    projects: [...projects.values()].sort((a, b) => b.total - a.total),
    sessions,
  };
}
