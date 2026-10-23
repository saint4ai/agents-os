// Отчёт агента: карточка с тезисами в панели справа. Данные: /api/report (задача из головы файла, что сделал из
// последнего сообщения, как выполнял и проверки из индекса). Переписка открывается отдельной кнопкой.
// Порядок блоков: задача, что сделал (фокус панели), как выполнял, проверки, итог.

import { T, el, plural, mdRender, displayTitle, timeNote, rowBadgeText, pathText, api } from './util.js';
import { led } from './maps.js';

const POLL_MS = 3000; // пока агент работает, отчёт обновляется
const PENDING_MS = 700; // индекс файла ещё строится

function section(title, cls) {
  const s = el('section', 'rp-sec' + (cls ? ' ' + cls : ''));
  s.append(el('h3', 'rp-k', title));
  return s;
}

const row = (label, node) => {
  const r = el('div', 'rp-row');
  r.append(el('span', 'rp-label', label));
  const v = el('div', 'rp-val');
  if (node) v.append(node);
  r.append(v);
  return r;
};

function toggleLink(text, onClick) {
  const b = el('button', 'rp-link', text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const nTimes = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;

export class ReportPanel {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks || {};
    this.node = null;
    this.data = null;
    this.token = 0;
    this.timer = null;
    this.open_ = { task: false, did: false, prev: false };
    this.build();
  }

  build() {
    this.root.replaceChildren();
    const top = el('div', 'rp-top');
    const back = el('button', 'rp-back', T.toList);
    back.type = 'button';
    back.addEventListener('click', () => this.hooks.onClose && this.hooks.onClose());
    this.pinBtn = el('button', 'icon-btn rp-pin', '⇥');
    this.pinBtn.type = 'button';
    this.pinBtn.addEventListener('click', () => this.hooks.onPin && this.hooks.onPin());
    this.closeBtn = el('button', 'icon-btn rp-close', '✕');
    this.closeBtn.type = 'button';
    this.closeBtn.title = T.close + ' (Esc)';
    this.closeBtn.setAttribute('aria-label', T.close);
    this.closeBtn.addEventListener('click', () => this.hooks.onClose && this.hooks.onClose());
    top.append(back, el('span', 'rp-spacer'), this.pinBtn, this.closeBtn);
    this.scroller = el('div', 'rp-scroll');
    this.foot = el('div', 'rp-foot');
    this.feedBtn = el('button', 'btn rp-feed', T.openFeed);
    this.feedBtn.type = 'button';
    this.feedBtn.addEventListener('click', () => this.node && this.hooks.onOpenFeed && this.hooks.onOpenFeed(this.node));
    this.foot.append(this.feedBtn);
    this.root.append(top, el('div', 'rp-empty', T.feedEmpty), this.scroller, this.foot);
    this.root.classList.add('is-empty');
  }

  setPinned(pinned) {
    this.pinBtn.title = pinned ? T.unpin : T.pin;
    this.pinBtn.setAttribute('aria-label', this.pinBtn.title);
    this.pinBtn.classList.toggle('on', pinned);
    this.closeBtn.hidden = pinned;
  }

  /* --- жизненный цикл --- */

  open(node) {
    this.node = node;
    this.data = null;
    this.open_ = { task: false, did: false, prev: false };
    this.root.classList.remove('is-empty');
    this.load(false);
  }

  clear() {
    this.token++;
    clearTimeout(this.timer);
    this.node = null;
    this.data = null;
    this.scroller.replaceChildren();
    this.root.classList.add('is-empty');
  }

  // Узел обновился (опрос проекта): если статус сменился, отчёт перечитывается.
  refresh(node) {
    if (!this.node || this.node.id !== node.id) return;
    const changed = node.status !== this.node.status;
    this.node = node;
    if (changed) this.load(true);
  }

  async load(quiet) {
    if (!this.node) return;
    const node = this.node;
    const my = ++this.token;
    clearTimeout(this.timer);
    if (!quiet) this.renderShell(node, this.loadingBox());
    try {
      const data = await api('/api/report?id=' + encodeURIComponent(node.id));
      if (my !== this.token) return;
      if (data.pending) {
        if (!quiet || !this.data) this.renderShell(node, this.loadingBox(data.pct));
        this.timer = setTimeout(() => this.load(true), PENDING_MS);
        return;
      }
      this.data = data;
      this.render();
      if (this.node.status === 'working' || data.status === 'working') this.timer = setTimeout(() => this.load(true), POLL_MS);
    } catch (e) {
      if (my !== this.token) return;
      this.renderShell(node, this.errorBox(e.message));
    }
  }

  /* --- каркас и состояния --- */

  loadingBox(pct) {
    const box = el('div', 'state-box');
    box.append(el('div', 'state-title', 'Читаю переписку агента…'));
    if (pct != null) {
      const wrap = el('div', 'progress');
      wrap.setAttribute('role', 'progressbar');
      wrap.setAttribute('aria-valuenow', String(pct));
      const bar = el('div', 'progress-bar');
      bar.style.width = Math.max(3, pct) + '%';
      wrap.append(bar);
      box.append(wrap);
    }
    return box;
  }

  errorBox(msg) {
    const box = el('div', 'state-box');
    box.append(el('div', 'state-title', 'Отчёт не загрузился'), el('div', 'state-text', msg));
    const b = el('button', 'btn', T.retry);
    b.type = 'button';
    b.addEventListener('click', () => this.load(false));
    box.append(b);
    return box;
  }

  // Шапка карточки (из узла, она готова сразу) плюс переданное содержимое.
  renderShell(node, ...content) {
    const top = this.scroller.scrollTop;
    this.scroller.replaceChildren(this.head(node), ...content);
    this.scroller.scrollTop = top;
  }

  head(node) {
    const h = el('header', 'rp-head');
    const crumb = el('div', 'rp-crumb');
    const proj = el('button', 'rp-crumb-link', node.project ? node.project.name : '');
    proj.type = 'button';
    proj.title = pathText(node.project ? node.project.path : '');
    proj.addEventListener('click', () => node.project && this.hooks.onOpenProject && this.hooks.onOpenProject(node.project.key));
    crumb.append(proj, document.createTextNode(' › Агент'));
    const title = el('h2', 'rp-title', displayTitle(node.title));
    title.title = node.title;
    const meta = el('div', 'rp-meta');
    meta.append(el('span', 'pbadge p-' + node.provider, rowBadgeText(node)), led(node.status), el('span', 'rp-st st-' + node.status, T[node.status]));
    meta.append(el('span', 'num', timeNote(node, node.status === 'working')), el('span', 'num', T.tokens(node.tokens.in + node.tokens.out)));
    h.append(crumb, title, meta);
    return h;
  }

  /* --- содержимое --- */

  render() {
    const d = this.data;
    const node = this.node;
    if (d.unsupported) {
      this.renderShell(node, el('div', 'rp-note', 'Для этого источника отчёта пока нет. Откройте переписку.'));
      return;
    }
    const parts = [];
    parts.push(this.taskSection(d));
    const who = this.launcherSection(d);
    if (who) parts.push(who);
    parts.push(this.didSection(d));
    parts.push(this.howSection(d));
    parts.push(this.checksSection(d));
    parts.push(this.summarySection(d));
    this.renderShell(node, ...parts);
  }

  taskSection(d) {
    const s = section('Задача');
    const t = d.task || {};
    if (t.long) {
      s.append(el('p', 'rp-text', 'Задача длинная: откройте переписку, чтобы прочитать её целиком.'));
      return s;
    }
    if (!t.preview) {
      s.append(el('p', 'rp-text rp-dim', 'Текст задачи не найден.'));
      return s;
    }
    if (this.open_.task && t.text) {
      const full = el('div', 'rp-md bubble');
      full.innerHTML = mdRender(t.text);
      s.append(full);
    } else {
      s.append(el('p', 'rp-text rp-clamp', t.preview));
    }
    if (t.text) s.append(toggleLink(this.open_.task ? T.showLess : 'Показать всё', () => { this.open_.task = !this.open_.task; this.render(); }));
    if (t.count > 1) s.append(this.previousTasks(t));
    return s;
  }

  // Сессию GLM продолжали через --resume: показана последняя задача, прошлые свёрнуты списком заголовков.
  previousTasks(t) {
    const box = el('div', 'rp-prev');
    box.append(el('p', 'rp-note-s', T.taskOf(t.count)));
    box.append(toggleLink(`${T.taskPrev(t.count - 1)} ${this.open_.prev ? '▾' : '▸'}`, () => { this.open_.prev = !this.open_.prev; this.render(); }));
    if (this.open_.prev) {
      const ul = el('ul', 'rp-list');
      if (t.earlier) ul.append(el('li', 'rp-more', `ещё ${t.earlier} раньше`));
      for (const title of t.previous) ul.append(el('li', null, displayTitle(title)));
      box.append(ul);
    }
    return box;
  }

  launcherSection(d) {
    const lf = d.launcher || (this.node && this.node.launchedFrom);
    if (d.role !== 'glm' || !lf) return null;
    const s = section('Кто поставил задачу');
    const who = lf.task ? `Помощник «${displayTitle(lf.task)}» из сессии «${lf.sessionTitle}»` : `Сессия «${lf.sessionTitle}»`;
    s.append(el('p', 'rp-text', `${who} (проект ${lf.project.name})`));
    s.append(toggleLink('Открыть цепочку ›', () => this.hooks.onOpenChain && this.hooks.onOpenChain(lf)));
    return s;
  }

  didSection(d) {
    const s = section('Что сделал', 'rp-focus');
    const node = this.node;
    if (d.status === 'working' || node.status === 'working' || !d.did) {
      s.append(el('p', 'rp-text', 'Отчёта пока нет: агент ещё работает.'));
      if (d.step) s.append(el('p', 'rp-step', `${T.now} ${d.step}`));
      return s;
    }
    const did = d.did;
    if (did.empty === 'none') { s.append(el('p', 'rp-text', 'Агент закончил без текстового отчёта.')); return s; }
    if (did.empty === 'toolarge') { s.append(el('p', 'rp-text', 'Последнее сообщение слишком большое. Откройте переписку.')); return s; }
    if (did.status) s.append(row('Статус', document.createTextNode(did.status)));
    for (const sec of did.sections) {
      const ul = el('ul', 'rp-list');
      for (const b of sec.bullets) ul.append(el('li', null, b));
      if (sec.more) ul.append(el('li', 'rp-more', `ещё ${sec.more}`));
      const r = row(sec.label, ul);
      const none = sec.bullets.length === 1 && /^(нет|ничего)\.?$/i.test(sec.bullets[0]); // «Блокеры: нет» не тревожит
      if ((sec.key === 'blockers' || sec.key === 'decision') && !none) r.classList.add('rp-warn');
      if (none) r.classList.add('rp-none');
      s.append(r);
    }
    if (did.fallback && did.sections.length) s.append(el('p', 'rp-note-s', 'Отчёт без разметки: показаны первые пункты'));
    if (did.text) {
      if (this.open_.did) {
        const full = el('div', 'rp-md bubble');
        full.innerHTML = mdRender(did.text);
        s.append(full);
      }
      s.append(toggleLink(this.open_.did ? T.showLess : 'Показать весь отчёт', () => { this.open_.did = !this.open_.did; this.render(); }));
    }
    return s;
  }

  howSection(d) {
    const s = section('Как выполнял');
    const how = d.how;
    const files = el('div', 'rp-files');
    if (!how.filesTotal) files.append(el('span', 'rp-dim', 'Файлы не менял'));
    for (const f of how.files) {
      const n = f.edits + f.writes;
      const c = el('span', 'rp-file');
      c.title = f.path;
      c.append(el('code', null, f.name), el('span', 'rp-dim num', ' · ' + nTimes(n, 'правка', 'правки', 'правок')));
      files.append(c);
    }
    const rest = how.filesTotal - how.files.length;
    if (rest > 0 || how.filesOver) files.append(el('span', 'rp-dim', `ещё ${rest > 0 ? rest : ''}${how.filesOver ? '+' : ''}`));
    s.append(row(`Файлы (${how.filesTotal}${how.filesOver ? '+' : ''})`, files));
    if (how.cmds.length) {
      const cmds = el('div', 'rp-cmds');
      for (const c of how.cmds) cmds.append(Object.assign(el('code', 'rp-cmd', c.length > 70 ? c.slice(0, 69) + '…' : c), { title: c }));
      s.append(row('Команды', cmds));
    }
    const tc = how.tools || {};
    const edits = (tc.Edit || 0) + (tc.MultiEdit || 0) + (tc.Write || 0) + (tc.NotebookEdit || 0);
    const bash = tc.Bash || 0;
    const helpers = (tc.Agent || 0) + (tc.Task || 0);
    const bits = [];
    if (edits) bits.push(nTimes(edits, 'правка', 'правки', 'правок'));
    if (bash) bits.push(nTimes(bash, 'команда', 'команды', 'команд'));
    if (helpers) bits.push(nTimes(helpers, 'запуск помощников', 'запуска помощников', 'запусков помощников'));
    if (bits.length) s.append(el('p', 'rp-note-s', bits.join(', ')));
    if (bash) s.append(el('p', 'rp-note-s', 'Правки через Bash не учитываются'));
    return s;
  }

  checksSection(d) {
    const s = section('Проверки');
    if (!d.checks.length) {
      s.append(el('p', 'rp-text rp-dim', 'Тесты и сборки не запускались'));
      return s;
    }
    for (const c of d.checks) {
      const r = el('div', 'rp-check');
      const mark = el('span', 'ck ' + (c.ok === true ? 'ck-ok' : c.ok === false ? 'ck-bad' : 'ck-unk'));
      mark.setAttribute('role', 'img');
      mark.setAttribute('aria-label', c.ok === true ? 'прошла' : c.ok === false ? 'не прошла' : 'итог неясен');
      const cmd = el('code', 'rp-cmd', c.cmd.length > 44 ? c.cmd.slice(0, 43) + '…' : c.cmd);
      cmd.title = c.cmd;
      const res = el('span', 'rp-res num', c.pending ? (this.node.status === 'working' ? 'выполняется' : 'итог не определён: результата нет в переписке') : c.summary);
      r.append(mark, cmd, res);
      s.append(r);
      const series = c.runs.map((x) => x.summary);
      if (c.runs.length > 1 && series[0] !== series[series.length - 1]) {
        s.append(el('p', 'rp-note-s', 'сначала ' + series.join(', потом ')));
      }
    }
    s.append(el('p', 'rp-note-s', 'Итоги определены по тексту вывода команд'));
    return s;
  }

  summarySection(d) {
    const s = section('Итог');
    const node = this.node;
    const word = node.status === 'working' ? 'В работе' : node.status === 'error' ? 'Закончил с ошибкой' : 'Готово';
    const model = node.provider === 'glm' ? '' : rowBadgeText(node); // у GLM модель и роль называются одинаково
    const parts = [word, timeNote(node, node.status === 'working'), T.tokens(d.summary.usage.in + d.summary.usage.out), model, T.roles[d.role] || ''];
    s.append(el('p', 'rp-text rp-sum num', parts.filter(Boolean).join(' · ')));
    return s;
  }
}
