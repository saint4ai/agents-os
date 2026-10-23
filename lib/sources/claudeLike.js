'use strict';

// Общая часть адаптеров Claude Code и GLM: у них одинаковая раскладка и формат транскриптов.
//   <корень>/<папка проекта>/<sessionId>.jsonl                          - сессия;
//   <корень>/<папка проекта>/<sessionId>/subagents/agent-<id>.jsonl     - субагент
//   (+ agent-<id>.meta.json: description, agentType, finished, toolUseId, model);
//   субагенты воркфлоу лежат глубже: subagents/workflows/<wf>/agent-<id>.jsonl.
// Провайдер определяется по ИСТОЧНИКУ (папке), а не по полю message.model:
// Z.ai подменяет имя модели в транскриптах GLM на claude-opus-….

const fs = require('fs');
const path = require('path');
const { parseRecord, blockText } = require('../parse');
const { parseAgentLaunches } = require('../shell');
const { current: currentProfiles } = require('../providers');
const { addUsage, commitUsage, pushCapped, pushLast, addFileEdit, countTool, CMDS_CAP, CHECKS_CAP, PROMPTS_CAP } = require('../acc');
const { classifyCommand, parseVerdict } = require('../checks');

const MAX_SUB_DEPTH = 3;
const MAX_META_BYTES = 64 * 1024;
const TOOL_AGENT = new Set(['Agent', 'Task']);
const TOOL_EDIT = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const SYSTEM_NAME = /^(system-reminder|command-[a-z-]+|local-command-[a-z-]+|pasted_content[\s\S]*)$/;
const SYSTEM_BLOCK_MAX = 1024 * 1024; // потолок длины служебного блока: длиннее режем только теги
const SYSTEM_TAG_MAX = 200; // потолок длины имени тега

// Без служебных блоков и тегов, переносы строк сохранены (нужны, чтобы взять первые строки задачи).
// Строго один проход по тегам (indexOf двигается только вперёд): регулярка с [\s\S]*? и обратной
// ссылкой на строке с десятками тысяч незакрытых <system-reminder> деградировала квадратично.
function cleanBlocks(s) {
  const text = String(s || '');
  let out = '';
  let from = 0;
  let pos = 0; // докуда просмотрели теги
  let openLt = -1; // открытый служебный блок (может быть только один)
  let openGt = -1;
  let openName = '';
  for (;;) {
    const lt = text.indexOf('<', pos);
    if (lt === -1) break;
    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) break; // закрывающих ">" больше нет
    const name = text.slice(lt + 1, gt);
    pos = gt + 1;
    if (openLt === -1) {
      if (name.length <= SYSTEM_TAG_MAX && SYSTEM_NAME.test(name)) {
        openLt = lt;
        openGt = gt;
        openName = name;
      }
    } else if (name === '/' + openName) {
      if (gt - openLt <= SYSTEM_BLOCK_MAX) {
        out += text.slice(from, openLt) + ' ';
        from = gt + 1;
      }
      openLt = -1;
    }
  }
  if (openLt !== -1) {
    // блок не закрылся (или гигантский): тег выкинет общая чистка тегов, содержимое остаётся
    out += text.slice(from, openLt) + ' ';
    from = openGt + 1;
  }
  out += text.slice(from);
  return out.replace(/<\/?[a-z_-]+[^>]*>/gi, ' ');
}

function cleanText(s) {
  return cleanBlocks(s).replace(/\s+/g, ' ').trim();
}

// Запрос пользователя: служебные записи, прерывания и сводки уплотнения запросами не считаются.
// Заголовок запроса это его первая непустая строка («ЦЕЛЬ: …» у ТЗ GLM), до 200 знаков.
// Разбираются только первые 8 КБ записи: заголовок и первый абзац живут там, а чистка длинной
// строки стоит линейно от её длины. Смещения (lastUserEnd, lastGoal.end) считаются от исходной
// строки записи и от размера разбора не зависят.
const PROMPT_HEAD_BYTES = 8 * 1024;

function notePrompt(acc, rec, raw, ts) {
  if (rec.isMeta || rec.isCompactSummary) return;
  const clean = cleanBlocks(String(raw || '').slice(0, PROMPT_HEAD_BYTES));
  const first = clean.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean);
  if (!first || /^\[Request interrupted/.test(first)) return;
  const title = first.slice(0, 200);
  const at = ts > 0 ? ts : 0;
  const goal = /^ЦЕЛЬ\s*:/i.test(title);
  if (!acc.firstUser) acc.firstUser = cleanText(String(raw || '').slice(0, PROMPT_HEAD_BYTES)).slice(0, 200) || null;
  acc.lastUser = title;
  acc.lastUserEnd = acc.indexedBytes; // индексатор выставляет его до разбора записи, поэтому это конец её строки
  if (goal) acc.lastGoal = { title, end: acc.indexedBytes, ts: at };
  acc.userCount++;
  pushLast(acc.prompts, { ts: at, title, goal }, PROMPTS_CAP);
}

