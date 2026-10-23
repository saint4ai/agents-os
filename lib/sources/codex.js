'use strict';

// Источник: OpenAI Codex CLI (GPT). Сессии лежат в ~/.codex/sessions/ГГГГ/ММ/ДД/rollout-*.jsonl
// (CODEX_SESSIONS_DIR переопределяет). Адаптер включается, только если папка существует.
//
// Разбор написан по описанному формату rollout-файлов (строка = {timestamp, type, payload}):
//   session_meta          payload.cwd, payload.id
//   turn_context          payload.cwd, payload.model
//   response_item         payload.type: message | reasoning | function_call | function_call_output
//   event_msg             payload.type = token_count, payload.info.total_token_usage (нарастающий итог)
// Проверен на синтетическом файле. На живых данных Codex не проверялся: у автора папки ~/.codex нет.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { statSafe } = require('./claudeLike');

const SKIP_USER = /^\s*<(environment_context|user_instructions|user_action)/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Вывод функции приходит строкой JSON {"output": "...", "metadata": {"exit_code": 0}} или обычным текстом.
function readOutput(raw) {
  const o = typeof raw === 'string' ? parseJson(raw) : raw;
  if (o && typeof o === 'object' && 'output' in o) {
    const code = o.metadata && typeof o.metadata.exit_code === 'number' ? o.metadata.exit_code : 0;
    return { text: String(o.output), isError: code !== 0 };
  }
  return { text: typeof raw === 'string' ? raw : JSON.stringify(raw), isError: false };
}

function scanRecord(rec, acc) {
  if (!rec || typeof rec !== 'object') return;
  const p = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};
  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  if (ts > 0) {
    if (!acc.firstTs || ts < acc.firstTs) acc.firstTs = ts;
    if (ts > acc.lastTs) acc.lastTs = ts;
  }
  if (rec.type === 'session_meta' || rec.type === 'turn_context') {
    if (typeof p.cwd === 'string' && p.cwd && !acc.cwd) acc.cwd = p.cwd;
    if (rec.type === 'turn_context' && typeof p.model === 'string' && p.model) acc.models[p.model] = (acc.models[p.model] || 0) + 1;
  } else if (rec.type === 'response_item') {
    if (p.type === 'message' && p.role === 'user') {
      const t = textOf(p.content);
      if (!acc.firstUser && t && !SKIP_USER.test(t)) acc.firstUser = t.replace(/\s+/g, ' ').trim().slice(0, 200);
      acc.lastErr = false;
    } else if (p.type === 'message' && p.role === 'assistant') {
      acc.lastErr = false;
    } else if (p.type === 'function_call_output') {
      acc.lastErr = readOutput(p.output).isError;
    }
  } else if (rec.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.total_token_usage) {
    const u = p.info.total_token_usage;
    const cached = u.cached_input_tokens || 0;
    acc.in = Math.max(0, (u.input_tokens || 0) - cached);
    acc.out = u.output_tokens || 0;
    acc.cache = cached;
  }
}

// Запись rollout → события ленты (формат как у parseRecord Claude Code).
function parseRecord(rec) {
  if (!rec || typeof rec !== 'object' || rec.type !== 'response_item') return [];
  const p = rec.payload || {};
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : '';
  const mk = (kind, role, extra) => Object.assign({ ts, kind, role, text: '', tool: null, input: null, resultFor: null, isError: false, id: null }, extra);
  if (p.type === 'message') {
    const t = textOf(p.content);
    if (!t || (p.role === 'user' && SKIP_USER.test(t))) return [];
    return [mk(p.role === 'user' ? 'user' : 'assistant', p.role, { text: t })];
  }
  if (p.type === 'reasoning') {
    const t = Array.isArray(p.summary) ? p.summary.map((s) => (s && s.text) || '').filter(Boolean).join('\n') : '';
    return t ? [mk('thinking', 'assistant', { text: t })] : [];
  }
  if (p.type === 'function_call') {
    const args = typeof p.arguments === 'string' ? parseJson(p.arguments) : p.arguments;
    let input = args && typeof args === 'object' ? args : { arguments: String(p.arguments || '') };
    // shell: command = ["bash","-lc","ls"] → строкой, как Bash у Claude Code
    if (Array.isArray(input.command)) input = Object.assign({}, input, { command: input.command.join(' ') });
    return [mk('tool_call', 'assistant', { tool: p.name === 'shell' ? 'Bash' : p.name || '', input, id: p.call_id || null })];
  }
  if (p.type === 'function_call_output') {
    const o = readOutput(p.output);
    return [mk('tool_result', 'user', { resultFor: p.call_id || null, isError: o.isError, text: o.text })];
  }
  return [];
}

async function walk(dir, depth, out) {
  let ents;
  try {
    ents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = ents.filter((e) => e.isFile() && /^rollout-.*\.jsonl$/.test(e.name));
  if (files.length) out.push(dir);
  if (depth < 3) for (const e of ents) if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1, out);
}

function createCodex({ id = 'codex', provider = 'gpt', label = 'GPT (Codex)', root, dirIsProject = false, reportSupported = false, executor = true }) {
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

    async listDirs() {
      const dirs = [];
      await walk(root, 0, dirs);
      return dirs.map((d) => ({ dir: d, name: path.relative(root, d) }));
    },

    async listSessions(dir) {
      let ents;
      try {
        ents = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const out = [];
      for (const ent of ents) {
        if (!ent.isFile() || !/^rollout-.*\.jsonl$/.test(ent.name)) continue;
        const p = path.join(dir, ent.name);
        const st = await statSafe(p);
        if (!st) continue;
        out.push({
          path: p,
          rel: path.relative(root, p).split(path.sep).join('/'),
          size: st.size,
          mtimeMs: st.mtimeMs,
          birthtimeMs: st.birthtimeMs,
          kind: 'session',
          sessionId: ent.name.replace(/^rollout-/, '').slice(0, -6),
        });
      }
      return out;
    },

    async listSubagents() {
      return [];
    },
  };
}

// Прежний вид: единственный встроенный источник Codex.
function create(env) {
  const e = env || process.env;
  const root = path.resolve(e.CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions'));
  return createCodex({ root });
}

module.exports = { create, createCodex, scanRecord, parseRecord };
