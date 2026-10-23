'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyCommand, parseVerdict } = require('../lib/checks');

const v = (kind, out, isError) => parseVerdict(kind, out, isError);

test('vitest: зелёный прогон', () => {
  const out = ' Test Files  12 passed (12)\n      Tests  362 passed (362)\n   Duration  4.1s\n';
  assert.deepStrictEqual(v('tests', out, false), { kind: 'tests', ok: true, summary: '362 passed' });
});

test('vitest: красный прогон «5 failed, 357 passed»', () => {
  const out = ' Test Files  1 failed | 11 passed (12)\n      Tests  5 failed | 357 passed (362)\n';
  assert.deepStrictEqual(v('tests', out, false), { kind: 'tests', ok: false, summary: '5 failed, 357 passed' });
});

test('vitest: цветной вывод (ANSI) читается так же', () => {
  const out = '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m2 failed\x1b[39m\x1b[22m\x1b[90m | \x1b[39m\x1b[1m\x1b[32m10 passed\x1b[39m\x1b[22m\x1b[90m (12)\x1b[39m\n';
  assert.strictEqual(v('tests', out, false).summary, '2 failed, 10 passed');
});

test('jest: «Tests: 1 failed, 4 passed, 5 total»', () => {
  assert.deepStrictEqual(v('tests', 'Tests:       1 failed, 4 passed, 5 total\n', false), { kind: 'tests', ok: false, summary: '1 failed, 4 passed' });
});

test('node --test: «# pass» и «# fail», в том числе в формате spec с ℹ', () => {
  assert.deepStrictEqual(v('tests', '# tests 56\n# pass 56\n# fail 0\n', false), { kind: 'tests', ok: true, summary: '56 passed' });
  assert.deepStrictEqual(v('tests', 'ℹ tests 56\nℹ pass 54\nℹ fail 2\n', false), { kind: 'tests', ok: false, summary: '2 failed, 54 passed' });
});

test('pytest: строка итога со временем', () => {
  assert.deepStrictEqual(v('tests', '=========== 5 failed, 357 passed in 3.2s ===========\n', false), { kind: 'tests', ok: false, summary: '5 failed, 357 passed' });
  assert.deepStrictEqual(v('tests', '362 passed in 1.20s\n', false), { kind: 'tests', ok: true, summary: '362 passed' });
  assert.strictEqual(v('tests', '== 1 failed, 3 passed, 2 errors in 0.5s ==', false).summary, '1 failed, 2 errors, 3 passed');
});

test('tsc: без ошибок (молчит) и с ошибками (строка «Found N errors» или счёт по строкам)', () => {
  assert.deepStrictEqual(v('types', '', false), { kind: 'types', ok: true, summary: 'без ошибок' });
  assert.deepStrictEqual(v('types', 'src/a.ts(1,1): error TS2304: x\nsrc/b.ts(2,2): error TS2322: y\nFound 2 errors in 2 files.\n', false), { kind: 'types', ok: false, summary: '2 ошибки типов' });
  assert.strictEqual(v('types', 'src/a.ts(1,1): error TS2304: Cannot find name', false).summary, '1 ошибка типов');
  assert.strictEqual(v('types', 'Found 5 errors.', false).summary, '5 ошибок типов');
});

test('сборка упала и сборка прошла', () => {
  assert.deepStrictEqual(v('build', 'dashboard.html: 3 скрипта, синтаксис верный\nOK\n', false), { kind: 'build', ok: true, summary: 'сборка прошла' });
  assert.deepStrictEqual(v('build', 'make: *** [build-dashboard] Error 1\n', false), { kind: 'build', ok: false, summary: 'сборка упала' });
  assert.strictEqual(v('build', 'npm ERR! code ELIFECYCLE\n', false).ok, false);
  assert.strictEqual(v('build', 'done, 0 errors\n', false).ok, true, 'слово «errors» в нормальном выводе не красит сборку');
  assert.strictEqual(v('build', 'тихий вывод', true).ok, false, 'красный is_error верен');
});

test('конвейер скрывает код возврата при is_error:false: красный текст остаётся красным', () => {
  const piped = ' Test Files  1 failed | 11 passed (12)\n      Tests  5 failed | 357 passed (362)\n';
  assert.strictEqual(v('tests', piped, false).ok, false, 'is_error:false, но в тексте 5 failed');
  // vitest упал до запуска тестов: строки «Tests» нет, но «Test Files  1 failed» есть
  const crash = 'ReferenceError: describe is not defined\n    at file:///x/a.test.js:3:1\n Test Files  1 failed (1)\n      Tests  no tests\n';
  assert.deepStrictEqual(v('tests', crash, false), { kind: 'tests', ok: false, summary: '1 файл тестов упал' });
});

