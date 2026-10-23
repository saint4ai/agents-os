'use strict';

// Профили провайдеров. Встроенные (claude, glm, codex) - значения по умолчанию;
// ~/.agents-os/providers.json (путь переопределяет AGENTS_OS_HOME) добавляет профили
// и переопределяет поля встроенных, но не удаляет их. Пустой или битый файл - работают
// встроенные, предупреждение в лог.
//
// Поля профиля:
//   id, label        - имя источника на карте;
//   kind             - «род» формата истории: claude-like | codex (по нему выбирается адаптер);
//   historyDir       - корень истории (может начинаться с ~);
//   dirIsProject     - папка внутри historyDir = один проект;
//   reportSupported  - строить ли отчёт агента (lib/report.js понимает формат Claude Code);
//   executor         - может быть исполнителем в связях «кто кого запустил» (у claude - нет);
//   baseUrl          - ANTHROPIC_BASE_URL для claude-like (обёртка tools/agent-run);
//   keychainService  - сервис ключа в Связке ключей (по умолчанию agents-os-<id>);
//   mcpKeyEnv        - переменная для ключа MCP-серверов (экспортируется только при --mcp-config);
//   run              - как распознать запуск в Bash: binaries, printFlags, resumeFlags, checkFlags;
//   mcpTools         - шаблоны имён MCP-инструментов, вызов которых значит «запустил этого исполнителя».
// Моделей в профиле нет: модель выбирает провайдер; своя - AGENT_RUN_MODEL при запуске.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const KINDS = new Set(['claude-like', 'codex']);
const MAX_PROFILES = 32; // профилей в файле
const MAX_STR = 200; // потолок длины строковых полей
const MAX_LIST = 16; // потолок длины списков (binaries, flags, mcpTools)

// historyDir из окружения: <ID>_PROJECTS_DIR для claude-like, <ID>_SESSIONS_DIR для codex.
// Прежние переменные (CLAUDE_PROJECTS_DIR, GLM_PROJECTS_DIR, CODEX_SESSIONS_DIR) подходят
// под общее правило и работают как раньше.
function envDirName(id, kind) {
  return id.toUpperCase().replace(/-/g, '_') + (kind === 'codex' ? '_SESSIONS_DIR' : '_PROJECTS_DIR');
}

function expandTilde(p, home) {
  return p.replace(/^~(?=\/|$)/, () => home);
}

// Корень профиля: переменная окружения сильнее historyDir из файла.
function resolveDir(p, e) {
  const home = e.HOME || os.homedir();
  return path.resolve(e[envDirName(p.id, p.kind)] || expandTilde(p.historyDir, home));
}

function builtinProfiles(env) {
  const e = env || process.env;
  const dir = (p, id, kind) => path.resolve(e[envDirName(id, kind)] || path.join(e.HOME || os.homedir(), p));
  const glm = {
    id: 'glm',
    label: 'GLM (через Z.ai)',
    kind: 'claude-like',
    historyDir: dir('.glm-worker/projects', 'glm', 'claude-like'),
    dirIsProject: true,
    reportSupported: true,
    executor: true,
    baseUrl: 'https://api.z.ai/api/anthropic',
    keychainService: 'claude-glm-zai', // тот же ключ, что у tools/claude-glm: второй раз вводить не нужно
    mcpKeyEnv: 'ZAI_MCP_KEY',
    run: { binaries: ['claude-glm', 'agent-run'], printFlags: ['-p', '--print'], resumeFlags: ['--resume', '-r'], checkFlags: ['--check'] },
    mcpTools: [],
  };
  const claude = {
    id: 'claude',
    label: 'Claude',
    kind: 'claude-like',
    historyDir: dir('.claude/projects', 'claude', 'claude-like'),
    dirIsProject: true,
    reportSupported: true,
    executor: false, // мозг по умолчанию: его сессии - не кандидаты в исполнители
    baseUrl: null,
    keychainService: 'agents-os-claude',
    mcpKeyEnv: null,
    run: { binaries: ['claude'], printFlags: ['-p', '--print'], resumeFlags: ['--resume', '-r'], checkFlags: [] },
    mcpTools: [],
  };
  const codex = {
    id: 'codex',
    label: 'GPT (Codex)',
    kind: 'codex',
    historyDir: dir('.codex/sessions', 'codex', 'codex'),
    dirIsProject: false, // проект у каждой сессии свой, берётся из cwd
    reportSupported: false,
    executor: true,
    baseUrl: null,
    keychainService: 'agents-os-codex',
    mcpKeyEnv: null,
    run: { binaries: ['codex'], printFlags: ['exec'], resumeFlags: ['resume'], checkFlags: [] },
    mcpTools: ['mcp__codex__*'],
  };
  return [claude, glm, codex];
}

