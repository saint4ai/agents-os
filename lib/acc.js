'use strict';

// Накопитель индекса одного транскрипта (acc). Его заполняет адаптер построчно, пока файл читается потоком.
// Весь acc маленький: счётчики и короткие списки запусков, текст сообщений в нём не хранится.

const CAP = 5000; // потолок длины списков запусков, чтобы acc не рос без границ
// Потолки «как выполнял»: acc остаётся в пределах нескольких КБ, сколько бы правок ни было в файле.
const FILES_CAP = 60; // путей с правками
const CMDS_CAP = 30; // ключевых команд (при переполнении остаются последние)
const CHECKS_CAP = 30; // итогов проверок и ждущих результата вызовов
const TOOLS_CAP = 40; // разных имён инструментов в счётчике
const PROMPTS_CAP = 12; // заголовков последних запросов пользователя (сессию GLM продолжают через --resume)

function newAcc(file) {
  return {
    path: file.path,
    size: 0,
    mtimeMs: 0,
    indexedBytes: 0, // докуда прочитано (по границе полных строк)
    records: 0,
    skippedLong: 0,
    cwd: null, // первая рабочая папка = проект
    curCwd: null, // рабочая папка последней записи (нужна для относительных cd)
    firstTs: 0,
    lastTs: 0,
    title: null, // ai-title
    firstUser: null,
    lastUser: null, // первая строка последнего запроса пользователя
    lastUserEnd: 0, // байтовое смещение конца строки с этим запросом: по нему отчёт читает его целиком одной строкой
    lastGoal: null, // последний запрос «ЦЕЛЬ: …» (первый пункт шаблона ТЗ для GLM): { title, end, ts }. Это задача сессии GLM, приёмки её не перекрывают
    userCount: 0, // сколько запросов пользователя было в сессии
    prompts: [], // последние PROMPTS_CAP запросов: { ts, title, goal }
    models: {}, // имя модели → число ответов
    in: 0, // input_tokens
    out: 0, // output_tokens
    cache: 0, // кэш чтения и записи (в «токены» карточки не входит)
    pend: null, // usage последнего ответа ещё может дописываться
    lastErr: false,
    agents: [], // вызовы Agent/Task
    sends: [], // вызовы SendMessage
    launches: [], // запуски исполнителей: Bash из профилей (lib/providers.js) и MCP-инструменты
    files: {}, // путь → { edits, writes }: правки файлов (не больше FILES_CAP путей)
    filesN: 0, // сколько путей в files (Object.keys на каждую правку давал бы лишний мусор для GC)
    filesOver: false, // путей было больше, чем влезло
    toolKinds: 0, // сколько разных имён в toolCounts
    cmds: [], // ключевые команды: проверки, сборки, git, make, npm, claude-glm
    toolCounts: {}, // имя инструмента → сколько раз вызван
    pendingChecks: [], // вызовы проверок, результата которых ещё не было: { id, cmd, kind }
    checks: [], // итоги проверок: { cmd, kind, ok, summary, ts }; текст вывода не хранится
  };
}

// Одно сообщение ассистента пишется в транскрипт несколькими строками (по блокам) с одним message.id,
// usage в них нарастает: считать надо последнее значение на id, иначе токены задваиваются.
function addUsage(acc, msg) {
  const id = msg.id || null;
  const u = msg.usage;
  if (acc.pend && acc.pend.id !== id) commitUsage(acc);
  if (!acc.pend) acc.pend = { id, model: null, in: 0, out: 0, cache: 0 };
  if (msg.model && msg.model !== '<synthetic>') acc.pend.model = msg.model;
  if (u && typeof u === 'object') {
    acc.pend.in = u.input_tokens || 0;
    acc.pend.out = u.output_tokens || 0;
    acc.pend.cache = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
}

function commitUsage(acc) {
  const p = acc.pend;
  if (!p) return;
  acc.in += p.in;
  acc.out += p.out;
  acc.cache += p.cache;
  if (p.model) acc.models[p.model] = (acc.models[p.model] || 0) + 1;
  acc.pend = null;
}

// Итоговые токены с учётом ещё не закрытого сообщения.
function totals(acc) {
  const p = acc.pend;
  const models = Object.assign({}, acc.models);
  if (p && p.model) models[p.model] = (models[p.model] || 0) + 1;
  return { in: acc.in + (p ? p.in : 0), out: acc.out + (p ? p.out : 0), cache: acc.cache + (p ? p.cache : 0), models };
}

function pushCapped(list, item) {
  if (list.length < CAP) list.push(item);
}

// Короткий список с потолком: при переполнении уходит самое старое.
function pushLast(list, item, cap) {
  list.push(item);
  if (list.length > cap) list.shift();
}

function addFileEdit(acc, p, edits, writes) {
  if (typeof p !== 'string' || !p) return;
  let f = acc.files[p];
  if (!f) {
    if (acc.filesN >= FILES_CAP) {
      acc.filesOver = true;
      return;
    }
    acc.filesN++;
    f = acc.files[p] = { edits: 0, writes: 0 };
  }
  f.edits += edits;
  f.writes += writes;
}

function countTool(acc, name) {
  const k = typeof name === 'string' && name ? name.slice(0, 60) : '?';
  const n = acc.toolCounts[k];
  if (n === undefined) {
    if (acc.toolKinds >= TOOLS_CAP) {
      acc.toolCounts._other = (acc.toolCounts._other || 0) + 1;
      return;
    }
    acc.toolKinds++;
    acc.toolCounts[k] = 1;
    return;
  }
  acc.toolCounts[k] = n + 1;
}

module.exports = { newAcc, addUsage, commitUsage, totals, pushCapped, pushLast, addFileEdit, countTool, CAP, FILES_CAP, CMDS_CAP, CHECKS_CAP, TOOLS_CAP, PROMPTS_CAP };
