'use strict';

// Разбор команд с путями Windows: Git Bash, PowerShell, UNC. Правила путей задаются платформой
// ({ platform: 'win32' }), поэтому тесты проходят на любой ОС; к настоящей платформе привязан только ~/x.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { parseGlmLaunches, resolveCd, tokenize } = require('../lib/shell');

const WIN = { platform: 'win32' };
const winRun = (cmd, cwd) => parseGlmLaunches(cmd, cwd, WIN).map((x) => x.cwd);

test('Windows: cd /c/Проекты/x && claude-glm -p … это запуск с проектом C:\\Проекты\\x', () => {
  const r = parseGlmLaunches('cd /c/Проекты/x && claude-glm -p "$(cat /c/Users/demo/tz.md)" --output-format json', 'C:\\Проекты\\agents-os', WIN);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].cwd, 'C:\\Проекты\\x');
  assert.strictEqual(r[0].cat, '/c/Users/demo/tz.md');
});

test('Windows: все формы cd ведут в один и тот же проект C:\\Проекты\\x', () => {
  const start = 'C:\\Проекты\\agents-os';
  const forms = [
    'cd /c/Проекты/x',
    'cd /C/Проекты/x/',
    'cd C:/Проекты/x',
    'cd C:\\Проекты\\x',
    'cd c:\\Проекты\\x\\',
    'cd "C:\\Проекты\\x"',
    "cd 'C:\\Проекты\\x'",
    'cd "/c/Проекты/x"',
    'cd ..\\x',
    'cd ../x',
    'cd /d C:\\Проекты\\x',
    'cd -Path C:\\Проекты\\x',
    'Set-Location -LiteralPath "C:\\Проекты\\x"',
    'CD C:\\Проекты\\.\\x',
  ];
  for (const f of forms) assert.deepStrictEqual(winRun(f + ' && claude-glm -p "x"', start), ['C:\\Проекты\\x'], f);
});

test('Windows: путь с пробелом и кириллицей, экранированный пробел, PowerShell-цепочка через «;»', () => {
  assert.deepStrictEqual(winRun('cd "D:\\Мои проекты\\Клиент 1" && claude-glm -p "x"', 'C:\\a'), ['D:\\Мои проекты\\Клиент 1']);
  assert.deepStrictEqual(winRun('cd D:\\Мои\\ проекты\\Клиент && claude-glm -p "x"', 'C:\\a'), ['D:\\Мои проекты\\Клиент']);
  assert.deepStrictEqual(winRun('Set-Location "D:\\Проекты\\z"; claude-glm -p "x"', 'C:\\a'), ['D:\\Проекты\\z']);
  assert.deepStrictEqual(winRun('sl D:\\z; claude-glm --check', 'C:\\a'), ['D:\\z']);
});

test('Windows: относительный cd считается от рабочей папки по правилам Windows, слэши любые', () => {
  assert.deepStrictEqual(winRun('cd ..\\beta && claude-glm -p "x"', 'C:\\work\\alpha'), ['C:\\work\\beta']);
  assert.deepStrictEqual(winRun('cd beta && claude-glm -p "x"', 'C:\\work'), ['C:\\work\\beta']);
  assert.deepStrictEqual(winRun('cd a/b/../c && claude-glm -p "x"', 'c:/work'), ['C:\\work\\a\\c']);
  assert.deepStrictEqual(winRun('cd "\\tmp" && claude-glm -p "x"', 'D:\\work\\alpha'), ['D:\\tmp']);
  // два cd подряд: каждый считается от предыдущего
  assert.deepStrictEqual(winRun('cd C:\\work && cd beta && claude-glm -p "x"', 'D:\\q'), ['C:\\work\\beta']);
  // `cd -` папку не меняет
  assert.deepStrictEqual(winRun('cd C:\\work && cd - && claude-glm -p "x"', 'D:\\q'), ['C:\\work']);
});

