'use strict';

// Отчёт агента: задача, что сделал, как выполнял, проверки. Транскрипт целиком не читается:
//   задача             - голова файла (readHead, до 256 КБ);
//   что сделал         - последнее сообщение ассистента из хвоста (readBackLines, до 3 МБ с конца);
//   как выполнял, проверки - из индекса файла (acc), который уже построен потоком.
// Разбор текста отчёта отделён от чтения файла: parseDid работает со строкой и проверяется отдельно.

const os = require('os');
const path = require('path');
const { relativeInside } = require('./paths');
const { readHead, readBackLines, HEAD_BYTES, MAX_LINE } = require('./lines');
const { parseLine } = require('./parse');
const { cleanBlocks } = require('./sources/claudeLike');

const TEXT_CAP = 30000; // полный текст в ответе не длиннее (как у ленты)
const BULLET_MAX = 5; // тезисов в секции
const BULLET_LEN = 160;
const STATUS_LEN = 240;
const PREVIEW_LINES = 3;
const PREVIEW_LEN = 400;
const MIN_REPORT_LEN = 40; // последнее сообщение короче не считается отчётом
const BACK_PASSES = [
  { lines: 80, bytes: 2 * 1024 * 1024 },
  { lines: 400, bytes: 1024 * 1024 },
];

/* ---------- текст ---------- */

