'use strict';

// Реестр: проекты, узлы (сессии, субагенты, GLM-исполнители) и связи между ними.
// Принципы памяти:
//   - при старте ничего не индексируется; список проектов строится по readdir/stat и «голове» (256 КБ)
//     одного-двух свежих файлов на папку;
//   - индекс файла (потоком) строится, когда проект или сессию открыли, не больше двух одновременно;
//   - связи берутся из индексов, которые уже есть в кэше; недостающие кандидаты индексируются адресно.

const path = require('path');
const { readHead, readTailText, HEAD_BYTES, MAX_LINE } = require('./lines');
const { newAcc, commitUsage, totals } = require('./acc');
const { makeFileId } = require('./sources');
const { primaryModel, groupOf, nodeStatus, PENDING_MS } = require('./models');
const { readTailState, stepNow } = require('./step');
const { lastTests, followsLastPrompt, currentPrompt } = require('./report');

const SCAN_TTL_MS = 2000;
const HOT_MS = 2 * 60 * 60 * 1000; // субагентов ищем только у сессий, менявшихся за последние 2 часа
const PROJECT_SESSION_LIMIT = 40; // сессий на карту проекта (свежие первыми)
const PROJECT_BYTES_LIMIT = 1024 * 1024 * 1024; // и не больше ~1 ГБ транскриптов
const MATCH_BEFORE_MS = 5000; // GLM-сессия не может начаться раньше запуска больше чем на 5 с
const MATCH_AFTER_MS = 2 * 60 * 1000; // и позже 2 минут после запуска
const UUID_TAIL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVERSE_CANDIDATES = 12;
const PEEK_CAP = 4000;
const TAIL_CAP = 400;
const LAUNCH_SLACK_MS = 5000; // запрос GLM пишется через секунду после вызова claude-glm; запас на разброс часов
const RECENT_LIMIT = 30; // «Готово недавно» на экране «Сейчас»

const normPath = (p) => (typeof p === 'string' && p.length > 1 ? p.replace(/\/+$/, '') : p);

class Registry {
  constructor(adapters, indexer, opts) {
    this.adapters = adapters;
    this.indexer = indexer;
    this.now = (opts && opts.now) || Date.now;
    this.dirCwd = new Map(); // папка → cwd проекта
    this.peeks = new Map(); // путь → { size, mtimeMs, acc }
    this.tails = new Map(); // путь → { size, mtimeMs, state }: хвост файла (висящий вызов, последний шаг)
    this.fileIndex = new Map(); // путь → файл, когда-либо виденный в сканах
    this.idIndex = new Map(); // id узла → тот же файл
    this._scan = null;
    this._scanning = null;
    this.reverseCache = new Map(); // путь GLM-сессии → { at, files }
  }

  /* ---------- «голова» файла ---------- */

