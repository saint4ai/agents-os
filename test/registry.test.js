'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildWorld } = require('./helpers/world');
const { user, assistant, toolResult, toolUse, text, writeJsonl } = require('./helpers/synth');
const { loadAdapters } = require('../lib/sources');
const { Indexer } = require('../lib/indexer');
const { Registry } = require('../lib/registry');
const { groupOf, nodeStatus, primaryModel } = require('../lib/models');

async function setup() {
  const w = buildWorld();
  const adapters = await loadAdapters(w.env);
  const make = () => new Registry(adapters, new Indexer(), { now: () => w.now });
  return { w, adapters, make };
}

const byTitle = (v, t) => v.nodes.find((n) => n.title === t);

test('проекты берутся по cwd из записей, а не по расшифровке имени папки', async () => {
  const { w, make } = await setup();
  try {
    const list = await make().listProjects();
    assert.deepStrictEqual(list.map((p) => p.name).sort(), ['alpha', 'beta']);
    const alpha = list.find((p) => p.name === 'alpha');
    assert.strictEqual(alpha.path, '/work/alpha');
    assert.deepStrictEqual(alpha.providers, { claude: 1, glm: 1 }, 'сессии Claude и GLM одного cwd сведены в один проект');
  } finally {
    w.cleanup();
  }
});

test('карта проекта: субагент по toolUseId, SendMessage, токены без дублей, провайдер по источнику', async () => {
  const { w, make } = await setup();
  try {
    const v = await make().projectView('/work/alpha', { wait: true });
    const s = byTitle(v, 'Карта проекта alpha');
    const a = byTitle(v, 'Проверить сборку');
    assert.ok(s && a);
    assert.strictEqual(s.group.label, 'Claude Opus');
    assert.strictEqual(a.group.label, 'Claude Sonnet');
    assert.strictEqual(a.parent, s.id, 'субагент привязан к сессии, запустившей Agent с этим toolUseId');
    assert.deepStrictEqual(a.tokens, { in: 5, out: 150, cache: 0 });
    assert.strictEqual(a.status, 'error', 'последняя запись: tool_result с ошибкой');
    assert.strictEqual(a.sendsIn, 1);
    assert.ok(v.edges.some((e) => e.kind === 'send' && e.from === s.id && e.to === a.id));
    // GLM: в записях claude-opus-5-5, но группа GLM
    const g2 = v.nodes.find((n) => n.sessionId === w.G2);
    assert.strictEqual(g2.provider, 'glm');
    assert.strictEqual(g2.model, 'claude-opus-5-5');
    assert.strictEqual(g2.group.id, 'glm');
    assert.strictEqual(g2.group.label, 'GLM');
    assert.deepStrictEqual(v.progress, { done: v.progress.total, total: v.progress.total, bytesDone: v.progress.bytesTotal, bytesTotal: v.progress.bytesTotal, pct: 100 });
  } finally {
    w.cleanup();
  }
});

test('--resume даёт прямую ссылку на GLM-сессию, даже если она началась давно', async () => {
  const { w, make } = await setup();
  try {
    const v = await make().projectView('/work/alpha', { wait: true });
    const s = byTitle(v, 'Карта проекта alpha');
    const g2 = v.nodes.find((n) => n.sessionId === w.G2);
    assert.strictEqual(g2.parent, s.id);
    const e = v.edges.find((x) => x.kind === 'glm' && x.to === g2.id);
    assert.strictEqual(e.how, 'resume');
  } finally {
    w.cleanup();
  }
});

test('межпроектная связь: GLM в другом проекте найден по cd и времени, видна с обеих сторон', async () => {
  const { w, make } = await setup();
  try {
    // со стороны запустившего (alpha)
    const va = await make().projectView('/work/alpha', { wait: true });
    const g = va.nodes.find((n) => n.sessionId === w.G);
    assert.ok(g, 'GLM-сессия из beta попала в граф alpha как внешний узел');
    assert.strictEqual(g.external, true);
    assert.strictEqual(g.project.name, 'beta');
    const a = byTitle(va, 'Проверить сборку');
    assert.strictEqual(g.parent, a.id, 'запустил субагент (cd /work/beta && claude-glm …)');
    assert.deepStrictEqual(
      { project: g.launchedFrom.project.name, title: g.launchedFrom.sessionTitle, task: g.launchedFrom.task },
      { project: 'alpha', title: 'Карта проекта alpha', task: 'Проверить сборку' }
    );

    // со стороны исполнителя (beta), «холодный» старт: кэша индексов нет, запустивший ищется по времени жизни файлов
    const vb = await make().projectView('/work/beta', { wait: true });
    const gb = vb.nodes.find((n) => n.sessionId === w.G);
    assert.strictEqual(gb.external, false);
    assert.strictEqual(gb.launchedFrom.project.name, 'alpha');
    assert.strictEqual(gb.launchedFrom.sessionTitle, 'Карта проекта alpha');
    assert.strictEqual(gb.tz, 'tz-beta.md');
  } finally {
    w.cleanup();
  }
});

