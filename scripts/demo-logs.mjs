#!/usr/bin/env node
// Genera logs sintéticos de Claude Code y Codex (60 días hasta hoy) para probar el panel.
// Uso: node scripts/demo-logs.mjs CARPETA
//      node bin/usage-panel.mjs --claude-dir CARPETA/claude/projects --codex-dir CARPETA/codex/sessions
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('Uso: node scripts/demo-logs.mjs CARPETA');
  process.exit(1);
}
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => Math.floor(a + rnd() * (b - a + 1));
const write = (p, lines) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};
const projects = ['tienda-web', 'api-pagos', 'app-movil', 'scripts-datos', 'blog'];
const lines = (n) => Array.from({ length: n }, (_, i) => `línea ${i}`).join('\n');
const today = new Date();
today.setHours(12, 0, 0, 0);

for (let back = 59; back >= 0; back--) {
  const day = new Date(today.getTime() - back * 86400000);
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  // Claude Code
  for (let s = 0; s < (weekend ? int(0, 1) : int(1, 3)); s++) {
    const project = pick(projects.slice(0, 4));
    const model = rnd() < 0.7 ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
    const sid = `demo-c-${back}-${s}`;
    const out = [];
    let t = day.getTime() + int(-3, 6) * 3600000;
    let ctx = int(8000, 20000);
    for (let m = 0; m < int(8, 40); m++) {
      t += int(20, 240) * 1000;
      const id = `msg_${sid}_${m}`;
      const usage = { input_tokens: int(2, 60), cache_creation_input_tokens: int(200, 4000), cache_read_input_tokens: ctx, output_tokens: int(80, 1800) };
      ctx += usage.cache_creation_input_tokens;
      const content = [];
      if (rnd() < 0.35) {
        const kind = pick(['Edit', 'Edit', 'Write', 'MultiEdit']);
        const input = kind === 'Write' ? { file_path: 'f', content: lines(int(10, 120)) }
          : kind === 'Edit' ? { file_path: 'f', old_string: lines(int(1, 12)), new_string: lines(int(2, 25)) }
          : { file_path: 'f', edits: [{ old_string: 'a', new_string: lines(int(2, 10)) }, { old_string: lines(4), new_string: '' }] };
        content.push({ type: 'tool_use', id: `toolu_${sid}_${m}`, name: kind, input });
      } else content.push({ type: 'text', text: '…' });
      const base = { type: 'assistant', requestId: `req_${sid}_${m}`, sessionId: sid, cwd: `/home/demo/${project}`, timestamp: new Date(t).toISOString() };
      out.push({ ...base, message: { id, role: 'assistant', model, content: [{ type: 'thinking', thinking: '' }], usage: { ...usage, output_tokens: Math.floor(usage.output_tokens / 3) } } });
      out.push({ ...base, message: { id, role: 'assistant', model, content, usage } });
    }
    write(path.join(root, 'claude', 'projects', `-home-demo-${project}`, `${sid}.jsonl`), out);
  }
  // Codex
  for (let s = 0; s < (weekend ? int(0, 1) : int(0, 2)); s++) {
    const project = pick(projects.slice(1));
    const model = rnd() < 0.6 ? 'gpt-5-codex' : 'gpt-5';
    const id = `0199${String(back).padStart(4, '0')}-0000-4000-8000-${String(s).padStart(12, '0')}`;
    let t = day.getTime() + int(-2, 7) * 3600000;
    const ts = () => new Date((t += int(15, 200) * 1000)).toISOString();
    const out = [
      { timestamp: ts(), type: 'session_meta', payload: { id, cwd: `/home/demo/${project}`, cli_version: '0.60.0' } },
      { timestamp: ts(), type: 'turn_context', payload: { cwd: `/home/demo/${project}`, model } },
    ];
    const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    for (let k = 0; k < int(4, 25); k++) {
      const inp = int(6000, 40000);
      const last = { input_tokens: inp, cached_input_tokens: Math.floor(inp * (0.4 + rnd() * 0.5)), output_tokens: int(200, 3000), reasoning_output_tokens: 0 };
      last.reasoning_output_tokens = Math.floor(last.output_tokens * 0.4);
      last.total_tokens = last.input_tokens + last.output_tokens;
      for (const key in total) total[key] += last[key];
      out.push({ timestamp: ts(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { ...total }, last_token_usage: last } } });
      if (rnd() < 0.4) {
        const add = Array.from({ length: int(3, 60) }, () => '+x').join('\n');
        const del = Array.from({ length: int(0, 15) }, () => '-y').join('\n');
        out.push({ timestamp: ts(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: `call_${id}_${k}`, input: `*** Begin Patch\n*** Update File: f\n@@\n${del}\n${add}\n*** End Patch` } });
      }
    }
    const d = new Date(t);
    const dir = path.join(root, 'codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    write(path.join(dir, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), out);
  }
}
console.log(`Logs de demo en ${path.resolve(root)}`);
