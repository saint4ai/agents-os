'use strict';

// Синтетические транскрипты для тестов. Всё выдумано: пути /work/..., имена и тексты не из реальных сессий.

const fs = require('fs');
const os = require('os');
const path = require('path');

let seq = 0;
const iso = (ms) => new Date(ms).toISOString();

function user(ms, text, extra) {
  return Object.assign({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, uuid: 'u' + ++seq, timestamp: iso(ms) }, extra);
}

function assistant(ms, blocks, extra) {
  const e = extra || {};
  return Object.assign(
    {
      type: 'assistant',
      message: {
        id: e.msgId || 'msg_' + ++seq,
        model: e.model || 'claude-opus-5-5',
        role: 'assistant',
        content: blocks,
        usage: { input_tokens: e.in != null ? e.in : 2, output_tokens: e.out != null ? e.out : 10, cache_read_input_tokens: e.cache || 0 },
      },
      uuid: 'a' + ++seq,
      timestamp: iso(ms),
    },
    e.rec
  );
}

const text = (t) => ({ type: 'text', text: t });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

function toolResult(ms, id, content, isError) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isError, content }] },
    uuid: 'r' + ++seq,
    timestamp: iso(ms),
  };
}

const line = (rec) => JSON.stringify(rec) + '\n';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'agent-console-test-'));
}

function writeJsonl(file, recs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map(line).join(''));
}

// Большой файл, записанный потоком (память не растёт): ~targetBytes того же формата, что у Claude Code.
// Есть длинные tool_result (до ~200 КБ), служебные записи по ~800 КБ (под потолком, разбираются)
// и несколько строк по ~6 МБ (длиннее потолка 1 МБ, читатель их пропускает).
// opts.tools: на каждый шаг ещё правка нового файла (Edit) и прогон тестов (Bash + результат): так индекс «как выполнял»
// получает десятки тысяч записей, которые должны уложиться в его потолки (R-07). Токены от этих записей нулевые.
async function writeBigTranscript(file, targetBytes, cwd, opts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ws = fs.createWriteStream(file);
  let written = 0;
  const w = async (s) => {
    written += Buffer.byteLength(s);
    if (!ws.write(s)) await new Promise((r) => ws.once('drain', r));
  };
  const base = Date.UTC(2026, 0, 10, 9, 0, 0);
  const filler = (n) => 'строка-заполнитель '.repeat(Math.ceil(n / 19)).slice(0, n);
  let i = 0;
  let longLines = 0;
  await w(line(user(base, 'Привет, это синтетическая сессия для проверки памяти', { cwd })));
  while (written < targetBytes) {
    const t = base + i * 1500;
    const mid = 'msg_big_' + i;
    // два блока одного ответа: usage нарастает, считаться должно последнее
    await w(line(assistant(t, [text('Ответ ' + i + ' ' + filler(300))], { msgId: mid, out: 5, cwd, rec: { cwd } })));
    await w(line(assistant(t + 1, [toolUse('tu_' + i, 'Bash', { command: 'echo ' + i })], { msgId: mid, out: 40 + (i % 7), cache: 1000, rec: { cwd } })));
    const size = i % 50 === 0 ? 200 * 1024 : 4 * 1024;
    await w(line(toolResult(t + 2, 'tu_' + i, filler(size), i % 97 === 0)));
    if (opts && opts.tools) {
      await w(line(assistant(t + 3, [toolUse('ed_' + i, 'Edit', { file_path: cwd + '/src/file-' + i + '.js', old_string: 'a', new_string: 'b' })], { msgId: 'msg_ed_' + i, in: 0, out: 0, rec: { cwd } })));
      await w(line(assistant(t + 4, [toolUse('vt_' + i, 'Bash', { command: 'npx vitest run 2>&1 | tail -5' })], { msgId: 'msg_vt_' + i, in: 0, out: 0, rec: { cwd } })));
      await w(line(toolResult(t + 5, 'vt_' + i, '      Tests  ' + (i % 5 ? '' : '2 failed | ') + (100 + i) + ' passed (' + (102 + i) + ')\n', false)));
    }
    if (i % 300 === 0) await w(line({ type: 'api-request-blob', blob: filler(400 * 1024) }));
    if (i % 2000 === 1999 && longLines < 4) {
      longLines++;
      await w(line({ type: 'api-request-blob', blob: filler(3 * 1024 * 1024) })); // кириллица: ~6 МБ
    }
    i++;
  }
  await w(line({ type: 'ai-title', aiTitle: 'Синтетическая большая сессия', sessionId: 'big' }));
  await new Promise((r) => ws.end(r));
  return { bytes: written, assistantMessages: i, longLines };
}

module.exports = { user, assistant, toolResult, toolUse, text, line, iso, tmpDir, writeJsonl, writeBigTranscript };
