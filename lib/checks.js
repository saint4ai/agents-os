'use strict';

// Проверки, которые запускал агент: какие команды считаются ключевыми и что они показали.
// Вердикт строится по ТЕКСТУ вывода: is_error не доверяем. Конвейер (`| grep`, `| tail`) прячет код возврата,
// и красный прогон приходит с is_error:false. Верим только красному is_error, когда в тексте итога нет.
// В индекс попадает короткий итог, текст вывода выбрасывается.

const path = require('path');
const { splitSegments, tokenize } = require('./shell');

const TAIL = 600; // из вывода берутся последние знаки: итог тестов и сборок всегда в конце
const WRAPPERS = new Set(['time', 'nohup', 'exec', 'command', 'sudo']);
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// Быстрый отсев: в большинстве команд (ls, cat, grep, sed, echo) нет ни одного слова, которое нас интересует.
const INTERESTING = /\b(?:npm|npx|pnpm|yarn|bun|vitest|jest|mocha|pytest|py\.test|tsc|node|python[0-9.]*|make|git|claude-glm|agent-run|curl)\b/;
// Без кавычек, экранирования и подстановок команду можно делить регулярками, это заметно дешевле побуквенного разбора.
const PLAIN = /^[^"'\\$`<]*$/;

const MEMO_CAP = 256; // повторяющиеся команды (npm test, git diff) разбираются один раз
const memo = new Map();

const TEST_RUNNERS = new Set(['vitest', 'jest', 'pytest', 'py.test', 'mocha']);
const NPM_LIKE = new Set(['npm', 'pnpm', 'yarn', 'bun']);

// Один сегмент команды (после разбиения по && | ;) → { key, kind } или null.
function classifySegment(tokens) {
  let toks = tokens;
  while (toks.length && (ENV_RE.test(toks[0]) || WRAPPERS.has(toks[0]))) toks = toks.slice(1);
  if (!toks.length) return null;
  const bin = path.basename(toks[0]);
  const args = toks.slice(1);
  const words = args.filter((t) => !t.startsWith('-'));

  if (NPM_LIKE.has(bin)) {
    const sub = words[0];
    if (!sub) return null;
    const script = sub === 'run' || sub === 'run-script' ? words[1] || '' : sub;
    if (/^(test|t|tests?:\S*)$/.test(script)) return { key: true, kind: 'tests' };
    if (/^(build|compile)(:\S*)?$/.test(script)) return { key: true, kind: 'build' };
    if (/^(typecheck|tsc|types|check-types)$/.test(script)) return { key: true, kind: 'types' };
    return { key: true, kind: null };
  }
  if (bin === 'npx') {
    const tool = words[0];
    if (TEST_RUNNERS.has(tool) || (tool === 'playwright' && words[1] === 'test')) return { key: true, kind: 'tests' };
    if (tool === 'tsc') return { key: true, kind: 'types' };
    if ((tool === 'vite' || tool === 'next') && words[1] === 'build') return { key: true, kind: 'build' };
    return { key: true, kind: null };
  }
  if (TEST_RUNNERS.has(bin)) return { key: true, kind: 'tests' };
  if (bin === 'tsc') return { key: true, kind: 'types' };
  if (bin === 'node' && args.includes('--test')) return { key: true, kind: 'tests' };
  if (/^python[0-9.]*$/.test(bin)) {
    const i = args.indexOf('-m');
    if (i !== -1 && (args[i + 1] === 'pytest' || args[i + 1] === 'unittest')) return { key: true, kind: 'tests' };
    return null;
  }
  if (bin === 'make') {
    const target = words[0] || 'all';
    if (/^(test|tests|check)$/.test(target)) return { key: true, kind: 'tests' };
    if (/^(build|all|dist|compile)/.test(target)) return { key: true, kind: 'build' };
    return { key: true, kind: null };
  }
  if (bin === 'git') {
    // git [-C путь] подкоманда ...
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-C' || args[i] === '-c') { i++; continue; }
      if (!args[i].startsWith('-')) rest.push(args[i]);
    }
    const sub = rest[0];
    if (sub === 'diff') return { key: true, kind: args.some((a) => /^--(stat|shortstat|numstat)$/.test(a)) ? 'diff' : null };
    if (sub === 'commit' || sub === 'push') return { key: true, kind: null };
    return null;
  }
  if (bin === 'claude-glm') return { key: true, kind: null };
  if (bin === 'curl') {
    const i = args.findIndex((a) => /^-X$|^--request$/.test(a));
    const method = i !== -1 ? args[i + 1] : (args.find((a) => /^-X[A-Z]+$/.test(a)) || '').slice(2);
    if (/^(POST|PUT|DELETE|PATCH)$/i.test(method || '')) return { key: true, kind: null };
  }
  return null;
}

