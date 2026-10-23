'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers/synth');
const { readHead, readTailText, readLines, readBackLines, readForward, MAX_LINE } = require('../lib/lines');

function withFile(content, fn) {
  const dir = tmpDir('agent-console-lines-');
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, content);
  return Promise.resolve(fn(f)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

test('readHead: только первые N байт', () =>
  withFile('a'.repeat(1000), async (f) => {
    assert.strictEqual((await readHead(f, 100)).length, 100);
    assert.strictEqual((await readHead(f, 5000)).length, 1000);
  }));

test('readLines: строки, смещения, кириллица на границе куска, неполный хвост не выдаётся', () => {
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, t: 'привет мир '.repeat(30) }));
  const body = lines.join('\n') + '\n{"недописано":';
  return withFile(body, async (f) => {
    const got = await collect(readLines(f, { highWaterMark: 1000 })); // мелкие куски: границы режут символы
    assert.strictEqual(got.length, 50);
    assert.deepStrictEqual(JSON.parse(got[49].text).i, 49);
    // смещения: end последней строки = позиция сразу после её \n
    assert.strictEqual(got[49].end, Buffer.byteLength(lines.join('\n') + '\n'));
    assert.strictEqual(got[1].offset, got[0].end);
    // чтение со смещения даёт то же продолжение
    const tail = await collect(readLines(f, { start: got[10].end }));
    assert.strictEqual(tail.length, 39);
  });
});

test('readLines: строка длиннее потолка пропускается, соседние целы, память не растёт', () => {
  const huge = JSON.stringify({ blob: 'я'.repeat(MAX_LINE) }); // ~2 МБ в байтах
  const body = '{"a":1}\n' + huge + '\n{"b":2}\n';
  return withFile(body, async (f) => {
    const got = await collect(readLines(f, { highWaterMark: 64 * 1024 }));
    assert.deepStrictEqual(got.map((x) => x.skipped), [false, true, false]);
    assert.strictEqual(got[1].text, null);
    assert.strictEqual(JSON.parse(got[2].text).b, 2);
  });
});

test('readBackLines: последние N полных строк, недописанный хвост игнорируется', () => {
  const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ i, t: 'x'.repeat(i % 7 === 0 ? 5000 : 20) }));
  return withFile(lines.join('\n') + '\n{"недописано":', async (f) => {
    const r = await readBackLines(f, null, 10);
    assert.strictEqual(r.lines.length, 10);
    assert.strictEqual(JSON.parse(r.lines[9].text).i, 99);
    assert.strictEqual(JSON.parse(r.lines[0].text).i, 90);
    assert.strictEqual(r.reachedStart, false);
    // догрузка левее: конец = начало первой строки предыдущего ответа
    const r2 = await readBackLines(f, r.startOffset, 10);
    assert.strictEqual(JSON.parse(r2.lines[9].text).i, 89);
    // целиком до начала
    const all = await readBackLines(f, null, 1000);
    assert.strictEqual(all.lines.length, 100);
    assert.strictEqual(all.reachedStart, true);
    assert.strictEqual(all.lines[0].offset, 0);
  });
});

test('readBackLines: строка длиннее потолка с конца пропускается и не раздувает память', () => {
  const huge = JSON.stringify({ blob: 'z'.repeat(3 * 1024 * 1024) });
  return withFile('{"a":1}\n{"b":2}\n' + huge + '\n{"c":3}\n', async (f) => {
    const r = await readBackLines(f, null, 10);
    assert.deepStrictEqual(r.lines.map((l) => Object.keys(JSON.parse(l.text))[0]), ['a', 'b', 'c']);
    assert.strictEqual(r.reachedStart, true);
  });
});

test('readForward: окно ограничено, смещение идёт по полным строкам, длинная строка пропускается', () => {
  const huge = JSON.stringify({ blob: 'q'.repeat(2 * 1024 * 1024) });
  return withFile('{"a":1}\n{"b":2}\n' + huge + '\n{"c":3}\n{"d":', async (f) => {
    const r1 = await readForward(f, 0, 100);
    assert.strictEqual(r1.data, '{"a":1}\n{"b":2}\n');
    assert.ok(r1.more);
    // окно (1 МБ) целиком внутри длинной строки: строка пропущена, offset за её \n
    let off = r1.offset;
    let seen = '';
    for (let i = 0; i < 10; i++) {
      const r = await readForward(f, off, 1024 * 1024);
      seen += r.data;
      off = r.offset;
      if (!r.more) break;
    }
    assert.strictEqual(seen.trim(), '{"c":3}');
    assert.strictEqual(fs.statSync(f).size - off, '{"d":'.length, 'недописанная строка осталась непрочитанной');
    const rot = await readForward(f, fs.statSync(f).size + 100, 100);
    assert.strictEqual(rot.truncated, true);
  });
});

test('readTailText: хвост без обрезанной первой строки', () =>
  withFile('{"a":1}\n{"b":2}\n{"c":3}\n', async (f) => {
    const all = await readTailText(f, 1000);
    assert.strictEqual(all, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const part = await readTailText(f, 12); // режет посередине второй строки
    assert.strictEqual(part, '{"c":3}\n');
  }));

test('readBackLines: skipped считает пропущенные длинные строки, maxBytes ограничивает просмотр с конца', () => {
  const huge = JSON.stringify({ blob: 'z'.repeat(3 * 1024 * 1024) });
  const pad = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, t: 'x'.repeat(2000) })).join('\n');
  return withFile(pad + '\n' + huge + '\n{"c":3}\n', async (f) => {
    const r = await readBackLines(f, null, 1000);
    assert.strictEqual(r.skipped, 1, 'одна строка длиннее потолка');
    assert.strictEqual(r.lines.length, 201);
    // бюджет 600 КБ: просмотрено не больше пары кусков по 256 КБ, до начала файла не дошли
    const short = await readBackLines(f, null, 1000, undefined, 600 * 1024);
    assert.strictEqual(short.reachedStart, false);
    assert.ok(short.lines.length < 201);
    assert.strictEqual(JSON.parse(short.lines[short.lines.length - 1].text).c, 3);
  });
});

test('readBackLines: без длинных строк skipped равен нулю', () =>
  withFile('{"a":1}\n{"b":2}\n', async (f) => {
    assert.strictEqual((await readBackLines(f, null, 10)).skipped, 0);
  }));
