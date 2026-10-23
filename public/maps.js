// Общие детали карты и два вида с проводами: дерево сессии («Цепочка») и связи между проектами («Сейчас»).
// Вид «Проект» и зоны «В работе» и «Готово» живут в zones.js. Провод «пульсирует», пока запущенный агент работает.

import { T, el, plural, shortModel, pathText, displayTitle, timeNote } from './util.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/* ---------- мелкие детали ---------- */

// Статус кодируется формой и цветом: работает - залитая пульсирующая точка, готов - пустое кольцо,
// ошибка - красный квадрат. Слово статуса есть в aria-label и подсказке.
export function led(status) {
  const s = el('span', 'led ' + status);
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', T[status] || status);
  return s;
}

// Диод внутри заголовка или кнопки со словом статуса: повторять слово для чтения с экрана не нужно.
export function dot(status) {
  const d = led(status);
  d.removeAttribute('role');
  d.removeAttribute('aria-label');
  d.setAttribute('aria-hidden', 'true');
  return d;
}

export function providerBadge(provider, label) {
  const names = { claude: 'Claude', glm: 'GLM', gpt: 'GPT', gemini: 'Gemini' };
  return el('span', 'pbadge p-' + provider, label || names[provider] || provider);
}

export function modelText(node) {
  if (node.provider === 'glm') return T.glmVia;
  if (node.provider === 'claude') return shortModel(node.model) || (node.group && node.group.sub) || '';
  return node.model || '';
}

// Короткий бейдж «вид ИИ · модель» для однострочных списков: Opus, Sonnet, Haiku, GLM, GPT.
export function modelBadge(node) {
  const g = node.group || {};
  const text = node.provider === 'claude' ? (g.label || 'Claude').replace(/^Claude\s*/, '') || 'Claude' : g.label || node.provider;
  const b = el('span', 'pbadge p-' + node.provider, text);
  b.title = (node.providerLabel || node.provider) + (modelText(node) ? ' · ' + modelText(node) : '');
  return b;
}

export function nodeTooltip(node) {
  const parts = [displayTitle(node.title) + (node.taskCount ? ` (${T.taskOf(node.taskCount)})` : ''), `${T[node.status]} · ${node.providerLabel || node.provider}${modelText(node) ? ' · ' + modelText(node) : ''}`, `${timeNote(node, node.status === 'working')} · ${T.tokens(node.tokens.in + node.tokens.out)}`];
  if (node.models && Object.keys(node.models).length > 1) parts.push(T.modelsHere + ': ' + Object.entries(node.models).map(([m, n]) => `${m} × ${n}`).join(', '));
  const lf = node.launchedFrom;
  if (lf && lf.project) parts.push(`${T.launchedFrom} ${lf.project.name} · ${lf.sessionTitle}${lf.task ? ' (' + lf.task + ')' : ''}`);
  if (node.project) parts.push(pathText(node.project.path || node.project.name));
  return parts.join('\n');
}

/* ---------- карточка узла: две строки ---------- */

