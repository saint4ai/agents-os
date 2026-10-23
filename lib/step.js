'use strict';

// Что агент делает прямо сейчас: по хвосту транскрипта (последние строки, файл целиком не читается).
// Даёт две вещи: метку последнего шага («правит Index.html») и признак «вызов без результата».
// Признак продлевает статус «в работе»: долгая команда (тесты, сборка, ожидание ответа) в файл не пишет.

const path = require('path');
const { readBackLines, MAX_LINE } = require('./lines');
const { parseLine } = require('./parse');
const { classifyCommand } = require('./checks');
const { parseAgentLaunches } = require('./shell');
const { current: currentProfiles } = require('./providers');

const TAIL_LINES = 30;
const TAIL_BYTES = 1024 * 1024;
const LABEL_MAX = 40; // метка короткая и без команд целиком
const LONG_WAIT_MS = 2 * 60 * 1000; // вызов без результата дольше: «ждёт команду: N мин»

function cut(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fileName(input) {
  const p = input && (input.file_path || input.notebook_path || input.path);
  return typeof p === 'string' && p ? path.basename(p) : '';
}

// Событие ленты → метка шага. Только слова и имя файла, команда целиком не показывается.
function stepLabel(ev) {
  if (!ev) return null;
  if (ev.kind === 'thinking') return 'думает';
  if (ev.kind === 'assistant') return 'пишет ответ';
  if (ev.kind === 'user') return 'читает запрос';
  if (ev.kind === 'tool_result') return 'разбирает результат';
  if (ev.kind !== 'tool_call') return null;
  const t = ev.tool || '';
  const input = ev.input || {};
  const name = fileName(input);
  let label;
  if (t === 'Edit' || t === 'MultiEdit' || t === 'NotebookEdit') label = 'правит ' + (name || 'файл');
  else if (t === 'Write') label = 'пишет ' + (name || 'файл');
  else if (t === 'Read') label = 'читает ' + (name || 'файл');
  else if (t === 'Grep' || t === 'Glob') label = 'ищет в коде';
  else if (t === 'Agent' || t === 'Task') label = 'запускает агента' + (input.description ? ': ' + input.description : '');
  else if (t === 'SendMessage') label = 'пишет агенту';
  else if (t === 'WebFetch' || t === 'WebSearch') label = 'ищет в сети';
  else if (t.startsWith('mcp__playwright') || t.startsWith('mcp__chrome')) label = 'проверяет в браузере';
  else if (t === 'TodoWrite') label = 'ведёт список задач';
  else if (t === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    const c = classifyCommand(cmd);
    const launch = parseAgentLaunches(cmd, currentProfiles(), null)[0];
    if (launch) label = launch.profile === 'glm' ? 'отдаёт задачу GLM' : 'отдаёт задачу: ' + (launch.profile || 'исполнителю');
    else if (c.kind === 'tests') label = 'запускает тесты';
    else if (c.kind === 'types') label = 'проверяет типы';
    else if (c.kind === 'build') label = 'собирает';
    else if (/^\s*(?:cd\s+\S+\s*&&\s*)?git\b/.test(cmd)) label = 'работает с git';
    else label = 'выполняет команду';
  } else label = 'использует инструмент';
  return cut(label, LABEL_MAX);
}

// Состояние по последним строкам файла: { pending, since, step }. pending: после последнего вызова
// инструмента ещё нет его результата (и агента не остановили); since: когда начался самый свежий
// из висящих вызовов; step: метка последнего события. Не зависит от «сейчас», поэтому кэшируется по mtime.
async function readTailState(filePath, parseRecord) {
  const back = await readBackLines(filePath, null, TAIL_LINES, MAX_LINE, TAIL_BYTES);
  const evs = [];
  for (const l of back.lines) for (const ev of parseLine(l.text, parseRecord)) evs.push(ev);
  const open = new Map();
  for (const ev of evs) {
    if (ev.kind === 'tool_call' && ev.id) open.set(ev.id, ev);
    else if (ev.kind === 'tool_result') open.delete(ev.resultFor);
    else if (ev.kind === 'user' && /^\s*\[Request interrupted/.test(ev.text)) open.clear(); // агента остановили
  }
  // слишком длинная строка рядом с концом: результат мог быть в ней, висящим вызов не считаем
  const pending = open.size > 0 && back.skipped === 0;
  // ждём ответа на самый свежий из висящих вызовов: старый вызов, у которого результат не записался, ожидание не продлевает
  const since = pending ? Math.max(...[...open.values()].map((e) => Date.parse(e.ts) || 0)) : null;
  return { pending, since: since || null, step: stepLabel(evs[evs.length - 1] || null) };
}

// Метка шага на момент nowMs: долгий вызов без результата превращается в «ждёт команду: N мин».
function stepNow(state, nowMs) {
  if (!state) return null;
  if (state.pending && state.since && nowMs - state.since >= LONG_WAIT_MS) return 'ждёт команду: ' + Math.floor((nowMs - state.since) / 60000) + ' мин';
  return state.step;
}

module.exports = { stepLabel, readTailState, stepNow, LONG_WAIT_MS };
