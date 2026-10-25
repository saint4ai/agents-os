'use strict';

// tools/agent-run, tools/claude-glm, tools/glm-worker/key-helper.sh: ключи в файле, --init, --set-key,
// --print-key, --list. Всё с временным HOME и подставными ключами: настоящие ~/.claude, ~/.agents-os,
// ~/.glm-worker не читаются и не пишутся, запросов к провайдерам нет.
// На Windows скрипты идут через Git Bash (bash из WSL не годится); нет bash - тесты пропускаются с причиной.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { findBash, WIN } = require('./helpers/bash');

const ROOT = path.resolve(__dirname, '..');
const AGENT_RUN = path.join(ROOT, 'tools', 'agent-run');
const CLAUDE_GLM = path.join(ROOT, 'tools', 'claude-glm');
const KEY_HELPER = path.join(ROOT, 'tools', 'glm-worker', 'key-helper.sh');

const BASH = findBash();
// На macOS скрипты берут ключ из настоящей Связки ключей (security), а тест её трогать не должен.
const SKIP = process.platform === 'darwin' ? 'на macOS скрипты ходят в настоящую Связку ключей, тест её не трогает' : BASH ? false : 'нет bash (на Windows нужен Git for Windows)';

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-os-tools-'));
  const env = Object.assign({}, process.env, { HOME: home, AGENTS_OS_HOME: path.join(home, '.agents-os') });
  delete env.XDG_CONFIG_HOME;
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC|ZAI_)/.test(k)) delete env[k];
  const run = (script, args, input) => cp.spawnSync(BASH, [script, ...args], { env, input, encoding: 'utf8', timeout: 60000 });
  try {
    return fn({ home, env, run });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const FAKE = 'FAKE-KEY-0123456789';

test('agent-run --list: без ключей профили видны, ключ не печатается', { skip: SKIP }, () => {
  withHome(({ run }) => {
    const r = run(AGENT_RUN, ['--list']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^claude {2}ключ: нет$/m);
    assert.match(r.stdout, /^glm {2}ключ: нет$/m);
    assert.match(r.stdout, /^codex {2}\(не claude-like/m);
  });
});

test('agent-run --init: папка профиля из временного HOME, settings.json с apiKeyHelper, второй запуск ничего не затирает', { skip: SKIP }, () => {
  withHome(({ home, run }) => {
    const r = run(AGENT_RUN, ['--init', 'deepseek']);
    assert.strictEqual(r.status, 0, r.stderr);
    const dir = path.join(home, '.deepseek-worker');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')));
    assert.strictEqual(settings.permissions.defaultMode, 'acceptEdits');
    assert.match(settings.apiKeyHelper, / --print-key deepseek$/);
    if (WIN) {
      // Claude Code запускает apiKeyHelper через cmd: скрипт зовётся через bash.exe из Git, пути в кавычках
      assert.match(settings.apiKeyHelper, /^"[^"]+bash\.exe" "[A-Za-z]:\/[^"]+agent-run" --print-key deepseek$/);
    } else {
      assert.match(settings.apiKeyHelper, /^"[^"]+agent-run" --print-key deepseek$/);
    }
    // правка пользователя переживает повторный --init
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'мои правила');
    const again = run(AGENT_RUN, ['--init', 'deepseek']);
    assert.strictEqual(again.status, 0, again.stderr);
    assert.match(again.stdout, /Существует/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'мои правила');
  });
});

test('agent-run: --set-key, --print-key, --list с подставным ключом (\\r\\n в конце вставки отбрасывается)', { skip: SKIP }, () => {
  withHome(({ home, run }) => {
    fs.mkdirSync(path.join(home, '.agents-os'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.agents-os', 'providers.json'),
      JSON.stringify({ profiles: [{ id: 'deepseek', kind: 'claude-like', baseUrl: 'https://api.deepseek.com/anthropic', historyDir: '~/.ds-worker/projects' }] })
    );
    const none = run(AGENT_RUN, ['--print-key', 'deepseek']);
    assert.strictEqual(none.status, 1);
    assert.strictEqual(none.stdout, '', 'без ключа на stdout пусто');
    assert.match(none.stderr, /Ключа профиля 'deepseek' нет/);

    const set = run(AGENT_RUN, ['--set-key', 'deepseek'], FAKE + '\r\n');
    assert.strictEqual(set.status, 0, set.stderr);
    assert.ok(!set.stdout.includes(FAKE) && !set.stderr.includes(FAKE), 'ключ не печатается при сохранении');
    assert.strictEqual(fs.readFileSync(path.join(home, '.agents-os', 'keys', 'deepseek'), 'utf8'), FAKE);

    const print = run(AGENT_RUN, ['--print-key', 'deepseek']);
    assert.strictEqual(print.status, 0, print.stderr);
    assert.strictEqual(print.stdout, FAKE, 'без перевода строки: apiKeyHelper отдаёт ключ как есть');

    const list = run(AGENT_RUN, ['--list']);
    assert.strictEqual(list.status, 0, list.stderr);
    assert.match(list.stdout, /^deepseek {2}ключ: есть$/m);
    assert.match(list.stdout, /^glm {2}ключ: нет$/m);
    assert.ok(!list.stdout.includes(FAKE));

    const empty = run(AGENT_RUN, ['--set-key', 'kimi'], '\n');
    assert.strictEqual(empty.status, 1, 'пустой ключ не сохраняется');
    assert.ok(!fs.existsSync(path.join(home, '.agents-os', 'keys', 'kimi')));
  });
});

test('ключ из файла, созданного вручную с \\r\\n (Блокнот, PowerShell), читается без перевода строки', { skip: SKIP }, () => {
  withHome(({ home, run }) => {
    fs.mkdirSync(path.join(home, '.agents-os', 'keys'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents-os', 'keys', 'glm'), FAKE + '\r\n');
    const r = run(AGENT_RUN, ['--print-key', 'glm']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, FAKE);
  });
});

test('claude-glm: --init, --set-key, --print-key идут в профиль glm; key-helper.sh отдаёт тот же ключ', { skip: SKIP }, () => {
  withHome(({ home, run }) => {
    const init = run(CLAUDE_GLM, ['--init']);
    assert.strictEqual(init.status, 0, init.stderr);
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.glm-worker', 'settings.json'), 'utf8'));
    assert.match(settings.apiKeyHelper, / --print-key glm$/);
    assert.strictEqual(run(CLAUDE_GLM, ['--set-key'], FAKE + '\n').status, 0);
    assert.strictEqual(fs.readFileSync(path.join(home, '.agents-os', 'keys', 'glm'), 'utf8'), FAKE);
    assert.strictEqual(run(CLAUDE_GLM, ['--print-key']).stdout, FAKE);
    const helper = run(KEY_HELPER, []);
    assert.strictEqual(helper.status, 0, helper.stderr);
    assert.strictEqual(helper.stdout, FAKE);
  });
});

test('key-helper.sh: без ключа код 1 и подсказка в stderr, прежний файл ~/.config/claude-glm/key читается как запасной', { skip: SKIP }, () => {
  withHome(({ home, run }) => {
    const none = run(KEY_HELPER, []);
    assert.strictEqual(none.status, 1);
    assert.strictEqual(none.stdout, '');
    assert.match(none.stderr, /claude-glm --set-key/);
    fs.mkdirSync(path.join(home, '.config', 'claude-glm'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'claude-glm', 'key'), FAKE + '\n');
    const legacy = run(KEY_HELPER, []);
    assert.strictEqual(legacy.stdout, FAKE);
  });
});

test('Windows: apiKeyHelper из settings.json, запущенный через cmd (как это делает Claude Code), отдаёт ключ профиля', { skip: WIN && !SKIP ? false : 'только Windows с Git Bash' }, () => {
  withHome(({ home, env, run }) => {
    assert.strictEqual(run(AGENT_RUN, ['--init', 'deepseek']).status, 0);
    assert.strictEqual(run(AGENT_RUN, ['--set-key', 'deepseek'], FAKE + '\n').status, 0);
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.deepseek-worker', 'settings.json'), 'utf8'));
    // exec зовёт cmd.exe /d /s /c, так же запускает helper Claude Code на Windows; HOME в окружении Windows обычно нет
    const childEnv = Object.assign({}, env);
    delete childEnv.HOME;
    const r = cp.spawnSync(settings.apiKeyHelper, { shell: true, env: childEnv, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, FAKE);
  });
});