export function nodeCard(node, ctx) {
  const c = ctx || {};
  const dim = c.match && !c.match(node);
  const card = el('button', 'card st-' + node.status + ' p-' + node.provider + (c.selectedId === node.id ? ' selected' : '') + (node.external ? ' external' : '') + (dim ? ' dim' : ''));
  card.type = 'button';
  card.dataset.id = node.id;
  card.title = nodeTooltip(node);
  card.addEventListener('click', () => c.onSelect && c.onSelect(node));

  const l1 = el('span', 'card-l1');
  l1.append(led(node.status), el('span', 'card-title', displayTitle(node.title)));
  if (c.showProject || node.external) l1.append(el('span', 'chip-project', node.project.name));
  card.append(l1);

  // вид ИИ несут цвет модели и боковая полоска; бейдж с подписью стоит в заголовке группы и в ленте
  const l2 = el('span', 'card-l2 num');
  const mt = modelText(node);
  if (mt) l2.append(el('span', 'card-model', mt), el('span', 'sep', '·'));
  l2.append(el('span', 'card-dur', timeNote(node, node.status === 'working')));
  if (node.sendsIn) l2.append(el('span', 'card-send', T.sendsIn(node.sendsIn)));
  if (node.glmRuns > 1) l2.append(el('span', 'card-send', T.glmRuns(node.glmRuns)));
  card.append(l2);

  // запуск из другого проекта виден прямо на карточке
  const lf = node.launchedFrom;
  if (lf && lf.project && node.project && lf.project.key !== node.project.key) {
    const from = el('span', 'card-from');
    from.append(document.createTextNode(T.launchedFrom + ' '), el('b', null, lf.project.name), document.createTextNode(' · ' + lf.sessionTitle));
    card.append(from);
  }
  // исполнитель вне team.json: запуск - факт из переписки, рисуется всегда; роль - отдельный слой
  // роль показываем на карточке, а не на проводе: между колонками нет места под подпись
  if (c.team && node.executor && c.team.offTeam && c.team.offTeam.has(node.provider)) {
    card.append(el('span', 'tm-offteam', T.offTeam));
  } else if (c.team && node.executor) {
    card.append(el('span', 'tm-exec', T.wireRole));
  }
  return card;
}

/* ---------- провода ---------- */

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
}

// Ломаная со скруглёнными углами: у соседей общий вертикальный ствол, дерево читается как схема, а не как пучок линий.
function elbowPath(x1, y1, x2, y2) {
  const r = 6;
  const dy = y2 - y1;
  if (Math.abs(dy) < 2 * r || x2 - x1 < 4 * r) return `M${x1},${y1} L${x2},${y2}`;
  const xm = x1 + Math.min(22, (x2 - x1) / 2);
  const s = dy > 0 ? 1 : -1;
  return `M${x1},${y1} H${xm - r} Q${xm},${y1} ${xm},${y1 + s * r} V${y2 - s * r} Q${xm},${y2} ${xm + r},${y2} H${x2}`;
}