const cutStr = (v) => (typeof v === 'string' ? v.slice(0, MAX_STR) : undefined);
const cutList = (v) =>
  Array.isArray(v)
    ? v
        .filter((x) => typeof x === 'string' && x)
        .map((x) => x.slice(0, MAX_STR))
        .slice(0, MAX_LIST)
    : undefined;

// Поля файла. historyDir из файла - строка с ~; в корень превращает loadAdapters.
function applyPatch(base, patch) {
  const out = Object.assign({}, base);
  for (const k of ['label', 'baseUrl', 'keychainService', 'mcpKeyEnv']) {
    const v = cutStr(patch[k]);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ['dirIsProject', 'reportSupported', 'executor']) {
    if (typeof patch[k] === 'boolean') out[k] = patch[k];
  }
  if (typeof patch.historyDir === 'string' && patch.historyDir && patch.historyDir.length <= MAX_STR) out.historyDir = patch.historyDir;
  if (patch.run && typeof patch.run === 'object') {
    const run = Object.assign({}, out.run);
    const binaries = cutList(patch.run.binaries);
    if (binaries) run.binaries = binaries;
    const printFlags = cutList(patch.run.printFlags);
    if (printFlags) run.printFlags = printFlags;
    const resumeFlags = cutList(patch.run.resumeFlags);
    if (resumeFlags) run.resumeFlags = resumeFlags;
    const checkFlags = cutList(patch.run.checkFlags);
    if (checkFlags) run.checkFlags = checkFlags;
    out.run = run;
  }
  const mcpTools = cutList(patch.mcpTools);
  if (mcpTools) out.mcpTools = mcpTools;
  return out;
}

// Читает и объединяет профили. Возвращает { profiles, warnings } - предупреждения печатает вызывающий.
function loadProfiles(env) {
  const e = env || process.env;
  const warnings = [];
  let home = e.AGENTS_OS_HOME || path.join(e.HOME || os.homedir(), '.agents-os');
  home = path.resolve(home);
  let fileProfiles = null;
  const file = path.join(home, 'providers.json');
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') warnings.push('не прочитан ' + file + ': ' + err.message);
  }
  if (text != null) {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.profiles) ? parsed.profiles : null;
      if (!list) warnings.push('в ' + file + ' нет массива profiles: файл пропущен');
      else {
        fileProfiles = [];
        for (const raw of list.slice(0, MAX_PROFILES)) {
          if (!raw || typeof raw !== 'object') continue;
          const id = typeof raw.id === 'string' ? raw.id : '';
          if (!ID_RE.test(id)) {
            warnings.push('профиль с плохим id пропущен: ' + JSON.stringify(String(id).slice(0, 40)));
            continue;
          }
          // kind проверяется при объединении: у нового профиля он обязателен, встроенный берёт свой
          fileProfiles.push({ id, patch: raw });
        }
      }
    } catch (err) {
      warnings.push('битый JSON в ' + file + ': встроенные профили работают, файл пропущен');
    }
  }

  const builtins = builtinProfiles(e);
  const byId = new Map(builtins.map((p) => [p.id, p]));
  const out = builtins.slice();
  for (const { id, patch } of fileProfiles || []) {
    // kind обязателен у нового профиля; у встроенного он уже есть и меняется только вместе с адаптером
    let kind = KINDS.has(patch.kind) ? patch.kind : null;
    if (!kind && byId.has(id)) kind = byId.get(id).kind;
    if (!kind) {
      warnings.push('профиль ' + id + ': неизвестный kind, пропущен');
      continue;
    }
    const base = byId.get(id);
    if (base) {
      const merged = applyPatch(base, patch);
      merged.kind = base.kind; // kind встроенного не меняем: по нему выбран адаптер при старте
      merged.historyDir = resolveDir(merged, e);
      out[out.findIndex((p) => p.id === id)] = merged;
      byId.set(id, merged);
    } else {
      const p = applyPatch({ id, kind, label: id, dirIsProject: kind !== 'codex', reportSupported: kind === 'claude-like', executor: true, baseUrl: null, keychainService: 'agents-os-' + id, mcpKeyEnv: null, run: { binaries: [id], printFlags: kind === 'codex' ? ['exec'] : ['-p', '--print'], resumeFlags: kind === 'codex' ? ['resume'] : ['--resume', '-r'], checkFlags: [] }, mcpTools: [] }, patch);
      if (!p.historyDir) {
        warnings.push('профиль ' + id + ': нет historyDir, пропущен');
        continue;
      }
      p.historyDir = resolveDir(p, e);
      out.push(p);
      byId.set(id, p);
    }
  }
  return { profiles: out, warnings };
}

// Профили последней загрузки: их берут распознавание запусков и шаги (lib/step.js),
// которым некуда передать профили через аргументы. До первой загрузки - встроенные.
let currentProfiles = null;

function setCurrent(profiles) {
  currentProfiles = profiles;
}

function current(env) {
  return currentProfiles || builtinProfiles(env);
}

module.exports = { loadProfiles, builtinProfiles, setCurrent, current, envDirName, ID_RE };
