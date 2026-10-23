'use strict';

// Реестр источников (адаптеров) и проверка путей.
// Адаптеры строятся из профилей (lib/providers.js): claude-like → claudeLike.js, codex → codex.js.
// Новый провайдер = профиль в ~/.agents-os/providers.json, код не меняется. Адаптер включается,
// только если его папка существует.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { loadProfiles, setCurrent } = require('../providers');
const { createClaudeLike } = require('./claudeLike');
const { createCodex } = require('./codex');

// Провайдер на карте: id профиля; у встроенных - прежние имена (claude, gpt у codex).
function providerOf(profile) {
  if (profile.id === 'claude') return 'claude';
  if (profile.id === 'codex') return 'gpt';
  return profile.id;
}

async function loadAdapters(env) {
  const e = env || process.env;
  const { profiles, warnings } = loadProfiles(e);
  setCurrent(profiles);
  for (const w of warnings) console.warn('[профили] ' + w);
  const out = [];
  for (const p of profiles) {
    // история может лежать не в HOME (AGENTS_OS_HOME в тестах): ~ раскрываем от домашней папки
    const root = path.isAbsolute(p.historyDir) ? p.historyDir : path.resolve(e.HOME || os.homedir(), p.historyDir);
    const common = { id: p.id, provider: providerOf(p), label: p.label, root, dirIsProject: p.dirIsProject, reportSupported: p.reportSupported, executor: p.executor };
    const adapter = p.kind === 'codex' ? createCodex(common) : createClaudeLike(common);
    if (await adapter.available()) out.push(adapter);
  }
  return out;
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// realpath кэшируется: корни и домашняя папка за жизнь сервера не меняются.
// Неудачи (файла ещё нет) не кэшируются: файл может появиться сразу после проверки.
const realCache = new Map();
function realpathCached(p) {
  const hit = realCache.get(p);
  if (hit !== undefined) return hit;
  let real = null;
  try {
    real = fs.realpathSync.native(p);
  } catch {}
  if (real !== null) {
    if (realCache.size >= 1000) realCache.clear();
    realCache.set(p, real);
  }
  return real;
}

// Путь разрешён, только если он строго внутри root (без выхода наверх) и после раскрытия
// симлинков (realpath) остался внутри realpath(root). Несуществующий путь → null.
// Возвращает абсолютный путь (уже realpath) или null.
function resolveWithin(root, target) {
  if (typeof target !== 'string' || !target) return null;
  if (target.includes('\0')) return null;
  const abs = path.resolve(expandHome(target));
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const real = realpathCached(abs);
  const rootReal = realpathCached(path.resolve(root));
  if (!real || !rootReal) return null;
  const relReal = path.relative(rootReal, real);
  if (!relReal || relReal.startsWith('..') || path.isAbsolute(relReal)) return null;
  return real;
}

// Путь строго внутри домашней папки.
function resolveWithinHome(target) {
  return resolveWithin(os.homedir(), target);
}

// Папки в домашней директории, содержимое которых не показываем даже как .md/.txt
// (для /api/file и подстановки $(cat ...); транскрипты адаптеры читают сами, это их не касается).
const SENSITIVE_HOME_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.config', '.claude', '.codex']);
const SENSITIVE_HOME_NESTED = [['Library', 'Keychains']];

// abs - уже realpath внутри домашней папки. true, если файл лежит в защищённой папке.
function isSensitiveHomePath(abs, home) {
  const base = home || os.homedir();
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return true;
  const parts = rel.split(path.sep);
  if (SENSITIVE_HOME_DIRS.has(parts[0])) return true;
  return SENSITIVE_HOME_NESTED.some((nest) => nest.every((seg, i) => parts[i] === seg));
}

// Путь под домашней папкой как ~/… (для показа), иначе как есть.
function homeTilde(abs) {
  const home = realpathCached(os.homedir()) || os.homedir();
  const rel = path.relative(home, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return '~/' + rel.split(path.sep).join('/');
}

// Идентификатор узла = "<адаптер>:<путь относительно корня адаптера>".
function makeFileId(adapter, rel) {
  return adapter.id + ':' + rel;
}

// Форма идентификатора без выхода на диск: { adapter, abs } (лексически внутри корня) или null.
// Нужна там, где «неизвестный агент» (404) отличается от «путь недоступен» (400).
function resolveFileIdShape(adapters, id) {
  if (typeof id !== 'string') return null;
  const i = id.indexOf(':');
  if (i < 1) return null;
  const adapter = adapters.find((a) => a.id === id.slice(0, i));
  const rel = id.slice(i + 1);
  if (!adapter || !rel.endsWith('.jsonl') || rel.includes('\0')) return null;
  const abs = path.resolve(adapter.root, rel);
  const relCheck = path.relative(path.resolve(adapter.root), abs);
  if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null;
  return { adapter, abs };
}

// Идентификатор → { adapter, abs } или null (чужой источник, выход за корень, не .jsonl,
// симлинк наружу или файла нет - realpath).
function resolveFileId(adapters, id) {
  const shape = resolveFileIdShape(adapters, id);
  if (!shape) return null;
  const abs = resolveWithin(shape.adapter.root, shape.abs);
  return abs ? { adapter: shape.adapter, abs } : null;
}

module.exports = { loadAdapters, resolveWithin, resolveWithinHome, expandHome, makeFileId, resolveFileId, resolveFileIdShape, isSensitiveHomePath, homeTilde };
