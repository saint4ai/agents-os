'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseLine, parseRecord, parseTranscript, blockText } = require('../lib/parse');

const FIXTURE = path.join(__dirname, 'fixtures', 'transcript.jsonl');

test('user-строка со строковым content → событие user', () => {
  const evs = parseLine('{"type":"user","timestamp":"2026-01-01T10:00:00.000Z","message":{"role":"user","content":"Привет"}}');
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].kind, 'user');
  assert.strictEqual(evs[0].role, 'user');
  assert.strictEqual(evs[0].text, 'Привет');
  assert.strictEqual(evs[0].ts, '2026-01-01T10:00:00.000Z');
  assert.strictEqual(evs[0].tool, null);
  assert.strictEqual(evs[0].isError, false);
});

test('thinking-блок → событие thinking', () => {
  const evs = parseLine('{"type":"assistant","timestamp":"t","message":{"role":"assistant","content":[{"type":"thinking","thinking":"думаю"}]}}');
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].kind, 'thinking');
  assert.strictEqual(evs[0].text, 'думаю');
});

test('text-блок → событие assistant', () => {
  const evs = parseLine('{"type":"assistant","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"**готово**"}]}}');
  assert.strictEqual(evs[0].kind, 'assistant');
  assert.strictEqual(evs[0].text, '**готово**');
});

test('tool_use → событие tool_call с именем и input', () => {
  const evs = parseLine('{"type":"assistant","timestamp":"t","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/a/b.txt"}}]}}');
  assert.strictEqual(evs[0].kind, 'tool_call');
  assert.strictEqual(evs[0].tool, 'Edit');
  assert.deepStrictEqual(evs[0].input, { file_path: '/a/b.txt' });
  assert.strictEqual(evs[0].resultFor, null);
});

test('tool_result со строковым content', () => {
  const evs = parseLine('{"type":"user","timestamp":"t","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"вывод"}]}}');
  assert.strictEqual(evs[0].kind, 'tool_result');
  assert.strictEqual(evs[0].resultFor, 't1');
  assert.strictEqual(evs[0].text, 'вывод');
  assert.strictEqual(evs[0].isError, false);
});

test('tool_result с массивом content и ошибкой', () => {
  const line = '{"type":"user","timestamp":"t","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":[{"type":"text","text":"упало"}]}]}}';
  const evs = parseLine(line);
  assert.strictEqual(evs[0].kind, 'tool_result');
  assert.strictEqual(evs[0].isError, true);
  assert.strictEqual(evs[0].text, 'упало');
});

test('запись с несколькими блоками даёт несколько событий', () => {
  const line = '{"type":"assistant","timestamp":"t","message":{"role":"assistant","content":[{"type":"thinking","thinking":"а"},{"type":"text","text":"б"}]}}';
  const evs = parseLine(line);
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs[0].kind, 'thinking');
  assert.strictEqual(evs[1].kind, 'assistant');
});

test('system-запись сохраняется', () => {
  const evs = parseLine('{"type":"system","timestamp":"t","content":"сжимание контекста"}');
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].kind, 'system');
  assert.strictEqual(evs[0].text, 'сжимание контекста');
});

test('прочие типы, пустые и битые строки пропускаются', () => {
  assert.deepStrictEqual(parseLine('{"type":"summary","summary":"x"}'), []);
  assert.deepStrictEqual(parseLine('   '), []);
  assert.deepStrictEqual(parseLine('не-json'), []);
  assert.deepStrictEqual(parseLine(''), []);
  assert.deepStrictEqual(parseLine(null), []);
});

test('fixture-транскрипт разбирается целиком в ожидаемую последовательность', () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const evs = parseTranscript(text);
  const kinds = evs.map((e) => e.kind);
  assert.deepStrictEqual(kinds, [
    'user', 'thinking', 'assistant', 'tool_call',
    'tool_result', 'tool_call', 'tool_result', 'system',
  ]);
  const errResult = evs.find((e) => e.kind === 'tool_result' && e.isError);
  assert.strictEqual(errResult.resultFor, 'toolu_02');
  assert.strictEqual(errResult.text, 'grep: нет такого файла');
  const call = evs.find((e) => e.kind === 'tool_call' && e.tool === 'Read');
  assert.strictEqual(call.input.file_path, '/tmp/demo/demo.txt');
});

test('parseRecord на мусоре не падает', () => {
  assert.deepStrictEqual(parseRecord(null), []);
  assert.deepStrictEqual(parseRecord('строка'), []);
  assert.deepStrictEqual(parseRecord({ type: 'user' }), []);
});

test('blockText собирает текст из массива блоков', () => {
  assert.strictEqual(blockText('строка'), 'строка');
  assert.strictEqual(blockText([{ type: 'text', text: 'а' }, { type: 'text', text: 'б' }]), 'а\nб');
  assert.strictEqual(blockText([{ type: 'tool_use', id: 'x' }]), '');
  assert.strictEqual(blockText(undefined), '');
});
