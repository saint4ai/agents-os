// Agents OS: состояние, навигация, шапка, левая колонка, опрос сервера.
// Три вида: «Сейчас» (что работает по всем проектам), «Проект» (зоны «В работе» и «Готово»), «Цепочка» (кто кого запустил).
// Справа выезжает панель агента: отчёт, по кнопке переписка.

import { T, $, el, plural, fmtTime, api, setHidePaths, pathText, displayTitle, rowBadgeText } from './util.js';
import { Feed } from './feed.js';
import { ReportPanel } from './report.js';
import { dot, renderTree, renderLinks } from './maps.js';
import { renderProjectPage, renderNowPage } from './zones.js';
import { attachZoom } from './zoom.js';

const WIDE = 1600; // с этой ширины панель агента можно закрепить колонкой
const NARROW = 700; // до этой ширины колонка проектов выезжает, панель на весь экран
const RECENT_PROJECTS = 5; // «Недавних» проектов в колонке

const S = {
  projects: [],
  team: null, // роли «мозг / исполнитель» из team.json (меняются разговором с агентом, не здесь)
  now: [], // работающие агенты по всем проектам
  recent: [], // недавно закончившие (за 2 часа)
  search: '',
  projectKey: null,
  view: 'now', // now | project | tree
  projectData: null,
  mapData: null,
  cross: [],
  sessionId: null,
  selectedId: null,
  pendingSelect: null,
  modelFilter: null,
  doneOpen: false, // «Готово» свёрнуто по умолчанию, выбор запоминается
  doneSort: 'new',
  liveAll: false,
  doneAll: false,
  openLeaves: new Set(), // родители, у которых раскрыты завершённые листья в «Цепочке»
  othersOpen: false,
  intro: true,
  hidePaths: false,
  zoom: 1,
  density: 'compact',
  rail: false,
  pin: false,
  loading: false,
  error: null,
  token: 0,
  zoomCtl: null,
  map: null,
  sigs: {},
  liveIds: new Set(), // кто был в «В работе» при прошлой отрисовке: для перехода в «Готово»
  liveFor: '',
  justDone: new Set(),
};

let feed;
let report;
let timer = null;
const ui = {}; // постоянные узлы шапки и панелей

/* ---------- настройки (localStorage, с запасным путём, если он недоступен) ---------- */

const store = {
  get(k, d) { try { const v = localStorage.getItem('agents-os-' + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('agents-os-' + k, v); } catch {} },
};

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (ui.theme) {
    ui.theme.textContent = theme === 'dark' ? '☀' : '☾';
    ui.theme.title = theme === 'dark' ? T.themeToLight : T.themeToDark;
    ui.theme.setAttribute('aria-label', ui.theme.title);
  }
}

function applyDensity(d) {
  S.density = d === 'comfortable' ? 'comfortable' : 'compact';
  document.documentElement.dataset.density = S.density;
  store.set('density', S.density);
}

function applyRail(on, persist) {
  S.rail = on;
  document.body.classList.toggle('rail', on);
  if (persist) store.set('rail', on ? '1' : '0'); // запоминаем только выбор пользователя, не автоматическое решение

  renderSide(true);
  if (ui.sideBtn) {
    ui.sideBtn.title = on ? T.railExpand : T.railCollapse;
    ui.sideBtn.setAttribute('aria-label', ui.sideBtn.title);
  }
  relayoutSoon();
}

function applyPin() {
  const pinned = S.pin && window.innerWidth >= WIDE;
  document.body.classList.toggle('feed-pinned', pinned);
  feed.setPinned(pinned);
  report.setPinned(pinned);
  relayoutSoon();
}

function applyHidePaths(on, persist) {
  S.hidePaths = on;
  setHidePaths(on);
  if (persist) store.set('hide-paths', on ? '1' : '0');
}

// размеры стейджа поменялись (колонка, панель, окно): карта пересчитывает ширину и провода
function relayoutSoon() {
  requestAnimationFrame(() => {
    if (S.zoomCtl) S.zoomCtl.relayout();
    if (S.map) S.map.wires.redraw();
  });
}

/* ---------- адрес ---------- */

