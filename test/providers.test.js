'use strict';

// Профили провайдеров: конфиг вместо кода. Всё на синтетике: AGENTS_OS_HOME во временную папку,
// пути проектов выдуманные, Связку ключей не трогаем.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { user, assistant, toolResult, toolUse, text, writeJsonl, tmpDir } = require('./helpers/synth');
const { loadProfiles, builtinProfiles, envDirName } = require('../lib/providers');
const { loadAdapters } = require('../lib/sources');
const { parseAgentLaunches } = require('../lib/shell');
const { Indexer } = require('../lib/indexer');
const { Registry } = require('../lib/registry');

const ROOT = path.resolve(__dirname, '..');
const UUID = '48f9b304-e91b-4f00-8da1-1c202f10a295';

function tmpHome() {
  const dir = tmpDir('agents-os-home-');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const envWith = (home, extra) => Object.assign({ AGENTS_OS_HOME: home, HOME: os.homedir() }, extra);

/* ---------- конфиг профилей ---------- */

test('без файла работают встроенные профили: claude, glm, codex', () => {
  const { profiles, warnings } = loadProfiles(envWith(tmpHome()));
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(profiles.map((p) => p.id), ['claude', 'glm', 'codex']);
  const glm = profiles.find((p) => p.id === 'glm');
  assert.strictEqual(glm.keychainService, 'claude-glm-zai', 'ключ GLM берётся тот же, что у tools/claude-glm');
  assert.strictEqual(glm.mcpKeyEnv, 'ZAI_MCP_KEY');
  assert.strictEqual(glm.baseUrl, 'https://api.z.ai/api/anthropic');
  const codex = profiles.find((p) => p.id === 'codex');
  assert.strictEqual(codex.kind, 'codex');
  assert.strictEqual(codex.dirIsProject, false);
  assert.deepStrictEqual(codex.mcpTools, ['mcp__codex__*']);
  assert.strictEqual(profiles.find((p) => p.id === 'claude').executor, false, 'claude - мозг, не исполнитель');
});

test('файл добавляет deepseek и переопределяет label у glm, встроенные не удаляет', () => {
  const home = tmpHome();
  fs.writeFileSync(
    path.join(home, 'providers.json'),
    JSON.stringify({
      profiles: [
        {
          id: 'deepseek',
          kind: 'claude-like',
          label: 'DeepSeek',
          historyDir: '~/.ds-worker/projects',
          baseUrl: 'https://api.deepseek.com/anthropic',
        },
        { id: 'glm', label: 'GLM (Z.ai)' },
      ],
    })
  );
  const env = envWith(home, { DEEPSEEK_PROJECTS_DIR: path.join(home, 'ds-projects'), GLM_PROJECTS_DIR: '/work/glm-hist' });
  const { profiles, warnings } = loadProfiles(env);
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(profiles.map((p) => p.id), ['claude', 'glm', 'codex', 'deepseek']);
  const deepseek = profiles.find((p) => p.id === 'deepseek');
  assert.strictEqual(deepseek.label, 'DeepSeek');
  assert.strictEqual(deepseek.historyDir, path.join(home, 'ds-projects'), 'переменная окружения сильнее historyDir');
  assert.strictEqual(deepseek.keychainService, 'agents-os-deepseek', 'сервис ключа по умолчанию');
  assert.strictEqual(deepseek.executor, true);
  const glm = profiles.find((p) => p.id === 'glm');
  assert.strictEqual(glm.label, 'GLM (Z.ai)', 'файл переопределяет поле встроенного');
  assert.strictEqual(glm.historyDir, '/work/glm-hist');
  assert.strictEqual(glm.baseUrl, 'https://api.z.ai/api/anthropic', 'остальные поля встроенного остаются');
});

test('битый JSON: встроенные работают, предупреждение', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'providers.json'), '{ profiles: [битый');
  const { profiles, warnings } = loadProfiles(envWith(home));
  assert.deepStrictEqual(profiles.map((p) => p.id), ['claude', 'glm', 'codex']);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /битый JSON/);
});