// pairs: [{ a, b, cls, label, elbow }]; провод идёт от правого края a к левому краю b.
// getScale: текущий масштаб холста, getBoundingClientRect отдаёт уже масштабированные размеры.
function drawWires(canvas, svg, pairs, getScale) {
  svg.replaceChildren();
  const k = getScale ? getScale() : 1;
  const cr = canvas.getBoundingClientRect();
  svg.setAttribute('width', canvas.offsetWidth);
  svg.setAttribute('height', canvas.offsetHeight);
  for (const p of pairs) {
    if (!p.a.isConnected || !p.b.isConnected) continue;
    const a = p.a.getBoundingClientRect();
    const b = p.b.getBoundingClientRect();
    const x1 = (a.right - cr.left) / k;
    const y1 = (a.top + a.height / 2 - cr.top) / k;
    const x2 = (b.left - cr.left) / k;
    const y2 = (b.top + b.height / 2 - cr.top) / k;
    const dx = Math.max(20, (x2 - x1) / 2);
    const d = p.elbow ? elbowPath(x1, y1, x2, y2) : `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    svg.append(svgEl('path', { d, class: 'wire ' + (p.cls || '') }));
    svg.append(svgEl('circle', { cx: x2, cy: y2, r: 2, class: 'wire-end ' + (p.cls || '') }));
    if (p.label) {
      // подпись роли - у середины горизонтального участка провода (у elbow это сегмент перед
      // карточкой цели), с подложкой фоном холста, чтобы не читалась сквозь карточки
      let lx = (x1 + x2) / 2;
      let ly = (y1 + y2) / 2 - 5;
      if (p.elbow && x2 - x1 >= 24) {
        const xm = x1 + Math.min(22, (x2 - x1) / 2);
        lx = (xm + x2) / 2;
        ly = y2 - 7;
      }
      const t = svgEl('text', { x: lx, y: ly, class: 'wire-label' + (p.labelCls ? ' ' + p.labelCls : ''), 'text-anchor': 'middle' });
      t.textContent = p.label;
      svg.append(t);
    }
  }
}

function attachWires(canvas, svg, build, getScale) {
  const redraw = () => drawWires(canvas, svg, build(), getScale);
  const ro = new ResizeObserver(redraw);
  ro.observe(canvas);
  requestAnimationFrame(redraw);
  return { redraw, destroy: () => ro.disconnect() };
}

function zoomCanvas(host, cls) {
  const sizer = el('div', 'zoom-sizer');
  const canvas = el('div', 'canvas ' + cls);
  sizer.append(canvas);
  host.append(sizer);
  return canvas;
}

/* ---------- группы по виду ИИ и модели ---------- */

export const GROUP_ORDER = ['claude-opus', 'claude-sonnet', 'claude-haiku', 'claude-other', 'claude-unknown', 'glm', 'gpt', 'gemini'];

export function groupNodes(nodes) {
  const map = new Map();
  for (const n of nodes) {
    const g = map.get(n.group.id) || { group: n.group, nodes: [] };
    g.nodes.push(n);
    map.set(n.group.id, g);
  }
  const out = [...map.values()];
  out.sort((a, b) => GROUP_ORDER.indexOf(a.group.id) - GROUP_ORDER.indexOf(b.group.id));
  return out;
}

export function countStatuses(nodes) {
  const c = { working: 0, done: 0, error: 0 };
  for (const n of nodes) c[n.status]++;
  return c;
}

/* ---------- дерево сессии ---------- */

const CARD_W = 244;
const GAP_X = 44;
const GAP_Y = 6;
const LEAF_FOLD_FROM = 3; // завершённых листьев у одного родителя: с этого числа сворачиваем в «ещё N»

// Какие узлы показать. Завершённые листья (без детей, готово, не выбраны) одного родителя сворачиваются в одну строку,
// пока родитель не раскрыт: в сессии из 39 агентов видны работающие ветки, а не список из 39 карточек. Ошибки остаются.
export function visibleNodes(view, selectedId, openParents) {
  const ids = new Set(view.nodes.map((n) => n.id));
  const parentOf = (n) => (n.parent && ids.has(n.parent) && n.id !== view.root ? n.parent : null);
  const hasKids = new Set();
  for (const n of view.nodes) {
    const p = parentOf(n);
    if (p) hasKids.add(p);
  }
  const foldable = new Map(); // родитель → завершённые листья
  for (const n of view.nodes) {
    const p = parentOf(n);
    if (p && n.status === 'done' && !hasKids.has(n.id) && n.id !== selectedId) {
      if (!foldable.has(p)) foldable.set(p, []);
      foldable.get(p).push(n);
    }
  }
  const hidden = new Set();
  const folds = []; // { parent, count, open }
  for (const [p, list] of foldable) {
    if (list.length < LEAF_FOLD_FROM) continue;
    const open = openParents && openParents.has(p);
    folds.push({ parent: p, count: list.length, open });
    if (!open) for (const n of list) hidden.add(n.id);
  }
  return { nodes: view.nodes.filter((n) => !hidden.has(n.id)), folds };
}

export function layoutTree(view, nodes) {
  const list = nodes || view.nodes;
  const ids = new Set(list.map((n) => n.id));
  const kids = new Map();
  for (const n of list) {
    const p = n.parent && ids.has(n.parent) && n.id !== view.root ? n.parent : null;
    if (p) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(n);
    }
  }
  for (const l of kids.values()) l.sort((a, b) => a.startMs - b.startMs);
  const pos = new Map();
  let row = 0;
  const seen = new Set();
  const walk = (n, depth) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    pos.set(n.id, { depth, row: row++ });
    for (const k of kids.get(n.id) || []) walk(k, depth + 1);
  };
  const rootNode = list.find((n) => n.id === view.root);
  if (rootNode) walk(rootNode, 0);
  for (const n of list) if (!seen.has(n.id)) walk(n, 1);
  return pos;
}

export function renderTree(host, view, ctx) {
  host.replaceChildren();
  const rootNode = view.nodes.find((n) => n.id === view.root);
  if (rootNode && rootNode.launchedFrom) {
    const lf = rootNode.launchedFrom;
    const b = el('button', 'launched-banner');
    b.type = 'button';
    b.title = lf.project.name + ' · ' + lf.sessionTitle;
    b.append(document.createTextNode(T.launchedFrom + ' '), el('span', 'chip-project', lf.project.name), el('span', 'banner-title', ' · ' + lf.sessionTitle + (lf.task ? ' (' + lf.task + ')' : '')));
    b.addEventListener('click', () => ctx.onOpenSession && ctx.onOpenSession(lf.sessionId, lf.project.key));
    host.append(b);
  }
  const vis = visibleNodes(view, ctx.selectedId, ctx.openLeaves);
  const pos = layoutTree(view, vis.nodes);
  // строки «ещё N завершённых» встают после поддерева родителя на глубину детей
  const rows = vis.nodes.slice().sort((a, b) => pos.get(a.id).row - pos.get(b.id).row).map((n) => ({ node: n, depth: pos.get(n.id).depth }));
  const lastRowOf = new Map(); // узел → индекс последней строки его поддерева
  const byId = new Map(vis.nodes.map((x) => [x.id, x]));
  rows.forEach((r, i) => {
    let cur = r.node;
    while (cur) {
      lastRowOf.set(cur.id, i);
      cur = cur.parent && byId.has(cur.parent) && cur.id !== view.root ? byId.get(cur.parent) : null;
    }
  });
  const items = rows.map((r) => ({ type: 'node', ...r }));
  for (const f of vis.folds.slice().sort((a, b) => (lastRowOf.get(b.parent) ?? -1) - (lastRowOf.get(a.parent) ?? -1))) {
    const at = lastRowOf.get(f.parent);
    const pd = pos.get(f.parent);
    if (at == null || !pd) continue;
    items.splice(at + 1, 0, { type: 'fold', fold: f, depth: pd.depth + 1 });
  }
  const maxDepth = Math.max(0, ...items.map((i) => i.depth));
  const canvas = zoomCanvas(host, 'tree');
  canvas.style.width = (maxDepth + 1) * (CARD_W + GAP_X) - GAP_X + 'px';
  const svg = svgEl('svg', { class: 'wires', 'aria-hidden': 'true' });
  canvas.append(svg);
  const els = new Map();
  const foldEls = [];
  for (const it of items) {
    let c;
    if (it.type === 'node') {
      c = nodeCard(it.node, Object.assign({}, ctx, { showProject: false }));
      els.set(it.node.id, c);
    } else {
      c = el('button', 'card more-leaves', it.fold.open ? T.leavesHide : T.leaves(it.fold.count));
      c.type = 'button';
      c.setAttribute('aria-expanded', it.fold.open ? 'true' : 'false');
      c.addEventListener('click', () => ctx.onToggleLeaves && ctx.onToggleLeaves(it.fold.parent));
      foldEls.push({ parent: it.fold.parent, el: c });
    }
    c.style.left = it.depth * (CARD_W + GAP_X) + 'px';
    c.style.width = CARD_W + 'px';
    canvas.append(c);
    it.el = c;
  }
  // высота карточек разная (третья строка у запущенных из другого проекта): расставляем по измеренной
  const place = () => {
    let y = 0;
    for (const it of items) {
      it.el.style.top = y + 'px';
      y += it.el.offsetHeight + GAP_Y;
    }
    canvas.style.height = Math.max(0, y - GAP_Y) + 'px';
  };
  place();

  const build = () => {
    const pairs = [];
    for (const n of vis.nodes) {
      if (!n.parent || !els.has(n.parent) || n.id === view.root) continue;
      pairs.push({ a: els.get(n.parent), b: els.get(n.id), elbow: true, cls: n.status === 'working' ? 'working' : n.status === 'error' ? 'error' : 'idle', label: null, labelCls: null });
    }
    for (const f of foldEls) if (els.has(f.parent)) pairs.push({ a: els.get(f.parent), b: f.el, elbow: true, cls: 'idle' });
    // вторичные связи видны только у выбранного узла: иначе дерево тонет в линиях; на линии подпись, что это
    for (const e of view.edges) {
      if (e.kind !== 'send' && e.kind !== 'glm-again') continue;
      if (e.from !== ctx.selectedId && e.to !== ctx.selectedId) continue;
      if (els.has(e.from) && els.has(e.to)) pairs.push({ a: els.get(e.from), b: els.get(e.to), cls: 'extra ' + e.kind, label: e.kind === 'send' ? T.wireSend : T.wireAgain });
    }
    return pairs;
  };
  const wires = attachWires(canvas, svg, build, ctx.getScale);
  return { canvas, wires, fluid: false, place };
}

/* ---------- связи между проектами (экран «Сейчас») ---------- */

export function renderLinks(host, data, ctx) {
  host.replaceChildren();
  const { projects, links } = data;
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const canvas = el('div', 'canvas allmap');
  const svg = svgEl('svg', { class: 'wires', 'aria-hidden': 'true' });
  canvas.append(svg);

  const head = el('div', 'all-head');
  head.append(el('h2', 'zone-title', T.linksTitle));
  canvas.append(head);

  const projCard = (p) => {
    const b = el('button', 'pcard' + (ctx.selectedKey === p.key ? ' selected' : ''));
    b.type = 'button';
    b.dataset.key = p.key;
    b.title = p.name + '\n' + pathText(p.path || '');
    const top = el('span', 'pcard-top');
    top.append(led(p.activeCount ? 'working' : 'done'), el('span', 'pcard-name', p.name));
    b.append(top);
    const meta = el('span', 'pcard-meta num');
    meta.append(el('span', null, `${p.sessions} ${plural(p.sessions, 'сессия', 'сессии', 'сессий')}`));
    if (p.activeCount) meta.append(el('span', 'sep', '·'), el('span', 'c-live', `${T.working} ${p.activeCount}`));
    b.append(meta);
    b.addEventListener('click', () => ctx.onOpenProject(p.key));
    return b;
  };

  const pairs = [];
  if (links.length) {
    const fromKeys = [...new Set(links.map((l) => l.from))];
    const toKeys = [...new Set(links.map((l) => l.to))];
    const cols = el('div', 'all-cols');
    const left = el('div', 'all-col');
    const right = el('div', 'all-col');
    left.append(el('div', 'all-col-label', T.linksFrom));
    right.append(el('div', 'all-col-label', T.linksTo));
    const elByKey = { from: new Map(), to: new Map() };
    for (const k of fromKeys) if (byKey.has(k)) { const c = projCard(byKey.get(k)); elByKey.from.set(k, c); left.append(c); }
    for (const k of toKeys) if (byKey.has(k)) { const c = projCard(byKey.get(k)); elByKey.to.set(k, c); right.append(c); }
    cols.append(left, el('div', 'all-gap'), right);
    canvas.append(cols);
    for (const l of links) {
      const a = elByKey.from.get(l.from);
      const b = elByKey.to.get(l.to);
      if (a && b) pairs.push({ a, b, cls: l.working ? 'working' : 'idle', label: T.glmRuns(l.count) });
    }
  } else {
    canvas.append(el('div', 'all-empty', T.linksNone));
  }
  host.append(canvas);
  return { canvas, wires: attachWires(canvas, svg, () => pairs, null), fluid: false };
}
