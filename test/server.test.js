'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { buildWorld } = require('./helpers/world');
const { createApp } = require('../server');

function request(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: Object.assign({ Host: '127.0.0.1:' + port }, headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withApp(envExtra, fn) {
  const w = buildWorld();
  const app = await createApp({ env: Object.assign({}, process.env, w.env, envExtra), now: () => w.now });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  try {
    await fn({ port, w, app });
  } finally {
    await new Promise((r) => app.server.close(r));
    w.cleanup();
  }
}

test('API: проекты, карта проекта, лента сессии', () =>
  withApp({}, async ({ port, w, app }) => {
    const list = await request(port, '/api/projects');
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.json.projects.map((p) => p.name).sort(), ['alpha', 'beta']);
    assert.deepStrictEqual(list.json.sources.map((s) => s.provider).sort(), ['claude', 'glm']);

    await app.registry.projectView('/work/alpha', { wait: true });
    const view = await request(port, '/api/project?key=' + encodeURIComponent('/work/alpha'));
    assert.strictEqual(view.status, 200);
    assert.strictEqual(view.json.progress.pct, 100);
    const s = view.json.nodes.find((n) => n.sessionId === w.S);

    const feed = await request(port, '/api/session?id=' + encodeURIComponent(s.id));
    assert.strictEqual(feed.status, 200);
    const glmCall = feed.json.events.find((e) => e.kind === 'tool_call' && e.glm);
    assert.ok(glmCall, 'запуск claude-glm помечен в ленте для вкладки «→ GLM»');
    assert.strictEqual(glmCall.glm.resume, w.G2);

    const miss = await request(port, '/api/project?key=%2Fnope');
    assert.strictEqual(miss.status, 404);
  }));

test('безопасность: чужой Host отклонён, id вне источников и не .jsonl отклонены', () =>
  withApp({}, async ({ port }) => {
    const rebinding = await request(port, '/api/projects', { Host: 'evil.example:' + port });
    assert.strictEqual(rebinding.status, 403);
    for (const id of ['claude:../../etc/passwd.jsonl', 'claude:-work-alpha/readme.md', 'nope:x.jsonl', '../x']) {
      const r = await request(port, '/api/session?id=' + encodeURIComponent(id));
      assert.strictEqual(r.status, 400, id);
    }
    const file = await request(port, '/api/file?path=' + encodeURIComponent('/etc/hosts'));
    assert.strictEqual(file.status, 400);
  }));

test('страховка по памяти: при RSS выше лимита тяжёлые запросы получают 503 с причиной, лёгкие работают', () =>
  withApp({ RSS_LIMIT_MB: '1' }, async ({ port }) => {
    const heavy = await request(port, '/api/project?key=%2Fwork%2Falpha');
    assert.strictEqual(heavy.status, 503);
    assert.match(heavy.json.error, /Память сервера выше лимита: RSS \d+ МБ из 1 МБ/);
    const feed = await request(port, '/api/session?id=x');
    assert.strictEqual(feed.status, 503);
    const light = await request(port, '/api/projects');
    assert.strictEqual(light.status, 200);
    const health = await request(port, '/api/health');
    assert.strictEqual(health.json.ok, false);
  }));

/* ---------- /api/report ---------- */

const fs = require('node:fs');
const path = require('node:path');
const { user, assistant, toolResult, toolUse, text, writeJsonl, tmpDir } = require('./helpers/synth');

const REPORT_TEXT = `**Сделано полностью.** Тесты 362 из 362 зелёные.

## СДЕЛАНО
- Правки в lib/acc.js и lib/checks.js
- Новый тест на фикстуре

## НЕ СДЕЛАНО / ЗАМЕЧАНИЯ
- Живой прогон не делал. Для проверки ключ был password=hunter2hunter2 и sk-abcdefghijklmnop

## ДАЛЬШЕ Я
Ничего.`;

// сессия alpha с отчётом: правка, красный и зелёный прогон тестов, структурный итог; старый файл = агент закончил
function addReportSession(w) {
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const f = path.join(w.env.CLAUDE_PROJECTS_DIR, '-work-alpha', id + '.jsonl');
  const at = (s) => w.t0 + s * 1000;
  const cwd = { cwd: '/work/alpha' };
  writeJsonl(f, [
    user(at(100), 'ЦЕЛЬ: починить фильтр\n\nКОНТЕКСТ: lib/filter.js\nСЕКРЕТ: token=abcd1234abcd1234\nГОТОВО, КОГДА: тесты зелёные', cwd),
    assistant(at(101), [toolUse('e1', 'Edit', { file_path: '/work/alpha/lib/acc.js' })], { rec: cwd }),
    assistant(at(102), [toolUse('e2', 'Edit', { file_path: '/work/alpha/lib/acc.js' })], { rec: cwd }),
    assistant(at(103), [toolUse('v1', 'Bash', { command: 'npx vitest run 2>&1 | tail -5' })], { rec: cwd }),
    toolResult(at(104), 'v1', '      Tests  5 failed | 357 passed (362)\n', false),
    assistant(at(105), [toolUse('v2', 'Bash', { command: 'npx vitest run 2>&1 | tail -5' })], { rec: cwd }),
    toolResult(at(106), 'v2', '      Tests  362 passed (362)\n', false),
    assistant(at(107), [text(REPORT_TEXT)], { rec: cwd }),
  ]);
  fs.utimesSync(f, new Date(at(110)), new Date(at(110)));
  return { id: 'claude:-work-alpha/' + id + '.jsonl', sessionId: id };
}

test('API /api/report: задача, что сделал, как выполнял, проверки; секреты замаскированы; повтор из кэша', () =>
  withApp({}, async ({ port, w, app }) => {
    const r = addReportSession(w);
    await app.registry.listProjects();
    const rep = await request(port, '/api/report?id=' + encodeURIComponent(r.id));
    assert.strictEqual(rep.status, 200);
    const j = rep.json;
    assert.strictEqual(j.pending, undefined);
    assert.strictEqual(j.role, 'main');
    assert.strictEqual(j.status, 'done');
    assert.strictEqual(j.project.name, 'alpha');
    assert.ok(j.task.preview.startsWith('ЦЕЛЬ: починить фильтр'));
    assert.strictEqual(j.did.structured, true);
    assert.strictEqual(j.did.status, 'Сделано полностью. Тесты 362 из 362 зелёные.');
    assert.deepStrictEqual(j.did.sections.map((s) => s.key), ['done', 'notdone']);
    assert.deepStrictEqual(j.how.files.map((f) => [f.path, f.edits]), [['lib/acc.js', 2]], 'путь относительно cwd проекта');
    assert.deepStrictEqual(j.checks.map((c) => [c.kind, c.ok, c.summary, c.runs.map((x) => x.summary)]), [['tests', true, '362 passed', ['5 failed, 357 passed', '362 passed']]]);
    assert.strictEqual(j.launcher, null);
    const raw = rep.text;
    for (const secret of ['hunter2hunter2', 'sk-abcdefghijklmnop', 'abcd1234abcd1234']) assert.ok(!raw.includes(secret), 'секрет ' + secret + ' замаскирован');
    assert.ok(raw.includes('<REDACTED>'));
    const again = await request(port, '/api/report?id=' + encodeURIComponent(r.id));
    assert.deepStrictEqual(again.json, j, 'повтор отдаёт тот же отчёт');
  }));

test('API /api/report: для GLM-сессии есть блок «кто поставил задачу»', () =>
  withApp({}, async ({ port, w, app }) => {
    await app.registry.projectView('/work/alpha', { wait: true });
    const view = await request(port, '/api/project?key=' + encodeURIComponent('/work/alpha'));
    const g2 = view.json.nodes.find((n) => n.sessionId === w.G2);
    const rep = await request(port, '/api/report?id=' + encodeURIComponent(g2.id));
    assert.strictEqual(rep.status, 200);
    assert.strictEqual(rep.json.role, 'glm');
    assert.strictEqual(rep.json.launcher.sessionTitle, 'Карта проекта alpha');
    assert.strictEqual(rep.json.launcher.project.name, 'alpha');
  }));

test('API /api/report: индекс ещё строится - pending с процентом; путь вне источников - 400; неизвестный агент - 404', () =>
  withApp({ REPORT_WAIT_MS: '30' }, async ({ port, w, app }) => {
    const r = addReportSession(w);
    await app.registry.listProjects();
    const realGet = app.indexer.get.bind(app.indexer);
    app.indexer.get = (adapter, file, prio) => new Promise((resolve) => setTimeout(() => resolve(realGet(adapter, file, prio)), 400).unref());
    const slow = await request(port, '/api/report?id=' + encodeURIComponent(r.id));
    assert.strictEqual(slow.status, 200);
    assert.strictEqual(slow.json.pending, true);
    assert.ok(Number.isFinite(slow.json.pct));
    for (const id of ['claude:../../etc/passwd.jsonl', 'nope:x.jsonl', '../x', 'claude:-work-alpha/readme.md']) {
      assert.strictEqual((await request(port, '/api/report?id=' + encodeURIComponent(id))).status, 400, id);
    }
    assert.strictEqual((await request(port, '/api/report?id=' + encodeURIComponent('claude:-work-alpha/ffffffff-ffff-4fff-8fff-ffffffffffff.jsonl'))).status, 404);
  }));

test('API /api/report: при RSS выше лимита - 503 с причиной', () =>
  withApp({ RSS_LIMIT_MB: '1' }, async ({ port }) => {
    const r = await request(port, '/api/report?id=x');
    assert.strictEqual(r.status, 503);
    assert.match(r.json.error, /Запрос «отчёт» отклонён/);
  }));

test('API /api/report: Codex отвечает unsupported, интерфейс не падает', async () => {
  const root = tmpDir('agent-console-codex-report-');
  try {
    const dir = path.join(root, 'sessions', '2026', '10', '22');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-10-22T10-00-00-s1.jsonl'), '{"timestamp":"2026-10-22T10:00:00Z","type":"session_meta","payload":{"id":"s1","cwd":"/work/codex-demo"}}\n');
    await withApp({ CODEX_SESSIONS_DIR: path.join(root, 'sessions') }, async ({ port }) => {
      const r = await request(port, '/api/report?id=' + encodeURIComponent('codex:2026/10/22/rollout-2026-10-22T10-00-00-s1.jsonl'));
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json, { unsupported: true });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API /api/now: рядом с работающими отдаёт недавно закончивших', () =>
  withApp({}, async ({ port }) => {
    const r = await request(port, '/api/now');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.nodes) && Array.isArray(r.json.recent));
  }));

test('server.js не читает .jsonl целиком (readFile только для .md и .txt из домашней папки)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const reads = src.match(/readFile(?:Sync)?\([^)]*\)/g) || [];
  assert.ok(reads.every((x) => /abs/.test(x)), 'readFile только по abs из apiFile и annotateCat: ' + reads.join(' | '));
  assert.ok(!/\.jsonl[^\n]*readFile|readFile[^\n]*\.jsonl/.test(src));
});

test('API /api/report: у сессии GLM из трёх запросов задача и тезисы по последнему, прошлые задачи списком заголовков', () =>
  withApp({}, async ({ port, w, app }) => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const cwd = { cwd: '/work/multi' };
    const at = (s) => w.t0 + s * 1000;
    const f = path.join(w.env.GLM_PROJECTS_DIR, '-work-multi', id + '.jsonl');
    writeJsonl(f, [
      user(at(0), 'ЦЕЛЬ: заменить старую таблицу\n\nКОНТЕКСТ: файл a.js', cwd),
      assistant(at(1), [text('Таблица заменена, тесты зелёные и проверены на стенде.')], { rec: cwd }),
      user(at(100), 'Приёмка: НЕ ПРИНЯТО, регрессия в мобильном виде.', cwd),
      assistant(at(101), [text('Поправил мобильный вид, тесты зелёные и проверены.')], { rec: cwd }),
      user(at(200), 'ЦЕЛЬ: доработать плитки недели\n\nКОНТЕКСТ: файл c.js\nМОЖНО МЕНЯТЬ: только c.js', cwd),
      assistant(at(201), [text('СТАТУС: готово\nИЗМЕНЕНЫ ФАЙЛЫ:\n  c.js — плитки недели')], { rec: cwd }),
    ]);
    fs.utimesSync(f, new Date(at(210)), new Date(at(210)));
    await app.registry.listProjects();
    const rep = await request(port, '/api/report?id=' + encodeURIComponent('glm:-work-multi/' + id + '.jsonl'));
    assert.strictEqual(rep.status, 200);
    const j = rep.json;
    assert.ok(j.task.preview.startsWith('ЦЕЛЬ: доработать плитки недели'), 'задача это последний запрос');
    assert.ok(!j.task.preview.includes('заменить старую таблицу'));
    assert.strictEqual(j.task.count, 3);
    assert.deepStrictEqual(j.task.previous, ['ЦЕЛЬ: заменить старую таблицу', 'Приёмка: НЕ ПРИНЯТО, регрессия в мобильном виде.']);
    assert.strictEqual(j.task.earlier, 0);
    assert.strictEqual(j.did.status, 'готово', 'тезисы из последнего сообщения, то есть по последней задаче');
    assert.strictEqual(j.title, 'ЦЕЛЬ: доработать плитки недели');
    // одиночная задача: блока прошлых задач нет
    await app.registry.projectView('/work/alpha', { wait: true });
    const view = await request(port, '/api/project?key=' + encodeURIComponent('/work/alpha'));
    const g2 = view.json.nodes.find((n) => n.sessionId === w.G2);
    const one = await request(port, '/api/report?id=' + encodeURIComponent(g2.id));
    assert.strictEqual(one.json.task.count, undefined);
  }));

