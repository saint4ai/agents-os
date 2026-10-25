'use strict';

// Правила путей по платформам. Windows задаётся параметром, поэтому тесты идут на любой ОС.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const {
  normPath, foldPath, isInside, relativeInside, gitBashToWin, isWinPath, nativeHome, expandTilde,
} = require('../lib/paths');

const W = 'win32';

test('normPath на macOS и Linux только срезает хвостовые «/» (поведение не менялось)', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.strictEqual(normPath('/work/alpha/', platform), '/work/alpha');
    assert.strictEqual(normPath('/work/alpha///', platform), '/work/alpha');
    assert.strictEqual(normPath('/', platform), '/');
    assert.strictEqual(normPath('C:\\Проекты\\x\\', platform), 'C:\\Проекты\\x\\', 'путь Windows на POSIX не трогается');
    assert.strictEqual(normPath(null, platform), null);
  }
});

test('normPath на Windows: заглавная буква диска, обратные слэши, без хвостового разделителя', () => {
  assert.strictEqual(normPath('c:\\Проекты\\x', W), 'C:\\Проекты\\x');
  assert.strictEqual(normPath('C:/Проекты/x/', W), 'C:\\Проекты\\x');
  assert.strictEqual(normPath('C:\\Проекты\\a\\..\\x\\.\\', W), 'C:\\Проекты\\x');
  assert.strictEqual(normPath('C:\\', W), 'C:\\');
  assert.strictEqual(normPath('d:', W), 'D:\\');
  assert.strictEqual(normPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\p\\', W), '\\\\wsl.localhost\\Ubuntu\\home\\u\\p');
  assert.strictEqual(normPath('//srv/share/dir/', W), '\\\\srv\\share\\dir');
  // POSIX-путь на Windows остаётся POSIX
  assert.strictEqual(normPath('/home/u/proj/', W), '/home/u/proj');
  assert.strictEqual(normPath('/work/alpha', W), '/work/alpha');
});

test('foldPath: на Windows один ключ для любого вида одной папки, UNC WSL и POSIX с регистром различаются', () => {
  const variants = ['C:\\Проекты\\x', 'c:\\проекты\\X', 'C:/Проекты/x/', 'c:/ПРОЕКТЫ/x'];
  assert.strictEqual(new Set(variants.map((v) => foldPath(v, W))).size, 1);
  assert.notStrictEqual(foldPath('C:\\Проекты\\x', W), foldPath('D:\\Проекты\\x', W));
  assert.notStrictEqual(foldPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\A', W), foldPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\a', W));
  assert.notStrictEqual(foldPath('/home/u/A', W), foldPath('/home/u/a', W));
  assert.strictEqual(foldPath('\\\\SRV\\Share\\X', W), foldPath('\\\\srv\\share\\x', W), 'обычный UNC без учёта регистра');
  // macOS и Linux: регистр различается
  assert.notStrictEqual(foldPath('/work/A', 'linux'), foldPath('/work/a', 'linux'));
});

test('isInside и relativeInside', () => {
  assert.ok(isInside('C:\\Проекты\\x\\src\\a.js', 'c:/проекты/x', W));
  assert.ok(isInside('C:\\Проекты\\x', 'C:\\Проекты\\x\\', W));
  assert.ok(!isInside('C:\\Проекты\\xy', 'C:\\Проекты\\x', W));
  assert.ok(isInside('C:\\Проекты\\x', 'C:\\', W), 'корень диска содержит всё на диске');
  assert.ok(!isInside('D:\\a', 'C:\\', W));
  assert.ok(isInside('/work/alpha/src', '/work/alpha', 'linux'));
  assert.ok(!isInside('/work/alphabet', '/work/alpha', 'linux'));
  assert.strictEqual(relativeInside('C:\\Проекты\\x\\src\\a.js', 'c:\\проекты\\x', W), 'src/a.js');
  assert.strictEqual(relativeInside('C:\\Проекты\\x', 'C:\\Проекты\\x', W), null, 'сам корень это не «внутри»');
  assert.strictEqual(relativeInside('/work/alpha/src/a.js', '/work/alpha', 'linux'), 'src/a.js');
  assert.strictEqual(relativeInside('/other/a.js', '/work/alpha', 'linux'), null);
});

test('gitBashToWin и isWinPath', () => {
  assert.strictEqual(gitBashToWin('/c/Проекты/x'), 'C:\\Проекты\\x');
  assert.strictEqual(gitBashToWin('/D/'), 'D:\\');
  assert.strictEqual(gitBashToWin('/c'), 'C:\\');
  assert.strictEqual(gitBashToWin('/work/alpha'), null, 'не однобуквенная папка - не диск');
  assert.strictEqual(gitBashToWin('/cx/dir'), null);
  assert.ok(isWinPath('C:\\x') && isWinPath('c:/x') && isWinPath('C:') && isWinPath('\\\\srv\\s') && isWinPath('//srv/s'));
  assert.ok(!isWinPath('/c/x') && !isWinPath('x/y') && !isWinPath('C:x'));
});

test('Windows: защищённые папки в домашней папке распознаются без учёта регистра, ~\\x и /c/… раскрываются', { skip: process.platform === 'win32' ? false : 'только Windows' }, () => {
  const path = require('node:path');
  const { isSensitiveHomePath, expandHome } = require('../lib/sources');
  const home = os.homedir();
  for (const d of ['.ssh', '.SSH', '.Claude', '.AWS']) assert.ok(isSensitiveHomePath(path.join(home, d, 'x.md'), home), d);
  assert.ok(!isSensitiveHomePath(path.join(home, 'notes', 'x.md'), home));
  assert.strictEqual(expandHome('~\\tz.md'), path.join(home, 'tz.md'));
  assert.strictEqual(expandHome('/c/Users/demo/tz.md'), 'C:\\Users\\demo\\tz.md');
});

test('nativeHome и expandTilde', () => {
  assert.strictEqual(nativeHome({ HOME: '/c/Users/demo' }, W), 'C:\\Users\\demo', 'HOME из Git Bash переводится в путь Windows');
  assert.strictEqual(nativeHome({ HOME: 'C:\\Users\\demo' }, W), 'C:\\Users\\demo');
  assert.strictEqual(nativeHome({ HOME: '/home/u' }, 'linux'), '/home/u');
  assert.strictEqual(nativeHome({}, 'linux'), os.homedir());
  assert.strictEqual(expandTilde('~/x', '/home/u', 'linux'), '/home/u/x');
  assert.strictEqual(expandTilde('~\\x', '/home/u', 'linux'), '~\\x', 'на POSIX ~\\ не раскрывается');
  assert.strictEqual(expandTilde('~\\x', 'C:\\Users\\u', W), 'C:\\Users\\u\\x');
  assert.strictEqual(expandTilde('~user/x', '/home/u', 'linux'), '~user/x');
});
