import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attribute, readRepos } from '../src/git-lines.mjs';

test('atribución por autor y Co-Authored-By', () => {
  assert.deepEqual(attribute({ authorName: 'Ana', body: 'fix\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>' }), ['claude']);
  assert.deepEqual(attribute({ authorName: 'Codex', authorEmail: 'codex@openai.com' }), ['codex']);
  assert.deepEqual(attribute({ authorName: 'Ana', authorEmail: 'ana@x.com', body: 'Mención a claude en el texto' }), []);
});

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('lee líneas en commits de un repo', { skip: !hasGit() && 'git no disponible' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-git-'));
  const git = (args, env = {}) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
  const commit = (file, content, msg, name, date) => {
    fs.writeFileSync(path.join(dir, file), content);
    git(['add', file]);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg], {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@example.com`,
      GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: 'c@example.com',
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
    });
  };
  git(['init', '-q']);
  commit('a.txt', '1\n2\n3\n', 'uno\n\nCo-Authored-By: Claude <noreply@anthropic.com>', 'Ana', '2026-11-10T12:00:00Z');
  commit('b.txt', '1\n2\n', 'dos', 'Codex', '2026-11-11T12:00:00Z');
  commit('c.txt', '1\n', 'tres', 'Ana', '2026-11-12T12:00:00Z');
  const r = readRepos([dir, path.join(dir, 'no-existe')]);
  assert.equal(r.commits.length, 3);
  assert.equal(r.errors.length, 1);
  const by = Object.fromEntries(r.commits.map((c) => [c.tools.join(',') || 'otro', c]));
  assert.equal(by.claude.added, 3);
  assert.equal(by.codex.added, 2);
  assert.equal(by.otro.added, 1);
  assert.equal(readRepos([dir], { since: '2026-11-11' }).commits.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