test('межпроектные связи для общей карты', async () => {
  const { w, make } = await setup();
  try {
    const reg = make();
    await reg.projectView('/work/alpha', { wait: true });
    const links = await reg.crossLinks();
    assert.deepStrictEqual(links.map((l) => [l.fromName, l.toName, l.count]), [['alpha', 'beta', 1]]);
  } finally {
    w.cleanup();
  }
});

test('карта сессии: сама сессия, её субагенты и GLM из других проектов; чужое не попадает', async () => {
  const { w, make } = await setup();
  try {
    const reg = make();
    const sc = await reg.scan();
    const S = sc.projects.get('/work/alpha').files.find((f) => f.sessionId === w.S);
    const v = await reg.sessionView(S.id, { wait: true });
    assert.strictEqual(v.root, S.id);
    assert.deepStrictEqual(v.nodes.map((n) => n.sessionId).sort(), [w.A, w.G, w.G2, w.S].sort());
    assert.ok(v.edges.some((e) => e.kind === 'glm' && e.to.includes(w.G)));
  } finally {
    w.cleanup();
  }
});

test('без toolUseId в meta субагент сопоставляется по description', async () => {
  const { w, make } = await setup();
  try {
    const metaFile = path.join(w.env.CLAUDE_PROJECTS_DIR, '-work-alpha', w.S, 'subagents', 'agent-' + w.A + '.meta.json');
    fs.writeFileSync(metaFile, JSON.stringify({ agentType: 'sonnet-executor', description: 'Проверить сборку', finished: true }));
    const v = await make().projectView('/work/alpha', { wait: true });
    const a = byTitle(v, 'Проверить сборку');
    const s = byTitle(v, 'Карта проекта alpha');
    assert.strictEqual(a.parent, s.id);
  } finally {
    w.cleanup();
  }
});

test('модель сессии = самая частая; остальные перечислены', async () => {
  assert.strictEqual(primaryModel({ 'claude-opus-5-5': 3, 'claude-haiku-4-5': 1 }), 'claude-opus-5-5');
  const { w, make } = await setup();
  try {
    const f = path.join(w.env.CLAUDE_PROJECTS_DIR, '-work-gamma', '44444444-4444-4444-8444-444444444444.jsonl');
    const t = w.t0;
    writeJsonl(f, [
      user(t, 'Смешанная сессия', { cwd: '/work/gamma' }),
      assistant(t + 1000, [], { model: 'claude-haiku-4-5', msgId: 'h1', rec: { cwd: '/work/gamma' } }),
      assistant(t + 2000, [], { model: 'claude-sonnet-5-5', msgId: 's1', rec: { cwd: '/work/gamma' } }),
      assistant(t + 3000, [], { model: 'claude-sonnet-5-5', msgId: 's2', rec: { cwd: '/work/gamma' } }),
    ]);
    const v = await make().projectView('/work/gamma', { wait: true });
    const n = v.nodes[0];
    assert.strictEqual(n.model, 'claude-sonnet-5-5');
    assert.deepStrictEqual(n.models, { 'claude-haiku-4-5': 1, 'claude-sonnet-5-5': 2 });
    assert.strictEqual(n.group.label, 'Claude Sonnet');
  } finally {
    w.cleanup();
  }
});

test('группы по виду ИИ и модели', () => {
  assert.strictEqual(groupOf('claude', 'claude-opus-5-5[1m]').label, 'Claude Opus');
  assert.strictEqual(groupOf('claude', 'claude-sonnet-4-5-20250929').label, 'Claude Sonnet');
  assert.strictEqual(groupOf('claude', 'claude-haiku-4-5').label, 'Claude Haiku');
  assert.strictEqual(groupOf('glm', 'claude-opus-5-5').label, 'GLM');
  assert.strictEqual(groupOf('gpt', 'gpt-5-codex').label, 'GPT');
  assert.strictEqual(groupOf('claude', null).id, 'claude-unknown');
});