function writeHash() {
  const p = new URLSearchParams();
  if (S.projectKey) p.set('p', S.projectKey);
  if (S.view !== 'now') p.set('v', S.view);
  if (S.sessionId && S.view === 'tree') p.set('s', S.sessionId);
  if (S.selectedId) p.set('n', S.selectedId);
  history.replaceState(null, '', '#' + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { p: p.get('p'), v: p.get('v'), s: p.get('s'), n: p.get('n') };
}

/* ---------- шапка: одна строка 40px ---------- */

function buildBar() {
  const bar = $('#bar');
  ui.sideBtn = el('button', 'icon-btn bar-side', '☰');
  ui.sideBtn.type = 'button';
  ui.sideBtn.addEventListener('click', () => {
    if (window.innerWidth <= NARROW) document.body.classList.toggle('side-open');
    else applyRail(!S.rail, true);
  });
  const brand = el('div', 'brand');
  brand.append(el('span', 'brand-mark'), el('span', 'brand-name', T.appTitle));
  ui.tabs = {};
  const nav = el('nav', 'tabs');
  nav.setAttribute('aria-label', 'Виды');
  for (const id of ['now', 'project', 'tree']) {
    const b = el('button', 'tab', T.tabs[id]);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (id === 'now') openNow();
      else if (id === 'project') openProject(S.projectKey || defaultProjectKey(), 'project');
      else openProject(S.projectKey || defaultProjectKey(), 'tree', S.view === 'tree' ? S.sessionId : null);
    });
    ui.tabs[id] = b;
    nav.append(b);
  }
  ui.liveBtn = el('button', 'live-count');
  ui.liveBtn.type = 'button';
  ui.liveBtn.title = T.liveTitle;
  ui.liveBtn.addEventListener('click', openNow);
  ui.search = el('input', 'bar-search');
  ui.search.type = 'search';
  ui.search.placeholder = T.searchAny;
  ui.search.title = T.searchAny;
  ui.search.setAttribute('aria-label', T.searchAny);
  ui.search.autocomplete = 'off';
  ui.search.spellcheck = false;
  let deb;
  ui.search.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      S.search = ui.search.value.trim();
      renderSide(true);
      renderStage(true);
    }, 150);
  });
  ui.theme = el('button', 'icon-btn');
  ui.theme.type = 'button';
  ui.theme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    store.set('theme', next);
    applyTheme(next);
  });
  ui.more = el('button', 'icon-btn bar-more', '⋯');
  ui.more.type = 'button';
  ui.more.title = T.more;
  ui.more.setAttribute('aria-label', T.more);
  ui.more.setAttribute('aria-haspopup', 'menu');
  ui.more.setAttribute('aria-expanded', 'false');
  ui.more.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  bar.append(ui.sideBtn, brand, nav, ui.liveBtn, el('div', 'bar-spacer'), ui.search, ui.theme, ui.more);
}

function updateBar() {
  for (const id of ['now', 'project', 'tree']) {
    const b = ui.tabs[id];
    b.classList.toggle('on', S.view === id);
    if (S.view === id) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const n = S.now.length;
  const sig = String(n);
  if (ui.liveBtn.dataset.sig !== sig) {
    ui.liveBtn.dataset.sig = sig;
    ui.liveBtn.classList.toggle('on', n > 0);
    ui.liveBtn.replaceChildren(dot(n ? 'working' : 'done'), el('span', 'num', T.liveCount(n)));
  }
}

/* ---------- меню «⋯»: стрелки, Esc, возврат фокуса на кнопку ---------- */

function menuItems() {
  return [...$('#menu').querySelectorAll('[role^="menuitem"]')];
}

function toggleMenu(force, returnFocus) {
  const m = $('#menu');
  const open = force != null ? force : m.hidden;
  if (!open) {
    if (m.hidden) return;
    m.hidden = true;
    ui.more.setAttribute('aria-expanded', 'false');
    if (returnFocus) ui.more.focus();
    return;
  }
  m.replaceChildren();
  const close = (fn) => () => { toggleMenu(false, true); fn(); };
  const item = (label, fn, role, checked) => {
    const b = el('button', 'menu-item');
    b.type = 'button';
    b.setAttribute('role', role || 'menuitem');
    if (role === 'menuitemcheckbox') {
      b.setAttribute('aria-checked', checked ? 'true' : 'false');
      b.append(el('span', null, label), el('span', 'menu-sw' + (checked ? ' on' : '')));
    } else b.textContent = label;
    b.addEventListener('click', close(fn));
    return b;
  };
  m.append(el('div', 'menu-label', T.density));
  const seg = el('div', 'menu-seg');
  seg.setAttribute('role', 'group');
  for (const [id, label] of [['compact', T.compact], ['comfortable', T.comfortable]]) {
    const b = el('button', 'menu-seg-btn' + (S.density === id ? ' on' : ''), label);
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', S.density === id ? 'true' : 'false');
    b.addEventListener('click', () => { applyDensity(id); toggleMenu(false, true); renderSide(true); renderStage(true); });
    seg.append(b);
  }
  m.append(seg);
  m.append(item(S.rail ? T.railExpand : T.railCollapse, () => applyRail(!S.rail, true)));
  if (window.innerWidth >= WIDE) m.append(item(S.pin ? T.unpin : T.pin, () => togglePin()));
  m.append(item(T.hidePaths, () => { applyHidePaths(!S.hidePaths, true); renderSide(true); renderStage(true); renderViewbar(); }, 'menuitemcheckbox', S.hidePaths));
  m.append(item(T.showIntro, () => { S.intro = true; store.set('intro', '0'); renderStage(true); }));
  m.append(item(T.refresh, () => { refreshProjects(); refreshNow(); if (S.view === 'tree') loadTree(); else if (S.view === 'project') loadProject(); else refreshCross(); }));
  m.hidden = false;
  ui.more.setAttribute('aria-expanded', 'true');
  const first = menuItems()[0];
  if (first) first.focus();
}

function onMenuKey(e) {
  const items = menuItems();
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = (i + 1) % items.length;
  else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (e.key === 'Tab') return toggleMenu(false, false);
  else return;
  e.preventDefault();
  items[next].focus();
}

function togglePin() {
  S.pin = !S.pin;
  store.set('pin', S.pin ? '1' : '0');
  applyPin();
  if (S.pin && !report.node && S.selectedId) {
    const n = findNode(S.selectedId);
    if (n) selectNode(n, true);
  }
}

/* ---------- левая колонка: только проекты ---------- */

function initials(name) {
  const words = String(name).split(/[\s\-_.]+/).filter(Boolean);
  const raw = words.length > 1 ? words[0][0] + words[1][0] : String(name).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2);
  return (raw || '?').toUpperCase();
}

