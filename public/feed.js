// Переписка выбранного агента: чат как в Claude Desktop. Открывается из отчёта кнопкой «Открыть переписку».
// Данные: /api/session (последние 300 событий, «Показать ранее» по смещению) и /api/stream (SSE, новые записи).

import { T, $, el, trunc, fmtTime, mdRender, highlight, api, displayTitle } from './util.js';

const FILE_TOOLS = ['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit'];
const FILTERS = ['all', 'messages', 'glm', 'send', 'agents', 'files'];

function matchesFilter(ev, filter) {
  switch (filter) {
    case 'messages': return ev.kind === 'user' || ev.kind === 'assistant';
    case 'glm': return ev.kind === 'tool_call' && !!ev.glm;
    case 'send': return ev.kind === 'tool_call' && ev.tool === 'SendMessage';
    case 'agents': return ev.kind === 'tool_call' && (ev.tool === 'Agent' || ev.tool === 'Task');
    case 'files': return ev.kind === 'tool_call' && FILE_TOOLS.includes(ev.tool);
    default: return true;
  }
}

function evSearchText(ev) {
  let s = (ev.text || '') + '\n' + (ev.tool || '');
  if (ev.input) {
    if (ev.input.__cat) s += '\n' + (ev.input.__cat.content || '');
    try { s += '\n' + JSON.stringify(ev.input); } catch {}
  }
  return s;
}

function toolIcon(ev) {
  if (ev.glm) return '→';
  if (ev.tool === 'Bash') return '$';
  if (ev.tool === 'SendMessage') return '✉';
  if (ev.tool === 'Agent' || ev.tool === 'Task') return '◇';
  if (FILE_TOOLS.includes(ev.tool)) return '▤';
  return '·';
}

// Название вызова в карточке: служебные имена агентских инструментов по-человечески, остальное как в переписке.
function toolTitle(ev) {
  if (ev.glm) return T.toolGlm;
  if (ev.tool === 'SendMessage') return 'Сообщение агенту';
  if (ev.tool === 'Agent' || ev.tool === 'Task') return 'Запуск агента';
  return ev.tool;
}

function keyArg(ev) {
  const i = ev.input || {};
  if (ev.tool === 'Bash') return trunc(i.command, 160);
  if (ev.tool === 'SendMessage') {
    const to = i.to ? '→ ' + i.to : '';
    return trunc((to + (i.summary ? (to ? ' · ' : '') + i.summary : '')).trim(), 120);
  }
  if (ev.tool === 'Agent' || ev.tool === 'Task') return trunc(i.description, 120);
  if (i.file_path) return trunc(i.file_path, 120);
  return trunc(i.description || i.pattern || i.url || i.query || '', 120);
}