  // Лёгкий разбор первых 256 КБ: cwd, заголовок, время начала, первая модель. Кэш по (путь, size, mtime).
  async peek(file) {
    const hit = this.peeks.get(file.path);
    if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return hit.acc;
    const acc = newAcc(file);
    try {
      const head = await readHead(file.path, HEAD_BYTES);
      const lines = head.split('\n');
      if (file.size > HEAD_BYTES) lines.pop(); // последняя строка обрезана границей чтения
      for (const l of lines) {
        if (!l || l.length > MAX_LINE) continue;
        let rec;
        try {
          rec = JSON.parse(l);
        } catch {
          continue;
        }
        file.adapter.scanRecord(rec, acc);
      }
      commitUsage(acc);
    } catch {
      // файл исчез между stat и чтением: остаётся пустой acc
    }
    if (this.peeks.size >= PEEK_CAP) this.peeks.delete(this.peeks.keys().next().value);
    this.peeks.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, acc });
    return acc;
  }

  /* ---------- хвост файла: последний шаг и висящий вызов ---------- */

  // Хвост читаем только у файлов, которые недавно менялись (не старше 15 минут) и не закончены по meta.
  // Кэш по (путь, size, mtime): пока файл молчит, повторного чтения нет.
  inTailWindow(file, now) {
    return now - file.mtimeMs < PENDING_MS && !(file.meta && file.meta.finished === true);
  }

  async tailOf(file) {
    const hit = this.tails.get(file.path);
    if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return hit.state;
    let state = null;
    try {
      state = await readTailState(file.path, file.adapter.parseRecord);
    } catch {
      // файл исчез между stat и чтением
    }
    if (this.tails.size >= TAIL_CAP) this.tails.delete(this.tails.keys().next().value);
    this.tails.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, state });
    return state;
  }

  // Статус файла с учётом висящего вызова и метка последнего шага.
  async statusOf(file, lastErr, now) {
    const tail = this.inTailWindow(file, now) ? await this.tailOf(file) : null;
    const status = nodeStatus({ mtimeMs: file.mtimeMs, meta: file.meta || null, lastErr, pending: !!(tail && tail.pending) }, now);
    return { status, step: status === 'working' ? stepNow(tail, now) : null };
  }

  /* ---------- скан: проекты и сессии ---------- */

  async cwdFromTail(adapter, file) {
    try {
      const acc = newAcc(file);
      for (const l of (await readTailText(file.path, 512 * 1024)).split('\n')) {
        if (!l || l.length > MAX_LINE) continue;
        try {
          adapter.scanRecord(JSON.parse(l), acc);
        } catch {
          continue;
        }
        if (acc.cwd) return acc.cwd;
      }
    } catch {
      // файл исчез
    }
    return null;
  }

  decorate(adapter, dir, info, projectKey) {
    const f = Object.assign({}, info, { adapter, adapterId: adapter.id, dir, projectKey });
    f.id = makeFileId(adapter, info.rel);
    this.fileIndex.set(f.path, f);
    this.idIndex.set(f.id, f);
    return f;
  }

  async cwdOfDir(adapter, dir, sessions) {
    if (this.dirCwd.has(dir)) return this.dirCwd.get(dir);
    for (const s of sessions.slice(0, 4)) {
      const acc = await this.peek(Object.assign({ adapter }, s));
      if (acc.cwd) {
        const cwd = normPath(acc.cwd);
        this.dirCwd.set(dir, cwd);
        return cwd;
      }
    }
    // в голове нет cwd (первое сообщение с картинкой на сотни КБ): смотрим хвост самой свежей сессии
    if (sessions.length) {
      const cwd = normPath(await this.cwdFromTail(adapter, sessions[0]));
      if (cwd) {
        this.dirCwd.set(dir, cwd);
        return cwd;
      }
    }
    return null;
  }

  async scan() {
    if (this._scan && this.now() - this._scan.at < SCAN_TTL_MS) return this._scan;
    if (!this._scanning) {
      this._scanning = this._doScan().finally(() => {
        this._scanning = null;
      });
    }
    return this._scanning;
  }

  async _doScan() {
    const projects = new Map();
    const get = (key, cwd, fallbackName) => {
      let p = projects.get(key);
      if (!p) {
        p = { key, path: cwd, name: cwd ? path.basename(cwd) || cwd : fallbackName, files: [] };
        projects.set(key, p);
      }
      return p;
    };
    const execs = [];
    for (const adapter of this.adapters) {
      for (const { dir, name } of await adapter.listDirs()) {
        const sessions = (await adapter.listSessions(dir)).sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (!sessions.length) continue;
        if (adapter.dirIsProject) {
          const cwd = await this.cwdOfDir(adapter, dir, sessions);
          const p = get(cwd || '?' + adapter.id + ':' + name, cwd, name);
          for (const s of sessions) p.files.push(this.decorate(adapter, dir, s, p.key));
        } else {
          for (const s of sessions) {
            const acc = await this.peek(Object.assign({ adapter }, s));
            const cwd = normPath(acc.cwd);
            const p = get(cwd || '?' + adapter.id + ':' + name, cwd, name);
            p.files.push(this.decorate(adapter, dir, s, p.key));
          }
        }
      }
    }
    for (const p of projects.values()) {
      p.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const f of p.files) if (f.adapter.executor && f.kind === 'session') execs.push(f);
    }
    // Сессии исполнителей нужны для сопоставления запусков: им достаточно «головы» (cwd, время первой записи)
    for (const g of execs) g.peek = await this.peek(g);

    const sc = { at: this.now(), projects, execs, active: [], recent: [] };
    // активные узлы: сессии и субагенты свежих сессий, без чтения содержимого
    const now = this.now();
    for (const p of projects.values()) {
      p.activeCount = 0;
      for (const f of p.files) {
        if (now - f.mtimeMs > HOT_MS) break; // файлы отсортированы по mtime
        const subs = (await f.adapter.listSubagents(f.dir, f.sessionId)).map((s) => this.decorate(f.adapter, f.dir, s, p.key));
        for (const x of [f, ...subs]) {
          const cached = this.indexer.cached(x.path);
          const { status } = await this.statusOf(x, cached && cached.lastErr, now);
          if (status === 'working') {
            p.activeCount++;
            sc.active.push(x);
          } else if (now - x.mtimeMs < HOT_MS) sc.recent.push(x);
        }
      }
    }
    this._scan = sc;
    return sc;
  }

  /* ---------- список проектов и «сейчас работают» ---------- */

  async listProjects() {
    const sc = await this.scan();
    const out = [];
    for (const p of sc.projects.values()) {
      const providers = {};
      for (const f of p.files) providers[f.adapter.provider] = (providers[f.adapter.provider] || 0) + 1;
      out.push({
        key: p.key,
        name: p.name,
        path: p.path,
        sessions: p.files.length,
        lastMs: p.files.length ? p.files[0].mtimeMs : 0,
        activeCount: p.activeCount || 0,
        providers,
      });
    }
    out.sort((a, b) => b.lastMs - a.lastMs);
    return out;
  }

  async listNow() {
    const sc = await this.scan();
    // индексацию активных файлов запускаем фоном: модель и токены подтянутся при следующем опросе
    const nodes = [];
    for (const f of sc.active) {
      this.indexer.get(f.adapter, f).catch(() => {});
      nodes.push(await this.makeNode(f, sc));
    }
    nodes.sort((a, b) => b.lastMs - a.lastMs);
    return nodes;
  }

  // Недавно закончившие (за последние 2 часа): для свёрнутого блока «Готово» на экране «Сейчас».
  async listRecent() {
    const sc = await this.scan();
    const files = sc.recent.slice().sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, RECENT_LIMIT);
    const nodes = [];
    for (const f of files) nodes.push(await this.makeNode(f, sc));
    return nodes;
  }

  // Файл узла по id (из последнего скана); null, если такого агента реестр не видел.
  async fileById(id) {
    await this.scan();
    return this.idIndex.get(id) || null;
  }

  // Кто поставил задачу сессии исполнителя: по уже проиндексированным запускам (новых чтений не запускает).
  // taskTs: время запроса, который показан как задача. Её поставил тот, кто запустил исполнителя в последний
  // раз до этого запроса (по запускам из индексов, без новых чтений); нет такого запуска, берётся первый.
  async launcherOf(file, sc, taskTs) {
    if (!file.adapter.executor || file.kind !== 'session') return null;
    const entries = this.linkMap(sc || (await this.scan())).byTarget.get(file.path);
    if (!entries || !entries.length) return null;
    const sorted = entries.slice().sort((a, b) => a.ts - b.ts);
    const first = (taskTs && sorted.filter((e) => e.ts <= taskTs + LAUNCH_SLACK_MS).pop()) || sorted[0];
    const lf = this.fileIndex.get(first.from);
    if (!lf) return null;
    return this.describeLauncher(lf, await this.makeNode(lf, sc), sc);
  }

  /* ---------- узел ---------- */

  async accFor(file, allowPeek) {
    const cached = this.indexer.cached(file.path);
    if (cached) return cached;
    if (allowPeek && file.kind === 'session') return this.peek(file);
    return null;
  }

  async makeNode(file, sc) {
    const acc = await this.accFor(file, true);
    const now = this.now();
    const a = acc || newAcc(file);
    const t = acc ? totals(acc) : { in: 0, out: 0, cache: 0, models: {} };
    const meta = file.meta || null;
    const provider = file.adapter.provider;
    let model = primaryModel(t.models);
    if (!model && meta && meta.model) model = meta.model;
    const { status, step } = await this.statusOf(file, a.lastErr, now);
    const startMs = a.firstTs || file.birthtimeMs || file.mtimeMs;
    const lastMs = Math.max(a.lastTs || 0, file.mtimeMs);
    const endMs = status === 'working' ? now : lastMs;
    const project = this.projectOf(file, sc);
    // у сессии исполнителя заголовок это её последняя задача; запросов в индексе может быть неполно, пока файл читается только с головы
    const promptsKnown = a.indexedBytes > 0 || file.size <= HEAD_BYTES;
    const lastTask = followsLastPrompt(file) && promptsKnown && currentPrompt(a) ? currentPrompt(a).title : null;
    let title;
    if (file.kind === 'subagent') title = (meta && meta.description) || a.firstUser || file.sessionId;
    else title = lastTask || a.title || a.firstUser || file.sessionId.slice(0, 8);
    const indexed = !!acc && acc.size === file.size && acc.mtimeMs === file.mtimeMs;
    return {
      id: file.id,
      kind: file.kind,
      provider,
      providerLabel: file.adapter.label,
      model: model || null,
      models: t.models,
      group: groupOf(provider, model, file.adapter.label),
      executor: file.adapter.executor === true,
      title: String(title).slice(0, 200),
      taskCount: lastTask && a.userCount > 1 ? a.userCount : null, // задач в сессии исполнителя, если их больше одной
      agentType: (meta && meta.agentType) || null,
      project,
      sessionId: file.sessionId,
      parentSessionId: file.parentSessionId || null,
      status,
      lastStep: step,
      testsOk: acc ? lastTests(acc) : null, // итог последнего прогона тестов: true, false или null
      finished: meta ? meta.finished === true : null,
      startMs,
      lastMs,
      durationMs: Math.max(0, endMs - startMs),
      tokens: { in: t.in, out: t.out, cache: t.cache },
      sizeBytes: file.size,
      indexed,
      parent: null,
      launchedFrom: null,
      sendsIn: 0,
      glmRuns: 0,
      external: false,
    };
  }

  projectOf(file, sc) {
    const scan = sc || this._scan;
    const p = scan && scan.projects.get(file.projectKey);
    return { key: file.projectKey, name: p ? p.name : path.basename(file.projectKey || '') || '?', path: p ? p.path : file.projectKey };
  }

  /* ---------- связи ---------- */

  // Все запуски исполнителей из кэшированных индексов → какая сессия исполнителя за ними.
  // Возвращает { byTarget: Map<путь сессии, [{from, ts, how, cat, profile}]>,
  //               missing: [{from, ts, profile}] } - запуски (MCP), для которых сессия не нашлась:
  // связь всё равно рисуется, с пометкой «сессия не найдена», без выдуманной сессии.
  linkMap(sc) {
    const launches = [];
    const addAll = (p, acc) => {
      for (const l of acc.launches) launches.push({ from: p, ts: l.ts, cwd: normPath(l.cwd), resume: l.resume, cat: l.cat, toolUseId: l.toolUseId, profile: l.profile, mcp: l.mcp === true });
    };
    for (const [p, acc] of this.indexer.cache) if (acc.launches.length) addAll(p, acc);
    for (const [p, acc] of this.indexer.running) if (acc.launches.length && !this.indexer.cache.has(p)) addAll(p, acc);
    launches.sort((a, b) => a.ts - b.ts);

    // id сессии → сессия. У Codex id потока (из resume) - это хвост имени файла rollout-<время>-<uuid>,
    // поэтому ищем и по полному sessionId, и по uuid на конце.
    const byId = new Map();
    const byTailId = new Map();
    for (const g of sc.execs) {
      byId.set(g.sessionId, g);
      const tail = g.sessionId.slice(-36);
      if (UUID_TAIL_RE.test(tail)) byTailId.set(tail.toLowerCase(), g);
    }
    const claimed = new Set();
    const byTarget = new Map();
    const missing = [];
    const push = (target, entry) => {
      if (target.path === entry.from) return;
      if (!byTarget.has(target.path)) byTarget.set(target.path, []);
      byTarget.get(target.path).push(entry);
    };
    for (const l of launches) {
      if (l.resume) {
        const t = byId.get(l.resume) || byTailId.get(l.resume);
        if (t) push(t, { from: l.from, ts: l.ts, how: 'resume', cat: l.cat, profile: l.profile });
        continue; // запуску с resume нужна именно своя сессия: по времени не подбираем
      }
      let best = null;
      let bestGap = Infinity;
      for (const g of sc.execs) {
        if (claimed.has(g.path) || g.path === l.from) continue;
        const first = g.peek && g.peek.firstTs;
        if (!first) continue;
        const gap = first - l.ts;
        if (gap < -MATCH_BEFORE_MS || gap > MATCH_AFTER_MS) continue;
        if (!cwdMatch(g.peek.cwd, l.cwd)) continue;
        if (gap < bestGap) {
          best = g;
          bestGap = gap;
        }
      }
      if (best) {
        claimed.add(best.path);
        push(best, { from: l.from, ts: l.ts, how: l.mcp ? 'mcp' : 'time', cat: l.cat, profile: l.profile });
      } else if (l.mcp) {
        // у MCP-запуска нет ни --resume, ни найденной сессии: факт запуска остаётся на карте
        missing.push({ from: l.from, ts: l.ts, profile: l.profile });
      }
    }
    return { byTarget, missing };
  }

  // Кандидаты в «запустившие» GLM-сессию: файлы, жившие в момент её старта. Дальше их индексирует очередь.
  async reverseCandidates(g, sc) {
    const hit = this.reverseCache.get(g.path);
    if (hit && this.now() - hit.at < 30000) return hit.files;
    const first = g.peek && g.peek.firstTs;
    const out = [];
    if (first) {
      const alive = (f) => f.birthtimeMs <= first + 2000 && f.mtimeMs >= first - MATCH_BEFORE_MS;
      for (const p of sc.projects.values()) {
        for (const f of p.files) {
          if (f.path === g.path || f.adapter.provider === 'glm') continue;
          if (f.mtimeMs < first - MATCH_BEFORE_MS) break; // отсортированы по mtime
          if (alive(f)) out.push(f);
          const subs = f.birthtimeMs <= first + 2000 ? await f.adapter.listSubagents(f.dir, f.sessionId) : [];
          for (const s of subs) if (alive(s)) out.push(this.decorate(f.adapter, f.dir, s, p.key));
        }
      }
    }
    out.sort((a, b) => Math.abs(a.birthtimeMs - first) - Math.abs(b.birthtimeMs - first));
    const files = out.slice(0, REVERSE_CANDIDATES);
    this.reverseCache.set(g.path, { at: this.now(), files });
    return files;
  }

  /* ---------- сборка графа ---------- */

  // files - узлы графа. Возвращает { nodes, edges, extraFiles }, extraFiles - файлы, которые стоит проиндексировать
  // (кандидаты в «запустившие» и GLM-сессии, найденные по запускам).
  async assemble(files, sc) {
    const nodes = new Map();
    for (const f of files) nodes.set(f.id, await this.makeNode(f, sc));
    const byPath = new Map(files.map((f) => [f.path, f]));
    const edges = [];
    const extraFiles = [];

    // 1. субагенты → родитель: по toolUseId из meta.json, иначе по description, иначе сессия
    const byToolUse = new Map();
    const agentCalls = [];
    for (const f of files) {
      const acc = this.indexer.cached(f.path);
      if (!acc) continue;
      for (const a of acc.agents) {
        if (a.id) byToolUse.set(a.id, f.id);
        agentCalls.push({ from: f.id, ...a, used: false });
      }
    }
    const sessionOf = new Map();
    for (const f of files) if (f.kind === 'session') sessionOf.set(f.dir + '|' + f.sessionId, f.id);
    for (const f of files) {
      if (f.kind !== 'subagent') continue;
      const node = nodes.get(f.id);
      const meta = f.meta || {};
      let parent = meta.toolUseId ? byToolUse.get(meta.toolUseId) : null;
      if (!parent && meta.description) {
        const c = agentCalls.find((x) => !x.used && x.description === meta.description && x.from !== f.id);
        if (c) {
          c.used = true;
          parent = c.from;
        }
      }
      if (!parent) parent = sessionOf.get(f.dir + '|' + f.parentSessionId) || null;
      node.parent = parent;
      if (parent) edges.push({ kind: 'agent', from: parent, to: f.id });
    }

    // 2. SendMessage → субагент (поле to = agentId)
    const byAgentId = new Map();
    for (const f of files) if (f.kind === 'subagent') byAgentId.set(f.sessionId, f.id);
    for (const f of files) {
      const acc = this.indexer.cached(f.path);
      if (!acc) continue;
      for (const s of acc.sends) {
        const to = byAgentId.get(s.to);
        if (!to || to === f.id) continue;
        edges.push({ kind: 'send', from: f.id, to, ts: s.ts, summary: s.summary });
        nodes.get(to).sendsIn++;
      }
    }

    // 3. запуски исполнителей: сессия или субагент → сессия исполнителя (в том числе из другого проекта)
    const links = this.linkMap(sc);
    const fileOf = (p) => byPath.get(p) || this.fileIndex.get(p) || null;
    const ensureNode = async (f) => {
      let n = nodes.get(f.id);
      if (!n) {
        n = await this.makeNode(f, sc);
        n.external = true;
        nodes.set(f.id, n);
        extraFiles.push(f);
      }
      return n;
    };
    for (const [targetPath, entries] of links.byTarget) {
      const target = fileOf(targetPath);
      if (!target) continue;
      const inGraph = nodes.has(target.id);
      const anyFromInGraph = entries.some((e) => byPath.has(e.from));
      if (!inGraph && !anyFromInGraph) continue;
      const sorted = entries.slice().sort((a, b) => a.ts - b.ts);
      const launcherFile = fileOf(sorted[0].from);
      if (!launcherFile) continue;
      const tNode = await ensureNode(target);
      const lNode = await ensureNode(launcherFile);
      tNode.parent = lNode.id;
      tNode.glmRuns = sorted.length;
      tNode.launchedFrom = await this.describeLauncher(launcherFile, lNode, sc);
      tNode.tz = sorted[0].cat ? path.basename(sorted[0].cat) : null;
      edges.push({ kind: 'glm', from: lNode.id, to: tNode.id, ts: sorted[0].ts, how: sorted[0].how, runs: sorted.length, profile: sorted[0].profile });
      for (const e of sorted.slice(1)) {
        const lf = fileOf(e.from);
        if (!lf) continue;
        const ln = await ensureNode(lf);
        edges.push({ kind: 'glm-again', from: ln.id, to: tNode.id, ts: e.ts, how: e.how, profile: e.profile });
      }
    }

    // 3а. запуски без найденной сессии (MCP): связь рисуется с пометкой «сессия не найдена»,
    // выдуманную сессию не создаём. to: null - интерфейс части Б рисует стрелку «в никуда».
    for (const m of links.missing) {
      const lf = fileOf(m.from);
      if (!lf || !nodes.has(lf.id)) continue;
      edges.push({ kind: 'glm', from: lf.id, to: null, ts: m.ts, how: 'mcp', profile: m.profile, missing: true });
    }

    // 4. у сессий исполнителей без найденного запустившего - кандидаты для адресной индексации
    for (const f of files) {
      if (!f.adapter.executor || f.kind !== 'session' || links.byTarget.has(f.path)) continue;
      if (!f.peek) f.peek = await this.peek(f);
      for (const c of await this.reverseCandidates(f, sc)) extraFiles.push(c);
    }
    return { nodes: [...nodes.values()], edges, extraFiles };
  }

  // «запущен из <проект> · <заголовок сессии>»: для субагента-запускателя берём его корневую сессию.
  async describeLauncher(file, node, sc) {
    let rootNode = node;
    if (file.kind === 'subagent') {
      const rootFile = this.fileIndex.get(path.join(file.dir, file.parentSessionId + '.jsonl'));
      if (rootFile) rootNode = await this.makeNode(rootFile, sc);
    }
    return {
      nodeId: node.id,
      kind: file.kind,
      task: file.kind === 'subagent' ? node.title : null,
      sessionId: rootNode.id,
      sessionTitle: rootNode.title,
      project: rootNode.project,
    };
  }

  /* ---------- представления ---------- */

  // Какие сессии проекта попадают на карту: самые свежие, в пределах бюджета по размеру.
  pickSessions(project) {
    const picked = [];
    let bytes = 0;
    for (const f of project.files) {
      if (picked.length >= PROJECT_SESSION_LIMIT) break;
      if (picked.length && bytes + f.size > PROJECT_BYTES_LIMIT) break;
      picked.push(f);
      bytes += f.size;
    }
    return picked;
  }

  async projectFiles(project, picked) {
    const files = picked.slice();
    for (const s of picked) {
      for (const sub of await s.adapter.listSubagents(s.dir, s.sessionId)) files.push(this.decorate(s.adapter, s.dir, sub, project.key));
    }
    return files;
  }

  kick(files, priority) {
    const sorted = files.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of sorted) this.indexer.get(f.adapter, f, priority).catch(() => {});
  }

  async projectView(key, opts) {
    const sc = await this.scan();
    const project = sc.projects.get(key);
    if (!project) return null;
    const picked = this.pickSessions(project);
    const files = await this.projectFiles(project, picked);
    this.kick(files);
    if (opts && opts.wait) await this.indexer.ensure(files.map((file) => ({ adapter: file.adapter, file })));
    const g = await this.assemble(files, sc);
    const extra = dedupeFiles(g.extraFiles);
    this.kick(extra);
    if (opts && opts.wait) {
      await this.indexer.ensure(extra.map((file) => ({ adapter: file.adapter, file })));
      const g2 = await this.assemble(files, sc);
      Object.assign(g, g2);
    }
    const all = dedupeFiles(files.concat(extra));
    return {
      project: { key: project.key, name: project.name, path: project.path },
      nodes: g.nodes,
      edges: g.edges,
      sessions: project.files.map((f) => ({ id: f.id, sessionId: f.sessionId, provider: f.adapter.provider, mtimeMs: f.mtimeMs, sizeBytes: f.size, shown: picked.includes(f) })),
      truncated: project.files.length > picked.length ? { shown: picked.length, total: project.files.length } : null,
      progress: this.indexer.progress(all),
    };
  }

  // Карта одной сессии: она, её субагенты и всё, что запущено из них (в том числе в других проектах).
  async sessionView(fileId, opts) {
    const sc = await this.scan();
    let root = this.idIndex.get(fileId) || null;
    if (!root || !sc.projects.has(root.projectKey)) return null;
    const project = sc.projects.get(root.projectKey);
    const subs = (await root.adapter.listSubagents(root.dir, root.sessionId)).map((s) => this.decorate(root.adapter, root.dir, s, root.projectKey));
    let files = [root, ...subs];
    this.kick(files, true);
    if (opts && opts.wait) await this.indexer.ensure(files.map((file) => ({ adapter: file.adapter, file })), true);

    // GLM-исполнители, запущенные из этих файлов (и их субагенты), и кандидаты в «запустившие» корень
    let g = await this.assemble(files, sc);
    let extra = dedupeFiles(g.extraFiles);
    this.kick(extra, true);
    if (opts && opts.wait) {
      await this.indexer.ensure(extra.map((file) => ({ adapter: file.adapter, file })), true);
      g = await this.assemble(files, sc);
    }
    // Сессии исполнителей из других проектов: их субагентов тоже берём в граф
    const glmFiles = [];
    for (const n of g.nodes) {
      if (!n.external || !n.executor) continue;
      const f = this.idIndex.get(n.id);
      if (!f) continue;
      glmFiles.push(f);
      for (const s of await f.adapter.listSubagents(f.dir, f.sessionId)) glmFiles.push(this.decorate(f.adapter, f.dir, s, f.projectKey));
    }
    if (glmFiles.length) {
      files = dedupeFiles(files.concat(glmFiles));
      this.kick(glmFiles, true);
      if (opts && opts.wait) await this.indexer.ensure(glmFiles.map((file) => ({ adapter: file.adapter, file })), true);
      g = await this.assemble(files, sc);
      extra = dedupeFiles(g.extraFiles.concat(glmFiles));
    }
    // оставляем поддерево корня + запустившего его (если корень - сессия исполнителя);
    // рёбра «сессия не найдена» (to: null) остаются, если живёт в поддереве
    const keep = subtree(root.id, g.edges);
    const nodes = g.nodes.filter((n) => keep.has(n.id));
    const edges = g.edges.filter((e) => keep.has(e.from) && (keep.has(e.to) || e.to === null));
    const all = dedupeFiles(files.concat(extra));
    return {
      root: root.id,
      project: { key: project.key, name: project.name, path: project.path },
      nodes,
      edges,
      progress: this.indexer.progress(all),
    };
  }

  // Профили, у которых есть запуски в проиндексированных переписках: ими заполняется список
  // исполнителей, когда team.json не задал его сам.
  launchProfiles() {
    const out = new Set();
    const add = (acc) => {
      for (const l of acc.launches) if (l.profile) out.add(l.profile);
    };
    for (const acc of this.indexer.cache.values()) add(acc);
    for (const [p, acc] of this.indexer.running) if (!this.indexer.cache.has(p)) add(acc);
    return [...out];
  }

  // Связи между проектами по тому, что уже проиндексировано: { from: проект запускателя, to: проект сессии исполнителя, count }.
  async crossLinks() {
    const sc = await this.scan();
    const byTarget = this.linkMap(sc).byTarget;
    const agg = new Map();
    for (const [targetPath, entries] of byTarget) {
      const t = this.fileIndex.get(targetPath);
      if (!t) continue;
      for (const e of entries) {
        const l = this.fileIndex.get(e.from);
        if (!l || l.projectKey === t.projectKey) continue;
        const k = l.projectKey + '\n' + t.projectKey;
        const cur = agg.get(k) || { from: l.projectKey, to: t.projectKey, count: 0, working: 0 };
        cur.count++;
        if (nodeStatus({ mtimeMs: t.mtimeMs, meta: t.meta }, this.now()) === 'working') cur.working++;
        agg.set(k, cur);
      }
    }
    const name = (key) => (sc.projects.get(key) ? sc.projects.get(key).name : key);
    return [...agg.values()].map((x) => Object.assign(x, { fromName: name(x.from), toName: name(x.to) }));
  }
}

function cwdMatch(a, b) {
  const x = normPath(a);
  const y = normPath(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

function dedupeFiles(list) {
  const seen = new Set();
  const out = [];
  for (const f of list) {
    if (!f || seen.has(f.path)) continue;
    seen.add(f.path);
    out.push(f);
  }
  return out;
}

// Корень и всё, до чего от него можно дойти по рёбрам agent/glm. Запустивший корень
// (если корень - GLM-сессия) в дерево не входит: он виден в root.launchedFrom.
function subtree(rootId, edges) {
  const keep = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) {
      if ((e.kind === 'agent' || e.kind === 'glm') && keep.has(e.from) && e.to && !keep.has(e.to)) {
        keep.add(e.to);
        grew = true;
      }
    }
  }
  return keep;
}

module.exports = { Registry, cwdMatch, normPath };