// Инициалы на рельсе не должны совпадать: при совпадении берём три буквы, потом добавляем номер.
function uniqueInitials(names) {
  const used = new Set();
  return names.map((name) => {
    let v = initials(name);
    if (used.has(v)) v = String(name).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3).toUpperCase() || v;
    let n = 2;
    const base = v;
    while (used.has(v)) v = base + n++;
    used.add(v);
    return v;
  });
}

function filteredProjects() {
  const q = S.search.toLowerCase();
  return S.projects.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.path || '').toLowerCase().includes(q));
}

// «Работают» (по числу агентов), «Недавние» (пять последних), «Остальные».
function splitProjects(list) {
  const live = list.filter((p) => p.activeCount > 0).sort((a, b) => b.activeCount - a.activeCount || b.lastMs - a.lastMs);
  const rest = list.filter((p) => !p.activeCount);
  return { live, recent: rest.slice(0, RECENT_PROJECTS), others: rest.slice(RECENT_PROJECTS) };
}

const isRail = () => S.rail && window.innerWidth > NARROW; // в выдвижной колонке рельса нет

function projectTip(p) {
  return p.name + '\n' + pathText(p.path || '') + '\n' + `${p.sessions} ${plural(p.sessions, 'сессия', 'сессии', 'сессий')}, последняя ${fmtTime(p.lastMs)}`;
}

function renderSide(force) {
  const side = $('#side');
  const list = filteredProjects();
  const rail = isRail();
  const sig = JSON.stringify([rail, S.search, S.projectKey, S.othersOpen, S.hidePaths, S.now.length, list.map((p) => [p.key, p.sessions, p.activeCount, Math.floor(p.lastMs / 60000)])]);
  if (!force && S.sigs.side === sig) return;
  S.sigs.side = sig;
  const prevTop = side.querySelector('.side-scroll') ? side.querySelector('.side-scroll').scrollTop : 0;
  side.replaceChildren();
  const scroll = el('div', 'side-scroll');
  side.append(scroll);
  const groups = splitProjects(list);
  const selectedInOthers = groups.others.some((p) => p.key === S.projectKey);

  if (rail) {
    const nowBtn = el('button', 'rail-now');
    nowBtn.type = 'button';
    nowBtn.title = T.liveTitle;
    nowBtn.setAttribute('aria-label', T.liveCount(S.now.length));
    nowBtn.append(dot(S.now.length ? 'working' : 'done'), el('span', 'num', String(S.now.length)));
    nowBtn.addEventListener('click', openNow);
    scroll.append(nowBtn);
    // на рельсе: работающие и недавние, выбранный проект всегда виден, остальные за кнопкой «···»
    const shown = groups.live.concat(groups.recent, selectedInOthers ? groups.others.filter((p) => p.key === S.projectKey) : []);
    const marks = uniqueInitials(shown.map((p) => p.name));
    shown.forEach((p, i) => {
      const b = el('button', 'rail-proj' + (p.key === S.projectKey ? ' selected' : ''), marks[i]);
      b.type = 'button';
      b.title = projectTip(p);
      b.setAttribute('aria-label', p.name);
      if (p.activeCount) b.append(el('span', 'rail-led'));
      b.addEventListener('click', () => openProject(p.key, 'project'));
      scroll.append(b);
    });
    if (groups.others.length) {
      const more = el('button', 'rail-proj rail-more', '···');
      more.type = 'button';
      more.title = `${T.sideOthers} · ${groups.others.length}`;
      more.setAttribute('aria-label', `${T.sideMoreRail}: ${groups.others.length}`);
      more.addEventListener('click', () => applyRail(false, true));
      scroll.append(more);
    }
    scroll.scrollTop = prevTop;
    return;
  }

  const projRow = (p) => {
    const b = el('button', 'proj-row' + (p.key === S.projectKey ? ' selected' : ''));
    b.type = 'button';
    b.title = projectTip(p);
    b.append(el('span', 'proj-name', p.name));
    if (p.activeCount) {
      const live = el('span', 'proj-live num');
      live.append(dot('working'), document.createTextNode(String(p.activeCount)));
      b.append(live);
    } else b.append(el('span', 'proj-n num', String(p.sessions)));
    b.addEventListener('click', () => {
      openProject(p.key, 'project');
      document.body.classList.remove('side-open');
    });
    return b;
  };
  const group = (title, items, cls) => {
    const sec = el('section', 'side-sec' + (cls ? ' ' + cls : ''));
    const h = el('h2', 'side-h');
    h.append(el('span', null, title));
    sec.append(h);
    for (const p of items) sec.append(projRow(p));
    return sec;
  };
  if (!list.length) scroll.append(el('div', 'side-empty', S.projects.length ? T.projectsNone : T.projectsEmpty));
  if (groups.live.length) scroll.append(group(`${T.sideLive} · ${groups.live.length}`, groups.live));
  if (groups.recent.length) scroll.append(group(T.sideRecent, groups.recent));
  if (groups.others.length) {
    const open = S.othersOpen || !!S.search || selectedInOthers;
    const sec = el('section', 'side-sec');
    const h = el('h2', 'side-h');
    const tg = el('button', 'side-toggle');
    tg.type = 'button';
    tg.setAttribute('aria-expanded', open ? 'true' : 'false');
    tg.append(el('span', 'zone-chev', open ? '▾' : '▸'), el('span', null, `${T.sideOthers} · ${groups.others.length}`));
    tg.addEventListener('click', () => { S.othersOpen = !open; renderSide(true); });
    h.append(tg);
    sec.append(h);
    if (open) for (const p of groups.others) sec.append(projRow(p));
    scroll.append(sec);
  }
  scroll.scrollTop = prevTop;
}

