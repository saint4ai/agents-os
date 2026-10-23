// Строки интерфейса, помощники форматирования, разбор markdown и подсветка поиска.
// Текст транскриптов везде экранируется (esc) до попадания в разметку.

export const T = {
  appTitle: 'Agents OS',
  searchProjects: 'Найти проект',
  searchAny: 'Найти проект или задачу',
  searchFeed: 'Поиск в переписке',
  themeToLight: 'Светлая тема',
  themeToDark: 'Тёмная тема',
  liveTitle: 'Работают сейчас во всех проектах. Нажмите, чтобы открыть',
  liveCount: (n) => `${n} в работе`,
  projectsEmpty: 'Проектов пока нет. Запустите агента в любой папке, и она появится',
  projectsNone: 'Нет проектов с таким названием',
  sideLive: 'Работают',
  sideRecent: 'Недавние',
  sideOthers: 'Остальные',
  sideMoreRail: 'Все проекты',
  working: 'в работе',
  done: 'готово',
  error: 'ошибка',
  testsFailed: 'тесты не прошли',
  tabs: { project: 'Проект', tree: 'Цепочка', now: 'Сейчас' },
  levels: { now: 'ВСЕ ПРОЕКТЫ', project: 'ПРОЕКТ', tree: 'ЦЕПОЧКА ЗАПУСКА' },
  nowTitle: 'Что делают агенты сейчас',
  session: 'Сессия',
  sessionShown: 'Показана сессия:',
  chooseProjectHint: 'Карта строится, когда вы открываете проект: переписки читаются по частям и только нужные.',
  clickHint: 'Нажмите на строку: откроется отчёт',
  treeCaption: 'Линия идёт от того, кто запустил, к тому, кого запустили. Зелёная: запущенный сейчас работает.',
  building: 'Читаю проект…',
  buildingSub: 'Читаю переписки агентов по частям. Первый раз дольше.',
  retry: 'Повторить',
  loadFailed: 'Проект не открылся',
  emptyProject: 'В этом проекте ещё не запускали агентов',
  emptyTree: 'Эта сессия никого не запускала: ни помощников, ни GLM',
  showMore: 'Показать ещё',
  showLess: 'Свернуть',
  truncated: (s, t) => `Показаны ${s} последних сессий из ${t}. Остальные открываются по одной через список «Сессия» во вкладке «Цепочка».`,
  launchedFrom: 'Запустил:',
  glmVia: 'через Z.ai',
  modelsHere: 'Модели в сессии',
  models: 'Модели',
  modelAll: 'Все',
  liveZone: 'В работе',
  doneZone: 'Готово',
  doneErrors: (n) => `ошибок ${n}`,
  sortNew: 'Новые',
  sortModel: 'По моделям',
  now: 'Сейчас:',
  liveEmpty: (task, ago) => `Сейчас никто не работает. Последним закончил «${task}», ${ago}.`,
  liveEmptyNone: 'Сейчас никто не работает.',
  liveEmptyFilter: 'Среди выбранных моделей сейчас никто не работает.',
  openReport: 'Открыть отчёт',
  recentZone: 'Готово за 2 часа',
  linksTitle: 'Связи между проектами',
  linksNone: 'Агенты пока не запускали друг друга между проектами. Связи появляются, когда вы откроете проект.',
  feedEmpty: 'Выберите агента в списке, чтобы увидеть отчёт',
  feedTabs: { all: 'Всё', messages: 'Диалог', glm: 'Задачи для GLM', send: 'Между агентами', agents: 'Запуски агентов', files: 'Файлы' },
  earlier: 'Показать ранее',
  loadingEarlier: 'Загружаю…',
  toLatest: 'К последнему сообщению',
  live: 'идёт сейчас',
  thinking: 'Размышления',
  toolInput: 'Что передали',
  toolResult: 'Результат',
  toolPending: 'Выполняется…',
  tzText: 'Текст ТЗ',
  toolGlm: 'Запуск GLM',
  noEvents: 'Здесь пока пусто. Выберите «Всё» или измените поиск.',
  feedFailed: 'Переписка не загрузилась',
  openFeed: 'Открыть переписку',
  toReport: '← К отчёту',
  toList: '← К списку',
  linksFrom: 'Откуда запускают',
  linksTo: 'Куда запускают',
  sendsIn: (n) => `${n} сообщ.`,
  glmRuns: (n) => `${n} ${plural(n, 'запуск', 'запуска', 'запусков')}`,
  wireSend: 'сообщение',
  wireAgain: 'повторный запуск',
  lastAnswer: 'последний ответ',
  taskOf: (n) => `задача ${n} из ${n}`, // сессию GLM продолжают через --resume: показана последняя из n задач
  taskPrev: (n) => `Прошлые задачи (${n})`,
  running: 'идёт',
  leaves: (n) => `ещё ${n} ${plural(n, 'завершённый агент', 'завершённых агента', 'завершённых агентов')}`,
  leavesHide: 'Свернуть завершённых',
  tokens: (n) => `${fmtTok(n)} ${plural(Math.floor(n) >= 1000 ? 5 : n, 'токен', 'токена', 'токенов')}`,
  close: 'Закрыть',
  menu: 'Проекты',
  more: 'Настройки вида',
  density: 'Размер строк',
  compact: 'Плотно',
  comfortable: 'Свободно',
  railCollapse: 'Свернуть колонку проектов',
  railExpand: 'Развернуть колонку проектов',
  pin: 'Закрепить панель справа',
  unpin: 'Открепить панель',
  refresh: 'Обновить сейчас',
  hidePaths: 'Скрыть пути',
  showIntro: 'Как читать карту',
  fit: 'Показать всё',
  zoomIn: 'Крупнее',
  zoomOut: 'Мельче',
  zoomHint: 'Масштаб: Ctrl или ⌘ и колесо, либо щипок на трекпаде',
  roles: { main: 'главный', helper: 'помощник', glm: 'GLM' },
  teamBrain: 'Мозг:',
  teamExecs: 'исполнители:',
  teamNone: 'пока никого',
  brainMark: 'мозг',
  offTeam: 'не в команде',
  wireRole: 'исполнитель',
  intro: {
    title: 'Как читать карту',
    p1: ['Сверху то, что работает сейчас.', ' Ниже то, что уже закончено.'],
    p2: ['Нажмите на агента:', ' откроется отчёт. Что ему поручили, что он сделал, какие тесты прошли.'],
    p3: ['Цвет показывает, кто работает:', ' Claude, GLM или GPT. Модель написана рядом.'],
    ok: 'Понятно',
  },
};

