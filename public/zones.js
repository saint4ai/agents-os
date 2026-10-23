// Экраны «Сейчас» и «Проект»: сверху зона «В работе» (единственный фокус экрана), ниже «Готово» свёрнутой строкой.
// Строка агента в «В работе»: диод, бейдж модели, задача целиком, «Сейчас: …», время. В «Готово»: одна строка 32 px.
// Всё, что человек читает на карточке, это задача, поэтому заголовок идёт на всю ширину и переносится, а не обрезается.

import { T, el, ago, displayTitle, timeNote, rowBadgeText, agoSec, pathText } from './util.js';
import { led, dot, nodeTooltip, groupNodes, countStatuses, providerBadge } from './maps.js';

const LIVE_LIMIT = 4; // строк «В работе» без раскрытия
const DONE_LIMIT = 40; // строк «Готово» без раскрытия

const GROUP_NAME = { 'claude-opus': 'Opus', 'claude-sonnet': 'Sonnet', 'claude-haiku': 'Haiku', 'claude-other': 'Claude', 'claude-unknown': 'Claude', glm: 'GLM', gpt: 'GPT', gemini: 'Gemini' };

/* ---------- заголовок страницы, плашка, полоса «Модели» ---------- */

export function pageHead({ level, title, path, summary }) {
  const h = el('header', 'ph');
  h.append(el('div', 'ph-level', level));
  const top = el('div', 'ph-top');
  top.append(el('h1', 'ph-h1', title));
  if (path) {
    const p = el('span', 'ph-path', pathText(path));
    p.title = pathText(path);
    top.append(p);
  }
  h.append(top);
  if (summary) h.append(el('div', 'ph-sum num', summary));
  return h;
}

export function introPlate(onClose) {
  const box = el('section', 'intro');
  box.setAttribute('aria-label', T.intro.title);
  box.append(el('h2', 'intro-title', T.intro.title));
  const list = el('ol', 'intro-list');
  for (const [lead, rest] of [T.intro.p1, T.intro.p2, T.intro.p3]) {
    const li = el('li');
    li.append(el('b', null, lead), document.createTextNode(rest));
    list.append(li);
  }
  const ok = el('button', 'btn intro-ok', T.intro.ok);
  ok.type = 'button';
  ok.addEventListener('click', onClose);
  box.append(list, ok);
  return box;
}