test('API /api/report: задача сессии GLM это последняя «ЦЕЛЬ:» (приёмка её не перекрывает), «кто поставил» это запустивший именно её', () =>
  withApp({}, async ({ port, w, app }) => {
    const ALPHA = { cwd: '/work/alpha' };
    const at = (s) => w.t0 + s * 1000;
    const S2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const G3 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const dir = path.join(w.env.CLAUDE_PROJECTS_DIR, '-work-alpha');
    // два помощника запускали GLM-сессию G3 в разное время: X для первой цели (по месту и времени), Y через --resume для второй
    const helper = (id, description, cmd, sec) => {
      const f = path.join(dir, S2, 'subagents', 'agent-' + id + '.jsonl');
      writeJsonl(f, [
        user(at(sec - 5), 'Запусти GLM', Object.assign({ isSidechain: true }, ALPHA)),
        assistant(at(sec), [toolUse('l_' + id, 'Bash', { command: cmd })], { rec: ALPHA }),
        toolResult(at(sec + 1), 'l_' + id, 'Command running in background', false),
      ]);
      fs.writeFileSync(f.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'sonnet-executor', description, finished: true }));
      fs.utimesSync(f, new Date(at(sec + 2)), new Date(at(sec + 2)));
    };
    writeJsonl(path.join(dir, S2 + '.jsonl'), [user(at(0), 'Главная сессия', ALPHA), { type: 'ai-title', aiTitle: 'Главная сессия', sessionId: S2 }]);
    fs.utimesSync(path.join(dir, S2 + '.jsonl'), new Date(at(300)), new Date(at(300)));
    helper('x0000000000000001', 'Помощник X', 'cd /work/alpha && claude-glm -p "$(cat /home/demo/tz1.md)" --output-format json', 10);
    helper('y0000000000000002', 'Помощник Y', `claude-glm -p --resume ${G3} "$(cat /home/demo/tz2.md)" --output-format json`, 100);
    const g = path.join(w.env.GLM_PROJECTS_DIR, '-work-alpha', G3 + '.jsonl');
    writeJsonl(g, [
      user(at(11), 'ЦЕЛЬ: первая задача', ALPHA),
      assistant(at(20), [text('Первая задача сделана, тесты зелёные и проверены.')], { rec: ALPHA }),
      user(at(101), 'ЦЕЛЬ: вторая задача\n\nКОНТЕКСТ: файл b.js', ALPHA),
      assistant(at(110), [text('СТАТУС: готово\nИЗМЕНЕНЫ ФАЙЛЫ:\n  b.js — вторая задача')], { rec: ALPHA }),
      user(at(200), 'Приёмка второй задачи: ПРИНЯТО', ALPHA),
      assistant(at(205), [text('Принято, замечаний нет, остальное без изменений здесь.')], { rec: ALPHA }),
    ]);
    fs.utimesSync(g, new Date(at(210)), new Date(at(210)));
    await app.registry.projectView('/work/alpha', { wait: true });
    const rep = await request(port, '/api/report?id=' + encodeURIComponent('glm:-work-alpha/' + G3 + '.jsonl'));
    assert.strictEqual(rep.status, 200);
    const j = rep.json;
    assert.ok(j.task.preview.startsWith('ЦЕЛЬ: вторая задача'), 'задача это последняя цель, а не приёмка и не первая цель');
    assert.strictEqual(j.title, 'ЦЕЛЬ: вторая задача');
    assert.strictEqual(j.task.count, 3);
    assert.deepStrictEqual(j.task.previous, ['ЦЕЛЬ: первая задача', 'Приёмка второй задачи: ПРИНЯТО'], 'приёмка остаётся в прошлых задачах, показанная цель из списка убрана');
    assert.strictEqual(j.task.earlier, 0);
    assert.strictEqual(j.launcher.task, 'Помощник Y', 'вторую цель запустил Y, а не первый запустивший X');
    const file = await app.registry.fileById('glm:-work-alpha/' + G3 + '.jsonl');
    assert.strictEqual((await app.registry.launcherOf(file)).task, 'Помощник X', 'без времени задачи берётся первый запуск: связь X есть, выбор идёт по времени');
  }));