export class Feed {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks || {};
    this.node = null;
    this.events = [];
    this.results = new Map();
    this.filter = 'all';
    this.query = '';
    this.es = null;
    this.offset = 0; // смещение, с которого продолжит поток
    this.firstOffset = 0; // смещение самого раннего загруженного события
    this.hasMore = false;
    this.atBottom = true;
    this.lastActivity = 0;
    this.token = 0;
    this.build();
    setInterval(() => this.updateLive(), 1000);
  }

  build() {
    this.root.innerHTML = '';
    const head = el('div', 'feed-head');
    this.backBtn = el('button', 'rp-back', T.toReport);
    this.backBtn.type = 'button';
    this.backBtn.addEventListener('click', () => this.hooks.onBack && this.hooks.onBack());
    this.titleNode = el('div', 'feed-title', T.feedEmpty);
    this.badgesNode = el('div', 'feed-badges');
    this.liveNode = el('span', 'live-badge');
    this.liveNode.append(el('span', 'led on'), el('span', null, T.live));
    this.pinBtn = el('button', 'icon-btn feed-pin', '⇥');
    this.pinBtn.type = 'button';
    this.pinBtn.addEventListener('click', () => this.hooks.onPin && this.hooks.onPin());
    this.closeBtn = el('button', 'icon-btn feed-close', '✕');
    this.closeBtn.type = 'button';
    this.closeBtn.title = T.close + ' (Esc)';
    this.closeBtn.setAttribute('aria-label', T.close);
    this.closeBtn.addEventListener('click', () => this.hooks.onClose && this.hooks.onClose());
    const top = el('div', 'feed-top');
    top.append(this.backBtn, el('span', 'rp-spacer'), this.liveNode, this.pinBtn, this.closeBtn);
    // шапка в два ряда: кнопки, затем заголовок и одна строка бейджей; поиск и вкладки идут отдельной панелью ниже
    head.append(top, this.titleNode, this.badgesNode);
    this.root.append(head);

    this.searchInput = el('input', 'feed-search');
    this.searchInput.type = 'search';
    this.searchInput.placeholder = T.searchFeed;
    this.searchInput.setAttribute('aria-label', T.searchFeed);
    let deb;
    this.searchInput.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { this.query = this.searchInput.value.trim(); this.render(); }, 200);
    });
    const bar = el('div', 'feed-bar');
    this.tabsNode = el('div', 'ftabs');
    for (const id of FILTERS) {
      const b = el('button', 'ftab' + (id === this.filter ? ' on' : ''));
      b.type = 'button';
      b.dataset.filter = id;
      b.append(document.createTextNode(T.feedTabs[id]), el('span', 'count'));
      b.addEventListener('click', () => {
        this.filter = id;
        for (const t of this.tabsNode.children) t.classList.toggle('on', t.dataset.filter === id);
        this.render();
      });
      this.tabsNode.append(b);
    }
    bar.append(this.tabsNode, this.searchInput);
    this.root.append(bar);

    const wrap = el('div', 'feed-wrap');
    this.scroller = el('div', 'feed');
    this.inner = el('div', 'feed-inner');
    this.scroller.append(this.inner);
    this.jump = el('button', 'jump-btn', T.toLatest);
    this.jump.type = 'button';
    this.jump.hidden = true;
    this.jump.addEventListener('click', () => this.scrollToBottom());
    wrap.append(this.scroller, this.jump);
    this.root.append(wrap);
    this.scroller.addEventListener('scroll', () => {
      this.atBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 60;
      this.jump.hidden = this.atBottom;
    });
    this.root.classList.add('is-empty');
  }

  // подпись кнопки «Закрепить»: видна только на широких экранах (см. CSS), текст зависит от состояния
  setPinned(pinned) {
    this.pinBtn.title = pinned ? T.unpin : T.pin;
    this.pinBtn.setAttribute('aria-label', this.pinBtn.title);
    this.pinBtn.classList.toggle('on', pinned);
    this.closeBtn.hidden = pinned;
  }

  /* --- открытие узла --- */

  async open(node, headBadges) {
    this.node = node;
    const my = ++this.token;
    this.closeStream();
    this.events = [];
    this.results.clear();
    this.offset = 0;
    this.hasMore = false;
    this.root.classList.remove('is-empty');
    this.titleNode.textContent = displayTitle(node.title);
    this.titleNode.title = node.title;
    this.badgesNode.replaceChildren(...(headBadges || []));
    this.inner.replaceChildren(el('div', 'feed-note', T.building));
    try {
      const data = await api('/api/session?id=' + encodeURIComponent(node.id));
      if (my !== this.token) return;
      this.offset = data.endOffset;
      this.firstOffset = data.offset;
      this.hasMore = data.hasMore;
      this.events = data.events;
      this.collectResults(data.events);
      this.lastActivity = node.status === 'working' ? Date.now() : 0;
      this.render();
      this.openStream();
    } catch (e) {
      if (my !== this.token) return;
      this.inner.replaceChildren(this.errorBox(e.message, () => this.open(node, headBadges)));
    }
  }

  errorBox(msg, retry) {
    const box = el('div', 'state-box');
    box.append(el('div', 'state-title', T.feedFailed), el('div', 'state-text', msg));
    const b = el('button', 'btn', T.retry);
    b.type = 'button';
    b.addEventListener('click', retry);
    box.append(b);
    return box;
  }

  clear() {
    this.token++;
    this.closeStream();
    this.node = null;
    this.events = [];
    this.titleNode.textContent = T.feedEmpty;
    this.badgesNode.replaceChildren();
    this.inner.replaceChildren();
    this.root.classList.add('is-empty');
    this.liveNode.classList.remove('on');
  }

  collectResults(events) {
    for (const ev of events) if (ev.kind === 'tool_result' && ev.resultFor) this.results.set(ev.resultFor, { text: ev.text, isError: ev.isError });
  }

  /* --- живой поток --- */

  openStream() {
    if (!this.node) return;
    const node = this.node;
    const es = new EventSource('/api/stream?id=' + encodeURIComponent(node.id) + '&offset=' + this.offset);
    this.es = es;
    es.addEventListener('batch', (e) => {
      const data = JSON.parse(e.data);
      this.offset = data.offset;
      this.appendEvents(data.events);
    });
    es.addEventListener('reset', () => {
      this.events = [];
      this.results.clear();
      this.offset = 0;
      this.render();
    });
    es.onerror = () => {
      es.close();
      if (this.es === es) this.es = null;
      setTimeout(() => { if (this.node === node && !this.es) this.openStream(); }, 3000);
    };
  }

  closeStream() {
    if (this.es) { this.es.close(); this.es = null; }
  }

  appendEvents(events) {
    if (!events.length) return;
    this.lastActivity = Date.now();
    for (const ev of events) {
      this.events.push(ev);
      if (ev.kind === 'tool_result' && ev.resultFor) {
        this.results.set(ev.resultFor, { text: ev.text, isError: ev.isError });
        this.fillCardResult(ev.resultFor);
      }
    }
    const q = this.query.toLowerCase();
    for (const ev of events) {
      if (ev.kind === 'tool_result' || !matchesFilter(ev, this.filter)) continue;
      if (q && !evSearchText(ev).toLowerCase().includes(q)) continue;
      this.appendNode(ev);
    }
    this.updateCounts();
    if (this.atBottom) this.scrollToBottom();
    else this.jump.hidden = false;
  }

  /* --- отрисовка --- */

  visible() {
    const q = this.query.toLowerCase();
    return this.events.filter((ev) => matchesFilter(ev, this.filter) && (!q || evSearchText(ev).toLowerCase().includes(q)));
  }

  render() {
    this.inner.replaceChildren();
    if (this.hasMore) this.inner.append(this.earlierButton());
    const vis = this.visible();
    if (!vis.length) this.inner.append(el('div', 'feed-note', this.node ? T.noEvents : T.feedEmpty));
    else for (const ev of vis) this.appendNode(ev);
    this.updateCounts();
    highlight(this.inner, this.query);
    this.atBottom = true;
    this.jump.hidden = true;
    this.scrollToBottom();
  }

  earlierButton() {
    const b = el('button', 'btn earlier', T.earlier);
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = T.loadingEarlier;
      const my = this.token;
      try {
        const data = await api('/api/session?id=' + encodeURIComponent(this.node.id) + '&before=' + this.firstOffset);
        if (my !== this.token) return;
        const prevH = this.scroller.scrollHeight;
        const prevTop = this.scroller.scrollTop;
        this.events = data.events.concat(this.events);
        this.collectResults(data.events);
        this.firstOffset = data.offset;
        this.hasMore = data.hasMore;
        this.render();
        this.scroller.scrollTop = prevTop + (this.scroller.scrollHeight - prevH);
        this.atBottom = false;
        this.jump.hidden = false;
      } catch (e) {
        b.disabled = false;
        b.textContent = T.earlier + ' (' + e.message + ')';
      }
    });
    return b;
  }

  updateCounts() {
    const counts = {};
    for (const id of FILTERS) counts[id] = 0;
    for (const ev of this.events) for (const id of FILTERS) if (matchesFilter(ev, id)) counts[id]++;
    for (const t of this.tabsNode.children) t.querySelector('.count').textContent = counts[t.dataset.filter] ? String(counts[t.dataset.filter]) : '';
  }

  appendNode(ev) {
    let node;
    if (ev.kind === 'user' || ev.kind === 'assistant') {
      node = el('div', 'msg ' + ev.kind);
      const bubble = el('div', 'bubble');
      bubble.innerHTML = mdRender(ev.text);
      node.append(bubble, el('div', 'msg-time', fmtTime(ev.ts)));
    } else if (ev.kind === 'thinking') {
      node = this.buildThinking(ev);
    } else if (ev.kind === 'tool_call') {
      node = this.buildToolCard(ev);
    } else if (ev.kind === 'system') {
      node = el('div', 'sys-line', ev.text);
    } else {
      return;
    }
    this.inner.append(node);
  }

  buildThinking(ev) {
    const d = document.createElement('details');
    d.className = 'thinking';
    d.append(Object.assign(document.createElement('summary'), { textContent: T.thinking }));
    const body = el('div', 'thinking-body');
    body.innerHTML = mdRender(ev.text);
    d.append(body);
    return d;
  }

  buildToolCard(ev) {
    const card = el('div', 'tool-card');
    card.dataset.toolId = ev.id || '';
    const head = el('button', 'tool-head');
    head.type = 'button';
    head.append(el('span', 'tool-ico', toolIcon(ev)), el('span', 'tool-name' + (ev.glm ? ' glm' : ''), toolTitle(ev)), el('span', 'tool-arg', keyArg(ev)), el('span', 'tool-chev', '▸'));
    card.append(head);

    const body = el('div', 'tool-body');
    // в карточках GLM сразу открыт текст ТЗ: ради него вкладка и нужна
    const open = this.filter === 'glm' && ev.input && ev.input.__cat;
    body.hidden = !open;
    card.classList.toggle('open', !!open);
    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
      card.classList.toggle('open', !body.hidden);
    });

    if (ev.input && ev.input.__cat) {
      body.append(el('div', 'tool-label', T.tzText + ' · ' + ev.input.__cat.path));
      if (ev.input.__cat.error) body.append(el('div', 'tool-warn', ev.input.__cat.error));
      else {
        const tz = el('div', 'tz-text bubble');
        tz.innerHTML = mdRender(ev.input.__cat.content);
        body.append(tz);
      }
    }
    body.append(el('div', 'tool-label', T.toolInput));
    const inputClone = Object.assign({}, ev.input);
    delete inputClone.__cat;
    const pre = el('div');
    pre.innerHTML = mdRender('```\n' + JSON.stringify(inputClone, null, 2) + '\n```');
    body.append(pre);
    body.append(el('div', 'tool-label', T.toolResult));
    const wrap = el('div', 'tool-result');
    this.renderResult(wrap, ev.id ? this.results.get(ev.id) : null);
    body.append(wrap);
    card.append(body);
    return card;
  }

  renderResult(wrap, res) {
    wrap.replaceChildren();
    if (!res) { wrap.append(el('span', 'tool-pending', T.toolPending)); return; }
    const pre = el('pre');
    if (res.isError) pre.classList.add('is-error');
    pre.textContent = res.text || '(пусто)';
    wrap.append(pre);
  }

  fillCardResult(id) {
    const card = this.inner.querySelector(`[data-tool-id="${CSS.escape(id)}"]`);
    const wrap = card && card.querySelector('.tool-result');
    if (wrap) this.renderResult(wrap, this.results.get(id));
  }

  scrollToBottom() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  updateLive() {
    const live = this.node && Date.now() - this.lastActivity < 60000;
    this.liveNode.classList.toggle('on', !!live);
  }
}
