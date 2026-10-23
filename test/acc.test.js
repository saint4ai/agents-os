'use strict';

// Индекс «как выполнял»: правки файлов, ключевые команды, счётчик инструментов, итоги проверок.
// Транскрипт выдуманный; индексируется тем же потоковым индексатором, что и настоящие файлы.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { user, assistant, toolResult, toolUse, text, writeJsonl, tmpDir } = require('./helpers/synth');
const { Indexer } = require('../lib/indexer');
const { create } = require('../lib/sources/claude');

async function indexRecords(recs) {
  const dir = tmpDir('agent-console-acc-');
  try {
    const file = path.join(dir, 'p', 's.jsonl');
    writeJsonl(file, recs);
    const st = fs.statSync(file);
    const adapter = create({ CLAUDE_PROJECTS_DIR: dir });
    return await new Indexer().get(adapter, { path: file, size: st.size, mtimeMs: st.mtimeMs });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);
const A = (n, blocks, rec) => assistant(T0 + n * 1000, blocks, { rec: Object.assign({ cwd: '/work/demo' }, rec) });
const R = (n, id, out, isError) => toolResult(T0 + n * 1000, id, out, isError);

test('правки файлов, ключевые команды и счётчик инструментов копятся в индексе', async () => {
  const acc = await indexRecords([
    user(T0, 'Поправь модуль', { cwd: '/work/demo' }),
    A(1, [toolUse('e1', 'Edit', { file_path: '/work/demo/lib/a.js', old_string: 'x', new_string: 'y' })]),
    A(2, [toolUse('e2', 'Edit', { file_path: '/work/demo/lib/a.js', old_string: 'y', new_string: 'z' })]),
    A(3, [toolUse('e3', 'Edit', { file_path: '/work/demo/lib/a.js', old_string: 'z', new_string: 'w' })]),
    A(4, [toolUse('m1', 'MultiEdit', { file_path: '/work/demo/lib/b.js', edits: [{}, {}, {}, {}] })]),
    A(5, [toolUse('w1', 'Write', { file_path: '/work/demo/lib/c.js', content: 'x' })]),
    A(6, [toolUse('n1', 'NotebookEdit', { notebook_path: '/work/demo/n.ipynb' })]),
    A(7, [toolUse('b1', 'Bash', { command: 'ls -la' })]),
    A(8, [toolUse('b2', 'Bash', { command: 'cat lib/a.js | grep x' })]),
    A(9, [toolUse('b3', 'Bash', { command: 'cd /work/demo && git commit -m "готово"' })]),
    A(10, [toolUse('g1', 'Agent', { description: 'Помощник', subagent_type: 'x' })]),
  ]);
  assert.deepStrictEqual(acc.files['/work/demo/lib/a.js'], { edits: 3, writes: 0 });
  assert.deepStrictEqual(acc.files['/work/demo/lib/b.js'], { edits: 4, writes: 0 }, 'MultiEdit считает число правок');
  assert.deepStrictEqual(acc.files['/work/demo/lib/c.js'], { edits: 0, writes: 1 });
  assert.deepStrictEqual(acc.files['/work/demo/n.ipynb'], { edits: 1, writes: 0 });
  assert.deepStrictEqual(acc.cmds, ['git commit -m "готово"'], 'ls и cat шумом не копятся, cd в начале срезан');
  assert.strictEqual(acc.toolCounts.Edit, 3);
  assert.strictEqual(acc.toolCounts.Bash, 3);
  assert.strictEqual(acc.toolCounts.Agent, 1);
  assert.strictEqual(acc.agents.length, 1, 'прежний разбор запусков помощников не сломан');
});

test('итоги проверок: красный прогон, затем зелёный; текст вывода в индекс не попадает', async () => {
  const noise = 'СЕКРЕТНЫЙ_ВЫВОД_СЕРВЕРА\n'.repeat(80);
  const acc = await indexRecords([
    user(T0, 'Прогони тесты', { cwd: '/work/demo' }),
    A(1, [toolUse('v1', 'Bash', { command: 'npx vitest run 2>&1 | tail -20' })]),
    R(2, 'v1', noise + ' Test Files  1 failed | 11 passed (12)\n      Tests  5 failed | 357 passed (362)\n', false),
    A(3, [toolUse('v2', 'Bash', { command: 'npx vitest run 2>&1 | tail -20' })]),
    R(4, 'v2', noise + '      Tests  362 passed (362)\n', false),
    A(5, [toolUse('t1', 'Bash', { command: 'npx tsc --noEmit' })]),
    R(6, 't1', '', false),
    A(7, [toolUse('d1', 'Bash', { command: 'git diff --stat' })]),
    R(8, 'd1', ' 3 files changed, 10 insertions(+), 2 deletions(-)\n', false),
    A(9, [toolUse('v3', 'Bash', { command: 'npm test' })]), // результата нет: агента прервали
  ]);
  assert.deepStrictEqual(acc.checks.map((c) => [c.kind, c.ok, c.summary]), [
    ['tests', false, '5 failed, 357 passed'],
    ['tests', true, '362 passed'],
    ['types', true, 'без ошибок'],
    ['diff', true, '3 файла, +10, -2'],
  ]);
  assert.deepStrictEqual(acc.pendingChecks.map((p) => p.id), ['v3'], 'вызов без результата ждёт в pendingChecks');
  assert.ok(!JSON.stringify(acc).includes('СЕКРЕТНЫЙ_ВЫВОД'), 'в acc лежат только вердикты');
});

test('потолки: 60 путей, 30 команд, 30 проверок, 40 имён инструментов; acc остаётся маленьким', async () => {
  const recs = [user(T0, 'Много работы', { cwd: '/work/demo' })];
  let n = 1;
  for (let i = 0; i < 1000; i++) recs.push(A(n++, [toolUse('e' + i, 'Edit', { file_path: `/work/demo/f${i}.js` })]));
  for (let i = 0; i < 100; i++) recs.push(A(n++, [toolUse('c' + i, 'Bash', { command: 'make deploy-' + i })]));
  for (let i = 0; i < 100; i++) {
    recs.push(A(n++, [toolUse('k' + i, 'Bash', { command: 'npm test' })]));
    recs.push(R(n++, 'k' + i, '      Tests  ' + i + ' passed (' + i + ')\n', false));
  }
  for (let i = 0; i < 100; i++) recs.push(A(n++, [toolUse('x' + i, 'mcp__tool_' + i, {})]));
  for (let i = 0; i < 50; i++) recs.push(A(n++, [toolUse('p' + i, 'Bash', { command: 'npm test' })])); // 50 без результата
  const acc = await indexRecords(recs);
  assert.strictEqual(Object.keys(acc.files).length, 60);
  assert.strictEqual(acc.filesOver, true);
  assert.strictEqual(acc.cmds.length, 30);
  assert.strictEqual(acc.cmds[29], 'npm test', 'при переполнении остаются последние');
  assert.strictEqual(acc.checks.length, 30);
  assert.strictEqual(acc.checks[29].summary, '99 passed');
  assert.ok(acc.pendingChecks.length <= 30);
  assert.ok(Object.keys(acc.toolCounts).length <= 41);
  assert.strictEqual(acc.toolCounts.Edit, 1000, 'счётчик инструментов считает все вызовы, даже сверх потолка путей');
  const size = JSON.stringify({ files: acc.files, cmds: acc.cmds, toolCounts: acc.toolCounts, pendingChecks: acc.pendingChecks, checks: acc.checks }).length;
  assert.ok(size < 20 * 1024, 'новые поля в сумме ' + size + ' байт');
});

test('текст в блоке text и ответы ассистента не ломают разбор', async () => {
  const acc = await indexRecords([user(T0, 'Привет', { cwd: '/work/demo' }), A(1, [text('Готово')])]);
  assert.deepStrictEqual(acc.files, {});
  assert.deepStrictEqual(acc.cmds, []);
});

test('запросы пользователя: счётчик, последний, список; служебное, прерывания и результаты инструментов не в счёт', async () => {
  const recs = [
    user(T0, 'ЦЕЛЬ: первая задача\n\nКОНТЕКСТ: файл a.js', { cwd: '/work/demo' }),
    user(T0 + 500, '<system-reminder>служебное</system-reminder>', { cwd: '/work/demo', isMeta: true }),
    A(1, [toolUse('b1', 'Bash', { command: 'ls' })]),
    R(2, 'b1', 'файлы', false),
    user(T0 + 3000, '[Request interrupted by user]', { cwd: '/work/demo' }),
    // запрос из нескольких текстовых блоков одной записью считается один раз
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Приёмка: принято.' }, { type: 'text', text: 'Теперь вторая часть.' }] }, timestamp: new Date(T0 + 4000).toISOString(), cwd: '/work/demo' },
    A(5, [text('Работаю')]),
    user(T0 + 6000, 'ЦЕЛЬ: третья задача\n\nКОНТЕКСТ: файл c.js', { cwd: '/work/demo' }),
  ];
  const acc = await indexRecords(recs);
  assert.strictEqual(acc.userCount, 3);
  assert.strictEqual(acc.lastUser, 'ЦЕЛЬ: третья задача', 'заголовок это первая строка запроса');
  assert.deepStrictEqual(acc.prompts.map((p) => p.title), ['ЦЕЛЬ: первая задача', 'Приёмка: принято.', 'ЦЕЛЬ: третья задача']);
  assert.ok(acc.firstUser.startsWith('ЦЕЛЬ: первая задача'), 'firstUser прежний: первый запрос');
  assert.ok(acc.lastUserEnd > 0);
});

test('запросов больше потолка: хранится 12 последних, счётчик и последний верны, lastUserEnd указывает на конец строки запроса', async () => {
  const recs = [];
  for (let i = 1; i <= 30; i++) recs.push(user(T0 + i * 1000, `ЦЕЛЬ: задача ${i}`, { cwd: '/work/demo' }), A(i * 2, [text('Готово: задача ' + i + ' сделана и проверена полностью.')]));
  const dir = tmpDir('agent-console-acc-');
  try {
    const file = path.join(dir, 'p', 's.jsonl');
    writeJsonl(file, recs);
    const st = fs.statSync(file);
    const acc = await new Indexer().get(create({ CLAUDE_PROJECTS_DIR: dir }), { path: file, size: st.size, mtimeMs: st.mtimeMs });
    assert.strictEqual(acc.userCount, 30);
    assert.strictEqual(acc.prompts.length, 12);
    assert.strictEqual(acc.prompts[0].title, 'ЦЕЛЬ: задача 19');
    assert.strictEqual(acc.lastUser, 'ЦЕЛЬ: задача 30');
    const { readBackLines } = require('../lib/lines');
    const back = await readBackLines(file, acc.lastUserEnd, 1);
    assert.ok(back.lines[0].text.includes('ЦЕЛЬ: задача 30'), 'по смещению читается строка последнего запроса');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('«ЦЕЛЬ:» запоминается отдельно: приёмка после неё последним запросом остаётся, но задачей сессии считается цель', async () => {
  const acc = await indexRecords([
    user(T0, 'ЦЕЛЬ: сделать A\n\nКОНТЕКСТ: файл a.js', { cwd: '/work/demo' }),
    A(1, [text('Готово: A сделана, тесты зелёные и проверены.')]),
    user(T0 + 5000, 'Приёмка: ПРИНЯТО.', { cwd: '/work/demo' }),
  ]);
  assert.strictEqual(acc.lastUser, 'Приёмка: ПРИНЯТО.');
  assert.deepStrictEqual([acc.lastGoal.title, acc.lastGoal.ts], ['ЦЕЛЬ: сделать A', T0]);
  assert.deepStrictEqual(acc.prompts.map((p) => p.goal), [true, false]);
  assert.ok(acc.lastGoal.end > 0 && acc.lastGoal.end < acc.lastUserEnd, 'конец строки цели раньше конца строки приёмки');
  const none = await indexRecords([user(T0, 'Просто вопрос', { cwd: '/work/demo' })]);
  assert.strictEqual(none.lastGoal, null);
});