async function statSafe(p) {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

function fileInfo(root, p, st, extra) {
  return Object.assign(
    { path: p, rel: path.relative(root, p).split(path.sep).join('/'), size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs },
    extra
  );
}

// Рекурсивный обход subagents/ с ограничением глубины: только agent-*.jsonl.
async function walkSubagents(dir, depth, out) {
  let ents;
  try {
    ents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < MAX_SUB_DEPTH) await walkSubagents(p, depth + 1, out);
    else if (e.isFile() && /^agent-.+\.jsonl$/.test(e.name)) out.push(p);
  }
}

// Разбор одной записи транскрипта в индекс (acc). Вызывается на каждую строку потоком.
function scanRecord(rec, acc) {
  if (!rec || typeof rec !== 'object') return;
  const type = rec.type;
  if (type === 'ai-title') {
    if (typeof rec.aiTitle === 'string' && rec.aiTitle) acc.title = rec.aiTitle;
    return;
  }
  if (type !== 'user' && type !== 'assistant' && type !== 'system' && type !== 'result') return;

  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  if (ts > 0) {
    if (!acc.firstTs || ts < acc.firstTs) acc.firstTs = ts;
    if (ts > acc.lastTs) acc.lastTs = ts;
  }
  if (typeof rec.cwd === 'string' && rec.cwd) {
    if (!acc.cwd) acc.cwd = rec.cwd;
    acc.curCwd = rec.cwd;
  }

  if (type === 'result') {
    acc.lastErr = rec.is_error === true;
    return;
  }
  const msg = rec.message;
  if (!msg || typeof msg !== 'object') return;

  if (type === 'assistant') {
    addUsage(acc, msg);
    acc.lastErr = false;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && b.type === 'tool_use') scanToolUse(b, acc, ts);
      }
    }
  } else if (type === 'user') {
    const c = msg.content;
    if (typeof c === 'string') {
      acc.lastErr = false;
      notePrompt(acc, rec, c, ts);
    } else if (Array.isArray(c)) {
      let text = null;
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_result') {
          acc.lastErr = b.is_error === true;
          resolveCheck(acc, b, ts);
        } else if (b.type === 'text') {
          acc.lastErr = false;
          text = (text == null ? '' : text + '\n') + (b.text || '');
        }
      }
      if (text != null) notePrompt(acc, rec, text, ts);
    }
  }
}

// Результат проверки: из текста вывода берётся только короткий вердикт, сам текст не хранится.
function resolveCheck(acc, b, ts) {
  if (!b.tool_use_id || !acc.pendingChecks.length) return;
  const i = acc.pendingChecks.findIndex((p) => p.id === b.tool_use_id);
  if (i === -1) return;
  const p = acc.pendingChecks.splice(i, 1)[0];
  const v = parseVerdict(p.kind, blockText(b.content), b.is_error === true);
  pushLast(acc.checks, { cmd: p.cmd, kind: v.kind, ok: v.ok, summary: v.summary, ts }, CHECKS_CAP);
}

function scanToolUse(b, acc, ts) {
  const input = b.input && typeof b.input === 'object' ? b.input : {};
  countTool(acc, b.name);
  const profiles = currentProfiles();
  if (isAgentLaunchTool(b.name)) {
    if (b.name === 'Bash' && typeof input.command === 'string') {
      for (const l of parseAgentLaunches(input.command, profiles, acc.curCwd || acc.cwd)) {
        pushCapped(acc.launches, { toolUseId: b.id || null, ts, cwd: l.cwd, resume: l.resume, cat: l.cat, check: l.check, profile: l.profile, mcp: false, cmd: input.command.slice(0, 300) });
      }
    } else {
      // вызов MCP-инструмента исполнителя: сессию ищем по cwd и времени, как запуск без --resume
      const profile = mcpProfile(b.name, profiles);
      pushCapped(acc.launches, { toolUseId: b.id || null, ts, cwd: acc.curCwd || acc.cwd, resume: null, cat: null, check: false, profile, mcp: true, cmd: b.name });
    }
  }
  if (TOOL_EDIT.has(b.name)) {
    const p = input.file_path || input.notebook_path;
    const writes = b.name === 'Write' ? 1 : 0;
    const edits = b.name === 'MultiEdit' ? (Array.isArray(input.edits) ? input.edits.length || 1 : 1) : b.name === 'Write' ? 0 : 1;
    addFileEdit(acc, p, edits, writes);
  } else if (b.name === 'Bash' && typeof input.command === 'string') {
    const c = classifyCommand(input.command);
    if (c.key || c.kind) {
      const cmd = (c.text || input.command.replace(/\s+/g, ' ').trim()).slice(0, 140);
      if (c.key) pushLast(acc.cmds, cmd, CMDS_CAP);
      if (c.kind && b.id) pushLast(acc.pendingChecks, { id: b.id, cmd, kind: c.kind }, CHECKS_CAP);
    }
  }
  if (TOOL_AGENT.has(b.name)) {
    pushCapped(acc.agents, {
      id: b.id || null,
      description: String(input.description || '').slice(0, 300),
      subagentType: input.subagent_type || null,
      model: input.model || null,
      ts,
    });
  } else if (b.name === 'SendMessage') {
    pushCapped(acc.sends, { to: String(input.to || '').slice(0, 120), summary: String(input.summary || '').slice(0, 200), ts });
  }
}

