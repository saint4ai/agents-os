'use strict';

// Agents OS: локальная «карта агентов» по всем проектам Claude Code, GLM и (если есть) Codex.
// Слушает только 127.0.0.1. Запуск: node --max-old-space-size=384 server.js
// Транскрипты целиком в память не читаются: см. lib/lines.js и lib/indexer.js.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadAdapters, resolveFileId, resolveFileIdShape, resolveWithinHome, expandHome, isSensitiveHomePath, homeTilde } = require('./lib/sources');
const { CAT_RE, parseAgentLaunches } = require('./lib/shell');
const { current: currentProfiles } = require('./lib/providers');
const { readBackLines, readForward } = require('./lib/lines');
const { parseLine } = require('./lib/parse');
const { redact, redactDeep, isEnabled, disabledWarning } = require('./lib/redact');
const { Indexer } = require('./lib/indexer');
const { Registry } = require('./lib/registry');
const { buildReport, currentPrompt } = require('./lib/report');
const { loadTeam, executorsFor } = require('./lib/team');
const { loadProfiles } = require('./lib/providers');
const guard = require('./lib/guard');

const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CAT_MAX_BYTES = 512 * 1024; // лимит подстановки $(cat ...)
const DEFAULT_LIMIT = 300; // последних событий в ленте
const MAX_LIMIT = 500;
const TEXT_CAP = 30000; // длиннее - обрезаем в ответе (в файле остаётся полный текст)
const MAX_STREAMS = 8;
const FEED_MAX_LINES = 6000; // сколько строк максимум просматриваем с конца ради limit событий
const REPORT_CACHE = 50; // готовых отчётов в памяти
const REPORT_WAIT_MS = 2500; // сколько ждём индекс файла, потом отвечаем pending

// Заголовки безопасности на каждом ответе; CSP на HTML (приложение без CDN и инлайн-скриптов).
const SEC_HEADERS = { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const CSP = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'";

const doRedact = (s) => (isEnabled() ? redact(s) : s);
const doRedactDeep = (o) => (isEnabled() ? redactDeep(o) : o);

function sendJson(res, code, obj) {
  const body = JSON.stringify(doRedactDeep(obj)); // маскировка в одном месте: любой JSON-ответ чистится
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS, { 'Content-Security-Policy': CSP }));
  res.end(body);
}

// ---------- события ленты ----------

function capString(s) {
  return typeof s === 'string' && s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + '\n… (обрезано, полный текст в файле сессии)' : s;
}

function capDeep(v) {
  if (typeof v === 'string') return capString(v);
  if (Array.isArray(v)) return v.map(capDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = capDeep(x);
    return o;
  }
  return v;
}