// Команда Bash → { key, kind, text }. key: попадает в список «команды» (шум вроде ls, cat, grep, sed, echo не берём).
// kind: tests | types | build | diff, если по выводу можно вынести вердикт. Для связки команд берётся последняя
// проверка: вывод в конце относится к ней. text: та часть связки, из-за которой команда ключевая (для показа
// в карточке: «npx vitest run», а не вся строка с cd, sed и конвейером).
function classifyCommand(cmd) {
  if (typeof cmd !== 'string') return { key: false, kind: null, text: '' };
  const hit = memo.get(cmd);
  if (hit) return hit;
  const out = classifyUncached(cmd);
  if (cmd.length <= 300) {
    if (memo.size >= MEMO_CAP) memo.delete(memo.keys().next().value);
    memo.set(cmd, out);
  }
  return out;
}

function classifyUncached(cmd) {
  const out = { key: false, kind: null, text: '' };
  if (!INTERESTING.test(cmd)) return out;
  const norm = cmd.replace(/\d*>&\d+/g, ' ').replace(/\s\d*>{1,2}\s*\/dev\/null/g, ' '); // перенаправления вывода не часть команды
  const segs = PLAIN.test(norm) ? norm.split(/&&|\|\||[;&|\n]/) : splitSegments(norm);
  let keyText = '';
  let kindText = '';
  for (const seg of segs) {
    const c = classifySegment(PLAIN.test(seg) ? seg.split(/\s+/).filter(Boolean) : tokenize(seg));
    if (!c) continue;
    if (c.key) {
      out.key = true;
      if (!keyText) keyText = seg;
    }
    if (c.kind) {
      out.kind = c.kind;
      kindText = seg;
    }
  }
  out.text = (kindText || keyText).replace(/\s+/g, ' ').trim();
  return out;
}

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

function testsSummary(failed, passed, errors) {
  const parts = [];
  if (failed) parts.push(failed + ' failed');
  if (errors) parts.push(errors + (errors === 1 ? ' error' : ' errors'));
  if (passed || !parts.length) parts.push(passed + ' passed');
  return parts.join(', ');
}