// Вызов - это запуск исполнителя? Bash с командой запуска или MCP-инструмент из mcpTools профиля.
// Быстрый отсев по подстроке, как раньше с claude-glm: большинство команд не содержат ни одного бинаря.
const launchCache = { profiles: null, tools: null };
function launchIndex() {
  const profiles = currentProfiles();
  if (launchCache.profiles !== profiles) {
    const tools = [];
    for (const p of profiles) for (const t of p.mcpTools || []) tools.push({ profile: p.id, re: mcpToolRe(t) });
    launchCache.profiles = profiles;
    launchCache.tools = tools;
  }
  return launchCache;
}

function mcpToolRe(t) {
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^.]*');
  return new RegExp('^' + escaped + '$');
}

function isAgentLaunchTool(name) {
  if (name === 'Bash') return true; // решает parseAgentLaunches по содержимому команды
  const idx = launchIndex();
  if (!idx.tools.length || typeof name !== 'string') return false;
  if (!name.startsWith('mcp__')) return false;
  return idx.tools.some((t) => t.re.test(name));
}

function mcpProfile(name, profiles) {
  for (const p of profiles) for (const t of p.mcpTools || []) if (mcpToolRe(t).test(name)) return p.id;
  return null;
}

function createClaudeLike({ id, provider, label, root, dirIsProject = true, reportSupported = true, executor = id !== 'claude' }) {
  return {
    id,
    provider,
    label,
    root,
    dirIsProject,
    reportSupported,
    executor,
    scanRecord,
    parseRecord,

    async available() {
      const st = await statSafe(root);
      return !!(st && st.isDirectory());
    },

    // Папки проектов (одна папка = один каталог запуска Claude Code).
    async listDirs() {
      let ents;
      try {
        ents = await fs.promises.readdir(root, { withFileTypes: true });
      } catch {
        return [];
      }
      return ents.filter((e) => e.isDirectory()).map((e) => ({ dir: path.join(root, e.name), name: e.name }));
    },

    // Сессии папки: только <sessionId>.jsonl на верхнем уровне, без чтения содержимого.
    async listSessions(dir) {
      let ents;
      try {
        ents = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const out = [];
      for (const e of ents) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const p = path.join(dir, e.name);
        const st = await statSafe(p);
        if (st) out.push(fileInfo(root, p, st, { kind: 'session', sessionId: e.name.slice(0, -6) }));
      }
      return out;
    },

    // Субагенты одной сессии + meta.json каждого (описание задачи, тип, finished).
    async listSubagents(dir, sessionId) {
      const files = [];
      await walkSubagents(path.join(dir, sessionId, 'subagents'), 0, files);
      const out = [];
      for (const p of files) {
        const st = await statSafe(p);
        if (!st) continue;
        const agentId = path.basename(p, '.jsonl').replace(/^agent-/, '');
        const meta = await readMeta(p.replace(/\.jsonl$/, '.meta.json'));
        out.push(fileInfo(root, p, st, { kind: 'subagent', sessionId: agentId, parentSessionId: sessionId, meta }));
      }
      return out;
    },
  };
}

// meta.json маленький; всё равно читаем с потолком.
async function readMeta(p) {
  const st = await statSafe(p);
  if (!st || st.size > MAX_META_BYTES) return null;
  try {
    return JSON.parse(await fs.promises.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { createClaudeLike, scanRecord, cleanText, cleanBlocks, statSafe };