function cut(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// Разметка в чистый текст: жирный, код, ссылки.
function stripMd(s) {
  return String(s || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Заголовки структурного отчёта. Порядок важен: «не сделано» и «сделано мимо» раньше «сделано».
const HEADS = [
  { key: 'notdone', label: 'Не сделано', re: /^(?:НЕ\s+СДЕЛАНО|ЧТО\s+НЕ\s+ПОЛУЧИЛОСЬ)/i },
  { key: 'files', label: 'Изменены файлы', re: /^ИЗМЕНЕНЫ\s+ФАЙЛЫ/i }, // формат отчёта GLM-исполнителя
  { key: 'verify', label: 'Проверка', re: /^ПРОВЕРК[АИ]/i },
  { key: 'risks', label: 'Вопросы и риски', re: /^(?:ВОПРОСЫ\s+И\s+)?РИСКИ/i },
  { key: 'extra', label: 'Сделано мимо плана', re: /^СДЕЛАНО\s+МИМО[^:\n]*/i },
  { key: 'done', label: 'Сделано', re: /^(?:ЧТО\s+)?СДЕЛАНО/i },
  { key: 'status', label: 'Статус', re: /^СТАТУС/i },
  { key: 'blockers', label: 'Блокеры', re: /^БЛОКЕРЫ/i },
  { key: 'decision', label: 'Нужно ваше решение', re: /^НУЖНО\s+(?:\S+\s+)?РЕШЕНИЕ/i },
  { key: 'next', label: 'Дальше', re: /^ДАЛЬШЕ(?:\s+Я)?/i },
];

// Строка → { key, inline } если это заголовок раздела. «Сделано полностью. Тесты…» заголовком не считается:
// после слова должны идти только пояснение через «/» или скобки, либо двоеточие.
function headOf(line) {
  let s = line.trim();
  if (!s) return null;
  s = s.replace(/^#{1,4}\s*/, '').replace(/^(\*\*|__)\s*/, '');
  for (const h of HEADS) {
    const m = h.re.exec(s);
    if (!m) continue;
    let rest = s.slice(m[0].length);
    if (/^\s*[/(]/.test(rest)) return { key: h.key, inline: '' };
    rest = rest.replace(/^(\*\*|__)/, '');
    if (/^\s*[:：]/.test(rest)) return { key: h.key, inline: stripMd(rest.replace(/^\s*[:：]\s*(\*\*|__)?/, '')) };
    if (!rest.replace(/[*_\s]/g, '')) return { key: h.key, inline: '' };
    return null;
  }
  return null;
}

// Текст → { pre, sections: [{key,label,lines}], structured }. Строки внутри ``` не анализируются.
function splitSections(text) {
  const pre = [];
  const sections = [];
  let cur = null;
  let fence = false;
  for (const raw of String(text).split('\n')) {
    if (/^\s*```/.test(raw)) fence = !fence;
    const h = fence ? null : headOf(raw);
    if (h) {
      cur = sections.find((x) => x.key === h.key);
      if (!cur) {
        cur = { key: h.key, label: HEADS.find((x) => x.key === h.key).label, lines: [] };
        sections.push(cur);
      }
      if (h.inline) cur.lines.push(h.inline);
      continue;
    }
    (cur ? cur.lines : pre).push(raw);
  }
  return { pre, sections, structured: sections.length >= 2 };
}

const LIST_RE = /^(\s*)(?:[-*•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/;
const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');

function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => stripMd(c));
}

// Таблица → строки: первая ячейка (если она короткий номер, то с второй) и ячейка «Доказательство», «Файл» или «Проверка».
function tableItems(rows) {
  const data = rows.filter((r) => !isTableSep(r));
  if (data.length < 2) return [];
  const head = cells(data[0]);
  const ev = head.findIndex((c, i) => i > 0 && /доказательств|файл|проверк/i.test(c));
  const out = [];
  for (const r of data.slice(1)) {
    const c = cells(r);
    let t = c[0] || '';
    if (t.length <= 6 && c[1] && ev !== 1) t += ' ' + c[1];
    if (ev > 0 && c[ev]) t += ' · ' + c[ev];
    if (t.trim()) out.push(t.trim());
  }
  return out;
}

// Строки раздела → тезисы: таблица, иначе пункты списка верхнего уровня, иначе первое предложение.
function bulletsOf(lines) {
  const body = [];
  let fence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) { fence = !fence; continue; }
    if (!fence) body.push(l);
  }
  const rows = body.filter(isTableRow);
  let items = [];
  if (rows.length >= 2) items = tableItems(rows);
  else {
    const list = body.map((l) => LIST_RE.exec(l)).filter(Boolean);
    if (list.length) {
      const min = Math.min(...list.map((m) => m[1].length));
      items = list.filter((m) => m[1].length <= min + 1).map((m) => stripMd(m[2]));
    } else {
      const lines = body.filter((l) => l.trim() && !isTableRow(l));
      // «путь: что сделано» по строке на пункт без маркеров (так пишет GLM): строка = тезис; один абзац = первое предложение
      if (lines.length >= 2) items = lines.map((l) => stripMd(l));
      else {
        const para = stripMd(lines.join(' '));
        if (para) items = [(para.split(/(?<=[.!?…])\s+/)[0] || para)];
      }
    }
  }
  items = items.filter(Boolean);
  return { bullets: items.slice(0, BULLET_MAX).map((x) => cut(x, BULLET_LEN)), more: Math.max(0, items.length - BULLET_MAX) };
}

function firstPara(lines) {
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) { if (out.length) break; continue; }
    if (/^#{1,6}\s/.test(t) && !out.length) continue;
    if (LIST_RE.test(l) || isTableRow(l)) break;
    out.push(t);
  }
  return stripMd(out.join(' '));
}

// GLM кладёт отчёт последним блоком ```: если внутри найдены заголовки отчёта, блок разворачивается в обычный текст.
// Блоки кода в середине сообщения и блоки без заголовков остаются как есть.
function unwrapReportFences(text) {
  const t = String(text).trimEnd();
  if (!t.endsWith('```')) return String(text);
  const close = t.length - 3;
  const open = t.lastIndexOf('```', close - 1);
  const nl = open === -1 ? -1 : t.indexOf('\n', open);
  if (nl === -1 || nl > close) return String(text);
  const inner = t.slice(nl + 1, close);
  return splitSections(inner).structured ? t.slice(0, open) + inner : String(text);
}

// Текст последнего сообщения → тезисы карточки. structured: найдено 2 и больше разных заголовков.
function parseDid(raw) {
  const text = unwrapReportFences(raw);
  const { pre, sections, structured } = splitSections(text);
  if (structured) {
    const st = sections.find((s) => s.key === 'status');
    const status = st ? firstPara(st.lines.concat('')) || stripMd(st.lines.find((l) => l.trim()) || '') : firstPara(pre);
    const out = [];
    for (const s of sections) {
      if (s.key === 'status' || s.key === 'next') continue;
      const b = bulletsOf(s.lines);
      if (b.bullets.length) out.push({ key: s.key, label: s.label, bullets: b.bullets, more: b.more });
    }
    return { structured: true, fallback: false, status: cut(status, STATUS_LEN) || null, sections: out };
  }
  // без разметки: первый абзац как статус, дальше пункты списка, без списка первые предложения
  const all = String(text).split('\n');
  const status = firstPara(all);
  const lines = all.slice();
  const first = lines.findIndex((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()));
  let end = first;
  while (end !== -1 && end < lines.length && lines[end].trim() && !LIST_RE.test(lines[end]) && !isTableRow(lines[end])) end++;
  const rest = end === -1 ? [] : lines.slice(end);
  let b = { bullets: [], more: 0 };
  if (rest.some((l) => LIST_RE.test(l))) b = bulletsOf(rest.filter((l) => LIST_RE.test(l)));
  else {
    const sentences = stripMd(rest.filter((l) => !isTableRow(l)).join(' ')).split(/(?<=[.!?…])\s+/).filter(Boolean);
    b = { bullets: sentences.slice(0, 3).map((x) => cut(x, BULLET_LEN)), more: 0 };
  }
  return {
    structured: false,
    fallback: true,
    status: cut(status, STATUS_LEN) || null,
    sections: b.bullets.length ? [{ key: 'points', label: 'Главное', bullets: b.bullets, more: b.more }] : [],
  };
}

/* ---------- чтение файла: голова и хвост ---------- */

// Сессию исполнителя продолжают через --resume: каждый новый запрос это новая задача, и показывать надо последнюю.
// У главной сессии и помощника задача одна, она берётся из головы файла.
const followsLastPrompt = (file) => file.kind === 'session' && file.adapter.executor === true;

// Запрос, который показан как задача сессии GLM: последний «ЦЕЛЬ: …», а без него последний запрос.
// Приёмки («Приёмка: ПРИНЯТО») заголовок не перекрывают, но остаются в списке прошлых задач.
function currentPrompt(acc) {
  if (acc.lastGoal) return acc.lastGoal;
  const p = acc.prompts[acc.prompts.length - 1];
  return p ? { title: acc.lastUser, end: acc.lastUserEnd, ts: p.ts } : null;
}

// Текст запроса пользователя из записи транскрипта (служебные записи и результаты инструментов не в счёт).
function promptOf(rec) {
  if (!rec || rec.type !== 'user' || rec.isMeta || rec.isCompactSummary) return null;
  const c = rec.message && rec.message.content;
  const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '';
  return cleanBlocks(raw).replace(/[ \t]+/g, ' ').trim() || null;
}

function taskOf(prompt, description, long) {
  const desc = description ? cut(stripMd(description), 200) : null;
  if (prompt == null) return { description: desc, preview: '', text: null, long };
  const preview = cut(prompt.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, PREVIEW_LINES).join('\n'), PREVIEW_LEN);
  const full = prompt.length > TEXT_CAP ? prompt.slice(0, TEXT_CAP) + '\n… (обрезано, полный текст в файле сессии)' : prompt;
  return { description: desc, preview, text: full.length > preview.length ? full : null, long: false };
}

// Задача агента: описание плюс первые 3 непустые строки запроса (до 400 знаков). По умолчанию это первый запрос
// из головы файла. lastEnd: смещение конца строки последнего запроса (из индекса), тогда читается одна эта строка.
async function readTask(file, description, lastEnd) {
  if (lastEnd > 0) {
    const back = await readBackLines(file.path, lastEnd, 1);
    let rec = null;
    try {
      rec = back.lines.length ? JSON.parse(back.lines[0].text) : null;
    } catch {
      rec = null;
    }
    const p = promptOf(rec);
    if (p) return taskOf(p, description, false);
  }
  const head = await readHead(file.path, HEAD_BYTES);
  const lines = head.split('\n');
  if (file.size > HEAD_BYTES) lines.pop(); // последняя строка обрезана границей чтения
  let prompt = null;
  for (const l of lines) {
    if (!l || l.length > MAX_LINE) continue;
    let rec;
    try {
      rec = JSON.parse(l);
    } catch {
      continue;
    }
    prompt = promptOf(rec);
    if (prompt) break;
  }
  return taskOf(prompt, description, prompt == null && file.size > HEAD_BYTES);
}

// Последнее сообщение ассистента с текстом длиннее 40 знаков: сначала 80 строк с конца, потом ещё 400.
// { text, tooLarge }: tooLarge - рядом с концом пропущены строки длиннее 1 МБ, а отчёта не нашлось.
async function lastAssistantText(file, parseRecord) {
  let end = null;
  let skipped = 0;
  for (const pass of BACK_PASSES) {
    const back = await readBackLines(file.path, end, pass.lines, MAX_LINE, pass.bytes);
    skipped += back.skipped;
    for (let i = back.lines.length - 1; i >= 0; i--) {
      const evs = parseLine(back.lines[i].text, parseRecord);
      for (let j = evs.length - 1; j >= 0; j--) {
        if (evs[j].kind === 'assistant' && evs[j].text.trim().length > MIN_REPORT_LEN) return { text: evs[j].text, tooLarge: false };
      }
    }
    if (back.reachedStart || !back.lines.length) break;
    end = back.startOffset;
  }
  return { text: null, tooLarge: skipped > 0 };
}

/* ---------- как выполнял, проверки ---------- */

const home = os.homedir();

// Путь для показа: внутри проекта относительный, внутри домашней папки с ~. Разделитель в показе всегда «/»,
// на Windows регистр букв и вид слэшей при сравнении не важны.
function relPath(p, cwd) {
  const inCwd = cwd && relativeInside(p, cwd);
  if (inCwd) return inCwd;
  const inHome = relativeInside(p, home);
  if (inHome) return '~/' + inHome;
  return p;
}

function howView(acc, cwd) {
  const all = Object.entries(acc.files).map(([p, f]) => ({ path: relPath(p, cwd), edits: f.edits, writes: f.writes }));
  all.sort((a, b) => b.edits + b.writes - (a.edits + a.writes) || a.path.localeCompare(b.path));
  const shown = all.slice(0, 5);
  const base = (p) => path.basename(p);
  const dup = new Set(shown.map((f) => base(f.path)).filter((n, i, a) => a.indexOf(n) !== i));
  for (const f of shown) f.name = dup.has(base(f.path)) ? f.path.split(/[\\/]/).slice(-2).join('/') : base(f.path);
  // команды: последние уникальные, по порядку
  const seen = new Set();
  const cmds = [];
  for (let i = acc.cmds.length - 1; i >= 0 && cmds.length < 6; i--) {
    if (!seen.has(acc.cmds[i])) { seen.add(acc.cmds[i]); cmds.unshift(acc.cmds[i]); }
  }
  return { files: shown, filesTotal: all.length, filesOver: !!acc.filesOver, cmds, tools: acc.toolCounts };
}

const CHECK_ORDER = ['tests', 'types', 'build', 'diff'];

// По одному виду проверки: последний итог и ряд последних запусков. Вызов без результата: ok null, pending.
function checksView(acc) {
  const out = [];
  for (const kind of CHECK_ORDER) {
    const runs = acc.checks.filter((c) => c.kind === kind);
    const pend = acc.pendingChecks.filter((p) => p.kind === kind);
    if (runs.length) {
      const last = runs[runs.length - 1];
      out.push({ kind, cmd: last.cmd, ok: last.ok, summary: last.summary, pending: false, runs: runs.slice(-3).map((r) => ({ ok: r.ok, summary: r.summary })) });
    } else if (pend.length) {
      out.push({ kind, cmd: pend[pend.length - 1].cmd, ok: null, summary: null, pending: true, runs: [] });
    }
  }
  return out;
}

// Итог последнего прогона тестов: true, false или null (не запускались или итог неясен).
function lastTests(acc) {
  for (let i = acc.checks.length - 1; i >= 0; i--) if (acc.checks[i].kind === 'tests') return acc.checks[i].ok;
  return null;
}

const roleOf = (file) => (file.kind === 'subagent' ? 'helper' : file.adapter.executor === true ? (file.adapter.provider === 'glm' ? 'glm' : 'executor') : 'main');

/* ---------- сборка ---------- */

// node - узел реестра (статус, модель, токены, запустивший), acc - готовый индекс файла.
async function buildReport({ file, node, acc }) {
  const working = node.status === 'working';
  const meta = file.meta || null;
  const rep = {
    id: file.id,
    status: node.status,
    role: roleOf(file),
    title: node.title,
    project: node.project,
    step: working ? node.lastStep || null : null,
    task: await readTask(file, meta && meta.description, followsLastPrompt(file) && currentPrompt(acc) ? currentPrompt(acc).end : 0),
    did: null,
    how: howView(acc, acc.cwd),
    checks: checksView(acc),
    summary: { durationMs: node.durationMs, lastMs: node.lastMs, usage: { in: node.tokens.in, out: node.tokens.out }, model: node.model },
    launcher: node.launchedFrom || null,
  };
  if (followsLastPrompt(file) && acc.userCount > 1) {
    // прошлые задачи сессии: только заголовки из индекса, без чтения файла
    rep.task.count = acc.userCount;
    // показанный запрос из списка убирается; если он старше хранимых 12, убирать нечего
    const shown = acc.lastGoal ? acc.prompts.findLastIndex((p) => p.goal) : acc.prompts.length - 1;
    rep.task.previous = acc.prompts.filter((_, i) => i !== shown).map((p) => cut(p.title, 140));
    rep.task.earlier = Math.max(0, acc.userCount - 1 - rep.task.previous.length);
  }
  if (!working) {
    const last = await lastAssistantText(file, file.adapter.parseRecord);
    if (last.text) {
      const d = parseDid(last.text);
      d.text = last.text.length > TEXT_CAP ? last.text.slice(0, TEXT_CAP) + '\n… (обрезано, полный текст в файле сессии)' : last.text;
      d.empty = null;
      rep.did = d;
    } else {
      rep.did = { empty: last.tooLarge ? 'toolarge' : 'none', structured: false, fallback: false, status: null, sections: [], text: null };
    }
  }
  return rep;
}

module.exports = { parseDid, readTask, lastAssistantText, howView, checksView, lastTests, buildReport, roleOf, followsLastPrompt, currentPrompt, TEXT_CAP };