test('статус узла: работает / готов / ошибка', () => {
  const now = 1_000_000_000_000;
  assert.strictEqual(nodeStatus({ mtimeMs: now - 30_000 }, now), 'working', 'файл менялся за последние 60 с');
  assert.strictEqual(nodeStatus({ mtimeMs: now - 5 * 60_000, meta: { finished: false } }, now), 'working', 'finished=false и файл менялся за 10 мин');
  assert.strictEqual(nodeStatus({ mtimeMs: now - 15 * 60_000, meta: { finished: false } }, now), 'done', 'finished=false, но тишина больше 10 мин');
  assert.strictEqual(nodeStatus({ mtimeMs: now - 5 * 60_000, meta: { finished: true } }, now), 'done');
  assert.strictEqual(nodeStatus({ mtimeMs: now - 5 * 60_000, lastErr: true }, now), 'error');
  assert.strictEqual(nodeStatus({ mtimeMs: now - 5_000, lastErr: true }, now), 'working', 'пока файл пишется, это работа, а не ошибка');
});

test('cwd не найден в голове (первое сообщение на сотни КБ): проект определяется по хвосту', async () => {
  const { w, make } = await setup();
  try {
    const f = path.join(w.env.CLAUDE_PROJECTS_DIR, '-work-delta', '55555555-5555-4555-8555-555555555555.jsonl');
    const t = w.t0;
    const big = user(t, 'я'.repeat(200 * 1024)); // без cwd, строка больше 256 КБ в байтах
    writeJsonl(f, [big, assistant(t + 1000, [], { model: 'claude-opus-5-5', rec: { cwd: '/work/delta' } })]);
    const list = await make().listProjects();
    const p = list.find((x) => x.path === '/work/delta');
    assert.ok(p, 'проект найден по cwd из хвоста');
    assert.strictEqual(p.name, 'delta');
  } finally {
    w.cleanup();
  }
});

/* ---------- «в работе» по висящему вызову и последний шаг (R-05) ---------- */

test('статус узла: висящий вызов без результата продлевает «в работе» до 15 минут', () => {
  const now = 1_000_000_000_000;
  assert.strictEqual(nodeStatus({ mtimeMs: now - 90_000, pending: true }, now), 'working', 'тишина 90 с, но вызов без результата');
  assert.strictEqual(nodeStatus({ mtimeMs: now - 90_000, pending: false }, now), 'done', 'результат есть: готово');
  assert.strictEqual(nodeStatus({ mtimeMs: now - 16 * 60_000, pending: true }, now), 'done', 'тишина 16 минут: не ждём дальше');
  assert.strictEqual(nodeStatus({ mtimeMs: now - 14 * 60_000, pending: true }, now), 'working');
});

// сессия с заданным хвостом, файл «молчит» silentMs до момента w.now
function tailSession(w, name, recsFn, silentMs) {
  const dir = path.join(w.env.CLAUDE_PROJECTS_DIR, '-work-live');
  const f = path.join(dir, name + '.jsonl');
  const at = (sec) => w.now - silentMs + sec * 1000;
  writeJsonl(f, recsFn(at));
  fs.utimesSync(f, new Date(w.now - silentMs), new Date(w.now - silentMs));
  return f;
}
const withCwd = { cwd: '/work/live' };

test('висящий вызов: агент в работе, последний шаг короткий и без команды целиком', async () => {
  const { w, make } = await setup();
  try {
    const long = 'npx vitest run ' + 'test/very-long-file-name-for-checking.test.js '.repeat(10);
    tailSession(w, '66666666-6666-4666-8666-666666666666', (at) => [
      user(at(-5), 'Прогони тесты', withCwd),
      assistant(at(0), [toolUse('t1', 'Bash', { command: long })], { rec: withCwd }),
    ], 90_000);
    const reg = make();
    const now = await reg.listNow();
    const n = now.find((x) => x.project.name === 'live');
    assert.ok(n, 'сессия без записи 90 с, но с висящим вызовом, попала в «сейчас»');
    assert.strictEqual(n.status, 'working');
    assert.strictEqual(n.lastStep, 'запускает тесты');
    assert.ok(n.lastStep.length <= 40);
    assert.ok(!n.lastStep.includes('vitest'), 'команда целиком не показывается');
  } finally {
    w.cleanup();
  }
});