// Для Bash-вызовов с $(cat <путь>): подставляем содержимое файла (.md/.txt, только внутри домашней папки
// и не в защищённых папках, с маскировкой) в input.__cat. Остальные файлы не читаем.
// Читаем через дескриптор с потолком CAT_MAX_BYTES+1 байт: без отдельного stat, гонки размера нет.
function annotateCat(ev) {
  if (ev.kind !== 'tool_call' || ev.tool !== 'Bash') return ev;
  const cmd = ev.input && typeof ev.input.command === 'string' ? ev.input.command : '';
  const m = CAT_RE.exec(cmd);
  if (!m) return ev;
  const raw = m[1].replace(/^["']|["']$/g, '');
  const abs = resolveWithinHome(raw);
  const info = { path: abs ? homeTilde(abs) : raw };
  if (!abs) info.error = 'путь вне домашней папки';
  else if (!/\.(md|txt)$/i.test(abs)) info.error = 'читаю только .md и .txt';
  else if (isSensitiveHomePath(abs)) info.error = 'файл в защищённой папке';
  else {
    let fd = null;
    try {
      fd = fs.openSync(abs, 'r');
      const buf = Buffer.allocUnsafe(CAT_MAX_BYTES + 1);
      const bytesRead = fs.readSync(fd, buf, 0, CAT_MAX_BYTES + 1, 0);
      if (bytesRead > CAT_MAX_BYTES) info.error = 'файл больше 512 КБ';
      else info.content = capString(doRedact(buf.toString('utf8', 0, bytesRead)));
    } catch {
      info.error = 'файл уже удалён или недоступен';
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch {}
    }
  }
  ev.input = Object.assign({}, ev.input, { __cat: info });
  return ev;
}

function toClientEvent(ev) {
  ev.text = capString(doRedact(ev.text));
  if (ev.input) ev.input = capDeep(doRedactDeep(ev.input));
  // запуск исполнителя: вкладка «→ GLM» показывает только настоящие запуски (не ls/cat самого скрипта);
  // у профилей из конфига пометка agentLaunch с именем профиля
  if (ev.kind === 'tool_call' && ev.tool === 'Bash' && ev.input && typeof ev.input.command === 'string') {
    const l = parseAgentLaunches(ev.input.command, currentProfiles(), null)[0];
    if (l) {
      ev.agentLaunch = { profile: l.profile, resume: l.resume, check: l.check };
      if (l.profile === 'glm') ev.glm = { resume: l.resume, check: l.check };
    }
  }
  return annotateCat(ev);
}

// ---------- приложение ----------

async function createApp(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const adapters = await loadAdapters(env);
  const indexer = new Indexer({ env });
  const registry = new Registry(adapters, indexer, { now: o.now });
  let streams = 0;
  const reports = new Map(); // (путь, size, mtime) → готовый отчёт; файл дописался - ключ другой
  const reportWait = Number(env.REPORT_WAIT_MS) || REPORT_WAIT_MS;

  // Тяжёлые запросы (чтение транскриптов) при высоком RSS отклоняем с причиной.
  function overMemory(res, what) {
    const c = guard.check(env);
    if (c.ok) return false;
    const msg = `Память сервера выше лимита: RSS ${c.rssMb} МБ из ${c.limitMb} МБ. Запрос «${what}» отклонён, повторите через несколько секунд.`;
    console.warn('[память] ' + msg);
    sendJson(res, 503, { error: msg, rssMb: c.rssMb, limitMb: c.limitMb });
    return true;
  }

  const fileFor = (id) => resolveFileId(adapters, id);

  // Роли «мозг / исполнитель». Файл team.json читается, но никогда не пишется: его правит
  // агент по просьбе человека. Исполнитель получает provider и label профиля для меток на карте.
  function teamWithInfo() {
    const t = loadTeam(env);
    const profiles = loadProfiles(env).profiles;
    const info = (id) => {
      const p = profiles.find((x) => x.id === id);
      if (!p) return { profile: id, provider: id, label: id };
      return { profile: p.id, provider: p.id === 'codex' ? 'gpt' : p.id, label: p.label };
    };
    const executors = t.team.executors.length ? t.team.executors.map((e) => Object.assign(info(e.profile), { projects: e.projects })) : registry.launchProfiles().map((p) => Object.assign(info(p), { projects: ['*'] }));
    return { brain: info(t.team.brain), executors, updatedAt: t.team.updatedAt, updatedBy: t.team.updatedBy, source: t.source, warnings: t.warnings };
  }

  async function apiTeam(res) {
    const t = teamWithInfo();
    sendJson(res, 200, { brain: t.brain, executors: t.executors, updatedAt: t.updatedAt, updatedBy: t.updatedBy, source: t.source });
  }

  async function apiProjects(res) {
    sendJson(res, 200, { projects: await registry.listProjects(), sources: adapters.map((a) => ({ id: a.id, provider: a.provider, label: a.label })) });
  }

  async function apiNow(res) {
    sendJson(res, 200, { nodes: await registry.listNow(), recent: await registry.listRecent() });
  }

  async function apiProject(res, q) {
    if (overMemory(res, 'карта проекта')) return;
    const view = await registry.projectView(q.get('key') || '');
    if (!view) return sendJson(res, 404, { error: 'Проект не найден. Обновите список проектов.' });
    // роли для этого проекта: team.json фильтруется по пути проекта, без файла - профили с запусками
    const t = teamWithInfo();
    const allowed = executorsFor(
      { executors: t.executors.map((e) => ({ profile: e.profile, projects: e.projects })) },
      view.project.path
    ).map((e) => ({ profile: e.profile, provider: e.provider, label: e.label }));
    view.team = { brain: t.brain, executors: allowed, source: t.source };
    sendJson(res, 200, view);
  }

  async function apiMap(res, q) {
    if (overMemory(res, 'карта сессии')) return;
    const view = await registry.sessionView(q.get('id') || '');
    if (!view) return sendJson(res, 404, { error: 'Сессия не найдена. Обновите список проектов.' });
    sendJson(res, 200, view);
  }

  async function apiCross(res) {
    sendJson(res, 200, { links: await registry.crossLinks() });
  }

  // Последние limit событий: читаем с конца кусками. ?before=<смещение> - догрузка более ранних.
  async function apiSession(res, q) {
    if (overMemory(res, 'лента')) return;
    const f = fileFor(q.get('id') || '');
    if (!f) return sendJson(res, 400, { error: 'Путь недоступен: сессия должна лежать внутри источников.' });
    let limit = parseInt(q.get('limit') || '', 10);
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
    limit = Math.min(limit, MAX_LIMIT);
    let st;
    try {
      st = await fs.promises.stat(f.abs);
    } catch {
      return sendJson(res, 404, { error: 'Файл сессии не найден: возможно, он удалён.' });
    }
    const before = parseInt(q.get('before') || '', 10);
    let endOffset = Number.isFinite(before) && before >= 0 ? Math.min(before, st.size) : st.size;

    const events = [];
    let startOffset = endOffset;
    let reachedStart = false;
    let scanned = 0;
    try {
      while (events.length < limit && scanned < FEED_MAX_LINES) {
        const back = await readBackLines(f.abs, endOffset, 400);
        scanned += back.lines.length;
        for (let i = back.lines.length - 1; i >= 0 && events.length < limit; i--) {
          const evs = parseLine(back.lines[i].text, f.adapter.parseRecord).map(toClientEvent);
          const room = limit - events.length;
          events.unshift(...(evs.length > room ? evs.slice(-room) : evs));
          startOffset = back.lines[i].offset;
        }
        if (back.reachedStart) {
          reachedStart = true;
          break;
        }
        if (!back.lines.length) {
          // строки подряд слишком длинные или пустые: сдвигаемся на кусок влево
          endOffset = Math.max(0, endOffset - 256 * 1024);
          startOffset = endOffset;
          if (endOffset === 0) {
            reachedStart = true;
            break;
          }
          continue;
        }
        endOffset = back.startOffset;
      }
    } catch {
      return sendJson(res, 404, { error: 'Файл сессии не прочитан.' });
    }
    sendJson(res, 200, {
      events,
      offset: startOffset,
      endOffset: st.size,
      mtime: st.mtimeMs,
      hasMore: !reachedStart && startOffset > 0,
    });
  }

  // Отчёт агента: задача (голова файла), что сделал (хвост), как выполнял и проверки (индекс).
  // Индекс ещё строится: { pending, pct }, интерфейс спросит снова. Файл целиком не читается.
  async function apiReport(res, q) {
    if (overMemory(res, 'отчёт')) return;
    const id = q.get('id') || '';
    // Форма id без диска: чужой источник / не .jsonl / выход за корень - 400;
    // корректный, но неизвестный или удалённый агент - 404.
    const shape = resolveFileIdShape(adapters, id);
    if (!shape) return sendJson(res, 400, { error: 'Путь недоступен: агент должен лежать внутри источников.' });
    if (!shape.adapter.reportSupported) return sendJson(res, 200, { unsupported: true });
    const known = await registry.fileById(id);
    if (!known) return sendJson(res, 404, { error: 'Агент не найден. Обновите список проектов.' });
    const f = fileFor(id) || known;
    let st;
    try {
      st = await fs.promises.stat(f.abs);
    } catch {
      return sendJson(res, 404, { error: 'Файл агента не найден: возможно, он удалён.' });
    }
    const file = Object.assign({}, known, { size: st.size, mtimeMs: st.mtimeMs });
    const key = file.path + '|' + st.size + '|' + st.mtimeMs;
    const hit = reports.get(key);
    if (hit) return sendJson(res, 200, hit);
    const acc = await Promise.race([indexer.get(file.adapter, file, true).catch(() => null), new Promise((r) => setTimeout(r, reportWait, null).unref())]);
    if (!acc) return sendJson(res, 200, { pending: true, pct: indexer.progress([file]).pct });
    const sc = await registry.scan();
    const node = await registry.makeNode(file, sc);
    node.launchedFrom = await registry.launcherOf(file, sc, (currentPrompt(acc) || {}).ts);
    const report = doRedactDeep(await buildReport({ file, node, acc }));
    if (reports.size >= REPORT_CACHE) reports.delete(reports.keys().next().value);
    reports.set(key, report);
    sendJson(res, 200, report);
  }

  // SSE: новые события по смещению
  function apiStream(req, res, q) {
    if (overMemory(res, 'поток')) return;
    const f = fileFor(q.get('id') || '');
    if (!f) return sendJson(res, 400, { error: 'Путь недоступен: сессия должна лежать внутри источников.' });
    if (streams >= MAX_STREAMS) return sendJson(res, 503, { error: 'Открыто слишком много живых потоков (максимум ' + MAX_STREAMS + '). Закройте лишние вкладки.' });
    streams++;
    let offset = parseInt(q.get('offset') || '0', 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }, SEC_HEADERS));
    res.write('retry: 3000\n\n');
    let closed = false;
    let busy = false;
    let watcher = null;
    const send = (event, data) => {
      if (!closed) res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    };
    const pump = async () => {
      if (closed || busy || !guard.check(env).ok) return;
      busy = true;
      try {
        for (let guardLoop = 0; guardLoop < 20 && !closed; guardLoop++) {
          const r = await readForward(f.abs, offset);
          if (r.truncated) send('reset', {});
          offset = r.offset;
          if (r.data) {
            const events = [];
            for (const line of r.data.split('\n')) for (const ev of parseLine(line, f.adapter.parseRecord)) events.push(toClientEvent(ev));
            if (events.length) send('batch', { offset, events });
          }
          if (!r.more) break;
        }
      } catch {
        // файл мог исчезнуть: ждём следующий тик
      } finally {
        busy = false;
      }
    };
    try {
      watcher = fs.watch(f.abs, () => pump());
      watcher.on('error', () => {});
    } catch {
      // fs.watch не поддержан: остаётся опрос
    }
    const timer = setInterval(pump, 1000);
    pump();
    req.on('close', () => {
      closed = true;
      streams--;
      clearInterval(timer);
      if (watcher) try { watcher.close(); } catch {}
    });
  }

  // .md/.txt из домашней папки (для текста ТЗ GLM), кроме защищённых папок.
  // Читаем через дескриптор с потолком CAT_MAX_BYTES+1: без отдельного stat, гонки размера нет.
  function apiFile(res, q) {
    const abs = resolveWithinHome(q.get('path') || '');
    if (!abs) return sendJson(res, 400, { error: 'Путь вне домашней папки.' });
    if (!/\.(md|txt)$/i.test(abs)) return sendJson(res, 400, { error: 'Разрешены только .md и .txt.' });
    if (isSensitiveHomePath(abs)) return sendJson(res, 403, { error: 'Файл в защищённой папке.' });
    fs.open(abs, 'r', (e, fd) => {
      if (e) return sendJson(res, 404, { error: 'Файл не найден.' });
      const buf = Buffer.allocUnsafe(CAT_MAX_BYTES + 1);
      fs.read(fd, buf, 0, CAT_MAX_BYTES + 1, 0, (e2, bytesRead) => {
        fs.close(fd, () => {});
        if (e2) return sendJson(res, 404, { error: 'Файл не прочитан.' });
        if (bytesRead > CAT_MAX_BYTES) return sendJson(res, 413, { error: 'Файл больше 512 КБ.' });
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SEC_HEADERS));
        res.end(doRedact(buf.toString('utf8', 0, bytesRead)));
      });
    });
  }

  function apiHealth(res) {
    const c = guard.check(env);
    sendJson(res, 200, { ok: c.ok, rssMb: c.rssMb, limitMb: c.limitMb, indexed: indexer.cache.size, indexing: indexer.running.size, streams });
  }

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

  function serveStatic(res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendJson(res, 400, { error: 'Неверный путь' });
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const abs = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!abs.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 400, { error: 'Неверный путь' });
    fs.readFile(abs, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'Не найдено' });
      const headers = Object.assign({ 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, SEC_HEADERS);
      if (/\.html$/i.test(abs)) headers['Content-Security-Policy'] = CSP;
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    // защита от DNS rebinding: транскрипты отдаём только по адресу, который слушаем
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return sendJson(res, 403, { error: 'Доступ только с 127.0.0.1' });
    let u;
    try {
      u = new URL(req.url, 'http://' + HOST);
    } catch {
      return sendJson(res, 400, { error: 'Неверный запрос' });
    }
    // API не для чужих сайтов: кросс-сайтовые запросы (Sec-Fetch-Site) и запросы с чужим Origin
    // отклоняем. Свои запросы и запросы без Origin/Sec-Fetch-Site (curl, закладка) работают как раньше.
    if (u.pathname.startsWith('/api/')) {
      const site = String(req.headers['sec-fetch-site'] || '');
      const origin = String(req.headers.origin || '');
      if (site === 'cross-site' || (origin && origin !== 'http://' + String(req.headers.host || ''))) {
        return sendJson(res, 403, { error: 'Межсайтовый запрос к API отклонён.' });
      }
    }
    const q = u.searchParams;
    const guardErr = (e) => sendJson(res, 500, { error: String((e && e.message) || e) });
    try {
      switch (u.pathname) {
        case '/api/projects': return void apiProjects(res).catch(guardErr);
        case '/api/team': return void apiTeam(res).catch(guardErr);
        case '/api/now': return void apiNow(res).catch(guardErr);
        case '/api/project': return void apiProject(res, q).catch(guardErr);
        case '/api/map': return void apiMap(res, q).catch(guardErr);
        case '/api/cross': return void apiCross(res).catch(guardErr);
        case '/api/session': return void apiSession(res, q).catch(guardErr);
        case '/api/report': return void apiReport(res, q).catch(guardErr);
        case '/api/stream': return void apiStream(req, res, q);
        case '/api/file': return void apiFile(res, q);
        case '/api/health': return void apiHealth(res);
        default:
          if (u.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Неизвестный эндпоинт' });
          return serveStatic(res, u.pathname);
      }
    } catch (e) {
      return guardErr(e);
    }
  });
  return { server, registry, indexer, adapters };
}

if (require.main === module) {
  const PORT = parseInt(process.env.PORT || '3939', 10);
  const redactWarn = disabledWarning();
  if (redactWarn) console.warn(redactWarn);
  createApp().then(({ server, adapters }) => {
    server.listen(PORT, HOST, () => {
      console.log(`Agents OS: http://${HOST}:${PORT}  (источники: ${adapters.map((a) => a.label).join(', ') || 'не найдены'}; память: лимит RSS ${guard.limitMb()} МБ)`);
    });
  });
}

module.exports = { createApp, toClientEvent };
