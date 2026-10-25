'use strict';

// Разбор Bash-команды из транскрипта: ищем запуск claude-glm и вытаскиваем
//   cwd    - куда вела цепочка `cd <путь> && ...` (проект GLM-исполнителя),
//   resume - id сессии из `--resume <id>`,
//   cat    - путь файла из `$(cat файл)` (текст ТЗ).
// Это не полноценный разбор shell: делим по операторам с учётом кавычек, остальное не важно.
// Windows: Claude Code зовёт Bash из Git Bash, поэтому `cd /c/Проекты/x` понимается как C:\Проекты\x;
// заодно разбираются C:/x, C:\x, 'C:\x', ~/x, UNC и PowerShell-формы (Set-Location, cd /d).

const os = require('os');
const path = require('path');
const { isWin, isWinPath, gitBashToWin, normPath, expandTilde } = require('./paths');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAT_RE = /\$\(\s*cat\s+("[^"]+"|'[^']+'|[^)\s]+)\s*\)/;

// Делит команду на сегменты по && || ; | & и переводу строки вне кавычек.
// Дойдя до heredoc (<<) останавливается: дальше идёт текст, а не команды.
function splitSegments(cmd) {
  const segs = [];
  let cur = '';
  let q = null; // текущая кавычка
  let depth = 0; // вложенность $( ... ) внутри двойных кавычек
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (q === '"' && c === '$' && cmd[i + 1] === '(') { depth++; cur += cmd[++i]; continue; }
      if (q === '"' && depth > 0 && c === ')') { depth--; continue; }
      if (c === q && depth === 0) q = null;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') { segs.push(cur); return segs; }
    if (c === '&' || c === '|' || c === ';' || c === '\n') {
      segs.push(cur);
      cur = '';
      while ((cmd[i + 1] === '&' || cmd[i + 1] === '|') && c !== '\n') i++;
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs;
}

// Слова сегмента; кавычки снимаются, содержимое $( ... ) в кавычках остаётся одним словом.
function tokenize(seg) {
  const toks = [];
  let cur = '';
  let has = false;
  let q = null;
  let depth = 0;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      // в двойных кавычках bash экранирует только $ ` " \ и перевод строки; "C:\Проекты\x" остаётся как есть
      if (c === '\\' && q === '"' && i + 1 < seg.length && '$`"\\\n'.includes(seg[i + 1])) { cur += seg[++i]; continue; }
      if (q === '"' && c === '$' && seg[i + 1] === '(') { depth++; cur += c + seg[++i]; continue; }
      if (q === '"' && depth > 0 && c === ')') { depth--; cur += c; continue; }
      if (c === q && depth === 0) { q = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < seg.length) {
      // путь Windows без кавычек: C:\Проекты\x, ..\x, ~\x и \\сервер\папка. Обратная косая тут разделитель,
      // а не экранирование. Экранированием она остаётся у кавычки, доллара и пробела внутри пути
      // (`C:\Program\ Files`); пробел в конце слова (`cd C:\x\ `) это хвостовой разделитель.
      const nx = seg[i + 1];
      const winish = /^(?:[A-Za-z]:|\.{1,2}(?:\\|$)|~(?:\\|$))/.test(cur) || cur.startsWith('\\\\');
      const trailing = /\s/.test(nx) && !seg.slice(i + 1).trim();
      const literal = winish && (trailing || !/[\s"'\\$`]/.test(nx));
      if (literal) { cur += c; has = true; continue; }
      if (cur === '' && nx === '\\' && i + 2 < seg.length && !/\s/.test(seg[i + 2])) { cur = '\\\\'; i++; has = true; continue; }
      cur += seg[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) toks.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) toks.push(cur);
  return toks;
}

function expandHome(p, platform) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || (isWin(platform) && p.startsWith('~\\'))) {
    return isWin(platform) ? expandTilde(p, os.homedir(), platform) : path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// Команды смены папки: Bash и PowerShell/cmd. Флаги перед путём пропускаются (cd /d, -Path, -LiteralPath, --, -P, -L).
const CD_NAMES = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl']);
const CD_FLAGS = new Set(['/d', '-path', '-literalpath', '--', '-p', '-l']);

// Куда ведёт `cd <target>` из папки cur. null/недоступно - остаётся cur.
// macOS и Linux: как раньше (path.resolve от cur). Windows:
//   /c/Проекты/x (Git Bash), C:/x, C:\x, \\сервер\папка - абсолютные, приводятся к C:\Проекты\x;
//   относительный путь считается по правилам Windows от cur, если cur это путь Windows;
//   пути в стиле POSIX (/work/x, /home/u/x из WSL) остаются POSIX: на Windows неизвестно, куда они ведут.
function resolveCd(cur, target, platform) {
  if (!isWin(platform)) {
    return cur ? path.posix.resolve(cur, target) : path.posix.isAbsolute(target) ? path.posix.normalize(target) : cur;
  }
  const t0 = expandHome(target, platform);
  const t = gitBashToWin(t0) || t0;
  if (isWinPath(t)) return normPath(path.win32.normalize(t), platform);
  if (t.startsWith('/')) return path.posix.normalize(t);
  if (/^\\(?!\\)/.test(t)) return cur && isWinPath(cur) ? normPath(path.win32.resolve(cur, t), platform) : cur;
  if (!cur) return cur;
  if (isWinPath(cur)) return normPath(path.win32.resolve(cur, t), platform);
  return path.posix.resolve(cur, t);
}

// Запуски исполнителей в команде по профилям (lib/providers.js): [{ cwd, resume, cat, check, profile }].
// startCwd - рабочая папка вызова. Запуском считается сегмент, где бинарь из run.binaries профиля
// стоит первым словом и есть флаг запуска (run.printFlags) или проверки связи (run.checkFlags).
// `agent-run <id> …` относится к профилю <id>. `codex exec resume <id>` - тоже resume: id идёт
// за resumeFlags. `--help`, login/mcp-подкоманды, `--set-key`, упоминания в heredoc, cat, ls, echo -
// не запуск: у них нет флага запуска.
// opts.platform - правила путей ('win32' | 'linux' | 'darwin'), по умолчанию платформа процесса.
function parseAgentLaunches(command, profiles, startCwd, opts) {
  const platform = (opts && opts.platform) || process.platform;
  if (typeof command !== 'string' || !Array.isArray(profiles) || !profiles.length) return [];
  let maybe = false;
  for (const p of profiles) {
    const run = p.run || {};
    for (const b of run.binaries || []) {
      if (command.includes(b)) {
        maybe = true;
        break;
      }
    }
    if (maybe) break;
  }
  if (!maybe) return [];
  const out = [];
  let cur = startCwd || null;
  for (const seg of splitSegments(command)) {
    let toks = tokenize(seg);
    while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]) || ['time', 'nohup', 'exec', 'command'].includes(toks[0]))) toks = toks.slice(1);
    if (!toks.length) continue;
    const cdName = isWin(platform) ? toks[0].toLowerCase() : toks[0];
    if (CD_NAMES.has(cdName) && (cdName === 'cd' || isWin(platform))) {
      let args = toks.slice(1);
      while (args.length && CD_FLAGS.has(args[0].toLowerCase())) args = args.slice(1);
      if (args[0] && args[0] !== '-') cur = resolveCd(cur, args[0], platform);
      if (args[0] || toks.length > 1) continue;
    }
    const found = matchProfile(toks, profiles);
    if (!found) continue;
    const { profile, rest } = found;
    const run = profile.run || {};
    const check = (run.checkFlags || []).some((f) => rest.includes(f));
    const ri = rest.findIndex((t) => (run.resumeFlags || []).includes(t));
    const isRun = check || ri !== -1 || (run.printFlags || []).some((f) => rest.includes(f));
    if (!isRun) continue;
    if (rest.includes('--help') || rest.includes('-h')) continue;
    const resume = ri !== -1 && UUID_RE.test(rest[ri + 1] || '') ? rest[ri + 1].toLowerCase() : null;
    const m = CAT_RE.exec(rest.join(' '));
    out.push({ cwd: cur, resume, cat: m ? m[1].replace(/^["']|["']$/g, '') : null, check, profile: profile.id });
  }
  return out;
}

// Первый токен сегмента → { profile, rest }. `agent-run <id>` выбирает профиль по id,
// остальные бинари - по run.binaries.
function matchProfile(toks, profiles) {
  if (toks[0] === 'agent-run') {
    if (!toks[1]) return null;
    const profile = profiles.find((p) => p.id === toks[1]);
    return profile ? { profile, rest: toks.slice(2) } : null;
  }
  const bin = binName(toks[0]);
  if (bin === 'agent-run') return null;
  const profile = profiles.find((p) => (p.run.binaries || []).includes(bin));
  return profile ? { profile, rest: toks.slice(1) } : null;
}

// Имя бинаря без папки и расширения: C:\Users\x\bin\claude-glm.cmd и /usr/local/bin/claude-glm это claude-glm.
function binName(tok) {
  return tok.split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
}

// Прежний вид: запуски GLM без поля profile (старые вызовы и тесты).
function parseGlmLaunches(command, startCwd, opts) {
  const { builtinProfiles } = require('./providers');
  const glm = builtinProfiles({}).find((p) => p.id === 'glm');
  return parseAgentLaunches(command, [glm], startCwd, opts).map(({ cwd, resume, cat, check }) => ({ cwd, resume, cat, check }));
}

module.exports = { parseAgentLaunches, parseGlmLaunches, resolveCd, splitSegments, tokenize, UUID_RE, CAT_RE };
