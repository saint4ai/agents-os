'use strict';

// Пути проектов на разных ОС.
// macOS и Linux: всё как прежде, срезаются только хвостовые «/».
// Windows: путь с буквой диска или UNC приводится к одному виду (C:\Проекты\x: буква диска заглавная,
// обратные слэши, без хвостового разделителя), а сравнивается без учёта регистра. Один проект - один ключ,
// даже если Claude Code записал cwd как c:\Проекты\x, C:/Проекты/x и C:\Проекты\x.
// UNC-пути WSL (\\wsl.localhost\Ubuntu\…) остаются UNC; файловая система под ними (ext4) различает
// регистр, поэтому без учёта регистра они не сравниваются.
// Пути в стиле POSIX (/home/u/x из WSL, /work/x в тестах) на Windows не трогаются: у них свои правила.
//
// Все функции принимают необязательный platform ('win32' | 'linux' | 'darwin'): по умолчанию
// process.platform. Так правила Windows проверяются тестами на любой ОС.

const os = require('os');
const path = require('path');

const DRIVE_RE = /^[A-Za-z]:(?:[\\/]|$)/;
const UNC_RE = /^(?:\\\\|\/\/)[^\\/]/;
const WSL_UNC_RE = /^\\\\wsl(?:\.localhost|\$)(?:\\|$)/i;
const GITBASH_RE = /^\/([A-Za-z])(?:\/(.*))?$/s; // /c, /c/Проекты/x (Git Bash)

const isWin = (platform) => (platform || process.platform) === 'win32';
const isWinPath = (p) => typeof p === 'string' && (DRIVE_RE.test(p) || UNC_RE.test(p));

// Git Bash: /c/Проекты/x -> C:\Проекты\x. Не путь в этом стиле - null.
function gitBashToWin(p) {
  const m = typeof p === 'string' ? GITBASH_RE.exec(p) : null;
  if (!m) return null;
  return m[1].toUpperCase() + ':\\' + (m[2] || '').replace(/\//g, '\\');
}

function normWin(p) {
  let s = /^[A-Za-z]:$/.test(p) ? p + '\\' : p;
  s = path.win32.normalize(s);
  s = s.replace(/^[a-z]:/, (m) => m.toUpperCase());
  const root = path.win32.parse(s).root;
  while (s.length > root.length && /[\\/]$/.test(s)) s = s.slice(0, -1);
  return s;
}

// Вид пути для показа и ключей проектов.
function normPath(p, platform) {
  if (typeof p !== 'string' || p.length <= 1) return p;
  if (isWin(platform) && isWinPath(p)) return normWin(p);
  return p.replace(/\/+$/, '');
}

// Вид пути для сравнения: на Windows без учёта регистра (кроме UNC WSL).
function foldPath(p, platform) {
  const n = normPath(p, platform);
  if (typeof n === 'string' && isWin(platform) && isWinPath(n) && !WSL_UNC_RE.test(n)) return n.toLowerCase();
  return n;
}

const sepOf = (p, platform) => (isWin(platform) && isWinPath(p) ? '\\' : '/');

// child лежит внутри parent или совпадает с ним.
function isInside(child, parent, platform) {
  const c = foldPath(child, platform);
  const q = foldPath(parent, platform);
  if (!c || !q) return false;
  if (c === q) return true;
  const sep = sepOf(q, platform);
  return c.startsWith(q.endsWith(sep) ? q : q + sep);
}

// Путь child относительно parent, с «/» в качестве разделителя (для показа); null, если child не строго внутри.
function relativeInside(child, parent, platform) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return null;
  const c = normPath(child, platform);
  const q = normPath(parent, platform);
  const sep = sepOf(q, platform);
  const base = q.endsWith(sep) ? q : q + sep;
  const fc = foldPath(c, platform);
  const fb = foldPath(base, platform);
  if (fc.length <= fb.length || !fc.startsWith(fb)) return null;
  return c.slice(base.length).replace(/\\/g, '/');
}

// Домашняя папка: HOME из окружения (в тестах и из Git Bash), иначе os.homedir().
// В Git Bash HOME бывает вида /c/Users/имя: на Windows он переводится в C:\Users\имя.
function nativeHome(env, platform) {
  const e = env || process.env;
  const h = e.HOME || os.homedir();
  if (isWin(platform)) return gitBashToWin(h) || h;
  return h;
}

// ~ и ~/x (на Windows ещё ~\x) -> домашняя папка.
function expandTilde(p, home, platform) {
  const re = isWin(platform) ? /^~(?=[\\/]|$)/ : /^~(?=\/|$)/;
  return String(p).replace(re, () => home);
}

module.exports = { isWin, isWinPath, gitBashToWin, normPath, foldPath, isInside, relativeInside, nativeHome, expandTilde, WSL_UNC_RE };
