'use strict';

// Роли «мозг / исполнитель»: team.json читается, никогда не пишется Agents OS.
// Демо и упаковка: npm run demo поднимает сервер на синтетике, npm pack не тащит лишнее.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const { buildWorld } = require('./helpers/world');
const { loadTeam, executorsFor, teamPath } = require('../lib/team');
const { createApp } = require('../server');

const ROOT = path.resolve(__dirname, '..');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-os-team-'));
}

/* ---------- lib/team.js ---------- */

test('team: нет файла - мозг claude, источник default', () => {
  const home = tmpHome();
  try {
    const r = loadTeam({ AGENTS_OS_HOME: home });
    assert.strictEqual(r.source, 'default');
    assert.strictEqual(r.team.brain, 'claude');
    assert.deepStrictEqual(r.team.executors, []);
    assert.deepStrictEqual(r.warnings, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('team: битый файл - значения по умолчанию и предупреждение', () => {
  const home = tmpHome();
  try {
    fs.writeFileSync(teamPath({ AGENTS_OS_HOME: home }), '{ brain: ');
    const r = loadTeam({ AGENTS_OS_HOME: home });
    assert.strictEqual(r.source, 'file', 'файл есть, читатель честно отвечает, что источник - файл');
    assert.strictEqual(r.team.brain, 'claude');
    assert.strictEqual(r.warnings.length, 1);
    assert.match(r.warnings[0], /битый JSON/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('team: файл с мозгом codex и исполнителями по проектам читается, кэш по mtime', () => {
  const home = tmpHome();
  try {
    const file = teamPath({ AGENTS_OS_HOME: home });
    fs.writeFileSync(file, JSON.stringify({ version: 1, brain: 'codex', executors: [{ profile: 'claude', projects: ['~/my-project'] }, { profile: 'bad entry' }], updatedAt: '2026-10-23T10:00:00Z', updatedBy: 'codex:9b21' }));
    const env = { AGENTS_OS_HOME: home };
    const r = loadTeam(env);
    assert.strictEqual(r.source, 'file');
    assert.strictEqual(r.team.brain, 'codex');
    assert.strictEqual(r.team.executors.length, 1, 'исполнитель с плохим профилем пропущен');
    assert.deepStrictEqual(r.team.executors[0], { profile: 'claude', projects: ['~/my-project'] });
    assert.strictEqual(r.team.updatedBy, 'codex:9b21');
    assert.strictEqual(r.warnings.length, 1, 'о пропущенном исполнителе предупредили');
    // кэш: то же время файла - тот же результат; файл переписан - перечитан
    assert.strictEqual(loadTeam(env).team.brain, 'codex');
    fs.writeFileSync(file, JSON.stringify({ brain: 'claude' }));
    const now = new Date();
    fs.utimesSync(file, now, new Date(Date.now() + 1000));
    assert.strictEqual(loadTeam(env).team.brain, 'claude');
    // фильтр по проекту: исполнитель разрешён в своём проекте и не виден в чужом
    const expanded = path.join(os.homedir(), 'my-project');
    assert.strictEqual(executorsFor(r.team, expanded, []).length, 1, 'исполнитель разрешён в своём проекте');
    assert.strictEqual(executorsFor(r.team, path.join(os.homedir(), 'other'), []).length, 0, 'в чужом проекте исполнителя нет');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ---------- /api/team и /api/project ---------- */

function request(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: '127.0.0.1:' + port } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('/api/team: без файла - default, исполнители - профили с запусками', async () => {
  const w = buildWorld();
  const home = tmpHome();
  const app = await createApp({ env: Object.assign({}, process.env, w.env, { AGENTS_OS_HOME: home }), now: () => w.now });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  try {
    // запуски появляются в индексах после сборки карты
    await app.registry.projectView('/work/alpha', { wait: true });
    const res = await request(port, '/api/team');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.source, 'default');
    assert.strictEqual(res.json.brain.profile, 'claude');
    assert.strictEqual(res.json.brain.provider, 'claude');
    assert.ok(res.json.executors.some((e) => e.profile === 'glm'), 'glm - среди профилей с запусками');
    assert.ok(res.json.executors.every((e) => e.provider && e.label), 'у исполнителя есть provider и label для меток');
    const view = await request(port, '/api/project?key=' + encodeURIComponent('/work/alpha'));
    assert.strictEqual(view.json.team.source, 'default');
    assert.ok(view.json.team.executors.some((e) => e.profile === 'glm'));
  } finally {
    await new Promise((r) => app.server.close(r));
    w.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('запуск исполнителя вне team.json виден в графе, но не в списке команды', async () => {
  const w = buildWorld();
  const home = tmpHome();
  try {
    // в команде только glm; факт запуска из переписки - отдельный слой и не зависит от списка
    fs.writeFileSync(
      path.join(home, 'team.json'),
      JSON.stringify({ version: 1, brain: 'claude', executors: [{ profile: 'glm', projects: ['*'] }], updatedBy: 'claude:test' })
    );
    const app = await createApp({ env: Object.assign({}, process.env, w.env, { AGENTS_OS_HOME: home }), now: () => w.now });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const port = app.server.address().port;
    try {
      const team = await request(port, '/api/team');
      assert.strictEqual(team.json.source, 'file');
      assert.deepStrictEqual(team.json.executors.map((e) => e.profile), ['glm']);
      await app.registry.projectView('/work/alpha', { wait: true });
      const view = await request(port, '/api/project?key=' + encodeURIComponent('/work/alpha'));
      assert.deepStrictEqual(view.json.team.executors.map((e) => e.profile), ['glm'], 'в команде только glm');
      assert.ok(view.json.nodes.some((n) => n.sessionId === w.G), 'факт запуска GLM в графе');
      const glm = view.json.nodes.find((n) => n.sessionId === w.G);
      assert.strictEqual(glm.executor, true, 'узлы несут executor: интерфейс по нему ставит пометку «не в команде»');
    } finally {
      await new Promise((r) => app.server.close(r));
    }
  } finally {
    w.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('/api/team: мозг codex из файла получает provider gpt и label профиля', async () => {
  const w = buildWorld();
  const home = tmpHome();
  try {
    fs.writeFileSync(path.join(home, 'team.json'), JSON.stringify({ brain: 'codex', executors: [{ profile: 'glm', projects: ['*'] }] }));
    const app = await createApp({ env: Object.assign({}, process.env, w.env, { AGENTS_OS_HOME: home }), now: () => w.now });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const port = app.server.address().port;
    try {
      const res = await request(port, '/api/team');
      assert.strictEqual(res.json.brain.profile, 'codex');
      assert.strictEqual(res.json.brain.provider, 'gpt', 'провайдер Codex на карте - gpt');
      assert.strictEqual(res.json.brain.label, 'GPT (Codex)');
      assert.strictEqual(res.json.source, 'file');
    } finally {
      await new Promise((r) => app.server.close(r));
    }
  } finally {
    w.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ---------- демо ---------- */

test('npm run demo: сервер поднимается, три демо-проекта, команда из team.json', async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'demo.js')], {
    env: Object.assign({}, process.env, { PORT: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  const out = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /127\.0\.0\.1:(\d+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    child.on('exit', (code) => reject(new Error('demo завершился с кодом ' + code)));
    setTimeout(() => reject(new Error('demo не напечатал порт: ' + buf)), 15000);
  });
  try {
    // сервер-ребёнок слушает не мгновенно: ждём /api/health
    let health = null;
    for (let i = 0; i < 50 && !health; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const h = await request(Number(out), '/api/health');
        if (h.status === 200) health = h;
      } catch {}
    }
    assert.ok(health, 'демо-сервер поднялся за 5 с');
    const projects = await request(Number(out), '/api/projects');
    assert.strictEqual(projects.status, 200);
    assert.deepStrictEqual(projects.json.projects.map((p) => p.name).sort(), ['alpha-shop', 'beta-clinic', 'gamma-app']);
    assert.ok(projects.json.projects.find((p) => p.name === 'beta-clinic').providers.glm, 'GLM виден в beta-clinic');
    const team = await request(Number(out), '/api/team');
    assert.strictEqual(team.json.source, 'file');
    assert.strictEqual(team.json.brain.profile, 'claude');
    assert.deepStrictEqual(team.json.executors.map((e) => e.profile).sort(), ['deepseek', 'glm'], 'codex не в команде');
    const beta = await request(Number(out), '/api/project?key=' + encodeURIComponent('/demo/beta-clinic'));
    assert.strictEqual(beta.status, 200);
    assert.ok(beta.json.nodes.some((n) => n.provider === 'gpt'), 'Codex на карте beta-clinic: факт запуска, вне команды');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
});

/* ---------- упаковка ---------- */

test('npm pack --dry-run не включает test/, .review/, samples-local/, .shots', () => {
  // На Windows npm это npm.cmd, а .cmd Node запускает только через shell (иначе EINVAL)
  const win = process.platform === 'win32';
  const out = execFileSync(win ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: win });
  const packs = JSON.parse(out);
  assert.ok(Array.isArray(packs) && packs.length === 1);
  const files = packs[0].files.map((f) => f.path);
  const bad = files.filter((f) => /^(test|\.review|samples-local|\.shots|scripts\/\.tmp)\//.test(f) || f.startsWith('.'));
  assert.deepStrictEqual(bad, [], 'в пакете только нужное');
  for (const need of ['server.js', 'lib/providers.js', 'lib/team.js', 'public/app.js', 'tools/agent-run', 'scripts/demo.js', 'docs/CONNECT.md', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(need), 'в пакете есть ' + need);
  }
});
