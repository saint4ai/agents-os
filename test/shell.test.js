'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseGlmLaunches } = require('../lib/shell');

const ID = '48f9b304-e91b-4f00-8da1-1c202f10a295';

test('простой запуск: cwd берётся из места вызова, текст ТЗ из $(cat …)', () => {
  const r = parseGlmLaunches('/usr/local/bin/claude-glm -p "$(cat /home/demo/tz-01.md)" --output-format json > /tmp/out.json 2>&1', '/work/alpha');
  assert.deepStrictEqual(r, [{ cwd: '/work/alpha', resume: null, cat: '/home/demo/tz-01.md', check: false }]);
});

test('cd в другой проект: цепочка mkdir && cd && claude-glm', () => {
  const r = parseGlmLaunches('mkdir -p /tmp/runs && cd /work/beta && claude-glm -p "$(cat /home/demo/tz.md)" --output-format stream-json', '/work/alpha');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].cwd, '/work/beta');
});

test('относительный cd считается от рабочей папки вызова', () => {
  const r = parseGlmLaunches('cd ../beta && claude-glm -p "x"', '/work/alpha');
  assert.strictEqual(r[0].cwd, '/work/beta');
});

test('--resume: id сессии берётся из команды (в любом порядке с -p)', () => {
  const a = parseGlmLaunches(`claude-glm -p --resume ${ID} "$(cat /home/demo/fix.md)"`, '/work/alpha');
  assert.strictEqual(a[0].resume, ID);
  const b = parseGlmLaunches(`cd /work/beta && claude-glm --resume ${ID} -p "x"`, '/work/alpha');
  assert.strictEqual(b[0].resume, ID);
  assert.strictEqual(b[0].cwd, '/work/beta');
});

test('--check - запуск (создаёт GLM-сессию), помечен check', () => {
  const r = parseGlmLaunches('cd /work/beta && /usr/local/bin/claude-glm --check 2>&1 | head -c 1500', '/work/alpha');
  assert.deepStrictEqual(r, [{ cwd: '/work/beta', resume: null, cat: null, check: true }]);
});

test('запуском НЕ считаются: --set-key, ls/cat самого скрипта, текст в heredoc, строка в кавычках', () => {
  const cwd = '/work/alpha';
  assert.deepStrictEqual(parseGlmLaunches('claude-glm --set-key', cwd), []);
  assert.deepStrictEqual(parseGlmLaunches('ls -la /usr/local/bin/claude-glm && cat /usr/local/bin/claude-glm | head -80', cwd), []);
  assert.deepStrictEqual(parseGlmLaunches('cat >> notes.md <<\'EOF\'\nзапуск: claude-glm -p "<ТЗ>" --output-format json\nEOF', cwd), []);
  assert.deepStrictEqual(parseGlmLaunches('echo "claude-glm -p x"', cwd), []);
  assert.deepStrictEqual(parseGlmLaunches('grep -rn claude-glm src/', cwd), []);
});

test('два запуска в одной команде (параллельно) дают две записи', () => {
  const r = parseGlmLaunches('cd /work/a && claude-glm -p "один" > a.out 2>&1 & cd /work/b && claude-glm -p "два" > b.out 2>&1', '/work/x');
  assert.deepStrictEqual(r.map((x) => x.cwd), ['/work/a', '/work/b']);
});

test('двоеточия, точки с запятой и && внутри кавычек не режут команду', () => {
  const r = parseGlmLaunches('cd /work/beta && claude-glm -p "сделай: а; потом б && в" --allowedTools "Bash(make build:*)"', '/work/alpha');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].cwd, '/work/beta');
});
