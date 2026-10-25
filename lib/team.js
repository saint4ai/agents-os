'use strict';

// Роли «мозг / исполнитель»: ~/.agents-os/team.json (папка переопределяется AGENTS_OS_HOME).
// Файл пишет агент по просьбе человека в разговоре; Agents OS файл только читает, никогда не пишет.
// Нет файла - brain: claude, исполнителями считаются все профили, у которых есть запуски.
// Битый файл - значения по умолчанию и предупреждение.
//
//   { "version": 1, "brain": "claude",
//     "executors": [{ "profile": "glm", "projects": ["*"] }, { "profile": "deepseek", "projects": ["~/my-project"] }],
//     "updatedAt": "2026-10-23T10:00:00Z", "updatedBy": "claude:7f3a…" }
//
// Роль - договорённость, запуск - факт из переписки; эти слои не смешиваются (см. README).

const fs = require('fs');
const path = require('path');
const { isWin, isInside, gitBashToWin, nativeHome, expandTilde } = require('./paths');

const MAX_BYTES = 64 * 1024; // файл на одну команду: больше - не читаем
const MAX_EXECUTORS = 32;
const MAX_STR = 200;

function teamPath(env) {
  const e = env || process.env;
  return path.resolve(e.AGENTS_OS_HOME || path.join(nativeHome(e), '.agents-os'), 'team.json');
}

function defaultTeam() {
  return { version: 1, brain: 'claude', executors: [], updatedAt: null, updatedBy: null };
}

const cutStr = (v) => (typeof v === 'string' ? v.slice(0, MAX_STR) : null);

// Разбор содержимого: { team, warnings }. Ошибки значений пропускаются, файл не роняет карту.
function parseTeam(text) {
  const warnings = [];
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { team: defaultTeam(), warnings: ['битый JSON в team.json: роли по умолчанию (мозг claude)'] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { team: defaultTeam(), warnings: ['в team.json нет объекта: роли по умолчанию (мозг claude)'] };
  }
  const team = defaultTeam();
  const brain = cutStr(raw.brain);
  if (brain && /^[a-z][a-z0-9-]{0,31}$/.test(brain)) team.brain = brain;
  else if (brain) warnings.push('плохой brain в team.json: мозг claude');
  if (Array.isArray(raw.executors)) {
    for (const e of raw.executors.slice(0, MAX_EXECUTORS)) {
      if (!e || typeof e !== 'object' || !/^[a-z][a-z0-9-]{0,31}$/.test(String(e.profile || ''))) {
        warnings.push('исполнитель без профиля в team.json пропущен');
        continue;
      }
      let projects = ['*'];
      if (Array.isArray(e.projects)) {
        projects = e.projects.filter((p) => typeof p === 'string' && p).map((p) => p.slice(0, MAX_STR)).slice(0, 16);
        if (!projects.length) projects = ['*'];
      }
      team.executors.push({ profile: e.profile, projects });
    }
    if (raw.executors.length > MAX_EXECUTORS) warnings.push('исполнителей больше ' + MAX_EXECUTORS + ': лишние пропущены');
  } else if (raw.executors != null) {
    warnings.push('executors в team.json не массив: исполнители по умолчанию');
  }
  team.updatedAt = cutStr(raw.updatedAt);
  team.updatedBy = cutStr(raw.updatedBy);
  return { team, warnings };
}

// Чтение с кэшем по (путь, size, mtime). Возвращает { team, source: 'file'|'default', warnings }.
function loadTeam(env) {
  const file = teamPath(env);
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {}
  if (!st || !st.isFile()) return { team: defaultTeam(), source: 'default', warnings: [] };
  const hit = loadTeam.cache;
  if (hit && hit.path === file && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.result;
  let text = null;
  try {
    if (st.size <= MAX_BYTES) text = fs.readFileSync(file, 'utf8');
  } catch {}
  let result;
  if (text == null) {
    result = { team: defaultTeam(), source: 'default', warnings: ['team.json не прочитан' + (st.size > MAX_BYTES ? ' (больше ' + Math.round(MAX_BYTES / 1024) + ' КБ)' : '') + ': роли по умолчанию'] };
  } else {
    const parsed = parseTeam(text);
    result = { team: parsed.team, source: 'file', warnings: parsed.warnings };
  }
  loadTeam.cache = { path: file, size: st.size, mtimeMs: st.mtimeMs, result };
  return result;
}

// Пути из team.json могут начинаться с ~; проект сравнивается по абсолютному пути.
// На Windows ещё понимается вид Git Bash (/c/Проекты/x), его агент мог записать в файл.
function expandProject(p, home) {
  const e = expandTilde(String(p), home);
  return (isWin() && gitBashToWin(e)) || e;
}

// Исполнители, разрешённые проекту: projects совпал или '*'. executorsByDefault - чем заполнить,
// когда файл не задал список (все профили с запусками, в виде [{profile}]).
function executorsFor(team, projectPath, executorsByDefault) {
  const list = team.executors.length ? team.executors : executorsByDefault || [];
  if (!projectPath) return list;
  const home = nativeHome(process.env);
  return list.filter((e) => {
    if (!e.projects || !e.projects.length || e.projects.includes('*')) return true;
    return e.projects.some((p) => isInside(projectPath, expandProject(p, home)));
  });
}

module.exports = { loadTeam, parseTeam, defaultTeam, teamPath, executorsFor, expandProject };
