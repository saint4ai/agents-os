'use strict';

// Главная проверка безопасности по памяти: индекс файла 600 МБ не должен тянуть RSS выше 300 МБ.
// Файл создаётся во временной папке ОС потоком, индексируется в отдельном процессе с
// --max-old-space-size=384 (как в `npm start`), после замера удаляется.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tmpDir, writeBigTranscript, assistant, toolUse, line } = require('./helpers/synth');

const SIZE_MB = parseInt(process.env.MEM_TEST_MB || '600', 10);
const RSS_LIMIT_MB = 300;
const HEAP_GROWTH_KB = 1024; // новые поля индекса («как выполнял», проверки) не должны удерживать в куче больше этого
const RSS_NOISE_MB = 50; // страховка от разгона: пик RSS с новыми полями не выше пика без них больше чем на это (шум замера около 10 МБ)

function runIndexChild(file, flag) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=384', '--expose-gc', path.join(__dirname, 'helpers', 'rss-run.js'), file].concat(flag ? [flag] : []), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error('индексатор упал: ' + err))));
  });
}

test(`индекс синтетического файла ${SIZE_MB} МБ: RSS < ${RSS_LIMIT_MB} МБ, строки длиннее 1 МБ пропущены`, async () => {
  const dir = tmpDir('agent-console-mem-');
  const file = path.join(dir, 'projects', 'big', 'session.jsonl');
  try {
    const t0 = Date.now();
    const info = await writeBigTranscript(file, SIZE_MB * 1024 * 1024, '/work/big');
    const writeMs = Date.now() - t0;
    const size = fs.statSync(file).size;
    assert.ok(size >= SIZE_MB * 1024 * 1024, 'файл создан нужного размера');

    const res = await runIndexChild(file);
    console.log(`  файл ${Math.round(size / 1048576)} МБ (запись ${writeMs} мс); индекс: ${res.ms} мс, пиковый RSS ${res.rssPeakMb} МБ, записей ${res.records}, пропущено длинных ${res.skippedLong}`);

    assert.ok(res.rssPeakMb < RSS_LIMIT_MB, `RSS ${res.rssPeakMb} МБ должен быть меньше ${RSS_LIMIT_MB} МБ`);
    assert.strictEqual(res.indexedBytes, size, 'прочитан весь файл до конца');
    assert.strictEqual(res.skippedLong, info.longLines, 'строки длиннее 1 МБ пропущены, остальные разобраны');
    assert.strictEqual(res.cwd, '/work/big');
    assert.strictEqual(res.title, 'Синтетическая большая сессия');
    // токены: на каждый ответ берётся ПОСЛЕДНЕЕ usage (40 + i % 7), а не сумма блоков
    let expect = 0;
    for (let i = 0; i < info.assistantMessages; i++) expect += 40 + (i % 7);
    assert.strictEqual(res.out, expect, 'токены считаются по последнему usage на message.id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(dir), 'синтетический файл удалён');
  }
});

test('дочитывание по смещению: после дописи читаются только новые байты', async () => {
  const { Indexer } = require('../lib/indexer');
  const { create } = require('../lib/sources/claude');
  const { totals } = require('../lib/acc');
  const dir = tmpDir('agent-console-append-');
  const file = path.join(dir, 'p', 's.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const first = [1, 2, 3].map((i) => line(assistant(1000 + i, [toolUse('t' + i, 'Bash', { command: 'echo' })], { msgId: 'm' + i, out: 10, rec: { cwd: '/work/x' } }))).join('');
    fs.writeFileSync(file, first);
    const adapter = create({ CLAUDE_PROJECTS_DIR: dir });
    const idx = new Indexer();
    const stat1 = fs.statSync(file);
    const a1 = await idx.get(adapter, { path: file, size: stat1.size, mtimeMs: stat1.mtimeMs });
    assert.strictEqual(a1.records, 3);
    assert.strictEqual(a1.indexedBytes, stat1.size);

    // дописываем две полные строки и одну недописанную
    const more = [4, 5].map((i) => line(assistant(1000 + i, [toolUse('t' + i, 'Bash', { command: 'echo' })], { msgId: 'm' + i, out: 10, rec: { cwd: '/work/x' } }))).join('');
    const partial = '{"type":"assistant","message":{"id":"m6"';
    fs.appendFileSync(file, more + partial);
    const stat2 = fs.statSync(file);
    const a2 = await idx.get(adapter, { path: file, size: stat2.size, mtimeMs: stat2.mtimeMs });
    assert.strictEqual(a2, a1, 'тот же накопитель: дочитывание, а не пересборка');
    assert.strictEqual(a2.records, 5, 'добавлены ровно две новые записи');
    assert.strictEqual(a2.indexedBytes, stat1.size + Buffer.byteLength(more), 'смещение остановилось на границе полной строки');
    assert.strictEqual(totals(a2).out, 50);

    // недописанная строка дописалась
    fs.appendFileSync(file, ',"usage":{"output_tokens":99}}}\n');
    const stat3 = fs.statSync(file);
    const a3 = await idx.get(adapter, { path: file, size: stat3.size, mtimeMs: stat3.mtimeMs });
    assert.strictEqual(a3.records, 6);
    assert.strictEqual(totals(a3).out, 149);

    // файл стал короче (ротация): индекс строится заново
    fs.writeFileSync(file, first);
    const stat4 = fs.statSync(file);
    const a4 = await idx.get(adapter, { path: file, size: stat4.size, mtimeMs: stat4.mtimeMs + 1 });
    assert.notStrictEqual(a4, a3);
    assert.strictEqual(a4.records, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(`индекс файла ${SIZE_MB} МБ с десятками тысяч правок и прогонов тестов: новые поля укладываются в потолки, кучу не раздувают`, async () => {
  const dir = tmpDir('agent-console-mem-tools-');
  const file = path.join(dir, 'projects', 'big', 'session.jsonl');
  try {
    const info = await writeBigTranscript(file, SIZE_MB * 1024 * 1024, '/work/big', { tools: true });
    const size = fs.statSync(file).size;
    assert.ok(info.assistantMessages * 2 >= 50000 || SIZE_MB < 600, `записей Edit и Bash: ${info.assistantMessages * 2}, нужно не меньше 50 000`);

    // один и тот же файл дважды: без новых полей (записи Edit и Bash вычеркнуты до разбора) и как есть
    const base = await runIndexChild(file, '--no-extra');
    const res = await runIndexChild(file);
    const growth = res.rssPeakMb - base.rssPeakMb;
    const heapGrowth = res.heapKb - base.heapKb;
    console.log(`  файл ${Math.round(size / 1048576)} МБ; индекс: ${res.ms} мс, пиковый RSS ${res.rssPeakMb} МБ (без новых полей ${base.rssPeakMb} МБ, разница ${growth} МБ), куча после сборки мусора ${res.heapKb} КБ (без новых полей ${base.heapKb} КБ, разница ${heapGrowth} КБ), правок ${res.edits}, путей в индексе ${res.files}, команд ${res.cmds}, проверок ${res.checks}, новые поля ${res.extraBytes} байт`);

    assert.ok(res.rssPeakMb < RSS_LIMIT_MB, `RSS ${res.rssPeakMb} МБ должен быть меньше ${RSS_LIMIT_MB} МБ`);
    assert.strictEqual(res.indexedBytes, size, 'прочитан весь файл до конца');
    assert.strictEqual(res.edits, info.assistantMessages, 'счётчик правок считает все вызовы');
    assert.ok(res.files <= 60 && res.cmds <= 30 && res.checks <= 30, 'потолки индекса: 60 путей, 30 команд, 30 проверок');
    assert.ok(res.extraBytes < 20 * 1024, `новые поля индекса ${res.extraBytes} байт`);
    assert.ok(heapGrowth <= HEAP_GROWTH_KB, `новые поля удерживают в куче ${heapGrowth} КБ, допустимо ${HEAP_GROWTH_KB}`);
    assert.ok(growth <= RSS_NOISE_MB, `пик RSS с новыми полями выше на ${growth} МБ, допустимо ${RSS_NOISE_MB}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(dir), 'синтетический файл удалён');
  }
});