function defaultProjectKey() {
  const list = S.projects;
  if (!list.length) return null;
  const live = list.filter((p) => p.activeCount > 0).sort((a, b) => b.activeCount - a.activeCount || b.lastMs - a.lastMs);
  return (live[0] || list[0]).key; // список уже по убыванию последней активности
}

/* ---------- крошка над страницей ---------- */

function renderViewbar() {
  const vb = $('#viewbar');
  const proj = S.projects.find((p) => p.key === S.projectKey);
  const sig = JSON.stringify([S.view, S.projectKey, proj && proj.name]);
  if (S.sigs.vb === sig) return;
  S.sigs.vb = sig;
  vb.replaceChildren();
  vb.hidden = S.view === 'now';
  if (S.view === 'now') return;
  const nav = el('nav', 'crumbs');
  nav.setAttribute('aria-label', 'Где вы');
  const link = (text, fn) => {
    const b = el('button', 'crumb-link', text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  nav.append(link(T.tabs.now, openNow), el('span', 'crumb-sep', '›'));
  if (S.view === 'tree') nav.append(link(proj ? proj.name : '', () => openProject(S.projectKey, 'project')), el('span', 'crumb-sep', '›'), el('span', 'crumb-here', T.tabs.tree));
  else nav.append(el('span', 'crumb-here', proj ? proj.name : ''));
  vb.append(nav);
}

/* ---------- центр ---------- */

function stateBox(title, text, extra) {
  const box = el('div', 'state-box center');
  box.append(el('div', 'state-title', title));
  if (text) box.append(el('div', 'state-text', text));
  if (extra) box.append(extra);
  return box;
}

function progressBox(pct) {
  const wrap = el('div', 'progress');
  wrap.setAttribute('role', 'progressbar');
  wrap.setAttribute('aria-valuenow', String(pct));
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', '100');
  const bar = el('div', 'progress-bar');
  bar.style.width = Math.max(3, pct) + '%';
  wrap.append(bar);
  const box = el('div', 'progress-box');
  box.append(wrap, el('div', 'progress-pct num', pct + '%'));
  return box;
}

function currentData() {
  return S.view === 'tree' ? S.mapData : S.projectData;
}

// Узел по id: в данных открытого вида или в списке «сейчас».
function findNode(id) {
  const d = currentData();
  return (d && d.nodes.find((x) => x.id === id)) || S.now.find((x) => x.id === id) || S.recent.find((x) => x.id === id) || null;
}

function matcher() {
  const q = S.search.toLowerCase();
  if (!q) return null;
  return (n) => n.title.toLowerCase().includes(q) || (n.model || '').toLowerCase().includes(q) || n.project.name.toLowerCase().includes(q) || (n.agentType || '').toLowerCase().includes(q);
}

// Исполнители вне team.json: провайдеры с фактами запусков, которых нет в списке команды.
// Считается только когда файл роли задал; без файла «все с запусками» и вне команды никого нет.
function offTeamProviders(nodes) {
  const team = S.team;
  if (!team || team.source !== 'file' || !team.executors.length) return new Set();
  const allowed = new Set(team.executors.map((e) => e.provider));
  if (team.brain) allowed.add(team.brain.provider);
  const off = new Set();
  for (const n of nodes) if (n.executor && !allowed.has(n.provider)) off.add(n.provider);
  return off;
}

function updateZoombar() {
  const z = $('#zoombar');
  z.hidden = S.view !== 'tree' || !S.zoomCtl;
  if (z.hidden) return;
  const lbl = z.querySelector('.zoom-pct');
  if (lbl) lbl.textContent = Math.round((S.zoomCtl ? S.zoomCtl.scale : 1) * 100) + '%';
}

function buildZoombar() {
  const z = $('#zoombar');
  z.title = T.zoomHint;
  const mk = (txt, title, fn, cls) => {
    const b = el('button', 'zbtn' + (cls ? ' ' + cls : ''), txt);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    return b;
  };
  const pct = el('span', 'zoom-pct num', '100%');
  z.append(mk('−', T.zoomOut, () => S.zoomCtl && S.zoomCtl.out()), pct, mk('+', T.zoomIn, () => S.zoomCtl && S.zoomCtl.in()), mk(T.fit, T.zoomHint, () => S.zoomCtl && S.zoomCtl.fit(), 'wide'));
}

// После перерисовки возвращаем фокус на тот же элемент: клавиатурный пользователь не должен терять место раз в 3 секунды.
function focusKey(root) {
  const a = document.activeElement;
  if (!a || a === document.body || !root.contains(a)) return null;
  const cls = String(a.className).split(' ')[0];
  return { id: a.dataset ? a.dataset.id : null, cls, i: cls ? [...root.querySelectorAll('.' + cls)].indexOf(a) : -1 };
}

function restoreFocus(root, k) {
  if (!k) return;
  const t = (k.id && root.querySelector(`[data-id="${CSS.escape(k.id)}"]`)) || (k.cls && k.i >= 0 && root.querySelectorAll('.' + k.cls)[k.i]);
  if (t) t.focus({ preventScroll: true });
}

// Кто в «В работе» сейчас и кто был: уходящая строка гаснет, в «Готово» она появляется с подсветкой слева.
function trackTransitions(liveNodes, allById) {
  const key = S.view + '|' + S.projectKey;
  const ids = new Set(liveNodes.map((n) => n.id));
  if (S.liveFor === key) {
    const gone = [...S.liveIds].filter((id) => !ids.has(id) && allById.has(id) && allById.get(id).status !== 'working');
    if (gone.length) {
      S.justDone = new Set(gone);
      setTimeout(() => { S.justDone = new Set(); for (const r of document.querySelectorAll('.row.just-done')) r.classList.remove('just-done'); }, 700);
    }
  }
  S.liveFor = key;
  S.liveIds = ids;
}

function ghostRows(stage, prevRows, liveNodes) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; // без анимации уходящая строка просто исчезает
  const live = new Set(liveNodes.map((n) => n.id));
  const zone = stage.querySelector('.zone-live');
  if (!zone) return;
  for (const [id, clone] of prevRows) {
    if (live.has(id) || !S.justDone.has(id)) continue;
    clone.classList.add('ghost');
    clone.removeAttribute('data-id');
    clone.tabIndex = -1;
    let body = zone.querySelector('.zone-body');
    if (!body) { body = el('div', 'zone-body ghost-body'); zone.querySelector('.zone-head').after(body); }
    body.prepend(clone);
    clone.addEventListener('animationend', () => { clone.remove(); if (body.classList.contains('ghost-body') && !body.children.length) body.remove(); });
  }
}

function pageCtx() {
  return {
    selectedId: S.selectedId,
    brainProvider: S.team && S.team.brain ? S.team.brain.provider : null,
    match: matcher(),
    modelFilter: S.modelFilter,
    doneOpen: S.doneOpen,
    doneSort: S.doneSort,
    liveAll: S.liveAll,
    doneAll: S.doneAll,
    forceOpen: !!S.search,
    intro: S.intro,
    justDone: S.justDone,
    onSelect: (n) => selectNode(n),
    onModel: (id) => { S.modelFilter = id; renderStage(true); },
    onToggleDone: () => { S.doneOpen = !S.doneOpen; store.set('done-open', S.doneOpen ? '1' : '0'); renderStage(true); },
    onSort: (m) => { S.doneSort = m; store.set('done-sort', m); renderStage(true); },
    onToggleLive: () => { S.liveAll = !S.liveAll; renderStage(true); },
    onToggleDoneAll: () => { S.doneAll = !S.doneAll; renderStage(true); },
    onIntroClose: () => { S.intro = false; store.set('intro', '1'); renderStage(true); },
  };
}

function sessionOptions() {
  const nodes = (S.projectData ? S.projectData.nodes : []).filter((n) => n.kind === 'session' && !n.external);
  const known = new Set(nodes.map((n) => n.id));
  const tag = (provider) => (provider === 'glm' ? ' · GLM' : '');
  const opts = nodes.slice().sort((a, b) => b.lastMs - a.lastMs).map((n) => ({ id: n.id, label: `${displayTitle(n.title)}${tag(n.provider)} · ${fmtTime(n.lastMs)}` }));
  if (S.projectData) {
    for (const s of S.projectData.sessions) if (!known.has(s.id) && !s.shown) opts.push({ id: s.id, label: `${T.session} ${s.sessionId.slice(0, 8)}${tag(s.provider)} · ${fmtTime(s.mtimeMs)}` });
  }
  return opts;
}

// Шапка «Цепочки»: уровень, h1, выбор сессии с видимой подписью, подпись линии.
function treeHeader() {
  const proj = S.projects.find((p) => p.key === S.projectKey);
  const h = el('header', 'ph');
  h.append(el('div', 'ph-level', T.levels.tree));
  const top = el('div', 'ph-top');
  top.append(el('h1', 'ph-h1', proj ? proj.name : ''));
  if (proj && proj.path) top.append(Object.assign(el('span', 'ph-path', pathText(proj.path)), { title: pathText(proj.path) }));
  h.append(top);
  const pick = el('div', 'ph-pick');
  const id = 'sess-select';
  const lab = el('label', 'ph-label', T.sessionShown);
  lab.htmlFor = id;
  const sel = el('select', 'vb-select');
  sel.id = id;
  for (const o of sessionOptions()) {
    const opt = el('option', null, o.label);
    opt.value = o.id;
    if (o.id === S.sessionId) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => openTree(sel.value));
  pick.append(lab, sel);
  h.append(pick, el('p', 'ph-caption', T.treeCaption));
  return h;
}

function renderStage(force) {
  const stage = $('#stage');
  const data = S.view === 'now' ? null : currentData();
  const nowSig = [S.now, S.recent, S.projects.map((p) => [p.key, p.activeCount, p.sessions, Math.floor(p.lastMs / 60000)]), S.cross];
  const sig = JSON.stringify([S.view, S.error, S.loading, S.selectedId, S.search, S.density, S.modelFilter, S.doneOpen, S.doneSort, S.liveAll, S.doneAll, S.intro, S.hidePaths, S.sessionId, [...S.openLeaves], S.team, S.view === 'now' ? nowSig : data]);
  if (!force && S.sigs.stage === sig) return;
  S.sigs.stage = sig;
  const prev = { top: stage.scrollTop, left: stage.scrollLeft };
  const fk = focusKey(stage);
  const prevRows = new Map([...stage.querySelectorAll('.zone-live .row-live')].map((r) => [r.dataset.id, r.cloneNode(true)]));
  if (S.map) { S.map.wires.destroy(); S.map = null; }
  if (S.zoomCtl) { S.zoomCtl.destroy(); S.zoomCtl = null; }
  stage.replaceChildren();
  updateZoombar();

  const finish = () => { stage.scrollTop = prev.top; stage.scrollLeft = prev.left; restoreFocus(stage, fk); };

  if (S.view === 'now') {
    if (!S.projects.length) { stage.append(stateBox(T.projectsEmpty, T.chooseProjectHint)); return; }
    trackTransitions(S.now, new Map(S.recent.map((n) => [n.id, n])));
    const host = el('div', 'view');
    const linksHost = el('div', 'links');
    stage.append(host);
    renderNowPage(host, { live: S.now, recent: S.recent }, pageCtx(), linksHost);
    S.map = renderLinks(linksHost, { projects: S.projects, links: S.cross }, { selectedKey: S.projectKey, onOpenProject: (k) => openProject(k, 'project') });
    ghostRows(stage, prevRows, S.now);
    finish();
    return;
  }
  if (S.error) {
    const b = el('button', 'btn', T.retry);
    b.type = 'button';
    b.addEventListener('click', () => (S.view === 'tree' ? loadTree() : loadProject()));
    stage.append(stateBox(T.loadFailed, S.error, b));
    return;
  }
  if (!data || !data.nodes.length) {
    if (S.loading || !data || (data.progress && data.progress.pct < 100)) {
      stage.append(stateBox(T.building, T.buildingSub, progressBox(data && data.progress ? data.progress.pct : 0)));
    } else stage.append(stateBox(S.view === 'tree' ? T.emptyTree : T.emptyProject, ''));
    return;
  }
  if (data.progress && data.progress.pct < 100) {
    const strip = el('div', 'build-strip');
    strip.setAttribute('aria-live', 'polite');
    strip.append(el('span', null, `${T.building} ${data.progress.pct}%`), progressBox(data.progress.pct).firstChild);
    stage.append(strip);
  }
  const host = el('div', 'view');
  stage.append(host);
  if (S.view === 'project') {
    trackTransitions(data.nodes.filter((n) => n.status === 'working'), new Map(data.nodes.map((n) => [n.id, n])));
    renderProjectPage(host, data, pageCtx());
    ghostRows(stage, prevRows, data.nodes.filter((n) => n.status === 'working'));
    finish();
    return;
  }
  // «Цепочка»
  host.append(treeHeader());
  const treeHost = el('div', 'tree-host');
  host.append(treeHost);
  const ctx = {
    selectedId: S.selectedId,
    team: { brainProvider: S.team && S.team.brain ? S.team.brain.provider : null, offTeam: offTeamProviders(data.nodes) },
    match: matcher(),
    openLeaves: S.openLeaves,
    getScale: () => (S.zoomCtl ? S.zoomCtl.scale : 1),
    onSelect: selectNode,
    onToggleLeaves: (parent) => { toggleSet(S.openLeaves, parent); renderStage(true); },
    onOpenSession: (sid, pkey) => {
      S.pendingSelect = null;
      if (pkey !== S.projectKey) openProject(pkey, 'tree', sid);
      else openTree(sid);
    },
  };
  S.map = renderTree(treeHost, data, ctx);
  S.zoomCtl = attachZoom(stage, S.map.canvas, {
    fluid: S.map.fluid,
    scale: S.zoom,
    onChange: (s) => { S.zoom = s; updateZoombar(); if (S.map) S.map.wires.redraw(); },
  });
  updateZoombar();
  finish();
}

function toggleSet(set, id) {
  if (set.has(id)) set.delete(id);
  else set.add(id);
}

function renderChrome() {
  updateBar();
  renderSide();
  renderViewbar();
  renderStage();
  writeHash();
}

/* ---------- загрузка ---------- */

function schedule(fn, ms) {
  clearTimeout(timer);
  timer = setTimeout(fn, ms);
}

async function loadProject() {
  if (!S.projectKey) return;
  const my = ++S.token;
  S.loading = !S.projectData;
  S.error = null;
  try {
    const data = await api('/api/project?key=' + encodeURIComponent(S.projectKey));
    if (my !== S.token) return;
    S.projectData = data;
    S.loading = false;
    afterData(data);
    if (S.view === 'tree' && !S.sessionId) {
      const sid = sessionForSelection();
      if (sid) { openTree(sid); return; }
    }
    if (S.view === 'tree' && S.sessionId) loadTree(true);
    if (S.view === 'project') schedule(loadProject, data.progress.pct < 100 ? 700 : 6000);
  } catch (e) {
    if (my !== S.token) return;
    S.loading = false;
    S.error = e.message;
    renderChrome();
  }
}

async function loadTree(quiet) {
  if (!S.sessionId) return;
  const my = ++S.token;
  if (!quiet) { S.loading = true; S.error = null; }
  try {
    const data = await api('/api/map?id=' + encodeURIComponent(S.sessionId));
    if (my !== S.token) return;
    S.mapData = data;
    S.loading = false;
    S.error = null;
    afterData(data);
    schedule(loadTree, data.progress.pct < 100 ? 700 : 6000);
  } catch (e) {
    if (my !== S.token) return;
    S.loading = false;
    S.error = e.message;
    renderChrome();
  }
}

function afterData(data) {
  if (S.pendingSelect) {
    const n = data.nodes.find((x) => x.id === S.pendingSelect);
    if (n) { S.pendingSelect = null; selectNode(n, true); }
  }
  const sel = data.nodes.find((x) => x.id === S.selectedId);
  if (sel) syncPanel(sel);
  renderChrome();
}

// Выбранный узел обновился: панель берёт свежие данные (статус, время).
function syncPanel(node) {
  if (feed.node && feed.node.id === node.id) feed.node = node;
  report.refresh(node);
}

/* ---------- навигация ---------- */

function openProject(key, view, sessionId) {
  if (!key) return;
  if (key !== S.projectKey) {
    S.projectKey = key;
    S.projectData = null;
    S.mapData = null;
    S.selectedId = S.pendingSelect || null;
    S.modelFilter = null;
    S.liveAll = false;
    S.doneAll = false;
    S.openLeaves = new Set();
    S.zoom = 1;
    feed.clear();
    report.clear();
    closePanel();
  }
  S.view = view || 'project';
  S.error = null;
  S.sessionId = sessionId || (view === 'tree' ? S.sessionId : null);
  renderChrome();
  if (S.view === 'tree' && sessionId) { S.mapData = null; loadTree(); }
  loadProject();
}

function sessionForSelection() {
  const data = S.projectData;
  if (!data) return null;
  let n = data.nodes.find((x) => x.id === S.selectedId);
  const byId = new Map(data.nodes.map((x) => [x.id, x]));
  while (n && n.kind !== 'session' && n.parent) n = byId.get(n.parent);
  if (n && n.kind === 'session' && !n.external) return n.id;
  const sessions = data.nodes.filter((x) => x.kind === 'session' && !x.external);
  const claude = sessions.filter((x) => x.provider !== 'glm').sort((a, b) => b.lastMs - a.lastMs);
  return (claude[0] || sessions.sort((a, b) => b.lastMs - a.lastMs)[0] || {}).id || null;
}

function openTree(sessionId) {
  if (!S.projectKey) return;
  const sid = sessionId || S.sessionId || sessionForSelection();
  S.view = 'tree';
  S.error = null;
  if (!sid) { S.sessionId = null; S.mapData = null; renderChrome(); loadProject(); return; }
  if (sid !== S.sessionId) S.mapData = null;
  S.sessionId = sid;
  renderChrome();
  loadTree();
}

async function openNow() {
  S.view = 'now';
  clearTimeout(timer);
  S.token++;
  document.body.classList.remove('side-open');
  renderChrome();
  await refreshCross();
}

async function refreshCross() {
  try {
    S.cross = (await api('/api/cross')).links;
  } catch {
    S.cross = [];
  }
  if (S.view === 'now') renderStage();
}

/* ---------- панель агента: отчёт, по кнопке переписка ---------- */

function setPane(pane) {
  document.body.classList.toggle('pane-feed', pane === 'feed');
}

function markSelected(id) {
  for (const c of document.querySelectorAll('.card.selected, .row.selected')) c.classList.remove('selected');
  const t = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (t && (t.classList.contains('card') || t.classList.contains('row'))) t.classList.add('selected');
}

function selectNode(node, silent) {
  S.selectedId = node.id;
  markSelected(node.id);
  setPane('report');
  report.open(node);
  document.body.classList.add('feed-open');
  writeHash();
  if (!silent && S.map) S.map.wires.redraw();
}

function openFeedFor(node) {
  const badges = [el('span', 'pbadge p-' + node.provider, rowBadgeText(node)), el('span', 'feed-st st-' + node.status, T[node.status])];
  if (node.project) badges.push(el('span', 'chip-project', node.project.name));
  feed.open(node, badges);
  setPane('feed');
}

function closePanel() {
  document.body.classList.remove('feed-open', 'pane-feed');
}

// Ссылка «Открыть цепочку» из отчёта GLM: дерево запустившей сессии, выбран запустивший помощник.
function openChain(lf) {
  S.pendingSelect = lf.nodeId;
  S.selectedId = null;
  openProject(lf.project.key, 'tree', lf.sessionId);
}

/* ---------- опрос ---------- */

async function refreshProjects() {
  try {
    S.projects = (await api('/api/projects')).projects;
    renderSide();
    updateBar();
    renderViewbar();
    if (S.view === 'now') renderStage();
  } catch (e) {
    if (!S.projects.length) $('#side').replaceChildren(el('div', 'side-empty', e.message));
  }
}

// Роли «мозг / исполнитель»: team.json правит агент в разговоре, карта только показывает.
async function refreshTeam() {
  try {
    S.team = await api('/api/team');
    renderSide();
    if (S.view !== 'now') renderStage();
  } catch {}
}

async function refreshNow() {
  try {
    const r = await api('/api/now');
    S.now = r.nodes;
    S.recent = r.recent || [];
    updateBar();
    renderSide();
    if (S.view === 'now') {
      renderStage();
      const sel = S.selectedId && S.now.find((x) => x.id === S.selectedId);
      if (sel) syncPanel(sel);
    }
  } catch {}
}

function every(fn, ms) {
  setInterval(() => { if (!document.hidden) fn(); }, ms);
}

/* ---------- старт ---------- */

async function init() {
  buildBar();
  buildZoombar();
  applyTheme(store.get('theme', 'dark') === 'light' ? 'light' : 'dark'); // тёмная по умолчанию
  applyDensity(store.get('density', 'compact'));
  S.pin = store.get('pin', '0') === '1';
  S.doneOpen = store.get('done-open', '0') === '1';
  S.doneSort = store.get('done-sort', 'new') === 'model' ? 'model' : 'new';
  S.intro = store.get('intro', '0') !== '1';
  applyHidePaths(store.get('hide-paths', '0') === '1', false);
  report = new ReportPanel($('#pane-report'), {
    onClose: closePanel,
    onPin: togglePin,
    onOpenFeed: openFeedFor,
    onOpenProject: (key) => openProject(key, 'project'),
    onOpenChain: openChain,
  });
  feed = new Feed($('#pane-feed'), { onClose: closePanel, onPin: togglePin, onBack: () => setPane('report') });
  const savedRail = store.get('rail', null);
  S.rail = savedRail == null ? window.innerWidth < 1000 : savedRail === '1'; // в узком окне колонка свёрнута сама
  applyRail(S.rail, false);
  applyPin();

  document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) toggleMenu(false, false); });
  $('#menu').addEventListener('keydown', onMenuKey);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#menu').hidden) return toggleMenu(false, true);
    if (!document.body.classList.contains('feed-pinned')) closePanel();
    document.body.classList.remove('side-open');
  });
  $('#scrim').addEventListener('click', () => document.body.classList.remove('side-open'));
  new MutationObserver(() => {
    $('#scrim').hidden = !document.body.classList.contains('side-open');
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { applyPin(); renderSide(true); relayoutSoon(); }, 120); });

  updateBar();
  renderSide();
  await Promise.all([refreshProjects(), refreshNow(), refreshTeam()]);
  const h = readHash();
  if (h.p && S.projects.some((p) => p.key === h.p)) {
    S.pendingSelect = h.n || null;
    if (h.v === 'tree' && h.s) openProject(h.p, 'tree', h.s);
    else openProject(h.p, h.v === 'tree' ? 'tree' : 'project');
  } else {
    await openNow();
  }
  every(refreshProjects, 5000);
  every(refreshNow, 3000);
  every(refreshTeam, 15000);
  every(() => { if (S.view === 'now') refreshCross(); }, 6000);
}

init();
