// Líneas en commits de uno o varios repos git, atribuidas a Claude o a Codex.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { localDate } from './util.mjs';

const RS = '\x1e';
const US = '\x1f';

/**
 * Herramientas a las que se atribuye un commit, por el autor o por las líneas
 * Co-Authored-By del mensaje. Devuelve un array (puede tener las dos o ninguna).
 */
export function attribute({ authorName = '', authorEmail = '', body = '' }) {
  const coauthors = [...body.matchAll(/^\s*co-authored-by:\s*(.+)$/gim)].map((m) => m[1]);
  const who = [authorName, authorEmail, ...coauthors].join('\n');
  const tools = [];
  if (/\bclaude\b|anthropic/i.test(who)) tools.push('claude');
  if (/\bcodex\b|openai|chatgpt/i.test(who)) tools.push('codex');
  return tools;
}

/** Interpreta la salida de `git log --numstat` con el formato de `gitLog`. */
export function parseGitLog(text, repoName = '') {
  const commits = [];
  for (const rec of text.split(RS)) {
    if (!rec.trim()) continue;
    const parts = rec.split(US);
    if (parts.length < 6) continue;
    const [hash, date, authorName, authorEmail, body, numstat] = parts;
    let added = 0;
    let removed = 0;
    for (const line of numstat.split(/\r?\n/)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!m) continue;
      if (m[1] !== '-') added += Number(m[1]); // '-' = fichero binario
      if (m[2] !== '-') removed += Number(m[2]);
    }
    commits.push({
      repo: repoName,
      hash: hash.trim(),
      ts: date.trim(),
      date: localDate(date.trim()),
      tools: attribute({ authorName, authorEmail, body }),
      added,
      removed,
    });
  }
  return commits;
}

export function gitLog(repo, { since } = {}) {
  const args = ['-C', repo, 'log', '--all', '--no-merges', '--numstat', `--format=${RS}%H${US}%aI${US}%an${US}%ae${US}%B${US}`];
  if (since) args.push(`--since=${since}T00:00:00`);
  const text = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return parseGitLog(text, path.basename(path.resolve(repo)));
}

/** Lee los repos indicados. Los errores se devuelven, no se lanzan. */
export function readRepos(repos, opts = {}) {
  const commits = [];
  const errors = [];
  const seen = new Set();
  for (const repo of repos) {
    try {
      for (const c of gitLog(repo, opts)) {
        if (seen.has(c.hash)) continue;
        seen.add(c.hash);
        commits.push(c);
      }
    } catch (err) {
      const msg = String((err.stderr && err.stderr.toString()) || err.message).trim().split('\n')[0];
      errors.push({ repo, reason: err.code === 'ENOENT' ? 'git no está instalado' : msg });
    }
  }
  return { commits, errors, repos };
}
