'use strict';

// Windows: один проект это один ключ (буква диска и регистр не важны), а запуск исполнителя через
// `cd /c/Проекты/b && claude-glm …` из Git Bash находит GLM-сессию с cwd C:\Проекты\b.
// Правила путей берутся из платформы процесса, поэтому на macOS и Linux эти тесты пропускаются
// (правила Windows там проверены в paths.test.js и shell-windows.test.js).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { user, assistant, toolResult, toolUse, text, writeJsonl, tmpDir } = require('./helpers/synth');
const { loadAdapters } = require('../lib/sources');
const { Indexer } = require('../lib/indexer');
const { Registry, cwdMatch } = require('../lib/registry');

const SKIP = process.platform === 'win32' ? false : 'правила путей Windows включаются только на Windows';

function world() {
  const root = tmpDir('agents-os-win-');
  const t0 = Date.now() + 5 * 60 * 1000;
  const sec = (n) => t0 + n * 1000;
  const touch = (f, s) => fs.utimesSync(f, new Date(sec(s)), new Date(sec(s)));
  const env = {
    CLAUDE_PROJECTS_DIR: path.join(root, 'claude', 'projects'),
    GLM_PROJECTS_DIR: path.join(root, 'glm', 'projects'),
    CODEX_SESSIONS_DIR: path.join(root, 'no-codex'),
    AGENTS_OS_HOME: path.join(root, 'aos'),
    HOME: root,
  };
  return { root, env, sec, touch, now: sec(3 * 3600), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function makeRegistry(w) {
  const adapters = await loadAdapters(w.env);
  return new Registry(adapters, new Indexer(), { now: () => w.now });
}

test('один проект приходит одним ключом, даже если cwd записан с другой буквой диска, регистром и слэшами', { skip: SKIP }, async () => {
  const w = world();
  try {
    const dirs = [
      ['c--Проекты-x', 'c:\\Проекты\\x', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['C--ПРОЕКТЫ-x', 'C:/ПРОЕКТЫ/x/', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      ['C--Проекты-x-2', 'C:\\Проекты\\X', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    ];
    dirs.forEach(([dir, cwd, id], i) => {
      const f = path.join(w.env.CLAUDE_PROJECTS_DIR, dir, id + '.jsonl');
      writeJsonl(f, [user(w.sec(i), 'Задача ' + i, { cwd }), assistant(w.sec(i + 1), [text('Готово')], { rec: { cwd } })]);
      w.touch(f, i + 2);
    });
    const reg = await makeRegistry(w);
    const list = await reg.listProjects();
    assert.strictEqual(list.length, 1, 'три записи cwd это один проект: ' + JSON.stringify(list.map((p) => p.key)));
    assert.strictEqual(list[0].sessions, 3);
    assert.match(list[0].key, /^C:\\/, 'буква диска заглавная, разделители обратные');
    assert.ok(!list[0].key.includes('/'), 'в ключе нет прямых слэшей');
    // ключ из запроса может быть записан иначе: проект всё равно находится
    for (const k of ['c:\\проекты\\x', 'C:/Проекты/x', list[0].key]) assert.ok(await reg.projectView(k), 'проект найден по ключу ' + k);
    assert.strictEqual(await reg.projectView('C:\\Проекты\\другой'), null);
  } finally {
    w.cleanup();
  }
});

test('UNC-путь WSL остаётся собой и с регистром не склеивается', { skip: SKIP }, async () => {
  const w = world();
  try {
    const dirs = [
      ['wsl-1', '\\\\wsl.localhost\\Ubuntu\\home\\u\\Proj', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
      ['wsl-2', '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
    ];
    dirs.forEach(([dir, cwd, id], i) => {
      const f = path.join(w.env.CLAUDE_PROJECTS_DIR, dir, id + '.jsonl');
      writeJsonl(f, [user(w.sec(i), 'Задача', { cwd }), assistant(w.sec(i + 1), [text('Готово')], { rec: { cwd } })]);
      w.touch(f, i + 2);
    });
    const list = await (await makeRegistry(w)).listProjects();
    assert.deepStrictEqual(list.map((p) => p.key).sort(), ['\\\\wsl.localhost\\Ubuntu\\home\\u\\Proj', '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj']);
  } finally {
    w.cleanup();
  }
});

test('запуск `cd /c/Проекты/b && claude-glm` из Git Bash связан с GLM-сессией проекта C:\\Проекты\\b', { skip: SKIP }, async () => {
  const w = world();
  try {
    const S = '11111111-1111-4111-8111-111111111111';
    const G = '22222222-2222-4222-8222-222222222222';
    const sFile = path.join(w.env.CLAUDE_PROJECTS_DIR, 'C--Проекты-a', S + '.jsonl');
    writeJsonl(sFile, [
      user(w.sec(0), 'Запусти GLM в проекте b', { cwd: 'C:\\Проекты\\a' }),
      assistant(w.sec(10), [toolUse('tu_launch', 'Bash', { command: 'cd /c/Проекты/b && claude-glm -p "$(cat /c/Users/demo/tz.md)" --output-format json', run_in_background: true })], { rec: { cwd: 'C:\\Проекты\\a' } }),
      toolResult(w.sec(11), 'tu_launch', 'Command running in background', false),
    ]);
    w.touch(sFile, 60);
    const gFile = path.join(w.env.GLM_PROJECTS_DIR, 'c--проекты-b', G + '.jsonl');
    writeJsonl(gFile, [
      user(w.sec(11), 'ЦЕЛЬ: сделать страницу b', { cwd: 'c:\\проекты\\b' }),
      assistant(w.sec(15), [text('Делаю')], { model: 'claude-opus-5-5', out: 70, rec: { cwd: 'c:\\проекты\\b' } }),
    ]);
    w.touch(gFile, 25);

    const reg = await makeRegistry(w);
    const va = await reg.projectView('C:\\Проекты\\a', { wait: true });
    const g = va.nodes.find((n) => n.sessionId === G);
    assert.ok(g, 'GLM-сессия проекта b попала в граф проекта a');
    assert.strictEqual(g.external, true);
    assert.strictEqual(g.project.name, 'b');
    assert.strictEqual(g.launchedFrom.project.name, 'a');
    const links = await reg.crossLinks();
    assert.deepStrictEqual(links.map((l) => [l.fromName, l.toName, l.count]), [['a', 'b', 1]]);
  } finally {
    w.cleanup();
  }
});

test('cwdMatch на Windows: регистр, слэши, вложенность', { skip: SKIP }, () => {
  assert.ok(cwdMatch('C:\\Проекты\\x', 'c:/проекты/x/'));
  assert.ok(cwdMatch('C:\\Проекты\\x\\sub', 'C:\\Проекты\\x'));
  assert.ok(cwdMatch('C:\\Проекты\\x', 'C:\\Проекты\\x\\sub'));
  assert.ok(!cwdMatch('C:\\Проекты\\x', 'C:\\Проекты\\xy'), 'xy это не вложенная папка x');
  assert.ok(!cwdMatch('C:\\Проекты\\x', 'D:\\Проекты\\x'));
  assert.ok(!cwdMatch('\\\\wsl.localhost\\Ubuntu\\home\\u\\Proj', '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj'));
});