export const $ = (sel, root) => (root || document).querySelector(sel);

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const nf = new Intl.NumberFormat('ru-RU');
export const fmtInt = (n) => nf.format(n);

export function fmtDur(ms) {
  if (!ms || ms < 1000) return '0 с';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' с';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' мин';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' ч ' + String(m % 60).padStart(2, '0') + ' мин';
  const d = Math.floor(h / 24);
  return d + ' д ' + (h % 24) + ' ч';
}

// Только старшая единица: «7 д», «3 ч», «23 мин». Для однострочных списков.
export function fmtDurShort(ms) {
  if (!ms || ms < 1000) return '0 с';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' с';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' мин';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' ч';
  return Math.floor(h / 24) + ' д';
}

export function fmtTok(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace('.', ',') + ' тыс.';
  return (n / 1e6).toFixed(1).replace('.', ',') + ' млн';
}

export function fmtTime(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const hm = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return hm;
  return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
}

// «14 с назад», «3 мин назад»: для строки «Сейчас: правит …» нужна точность до секунд.
export function agoSec(ms) {
  const d = Math.max(0, Date.now() - ms);
  if (d < 60000) return Math.floor(d / 1000) + ' с назад';
  return ago(ms);
}

export function ago(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return 'только что';
  if (d < 3600000) return Math.floor(d / 60000) + ' мин назад';
  if (d < 86400000) return Math.floor(d / 3600000) + ' ч назад';
  return Math.floor(d / 86400000) + ' д назад';
}

// claude-opus-5-5[1m] → «Opus 5.5»; claude-sonnet-4-5-20250929 → «Sonnet 4.5»
export function shortModel(model) {
  if (!model) return '';
  const m = /(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model);
  if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
  return String(model).replace(/^claude-/, '').replace(/\[.*\]$/, '');
}