test('вызов с результатом, тишина 90 с: готово, в «сейчас» нет, в «недавно» есть', async () => {
  const { w, make } = await setup();
  try {
    tailSession(w, '77777777-7777-4777-8777-777777777777', (at) => [
      user(at(-5), 'Прогони тесты', withCwd),
      assistant(at(0), [toolUse('t1', 'Bash', { command: 'npm test' })], { rec: withCwd }),
      toolResult(at(5), 't1', '      Tests  3 passed (3)\n', false),
      assistant(at(6), [text('Тесты зелёные, всё готово и проверено на этой машине.')], { rec: withCwd }),
    ], 90_000);
    const reg = make();
    assert.strictEqual((await reg.listNow()).find((x) => x.project.name === 'live'), undefined);
    const recent = (await reg.listRecent()).find((x) => x.project.name === 'live');
    assert.ok(recent && recent.status === 'done');
    assert.strictEqual(recent.lastStep, null, 'у законченного агента шага нет');
  } finally {
    w.cleanup();
  }
});

test('висящий вызов старше 15 минут: готово', async () => {
  const { w, make } = await setup();
  try {
    tailSession(w, '88888888-8888-4888-8888-888888888888', (at) => [
      user(at(-5), 'Жду ответ', withCwd),
      assistant(at(0), [toolUse('t1', 'Bash', { command: 'sleep 5000' })], { rec: withCwd }),
    ], 16 * 60_000);
    const reg = make();
    assert.strictEqual((await reg.listNow()).find((x) => x.project.name === 'live'), undefined);
  } finally {
    w.cleanup();
  }
});

test('долгий вызов без результата: «ждёт команду: N мин»; параллельный вызов с результатом не мешает', async () => {
  const { w, make } = await setup();
  try {
    tailSession(w, '99999999-9999-4999-8999-999999999999', (at) => [
      user(at(-200), 'Собери', withCwd),
      assistant(at(-190), [toolUse('a', 'Read', { file_path: '/work/live/a.js' })], { rec: withCwd }),
      assistant(at(-180), [toolUse('b', 'Bash', { command: 'make build' })], { rec: withCwd }),
      toolResult(at(-170), 'a', 'содержимое', false),
    ], 150_000);
    const n = (await make().listNow()).find((x) => x.project.name === 'live');
    assert.ok(n, 'вызов b ещё без результата');
    assert.strictEqual(n.lastStep, 'ждёт команду: 5 мин', 'вызов b начался за 330 с до «сейчас»');
  } finally {
    w.cleanup();
  }
});

test('агента остановили (Request interrupted): вызов без результата не держит «в работе»', async () => {
  const { w, make } = await setup();
  try {
    tailSession(w, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (at) => [
      user(at(-20), 'Запусти долгую команду', withCwd),
      assistant(at(-10), [toolUse('t1', 'Bash', { command: 'sleep 999' })], { rec: withCwd }),
      user(at(-5), '[Request interrupted by user for tool use]', withCwd),
    ], 90_000);
    assert.strictEqual((await make().listNow()).find((x) => x.project.name === 'live'), undefined);
  } finally {
    w.cleanup();
  }
});

test('метки шагов: файл, поиск, помощник, браузер, мысль', () => {
  const { stepLabel } = require('../lib/step');
  const call = (tool, input) => ({ kind: 'tool_call', tool, input });
  assert.strictEqual(stepLabel(call('Edit', { file_path: '/work/x/src/Index.html' })), 'правит Index.html');
  assert.strictEqual(stepLabel(call('Write', { file_path: '/a/b.md' })), 'пишет b.md');
  assert.strictEqual(stepLabel(call('Grep', { pattern: 'x' })), 'ищет в коде');
  assert.strictEqual(stepLabel(call('Bash', { command: 'git status' })), 'работает с git');
  assert.strictEqual(stepLabel(call('Bash', { command: 'cd /x && claude-glm -p "задача"' })), 'отдаёт задачу GLM');
  assert.strictEqual(stepLabel(call('Bash', { command: 'make build-dashboard' })), 'собирает');
  assert.strictEqual(stepLabel(call('Bash', { command: 'ls' })), 'выполняет команду');
  assert.strictEqual(stepLabel(call('mcp__playwright__browser_click', {})), 'проверяет в браузере');
  assert.ok(stepLabel(call('Agent', { description: 'Очень длинное описание помощника, которое не должно влезть целиком в метку' })).length <= 40);
  assert.strictEqual(stepLabel({ kind: 'thinking' }), 'думает');
  assert.strictEqual(stepLabel({ kind: 'assistant', text: 'x' }), 'пишет ответ');
});

/* ---------- сессия GLM, которую продолжают через --resume: заголовок по последней задаче ---------- */

