'use strict';

// Адаптер Codex проверен на синтетическом файле в описанном формате rollout (на живых данных не проверялся).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { tmpDir, line, iso } = require('./helpers/synth');
const { loadAdapters } = require('../lib/sources');
const { Indexer } = require('../lib/indexer');
const { Registry } = require('../lib/registry');
const { parseRecord } = require('../lib/sources/codex');

function rollout(t0) {
  const ev = (ms, type, payload) => line({ timestamp: iso(ms), type, payload });
  return [
    ev(t0, 'session_meta', { id: 'sess-1', cwd: '/work/codex-demo', originator: 'codex_cli_rs' }),
    ev(t0 + 100, 'turn_context', { cwd: '/work/codex-demo', model: 'gpt-5-codex' }),
    ev(t0 + 200, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>служебное</environment_context>' }] }),
    ev(t0 + 300, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Почини тест в модуле demo' }] }),
    ev(t0 + 400, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }), call_id: 'call_1' }),
    ev(t0 + 500, 'response_item', { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ output: 'FAIL', metadata: { exit_code: 1 } }) }),
    ev(t0 + 600, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 1000, output_tokens: 240 } } }),
    ev(t0 + 700, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 2500, cached_input_tokens: 1800, output_tokens: 410 } } }),
  ].join('');
}

test('адаптер включается, только если папка существует', async () => {
  const root = tmpDir('agent-console-codex-');
  try {
    const none = await loadAdapters({ CLAUDE_PROJECTS_DIR: path.join(root, 'a'), GLM_PROJECTS_DIR: path.join(root, 'b'), CODEX_SESSIONS_DIR: path.join(root, 'c') });
    assert.deepStrictEqual(none, []);
    fs.mkdirSync(path.join(root, 'c'));
    const one = await loadAdapters({ CLAUDE_PROJECTS_DIR: path.join(root, 'a'), GLM_PROJECTS_DIR: path.join(root, 'b'), CODEX_SESSIONS_DIR: path.join(root, 'c') });
    assert.deepStrictEqual(one.map((a) => a.id), ['codex']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex: проект по cwd, группа GPT, токены нарастающим итогом, ошибка по exit_code', async () => {
  const root = tmpDir('agent-console-codex-');
  try {
    const t0 = Date.now() - 3 * 3600 * 1000;
    const dir = path.join(root, 'sessions', '2026', '10', '22');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-2026-10-22T10-00-00-sess-1.jsonl');
    fs.writeFileSync(file, rollout(t0));
    fs.utimesSync(file, new Date(t0 + 1000), new Date(t0 + 1000)); // файл давно не менялся
    const adapters = await loadAdapters({ CLAUDE_PROJECTS_DIR: path.join(root, 'a'), GLM_PROJECTS_DIR: path.join(root, 'b'), CODEX_SESSIONS_DIR: path.join(root, 'sessions') });
    const reg = new Registry(adapters, new Indexer());
    const list = await reg.listProjects();
    assert.deepStrictEqual(list.map((p) => [p.name, p.providers]), [['codex-demo', { gpt: 1 }]]);
    const v = await reg.projectView('/work/codex-demo', { wait: true });
    const n = v.nodes[0];
    assert.strictEqual(n.provider, 'gpt');
    assert.strictEqual(n.group.label, 'GPT');
    assert.strictEqual(n.model, 'gpt-5-codex');
    assert.strictEqual(n.title, 'Почини тест в модуле demo', 'служебный environment_context в заголовок не попал');
    assert.deepStrictEqual(n.tokens, { in: 700, out: 410, cache: 1800 }, 'берётся последний итог, а не сумма');
    assert.strictEqual(n.status, 'error', 'последний вывод функции с exit_code 1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex: записи ленты', () => {
  const rec = (type, payload) => ({ timestamp: '2026-10-22T10:00:00Z', type, payload });
  const call = parseRecord(rec('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }), call_id: 'c1' }))[0];
  assert.strictEqual(call.kind, 'tool_call');
  assert.strictEqual(call.tool, 'Bash');
  assert.strictEqual(call.input.command, 'bash -lc ls');
  const out = parseRecord(rec('response_item', { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }) }))[0];
  assert.deepStrictEqual([out.kind, out.resultFor, out.text, out.isError], ['tool_result', 'c1', 'ok', false]);
  assert.deepStrictEqual(parseRecord(rec('event_msg', { type: 'token_count' })), []);
  assert.deepStrictEqual(parseRecord(null), []);
});