// Заголовок задачи без префиксов «ЦЕЛЬ:» и «GLM ·»: роль агента уже видна в бейдже, а префикс съедает первые символы.
// У задачи GLM по шаблону ТЗ после цели идут КОНТЕКСТ, МОЖНО МЕНЯТЬ и так далее: в заголовок идёт только цель.
const TZ_LABELS = /\s(?:КОНТЕКСТ|МОЖНО МЕНЯТЬ|НЕЛЬЗЯ|ГОТОВО,? КОГДА|ПРОВЕРКА)\s*:/;
export function displayTitle(t) {
  const raw = String(t == null ? '' : t);
  const goal = /^\s*ЦЕЛЬ\s*:/i.test(raw) ? raw.split(TZ_LABELS)[0] : raw;
  const s = goal.replace(/^\s*(?:ЦЕЛЬ\s*:|GLM\s*·)\s*/i, '').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(t || '');
}

// Пути /Users/имя/… и /home/имя/… заменяются на ~/…, пока включён переключатель «Скрыть пути» (для записи экрана).
let hidePaths = false;
export function setHidePaths(v) { hidePaths = !!v; }
export function pathText(p) {
  const s = String(p == null ? '' : p);
  return hidePaths ? s.replace(/^\/(?:Users|home)\/[^/]+/, '~') : s;
}

// Главная сессия живёт днями: длительность «6 д 1 ч» ничего не говорит, поэтому у неё «последний ответ».
// У помощника и GLM одна задача, для них «идёт 8 мин» или «8 мин».
export function isMain(node) {
  return (node.kind === 'session' && node.provider !== 'glm') || node.durationMs > 24 * 3600 * 1000;
}

export function timeNote(node, working) {
  if (isMain(node)) return `${T.lastAnswer} ${fmtTime(node.lastMs)}`;
  return working ? `${T.running} ${fmtDur(node.durationMs)}` : fmtDur(node.durationMs);
}

// Подпись модели для бейджа строки: Sonnet 5.5, GLM, GPT. У провайдера из конфига - label
// профиля (DeepSeek), полное имя модели остаётся в подсказке строки.
export function rowBadgeText(node) {
  if (node.provider === 'glm') return 'GLM';
  if (node.provider === 'claude') return shortModel(node.model) || 'Claude';
  return (node.group && node.group.label) || node.provider;
}

/* ---------- markdown (текст всегда экранируется) ---------- */

function mdInline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return h;
}

function mdTable(rows) {
  const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(1).filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
  let h = '<table><thead><tr>' + head.map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of body) h += '<tr>' + cells(r).map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>';
  return h + '</tbody></table>';
}

function mdProse(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  const isUl = (l) => /^\s*[-*]\s+/.test(l);
  const isOl = (l) => /^\s*\d+[.)]\s+/.test(l);
  const isTable = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isBlock = (l) => l && (/^#{1,6}\s/.test(l) || isUl(l) || isOl(l) || isTable(l));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (isUl(line)) {
      const items = [];
      while (i < lines.length && isUl(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      out.push('<ul>' + items.map((x) => `<li>${mdInline(x)}</li>`).join('') + '</ul>');
      continue;
    }
    if (isOl(line)) {
      const items = [];
      while (i < lines.length && isOl(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
      out.push('<ol>' + items.map((x) => `<li>${mdInline(x)}</li>`).join('') + '</ol>');
      continue;
    }
    if (isTable(line)) {
      const rows = [];
      while (i < lines.length && isTable(lines[i])) { rows.push(lines[i]); i++; }
      out.push(mdTable(rows));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) { para.push(lines[i]); i++; }
    out.push('<p>' + mdInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
  }
  return out.join('');
}

export function mdRender(text) {
  const parts = String(text == null ? '' : text).split('```');
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      let code = parts[i];
      const nl = code.indexOf('\n');
      if (nl !== -1 && nl <= 30) code = code.slice(nl + 1);
      html += `<pre><code>${esc(code)}</code></pre>`;
    } else {
      html += mdProse(parts[i]);
    }
  }
  return html;
}

/* ---------- подсветка поиска по текстовым узлам ---------- */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function highlight(root, query) {
  if (!query) return;
  const rx = new RegExp(escapeRe(query), 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    if (node.parentElement && node.parentElement.closest('mark')) continue;
    rx.lastIndex = 0;
    if (!rx.test(node.nodeValue)) continue;
    rx.lastIndex = 0;
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = rx.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(el('mark', null, m[0]));
      last = m.index + m[0].length;
      if (m[0].length === 0) rx.lastIndex++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

export async function api(url) {
  let r;
  try {
    r = await fetch(url);
  } catch {
    throw new Error('Сервер не отвечает. Проверьте, что консоль запущена.');
  }
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error((data && data.error) || 'Ошибка ' + r.status);
  return data;
}