function resumedGlmSession(w) {
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const f = path.join(w.env.GLM_PROJECTS_DIR, '-work-multi', id + '.jsonl');
  const cwd = { cwd: '/work/multi' };
  const at = (s) => w.t0 + s * 1000;
  writeJsonl(f, [
    user(at(0), 'ЦЕЛЬ: заменить старую таблицу\n\nКОНТЕКСТ: файл a.js', cwd),
    assistant(at(1), [text('Таблица заменена, тесты зелёные.')], { model: 'claude-opus-5-5', rec: cwd }),
    user(at(100), 'Приёмка: НЕ ПРИНЯТО, регрессия в мобильном виде.', cwd),
    assistant(at(101), [text('Поправил мобильный вид, тесты зелёные.')], { model: 'claude-opus-5-5', rec: cwd }),
    user(at(200), 'ЦЕЛЬ: доработать плитки недели\n\nКОНТЕКСТ: файл c.js', cwd),
    assistant(at(201), [toolUse('e1', 'Edit', { file_path: '/work/multi/c.js' })], { model: 'claude-opus-5-5', rec: cwd }),
    toolResult(at(202), 'e1', 'ok', false),
    assistant(at(203), [text('Плитки недели доработаны, сборка и тесты зелёные.')], { model: 'claude-opus-5-5', rec: cwd }),
  ]);
  fs.utimesSync(f, new Date(at(210)), new Date(at(210)));
  return { id, cwd: '/work/multi' };
}

test('сессия GLM из трёх запросов: заголовок это третий запрос, отметка «3 из 3»; главная сессия Claude не затронута', async () => {
  const { w, make } = await setup();
  try {
    const r = resumedGlmSession(w);
    const v = await make().projectView(r.cwd, { wait: true });
    const n = v.nodes.find((x) => x.sessionId === r.id);
    assert.strictEqual(n.provider, 'glm');
    assert.strictEqual(n.title, 'ЦЕЛЬ: доработать плитки недели', 'не первый запрос «заменить старую таблицу»');
    assert.strictEqual(n.taskCount, 3);
    const { T } = await import('../public/util.js');
    assert.strictEqual(T.taskOf(n.taskCount), 'задача 3 из 3');
    // главная сессия Claude: заголовок по-прежнему ai-title, отметки нет
    const va = await make().projectView('/work/alpha', { wait: true });
    const s = va.nodes.find((x) => x.sessionId === w.S);
    assert.strictEqual(s.title, 'Карта проекта alpha');
    assert.strictEqual(s.taskCount, null);
    // GLM с одним запросом: отметки нет
    const g2 = va.nodes.find((x) => x.sessionId === w.G2);
    assert.strictEqual(g2.taskCount, null);
  } finally {
    w.cleanup();
  }
});

test('сессия GLM «ЦЕЛЬ: A», затем «Приёмка: ПРИНЯТ»: заголовок остаётся целью, отметка «2 из 2»; без «ЦЕЛЬ:» заголовок по последнему запросу', async () => {
  const { w, make } = await setup();
  try {
    const cwd = { cwd: '/work/acc' };
    const at = (s) => w.t0 + s * 1000;
    const fA = path.join(w.env.GLM_PROJECTS_DIR, '-work-acc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl');
    writeJsonl(fA, [
      user(at(0), 'ЦЕЛЬ: A\n\nКОНТЕКСТ: файл a.js', cwd),
      assistant(at(1), [text('Готово: A сделана, тесты зелёные и проверены.')], { rec: cwd }),
      user(at(100), 'Приёмка: ПРИНЯТ', cwd),
    ]);
    const fB = path.join(w.env.GLM_PROJECTS_DIR, '-work-acc', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl');
    writeJsonl(fB, [user(at(0), 'Первый вопрос', cwd), assistant(at(1), [text('Ответ на первый вопрос, подробный и полный.')], { rec: cwd }), user(at(100), 'Второй вопрос', cwd)]);
    const v = await make().projectView('/work/acc', { wait: true });
    const a = v.nodes.find((n) => n.sessionId === 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    assert.strictEqual(a.title, 'ЦЕЛЬ: A');
    assert.strictEqual(a.taskCount, 2);
    const { T } = await import('../public/util.js');
    assert.strictEqual(T.taskOf(a.taskCount), 'задача 2 из 2');
    const b = v.nodes.find((n) => n.sessionId === 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    assert.strictEqual(b.title, 'Второй вопрос', 'нет ни одной «ЦЕЛЬ:»: берётся последний запрос');
  } finally {
    w.cleanup();
  }
});