test('вывод пропущен через grep: итога нет, красных догадок по слову Error не делаем (итог не определён)', () => {
  const filtered = 'FAIL  src/a.test.ts > отдаёт ошибку Error: expected 1 received 2\n{"level":"error","msg":"Error handling"}\n';
  assert.deepStrictEqual(v('tests', filtered, false), { kind: 'tests', ok: null, summary: 'итог не определён' });
  assert.strictEqual(v('tests', filtered, true).ok, false, 'красный is_error остаётся красным');
});

test('пустой вывод тестов: итог не определён, не зелёный', () => {
  assert.deepStrictEqual(v('tests', '', false), { kind: 'tests', ok: null, summary: 'итог не определён' });
  assert.deepStrictEqual(v('tests', '   \n', false), { kind: 'tests', ok: null, summary: 'итог не определён' });
  assert.strictEqual(v('tests', '', true).ok, false, 'красный is_error без текста: красный');
  assert.strictEqual(v('tests', 'Exit code 1\n', false).ok, false, '«Exit code 1» в начале вывода');
});

test('вывод длиннее 600 знаков: важен только хвост', () => {
  const noise = 'строка вывода сервера\n'.repeat(500);
  const out = 'Tests  1 failed | 9 passed (10)\n' + noise + ' Test Files  1 passed (1)\n      Tests  10 passed (10)\n';
  assert.ok(out.length > 600);
  assert.deepStrictEqual(v('tests', out, false), { kind: 'tests', ok: true, summary: '10 passed' }, 'старая красная строка далеко от конца не считается');
});

test('git diff --stat: файлы и строки', () => {
  const out = ' lib/a.js | 4 ++--\n 7 files changed, 338 insertions(+), 19 deletions(-)\n';
  assert.deepStrictEqual(v('diff', out, false), { kind: 'diff', ok: true, summary: '7 файлов, +338, -19' });
  assert.strictEqual(v('diff', ' 1 file changed, 2 insertions(+)\n', false).summary, '1 файл, +2, -0');
  assert.strictEqual(v('diff', '', false).summary, 'без изменений');
});

test('classifyCommand: ключевые команды и шум', () => {
  const k = (c) => { const { key, kind } = classifyCommand(c); return { key, kind }; };
  assert.deepStrictEqual(k('npx vitest run 2>&1 | tail -5'), { key: true, kind: 'tests' });
  assert.deepStrictEqual(k('cd /work/x && npm test'), { key: true, kind: 'tests' });
  assert.deepStrictEqual(k('npm run build'), { key: true, kind: 'build' });
  assert.deepStrictEqual(k('make build-dashboard'), { key: true, kind: 'build' });
  assert.deepStrictEqual(k('npx tsc --noEmit'), { key: true, kind: 'types' });
  assert.deepStrictEqual(k('node --test test/*.test.js'), { key: true, kind: 'tests' });
  assert.deepStrictEqual(k('python3 -m pytest -q'), { key: true, kind: 'tests' });
  assert.deepStrictEqual(k('git diff --stat | tail -1'), { key: true, kind: 'diff' });
  assert.deepStrictEqual(k('git commit -m "npm test"'), { key: true, kind: null }, 'текст в кавычках проверкой не считается');
  assert.deepStrictEqual(k('claude-glm -p "x"'), { key: true, kind: null });
  assert.deepStrictEqual(k('curl -s -X POST http://127.0.0.1:1/x'), { key: true, kind: null });
  assert.deepStrictEqual(k('npx tsc --noEmit && npx vitest run'), { key: true, kind: 'tests' }, 'у связки берётся последняя проверка');
  for (const noise of ['ls -la', 'cat a.txt | grep b', 'sed -n 1,5p a', 'head -3 a', 'pwd', 'echo "npm test"', 'git status', 'grep -r x .', '']) {
    assert.deepStrictEqual(k(noise), { key: false, kind: null }, noise);
  }
});

test('classifyCommand: text это нужная часть связки, а не вся строка', () => {
  assert.strictEqual(classifyCommand("cd /work/demo && sed -i '' 's/a/b/' x.js && npx vitest run 2>&1 | grep -v '^{' | tail -5").text, 'npx vitest run');
  assert.strictEqual(classifyCommand('md5 -q a > /tmp/h 2>/dev/null; git diff --stat | tail -1').text, 'git diff --stat');
  assert.strictEqual(classifyCommand('cd /work/demo && git commit -m "готово"').text, 'git commit -m "готово"');
});