test('плохой профиль пропускается с предупреждением, остальные работают', () => {
  const home = tmpHome();
  fs.writeFileSync(
    path.join(home, 'providers.json'),
    JSON.stringify({ profiles: [{ id: 'x', kind: 'gemini', historyDir: '/tmp/x' }, { id: 'DeepSeek!', kind: 'claude-like' }, { id: 'kimi', kind: 'claude-like', historyDir: '~/.kimi-worker/projects' }] })
  );
  const { profiles, warnings } = loadProfiles(envWith(home));
  assert.deepStrictEqual(profiles.map((p) => p.id), ['claude', 'glm', 'codex', 'kimi']);
  assert.strictEqual(warnings.length, 2);
});

/* ---------- адаптеры из профилей ---------- */

test('синтетическая папка deepseek-сессий видна как отдельный источник со своим provider', async () => {
  const home = tmpHome();
  const dsRoot = path.join(home, 'ds-projects');
  const dir = path.join(dsRoot, '-work-beta');
  const t = Date.now() + 60000;
  writeJsonl(path.join(dir, '99999999-9999-4999-8999-999999999999.jsonl'), [
    user(t, 'ЦЕЛЬ: сделать страницу beta', { cwd: '/work/beta' }),
    assistant(t + 1000, [text('Делаю')], { model: 'deepseek-v4-pro', out: 50, rec: { cwd: '/work/beta' } }),
  ]);
  fs.writeFileSync(
    path.join(home, 'providers.json'),
    JSON.stringify({ profiles: [{ id: 'deepseek', kind: 'claude-like', label: 'DeepSeek', historyDir: path.join(home, 'ds-projects'), baseUrl: 'https://api.deepseek.com/anthropic' }] })
  );
  const adapters = await loadAdapters(envWith(home, { CLAUDE_PROJECTS_DIR: path.join(home, 'no-claude'), GLM_PROJECTS_DIR: path.join(home, 'no-glm'), CODEX_SESSIONS_DIR: path.join(home, 'no-codex') }));
  try {
    const ds = adapters.find((a) => a.id === 'deepseek');
    assert.ok(ds, 'адаптер deepseek включился');
    assert.strictEqual(ds.provider, 'deepseek');
    assert.strictEqual(ds.executor, true);
    assert.strictEqual(ds.label, 'DeepSeek');
    const dirs = await ds.listDirs();
    assert.strictEqual(dirs.length, 1);
    const sessions = await ds.listSessions(dirs[0].dir);
    assert.strictEqual(sessions.length, 1);
    const reg = new Registry(adapters, new Indexer(), { now: () => t + 3600000 });
    const list = await reg.listProjects();
    const beta = list.find((p) => p.name === 'beta');
    assert.deepStrictEqual(beta.providers, { deepseek: 1 }, 'провайдер по папке источника, не по модели');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ---------- распознавание запусков ---------- */

const PROFILES = builtinProfiles({}).concat([
  { id: 'deepseek', kind: 'claude-like', run: { binaries: ['agent-run'], printFlags: ['-p', '--print'], resumeFlags: ['--resume', '-r'], checkFlags: [] } },
  { id: 'kimi', kind: 'claude-like', run: { binaries: ['agent-run'], printFlags: ['-p', '--print'], resumeFlags: ['--resume', '-r'], checkFlags: [] } },
]);

test('запуски по профилям: agent-run, codex exec, claude-glm', () => {
  const a = parseAgentLaunches('agent-run deepseek -p "сделай" --output-format json', PROFILES, '/work/alpha');
  assert.deepStrictEqual(a, [{ cwd: '/work/alpha', resume: null, cat: null, check: false, profile: 'deepseek' }]);

  const b = parseAgentLaunches(`agent-run kimi --resume ${UUID} "что исправить"`, PROFILES, '/work/alpha');
  assert.strictEqual(b[0].profile, 'kimi');
  assert.strictEqual(b[0].resume, UUID);

  const c = parseAgentLaunches('cd /work/beta && codex exec "почини тесты" --json', PROFILES, '/work/alpha');
  assert.deepStrictEqual(c, [{ cwd: '/work/beta', resume: null, cat: null, check: false, profile: 'codex' }]);

  const d = parseAgentLaunches(`codex exec resume ${UUID} "продолжай"`, PROFILES, '/work/alpha');
  assert.strictEqual(d[0].profile, 'codex');
  assert.strictEqual(d[0].resume, UUID, 'codex exec resume <id> - продолжение сессии');

  const e = parseAgentLaunches('claude-glm -p "$(cat /home/demo/tz.md)"', PROFILES, '/work/alpha');
  assert.strictEqual(e[0].profile, 'glm');
  assert.strictEqual(e[0].cat, '/home/demo/tz.md');
});

test('запуском НЕ считаются: codex login, codex mcp, --help, echo, heredoc', () => {
  for (const cmd of ['codex login', 'codex mcp add x', 'codex exec --help', 'echo codex exec "x"', `cat >> notes.md <<'EOF'\ncodex exec "текст"\nEOF`, 'agent-run', 'agent-run --list', 'grep agent-run src/']) {
    assert.deepStrictEqual(parseAgentLaunches(cmd, PROFILES, '/work/alpha'), [], cmd);
  }
});

/* ---------- связь через MCP ---------- */

function buildMcpWorld(withCodex) {
  const root = tmpDir('agents-os-mcp-');
  const claudeRoot = path.join(root, 'claude', 'projects');
  const codexRoot = path.join(root, 'codex', 'sessions');
  const t0 = Date.now() + 5 * 60 * 1000;
  const sec = (n) => new Date(t0 + n * 1000).toISOString();
  const S = '11111111-1111-4111-8111-111111111111';
  const C = '22222222-2222-4222-8222-222222222222';
  writeJsonl(path.join(claudeRoot, '-work-alpha', S + '.jsonl'), [
    user(sec(0), 'Почини тесты через Codex', { cwd: '/work/alpha' }),
    assistant(sec(10), [toolUse('tu_mcp', 'mcp__codex__codex', { prompt: 'почини тесты' })], { model: 'claude-opus-5-5', out: 30, rec: { cwd: '/work/alpha' } }),
    toolResult(sec(50), 'tu_mcp', 'готово', false),
  ]);
  if (withCodex) {
    writeJsonl(path.join(codexRoot, 'rollout-2026-10-22T12-00-' + C + '.jsonl'), [
      { timestamp: sec(40), type: 'session_meta', payload: { id: C, cwd: '/work/alpha' } },
      { timestamp: sec(40), type: 'turn_context', payload: { cwd: '/work/alpha', model: 'gpt-5-codex' } },
      { timestamp: sec(45), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Делаю' }] } },
    ]);
  }
  const env = { CLAUDE_PROJECTS_DIR: claudeRoot, GLM_PROJECTS_DIR: path.join(root, 'no-glm'), CODEX_SESSIONS_DIR: codexRoot, AGENTS_OS_HOME: path.join(root, 'agents-os') };
  return { root, env, t0, S, C, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function mcpEdges(w) {
  const adapters = await loadAdapters(w.env);
  const reg = new Registry(adapters, new Indexer(), { now: () => w.t0 + 3 * 3600 * 1000 });
  const v = await reg.projectView('/work/alpha', { wait: true });
  return { v, adapters };
}

test('MCP-запуск: сессия codex того же проекта через 30 с - связь how=mcp', async () => {
  const w = buildMcpWorld(true);
  try {
    const { v } = await mcpEdges(w);
    const codex = v.nodes.find((n) => n.provider === 'gpt');
    assert.ok(codex, 'сессия Codex в графе');
    const e = v.edges.find((x) => x.kind === 'glm' && x.to === codex.id);
    assert.ok(e, 'связь «главная → Codex» нарисована');
    assert.strictEqual(e.how, 'mcp');
    assert.strictEqual(e.profile, 'codex');
  } finally {
    w.cleanup();
  }
});

test('MCP-запуск без сессии: связь с пометкой missing, выдуманной сессии нет', async () => {
  const w = buildMcpWorld(false);
  try {
    const { v } = await mcpEdges(w);
    assert.strictEqual(v.nodes.filter((n) => n.provider === 'gpt').length, 0, 'сессий Codex нет');
    const e = v.edges.find((x) => x.kind === 'glm' && x.missing === true);
    assert.ok(e, 'связь «запустил, сессия не найдена» нарисована');
    assert.strictEqual(e.profile, 'codex');
    assert.strictEqual(e.to, null);
    assert.strictEqual(v.nodes.some((n) => n.sessionId === 'fake'), false);
  } finally {
    w.cleanup();
  }
});

/* ---------- обёртка agent-run ---------- */

function runAgentRun(args, env) {
  return execFileSync('bash', [path.join(ROOT, 'tools', 'agent-run'), ...args], {
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('agent-run: --list показывает профили и наличие ключа, --print-key читает файл 600, без ключа - ошибка', () => {
  const home = tmpHome();
  const id = 'kimi';
  try {
    fs.writeFileSync(
      path.join(home, 'providers.json'),
      JSON.stringify({ profiles: [{ id, kind: 'claude-like', label: 'Kimi', historyDir: '~/.kimi-worker/projects', baseUrl: 'https://api.moonshot.ai/anthropic' }] })
    );
    const env = { AGENTS_OS_HOME: home };
    const list = runAgentRun(['--list'], env);
    assert.match(list, /glm  ключ: (есть|нет)/);
    assert.match(list, /kimi  ключ: нет/, 'без ключа - «нет», самого ключа в выводе нет');
    assert.doesNotMatch(list, /sk-/);

    let failed = false;
    try {
      runAgentRun(['--print-key', id], env);
    } catch (err) {
      failed = true;
      assert.strictEqual(err.status, 1);
      assert.doesNotMatch(String(err.stdout), /sk-/, 'без ключа на stdout ничего похожего на ключ нет');
    }
    assert.ok(failed, '--print-key без ключа завершается с ошибкой');

    const keysDir = path.join(home, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    fs.writeFileSync(path.join(keysDir, id), 'test-key-12345');
    fs.chmodSync(path.join(keysDir, id), 0o600);
    const key = runAgentRun(['--print-key', id], env);
    assert.strictEqual(key.trim(), 'test-key-12345');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('agent-run: --init создаёт settings.json с apiKeyHelper и CLAUDE.md, существующее не трогает', () => {
  const home = tmpHome();
  const id = 'kimi';
  try {
    fs.writeFileSync(
      path.join(home, 'providers.json'),
      JSON.stringify({ profiles: [{ id, kind: 'claude-like', label: 'Kimi', historyDir: '~/.kimi-worker/projects', baseUrl: 'https://api.moonshot.ai/anthropic' }] })
    );
    const out = runAgentRun(['--init', id], { AGENTS_OS_HOME: home, HOME: home });
    const cfg = path.join(home, '.kimi-worker');
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    // Абсолютный путь к agent-run: apiKeyHelper запускается без PATH пользователя.
    assert.strictEqual(settings.apiKeyHelper, `${JSON.stringify(fs.realpathSync(path.join(ROOT, "tools", "agent-run")))} --print-key ${id}`, 'ключ берёт apiKeyHelper, в окружение он не попадает');
    assert.ok(settings.permissions.deny.some((x) => /git push/.test(String(x))), 'права как у glm-worker: push и опасное запрещены');
    assert.ok(fs.readFileSync(path.join(cfg, 'CLAUDE.md'), 'utf8').includes('# Ты исполнитель'));
    assert.match(out, /agent-run --set-key kimi/);

    // повторный --init: существующие файлы не перезаписываются
    fs.writeFileSync(path.join(cfg, 'settings.json'), '{"keep":true}');
    runAgentRun(['--init', id], { AGENTS_OS_HOME: home, HOME: home });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8')), { keep: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('agent-run: неизвестный профиль и не claude-like - ошибка без запуска', () => {
  const home = tmpHome();
  try {
    fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ profiles: [{ id: 'codex2', kind: 'codex', historyDir: '~/.codex2/sessions' }] }));
    // неизвестный профиль без baseUrl в конфиге до claude не доходит
    assert.throws(() => runAgentRun(['no-such', '-p', 'x'], { AGENTS_OS_HOME: home }), /нет baseUrl/);
    assert.throws(() => runAgentRun(['codex2', '-p', 'x'], { AGENTS_OS_HOME: home }), /не claude-like/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ---------- прежнее имя обёртки ---------- */

test('tools/claude-glm передаёт команду в agent-run glm (сухой разбор команды)', () => {
  // без запуска claude: проверяем, что распознавание в транскриптах видит новый формат
  const launches = parseAgentLaunches('claude-glm -p "задача"', PROFILES, '/work/alpha');
  assert.strictEqual(launches[0].profile, 'glm');
  const script = fs.readFileSync(path.join(ROOT, 'tools', 'claude-glm'), 'utf8');
  assert.match(script, /exec "\$AR" glm "\$@"/, 'claude-glm - тонкая обёртка над agent-run');
  // служебные команды идут перед профилем: claude-glm --check → agent-run --check glm
  assert.match(script, /--check\|--set-key\|--print-key\|--init\) exec "\$AR" "\$1" glm/);
});