// Полоса «Модели»: чипы-фильтры, они же легенда цветов (цвет = вид ИИ, модель написана рядом).
export function modelStrip(nodes, ctx) {
  const bar = el('div', 'models');
  bar.append(el('span', 'models-label', T.models));
  const chips = el('div', 'chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', T.models);
  const chip = (id, name, count, live, provider, title) => {
    const on = (ctx.modelFilter || null) === id;
    const b = el('button', 'chip' + (provider ? ' p-' + provider : '') + (on ? ' on' : ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (title) b.title = title;
    b.append(el('span', 'chip-name', name), el('span', 'chip-n num', String(count)));
    if (live) b.append(Object.assign(el('span', 'chip-dot'), { title: T.working }));
    b.addEventListener('click', () => ctx.onModel(on ? null : id));
    return b;
  };
  chips.append(chip(null, T.modelAll, nodes.length, false));
  for (const g of groupNodes(nodes)) {
    chips.append(chip(g.group.id, GROUP_NAME[g.group.id] || g.group.label, g.nodes.length, g.nodes.some((n) => n.status === 'working'), g.group.provider, g.group.sub || null));
  }
  bar.append(chips);
  return bar;
}

/* ---------- строки ---------- */

function row(node, ctx, cls) {
  const r = el('button', 'row ' + cls + (ctx.selectedId === node.id ? ' selected' : '') + (ctx.justDone && ctx.justDone.has(node.id) ? ' just-done' : ''));
  r.type = 'button';
  r.dataset.id = node.id;
  r.title = nodeTooltip(node);
  r.addEventListener('click', () => ctx.onSelect(node));
  return r;
}

const badge = (node) => el('span', 'pbadge p-' + node.provider, rowBadgeText(node));

// Имя провайдера для чипа ролей: label из /api/project, иначе известное имя,
// иначе профиль с заглавной.
const PNAME = { claude: 'Claude', glm: 'GLM', gpt: 'GPT', gemini: 'Gemini' };
const providerName = (e) => e.label || PNAME[e.provider] || (e.profile ? e.profile[0].toUpperCase() + e.profile.slice(1) : '');

// Правильные имена профилей берём с узлов карты (providerLabel): сервер отдаёт роли,
// а как пишется имя профиля - знают источники.
export function withLabels(team, nodes) {
  if (!team) return null;
  const labels = new Map();
  for (const n of nodes || []) if (n.providerLabel && !labels.has(n.provider)) labels.set(n.provider, n.providerLabel);
  const fix = (e) => (e.label || !labels.get(e.provider) ? e : Object.assign({}, e, { label: labels.get(e.provider) }));
  return { brain: fix(team.brain), executors: (team.executors || []).map(fix), source: team.source };
}

// Метка «мозг» у строки агента-мозга: роль из team.json (договорённость), а не факт запуска.
// Живёт в одной ячейке сетки с чипом модели: число колонок строки не меняется.
function badgeCell(node, ctx) {
  const cell = el('span', 'r-badges');
  cell.append(badge(node));
  if (ctx.brainProvider && node.provider === ctx.brainProvider && node.kind === 'session') {
    cell.append(el('span', 'tm-brain', T.brainMark));
  }
  return cell;
}

// Заголовок строки: задача, а у сессии GLM с несколькими задачами рядом отметка «задача 8 из 8».
function titleSpan(node) {
  const t = el('span', 'r-title', displayTitle(node.title));
  if (node.taskCount) {
    t.append(document.createTextNode(' '), Object.assign(el('span', 'r-task', T.taskOf(node.taskCount)), { title: T.taskPrev(node.taskCount - 1) }));
  }
  return t;
}

export function liveRow(node, ctx) {
  const r = row(node, ctx, 'row-live');
  const main = el('span', 'r-main');
  main.append(titleSpan(node));
  // «ждёт команду: 5 мин» уже несёт время, второй раз «5 мин назад» не нужно
  if (node.lastStep) main.append(el('span', 'r-step', `${T.now} ${node.lastStep}` + (/^ждёт/.test(node.lastStep) ? '' : ` · ${agoSec(node.lastMs)}`)));
  r.append(led('working'), badgeCell(node, ctx), main);
  if (ctx.showProject && node.project) r.append(el('span', 'chip-project r-proj', node.project.name));
  r.append(el('span', 'r-time num', timeNote(node, true)), el('span', 'r-chev', '›'));
  return r;
}

function verdictOf(node) {
  if (node.status === 'error') return ['error', T.error];
  if (node.testsOk === false) return ['tests', T.testsFailed];
  return ['ok', T.done];
}

export function doneRow(node, ctx) {
  const r = row(node, ctx, 'row-done');
  const [kind, word] = verdictOf(node);
  r.append(led(node.status === 'error' ? 'error' : 'done'), badgeCell(node, ctx), titleSpan(node));
  if (ctx.showProject && node.project) r.append(el('span', 'chip-project r-proj', node.project.name));
  r.append(el('span', 'r-time num', timeNote(node, false)), el('span', 'r-verdict v-' + kind, word), el('span', 'r-chev', '›'));
  return r;
}

/* ---------- зоны ---------- */

// «В работе»: дольше всех идущий сверху. emptyNote: что показать, если никого нет.
export function liveZone(nodes, ctx, empty) {
  const z = el('section', 'zone zone-live' + (nodes.length ? ' has' : ''));
  const head = el('div', 'zone-head');
  const title = el('h2', 'zone-title');
  title.append(dot(nodes.length ? 'working' : 'done'), document.createTextNode(`${T.liveZone} · ${nodes.length}`));
  head.append(title);
  if (nodes.length) head.append(el('span', 'zone-hint', T.clickHint));
  z.append(head);
  if (!nodes.length) {
    const e = el('div', 'zone-empty');
    e.append(el('span', null, empty.text));
    if (empty.node) {
      const b = el('button', 'btn zone-open', T.openReport);
      b.type = 'button';
      b.addEventListener('click', () => ctx.onSelect(empty.node));
      e.append(b);
    }
    z.append(e);
    return z;
  }
  const sorted = nodes.slice().sort((a, b) => a.startMs - b.startMs);
  const shown = ctx.liveAll ? sorted : sorted.slice(0, LIVE_LIMIT);
  const body = el('div', 'zone-body');
  for (const n of shown) body.append(liveRow(n, ctx));
  z.append(body);
  if (sorted.length > LIVE_LIMIT) {
    const more = el('button', 'btn more', ctx.liveAll ? T.showLess : `${T.showMore} ${sorted.length - LIVE_LIMIT}`);
    more.type = 'button';
    more.addEventListener('click', ctx.onToggleLive);
    z.append(more);
  }
  return z;
}

// Сначала ошибки и «тесты не прошли», дальше новые.
const attention = (n) => (n.status === 'error' || n.testsOk === false ? 0 : 1);
const byNew = (a, b) => b.lastMs - a.lastMs;

// «Готово»: свёрнуто по умолчанию, выбор запоминается. opts: { title, sortable }.
export function doneZone(nodes, ctx, opts) {
  const o = opts || {};
  if (!nodes.length) return null;
  const open = ctx.doneOpen || !!ctx.forceOpen;
  const z = el('section', 'zone zone-done' + (open ? ' open' : ''));
  const errors = nodes.filter((n) => n.status === 'error').length;
  const title = el('h2', 'zone-title');
  const toggle = el('button', 'zone-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.append(el('span', 'zone-chev', open ? '▾' : '▸'), el('span', null, `${o.title || T.doneZone} · ${nodes.length}`));
  if (errors) toggle.append(el('span', 'zone-sep', '·'), el('span', 'zone-err', T.doneErrors(errors)));
  toggle.addEventListener('click', ctx.onToggleDone);
  title.append(toggle);
  const head = el('div', 'zone-head');
  head.append(title);
  if (open && o.sortable) {
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'group');
    for (const [id, label] of [['new', T.sortNew], ['model', T.sortModel]]) {
      const b = el('button', 'seg-btn' + (ctx.doneSort === id ? ' on' : ''), label);
      b.type = 'button';
      b.setAttribute('aria-pressed', ctx.doneSort === id ? 'true' : 'false');
      b.addEventListener('click', () => ctx.onSort(id));
      seg.append(b);
    }
    head.append(seg);
  }
  z.append(head);
  if (!open) return z;

  const body = el('div', 'zone-body');
  if (o.sortable && ctx.doneSort === 'model') {
    for (const g of groupNodes(nodes)) {
      body.append(el('h3', 'zone-sub', `${GROUP_NAME[g.group.id] || g.group.label} · ${g.nodes.length}`));
      for (const n of g.nodes.slice().sort((a, b) => attention(a) - attention(b) || byNew(a, b))) body.append(doneRow(n, ctx));
    }
  } else {
    const sorted = nodes.slice().sort((a, b) => attention(a) - attention(b) || byNew(a, b));
    for (const n of ctx.doneAll ? sorted : sorted.slice(0, DONE_LIMIT)) body.append(doneRow(n, ctx));
    if (sorted.length > DONE_LIMIT) {
      const more = el('button', 'btn more', ctx.doneAll ? T.showLess : `${T.showMore} ${sorted.length - DONE_LIMIT}`);
      more.type = 'button';
      more.addEventListener('click', ctx.onToggleDoneAll);
      body.append(more);
    }
  }
  z.append(body);
  return z;
}

// Текст пустой зоны «В работе»: кто закончил последним.
function emptyInfo(all, filtered) {
  if (filtered) return { text: T.liveEmptyFilter, node: null };
  const last = all.filter((n) => n.status !== 'working').sort(byNew)[0];
  if (!last) return { text: T.liveEmptyNone, node: null };
  const task = displayTitle(last.title);
  return { text: T.liveEmpty(task.length > 70 ? task.slice(0, 69) + '…' : task, ago(last.lastMs)), node: last };
}

/* ---------- экраны ---------- */

// Строка «Мозг: Claude · исполнители: GLM, Codex» в шапке проекта. Роли из team.json —
// договорённость: меняются разговором с агентом, не в интерфейсе. Чипы - в цвете провайдера,
// как в полосе «Модели».
export function teamLine(team) {
  if (!team) return null;
  const line = el('div', 'tm-line');
  line.append(el('span', 'tm-label', T.teamBrain), providerBadge(team.brain.provider, providerName(team.brain)));
  const execs = el('span', 'tm-execs');
  execs.append(el('span', 'tm-label', T.teamExecs));
  if (team.executors.length) {
    for (const e of team.executors) execs.append(providerBadge(e.provider, providerName(e)));
  } else {
    execs.append(el('span', 'tm-none', T.teamNone));
  }
  line.append(el('span', 'tm-sep', '·'), execs);
  return line;
}

// Вид «Проект». view - ответ /api/project; ctx.match - фильтр поиска, ctx.modelFilter - выбранная модель.
export function renderProjectPage(host, view, ctx) {
  host.replaceChildren();
  const nodes = view.nodes;
  const c = countStatuses(nodes);
  const page = el('div', 'page');
  page.append(pageHead({ level: T.levels.project, title: view.project.name, path: view.project.path, summary: `${c.working} ${T.working} · ${c.done + c.error} ${T.done}` }));
  if (ctx.intro) page.append(introPlate(ctx.onIntroClose));
  if (view.truncated) page.append(el('div', 'hint warn', T.truncated(view.truncated.shown, view.truncated.total)));
  const tl = teamLine(withLabels(view.team, nodes));
  if (tl) page.append(tl);
  page.append(modelStrip(nodes, ctx));
  const shown = nodes.filter((n) => (!ctx.modelFilter || n.group.id === ctx.modelFilter) && (!ctx.match || ctx.match(n)));
  const live = shown.filter((n) => n.status === 'working');
  page.append(liveZone(live, ctx, emptyInfo(nodes, !!ctx.modelFilter && nodes.some((n) => n.status === 'working'))));
  const dz = doneZone(shown.filter((n) => n.status !== 'working'), ctx, { sortable: true });
  if (dz) page.append(dz);
  host.append(page);
}

// Экран «Сейчас»: работающие по всем проектам (с чипом проекта), недавно закончившие свёрнуто, связи между проектами.
export function renderNowPage(host, data, ctx, linksHost) {
  host.replaceChildren();
  const page = el('div', 'page');
  page.append(pageHead({ level: T.levels.now, title: T.nowTitle }));
  if (ctx.intro) page.append(introPlate(ctx.onIntroClose));
  const rctx = Object.assign({}, ctx, { showProject: true });
  const live = data.live.filter((n) => !ctx.match || ctx.match(n));
  page.append(liveZone(live, rctx, emptyInfo(data.recent, false)));
  const dz = doneZone(data.recent.filter((n) => !ctx.match || ctx.match(n)), rctx, { title: T.recentZone });
  if (dz) page.append(dz);
  page.append(linksHost);
  host.append(page);
}
