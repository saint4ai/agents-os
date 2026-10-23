'use strict';

// Разбор Bash-команды из транскрипта: ищем запуск claude-glm и вытаскиваем
//   cwd    - куда вела цепочка `cd <путь> && ...` (проект GLM-исполнителя),
//   resume - id сессии из `--resume <id>`,
//   cat    - путь файла из `$(cat файл)` (текст ТЗ).
// Это не полноценный разбор shell: делим по операторам с учётом кавычек, остальное не важно.

const os = require('os');
const path = require('path');

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
      if (c === '\\' && q === '"' && i + 1 < seg.length) { cur += seg[++i]; continue; }
      if (q === '"' && c === '$' && seg[i + 1] === '(') { depth++; cur += c + seg[++i]; continue; }
      if (q === '"' && depth > 0 && c === ')') { depth--; cur += c; continue; }
      if (c === q && depth === 0) { q = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < seg.length) { cur += seg[++i]; has = true; continue; }
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

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Запуски исполнителей в команде по профилям (lib/providers.js): [{ cwd, resume, cat, check, profile }].
// startCwd - рабочая папка вызова. Запуском считается сегмент, где бинарь из run.binaries профиля
// стоит первым словом и есть флаг запуска (run.printFlags) или проверки связи (run.checkFlags).
// `agent-run <id> …` относится к профилю <id>. `codex exec resume <id>` - тоже resume: id идёт
// за resumeFlags. `--help`, login/mcp-подкоманды, `--set-key`, упоминания в heredoc, cat, ls, echo -
// не запуск: у них нет флага запуска.
function parseAgentLaunches(command, profiles, startCwd) {
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
    if (toks[0] === 'cd' && toks[1]) {
      const target = expandHome(toks[1]);
      if (target !== '-') cur = cur ? path.resolve(cur, target) : path.isAbsolute(target) ? path.normalize(target) : cur;
      continue;
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
  const bin = path.basename(toks[0]);
  if (bin === 'agent-run') return null;
  const profile = profiles.find((p) => (p.run.binaries || []).includes(bin));
  return profile ? { profile, rest: toks.slice(1) } : null;
}

// Прежний вид: запуски GLM без поля profile (старые вызовы и тесты).
function parseGlmLaunches(command, startCwd) {
  const { builtinProfiles } = require('./providers');
  const glm = builtinProfiles({}).find((p) => p.id === 'glm');
  return parseAgentLaunches(command, [glm], startCwd).map(({ cwd, resume, cat, check }) => ({ cwd, resume, cat, check }));
}

module.exports = { parseAgentLaunches, parseGlmLaunches, splitSegments, tokenize, UUID_RE, CAT_RE };