// Итог прогона тестов из хвоста вывода: vitest и jest, node --test, pytest.
function parseTests(tail) {
  let failed = null;
  let passed = null;
  let errors = 0;
  // vitest: «Tests  5 failed | 357 passed (362)»; jest: «Tests:  1 failed, 4 passed, 5 total»
  const vt = /^\s*Tests:?\s+(.+)$/m.exec(tail);
  if (vt) {
    const f = /(\d+)\s+failed/i.exec(vt[1]);
    const p = /(\d+)\s+passed/i.exec(vt[1]);
    if (f || p) {
      failed = f ? +f[1] : 0;
      passed = p ? +p[1] : 0;
    }
  }
  // node --test: «# pass 56» / «ℹ pass 56»
  if (failed === null) {
    const p = /(?:#|ℹ)\s*pass\s+(\d+)/.exec(tail);
    const f = /(?:#|ℹ)\s*fail\s+(\d+)/.exec(tail);
    if (p || f) {
      passed = p ? +p[1] : 0;
      failed = f ? +f[1] : 0;
    }
  }
  // pytest: «=== 5 failed, 357 passed in 3.2s ===», «362 passed in 1.2s»
  if (failed === null) {
    const line = tail.split('\n').reverse().find((l) => /\bin\s+[\d.]+\s*s\b/.test(l) && /\d+\s+(passed|failed|errors?)/.test(l));
    if (line) {
      const f = /(\d+)\s+failed/.exec(line);
      const p = /(\d+)\s+passed/.exec(line);
      const e = /(\d+)\s+errors?/.exec(line);
      failed = f ? +f[1] : 0;
      passed = p ? +p[1] : 0;
      errors = e ? +e[1] : 0;
    }
  }
  // vitest упал до запуска тестов: строки «Tests» нет, но «Test Files  1 failed» есть
  if (failed === null) {
    const tf = /^\s*Test Files\s+(.+)$/m.exec(tail);
    const f = tf && /(\d+)\s+failed/i.exec(tf[1]);
    if (f && +f[1] > 0) return { ok: false, summary: f[1] + ' ' + plural(+f[1], 'файл тестов упал', 'файла тестов упало', 'файлов тестов упало') };
  }
  if (failed === null) return null;
  if (!failed && !passed && !errors) return { ok: null, summary: 'тестов не найдено' };
  return { ok: failed === 0 && errors === 0, summary: testsSummary(failed, passed, errors) };
}

function typesVerdict(tail) {
  const found = /Found\s+(\d+)\s+errors?/i.exec(tail);
  const n = found ? +found[1] : (tail.match(/error TS\d+/g) || []).length;
  if (n) return { ok: false, summary: n + ' ' + plural(n, 'ошибка', 'ошибки', 'ошибок') + ' типов' };
  if (/command not found|npm ERR!|Cannot find module|ENOENT/.test(tail)) return { ok: false, summary: 'проверка типов не запустилась' };
  return { ok: true, summary: 'без ошибок' }; // tsc молчит, когда ошибок нет
}

const BUILD_FAIL = /(?:^|\n)\s*(?:Exit code [1-9]|npm ERR!|make: \*\*\*|(?:Error|ERROR)[: ])|\bBuild failed\b|\bFAILED\b|error TS\d+/;

function buildVerdict(tail, exitCode, isError) {
  if (isError || (exitCode != null && exitCode !== 0) || BUILD_FAIL.test(tail)) return { ok: false, summary: 'сборка упала' };
  return { ok: true, summary: 'сборка прошла' };
}

function diffVerdict(tail) {
  const m = /(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/.exec(tail);
  if (!m) return tail.trim() ? { ok: null, summary: 'итог не определён' } : { ok: true, summary: 'без изменений' };
  const files = +m[1];
  return { ok: true, summary: `${files} ${plural(files, 'файл', 'файла', 'файлов')}, +${m[2] || 0}, -${m[3] || 0}` };
}

// Вердикт по выводу проверки. kind из classifyCommand, output - текст результата, isError - флаг результата
// (красный флаг верен, зелёному верить нельзя). Возвращает { kind, ok, summary }, ok: true | false | null.
function parseVerdict(kind, output, isError) {
  const raw = String(output == null ? '' : output);
  const head = /^\s*Exit code (\d+)/.exec(raw.slice(0, 80));
  const exitCode = head ? +head[1] : null;
  let tail = raw.slice(-TAIL * 4); // цветовые коды раздувают вывод, поэтому берём с запасом
  if (tail.includes('\x1b')) tail = tail.replace(ANSI, '');
  tail = tail.slice(-TAIL);
  let v;
  if (kind === 'tests') {
    v = parseTests(tail);
    // итога в тексте нет (вывод пропущен через grep или tail): красному is_error верим, зелёному нет
    if (!v) v = isError || (exitCode != null && exitCode !== 0) ? { ok: false, summary: 'тесты завершились с ошибкой' } : { ok: null, summary: 'итог не определён' };
  } else if (kind === 'types') {
    v = typesVerdict(tail);
  } else if (kind === 'build') {
    v = buildVerdict(tail, exitCode, isError);
  } else if (kind === 'diff') {
    v = diffVerdict(tail);
  } else {
    v = { ok: null, summary: 'итог не определён' };
  }
  return { kind, ok: v.ok, summary: v.summary };
}

module.exports = { classifyCommand, parseVerdict, TAIL };