test('Windows: ~/x и UNC-путь WSL', () => {
  if (process.platform === 'win32') {
    assert.deepStrictEqual(winRun('cd ~/x && claude-glm -p "x"', 'C:\\a'), [path.win32.join(path.win32.normalize(os.homedir()), 'x')]);
    assert.deepStrictEqual(winRun('cd ~\\x && claude-glm -p "x"', 'C:\\a'), [path.win32.join(path.win32.normalize(os.homedir()), 'x')]);
  }
  assert.deepStrictEqual(winRun('cd \\\\wsl.localhost\\Ubuntu\\home\\u\\proj && claude-glm -p "x"', 'C:\\a'), ['\\\\wsl.localhost\\Ubuntu\\home\\u\\proj']);
  assert.deepStrictEqual(winRun('cd "//wsl.localhost/Ubuntu/home/u/proj" && claude-glm -p "x"', 'C:\\a'), ['\\\\wsl.localhost\\Ubuntu\\home\\u\\proj']);
  assert.deepStrictEqual(winRun('cd .. && claude-glm -p "x"', '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj'), ['\\\\wsl.localhost\\Ubuntu\\home\\u']);
});

test('Windows: пути в стиле POSIX (WSL, тесты) остаются POSIX и считаются по правилам POSIX', () => {
  assert.deepStrictEqual(winRun('cd ../beta && claude-glm -p "x"', '/work/alpha'), ['/work/beta']);
  assert.deepStrictEqual(winRun('cd /work/beta && claude-glm -p "x"', '/home/u/alpha'), ['/work/beta']);
  assert.deepStrictEqual(winRun('cd /home/u/beta && claude-glm -p "x"', 'C:\\a'), ['/home/u/beta']);
});

test('macOS и Linux: /c/x это обычный POSIX-путь, поведение прежнее', () => {
  for (const platform of ['linux', 'darwin']) {
    const r = parseGlmLaunches('cd /c/Проекты/x && claude-glm -p "x"', '/work/alpha', { platform });
    assert.strictEqual(r[0].cwd, '/c/Проекты/x');
    const rel = parseGlmLaunches('cd ../beta && claude-glm -p "x"', '/work/alpha', { platform });
    assert.strictEqual(rel[0].cwd, '/work/beta');
  }
});

test('Windows: claude-glm по полному пути и с расширением распознаётся, кавычки с обратными слэшами не ломают ТЗ', () => {
  assert.strictEqual(winRun('C:\\Users\\demo\\.local\\bin\\claude-glm.cmd -p "x"', 'C:\\a').length, 1);
  assert.strictEqual(winRun('"C:/Users/demo/.local/bin/claude-glm" -p "x"', 'C:\\a').length, 1);
  const r = parseGlmLaunches('cd "C:\\Проекты\\x" && claude-glm -p "$(cat \\"C:\\tz.md\\")" --output-format json', 'C:\\a', WIN);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].cwd, 'C:\\Проекты\\x');
});

test('tokenize: пути Windows без кавычек и в двойных кавычках сохраняют обратные слэши', () => {
  assert.deepStrictEqual(tokenize('cd C:\\Проекты\\x'), ['cd', 'C:\\Проекты\\x']);
  assert.deepStrictEqual(tokenize('cd "C:\\Проекты\\x y"'), ['cd', 'C:\\Проекты\\x y']);
  assert.deepStrictEqual(tokenize("cd 'C:\\Program Files\\x'"), ['cd', 'C:\\Program Files\\x']);
  assert.deepStrictEqual(tokenize('cd \\\\srv\\share\\dir'), ['cd', '\\\\srv\\share\\dir']);
  // экранирование bash не пострадало
  assert.deepStrictEqual(tokenize('echo a\\ b "c\\"d" "e\\\\f"'), ['echo', 'a b', 'c"d', 'e\\f']);
});

test('resolveCd: правила платформ', () => {
  assert.strictEqual(resolveCd('/work/alpha', '../beta', 'linux'), '/work/beta');
  assert.strictEqual(resolveCd(null, '/work/beta', 'linux'), '/work/beta');
  assert.strictEqual(resolveCd(null, 'beta', 'linux'), null);
  assert.strictEqual(resolveCd(null, '/c/x', 'win32'), 'C:\\x');
  assert.strictEqual(resolveCd(null, 'beta', 'win32'), null);
});
