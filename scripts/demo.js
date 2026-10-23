#!/usr/bin/env node
'use strict';

// Демо-данные Agents OS: синтетические переписки трёх выдуманных проектов во временную папку
// и сервер на них. Ни одного реального пути, имени или ключа.
//
//   npm run demo            # http://127.0.0.1:3939, PORT переопределяет
//   PORT=0 npm run demo     # порт напечатается после запуска (для тестов)
//
// Данные: главные сессии Claude (Opus), помощники Sonnet и Haiku, GLM через claude-glm,
// deepseek через agent-run, Codex через codex exec; одна межпроектная связь; два агента
// «в работе», у части - структурные отчёты (СТАТУС / СДЕЛАНО / …). Свой providers.json
// (deepseek) и team.json (мозг - claude, codex не в команде: на «Цепочке» он с пометкой).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* ---------- маленький синтезатор транскриптов (как в test/helpers) ---------- */

let seq = 0;
const iso = (ms) => new Date(ms).toISOString();
const text = (t) => ({ type: 'text', text: t });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

function user(ms, txt, cwd) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text: txt }] }, uuid: 'u' + ++seq, timestamp: iso(ms), cwd };
}

function assistant(ms, blocks, cwd, opts) {
  const o = opts || {};
  return {
    type: 'assistant',
    message: {
      id: o.msgId || 'msg_' + ++seq,
      model: o.model || 'claude-opus-5-5',
      role: 'assistant',
      content: blocks,
      usage: { input_tokens: o.in != null ? o.in : 3, output_tokens: o.out != null ? o.out : 20, cache_read_input_tokens: 0 },
    },
    uuid: 'a' + ++seq,
    timestamp: iso(ms),
    cwd,
  };
}

function toolResult(ms, id, content, isError) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isError, content }] }, uuid: 'r' + ++seq, timestamp: iso(ms) };
}

function writeJsonl(file, recs, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r) + '\n').join(''));
  const t = mtime || Date.now();
  fs.utimesSync(file, new Date(t), new Date(t));
}

function writeMeta(file, meta) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(meta));
}

// Структурный отчёт исполнителя: report.js разбирает заголовки на тезисы.
function reportText(status, done, checks) {
  return `СТАТУС: ${status}

СДЕЛАНО:
- ${done}

ПРОВЕРКА: ${checks}

ВОПРОСЫ И РИСКИ: нет`;
}

/* ---------- сценарий демо ---------- */

function generate(home) {
  const claudeRoot = path.join(home, 'claude', 'projects');
  const glmRoot = path.join(home, 'glm', 'projects');
  const codexRoot = path.join(home, 'codex', 'sessions');
  const dsRoot = path.join(home, 'ds-worker', 'projects');
  const now = Date.now();
  const min = (n) => now - n * 60000;
  const dirs = {
    alpha: path.join(claudeRoot, '-demo-alpha-shop'),
    beta: path.join(claudeRoot, '-demo-beta-clinic'),
    gamma: path.join(claudeRoot, '-demo-gamma-app'),
  };
  const U = '11111111-1111-4111-8111-1111111111';

  /* alpha-shop: главная сессия Opus работает сейчас, helper Sonnet запустил GLM в beta-clinic (межпроектная связь) */
  const A1 = U + '01';
  writeJsonl(path.join(dirs.alpha, A1 + '.jsonl'), [
    user(min(240), 'ЦЕЛЬ: собрать витрину alpha-shop и прогнать тесты', '/demo/alpha-shop'),
    assistant(min(239), [toolUse('d_agent1', 'Agent', { description: 'Собери витрину', subagent_type: 'sonnet-executor', model: 'sonnet' })], '/demo/alpha-shop', { model: 'claude-opus-5-5', out: 40 }),
    assistant(min(30), [toolUse('d_t1', 'Bash', { command: 'npx vitest run 2>&1 | tail -5' })], '/demo/alpha-shop', { model: 'claude-opus-5-5', out: 25 }),
    // вызов без результата: главный Opus остаётся «в работе» (тесты идут)
  ], now - 5000);
  writeMeta(path.join(dirs.alpha, A1, 'subagents', 'agent-d000000000000001.meta.json'), { agentType: 'sonnet-executor', description: 'Собери витрину', toolUseId: 'd_agent1', finished: true, model: 'sonnet' });
  writeJsonl(path.join(dirs.alpha, A1, 'subagents', 'agent-d000000000000001.jsonl'), [
    user(min(238), 'Собери витрину alpha-shop', '/demo/alpha-shop'),
    assistant(min(200), [toolUse('d_glm1', 'Bash', { command: 'cd /demo/beta-clinic && claude-glm -p "$(cat /demo/tz/beta-page.md)" --output-format json' , run_in_background: true })], '/demo/alpha-shop', { model: 'claude-sonnet-5-5', out: 60 }),
    toolResult(min(199), 'd_glm1', 'Command running in background', false),
    assistant(min(60), [text(reportText('готово', 'витрина alpha-shop собрана', 'npx vitest run - 14 passed'))], '/demo/alpha-shop', { model: 'claude-sonnet-5-5', out: 30 }),
  ], min(60));
  writeJsonl(path.join(dirs.alpha, A1, 'subagents', 'agent-d000000000000002.jsonl'), [
    user(min(236), 'Собери факты по каталогу', '/demo/alpha-shop'),
    assistant(min(120), [text('Каталог: 42 товара, три категории, цены в data-атрибутах.')], '/demo/alpha-shop', { model: 'claude-haiku-4-5', out: 15 }),
  ], min(120));
  writeMeta(path.join(dirs.alpha, A1, 'subagents', 'agent-d000000000000002.meta.json'), { agentType: 'haiku-executor', description: 'Собери факты по каталогу', toolUseId: 'd_haiku1', finished: true, model: 'haiku' });

  /* GLM-исполнитель в beta-clinic (запущен из alpha-shop через cd): готов, со структурным отчётом */
  const G1 = U + '02';
  writeJsonl(path.join(glmRoot, '-demo-beta-clinic', G1 + '.jsonl'), [
    user(min(198), 'ЦЕЛЬ: сверстать страницу приёма beta-clinic\nКОНТЕКСТ: styles.css, index.html\nМОЖНО МЕНЯТЬ: index.html\nНЕЛЬЗЯ: styles.css\nГОТОВО, КОГДА: страница открывается без ошибок\nПРОВЕРКА: npm run build', '/demo/beta-clinic'),
    assistant(min(150), [toolUse('d_e1', 'Edit', { file_path: '/demo/beta-clinic/index.html', old_string: '<h1>', new_string: '<h1 class="hero">' })], '/demo/beta-clinic', { model: 'claude-opus-5-5', out: 80 }),
    // сборка из ПРОВЕРКИ ТЗ: без неё блок «Проверки» в отчёте пишет «не запускались» вопреки тексту отчёта
    assistant(min(80), [toolUse('d_bld1', 'Bash', { command: 'npm run build' })], '/demo/beta-clinic', { model: 'claude-opus-5-5', out: 20 }),
    toolResult(min(79), 'd_bld1', 'vite v6.2.0 building for production...\n✓ 42 modules transformed.\n✓ built in 1.84s', false),
    assistant(min(70), [text(reportText('готово', 'свёрстана страница приёма, форма валидируется', 'npm run build - сборка прошла'))], '/demo/beta-clinic', { model: 'claude-opus-5-5', out: 60 }),
  ], min(70));

  /* beta-clinic: главная сессия запускает codex exec (готов, не в команде) и deepseek через agent-run (в работе) */
  const B1 = U + '03';
  const D1 = U + '04';
  const C1 = U + '05';
  writeJsonl(path.join(dirs.beta, B1 + '.jsonl'), [
    user(min(180), 'ЦЕЛЬ: подключить онлайн-запись в beta-clinic', '/demo/beta-clinic'),
    assistant(min(91), [toolUse('d_cx1', 'Bash', { command: 'codex exec "обнови зависимости до мажорных версий" --json', run_in_background: true })], '/demo/beta-clinic', { model: 'claude-opus-5-5', out: 30 }),
    toolResult(min(90), 'd_cx1', 'Command running in background', false),
    assistant(min(25), [toolUse('d_ds1', 'Bash', { command: 'agent-run deepseek -p "$(cat /demo/tz/booking.md)" --output-format json', run_in_background: true })], '/demo/beta-clinic', { model: 'claude-opus-5-5', out: 35 }),
    toolResult(min(24), 'd_ds1', 'Command running in background', false),
  ], min(20));
  writeJsonl(path.join(dsRoot, '-demo-beta-clinic', D1 + '.jsonl'), [
    user(min(23), 'ЦЕЛЬ: форма онлайн-записи\nКОНТЕКСТ: booking.js\nМОЖНО МЕНЯТЬ: booking.js\nНЕЛЬЗЯ: index.html\nГОТОВО, КОГДА: форма шлёт запрос\nПРОВЕРКА: npx vitest run', '/demo/beta-clinic'),
    assistant(min(12), [toolUse('d_e2', 'Edit', { file_path: '/demo/beta-clinic/booking.js', old_string: 'fetch(', new_string: 'fetch("/api/slot"' })], '/demo/beta-clinic', { model: 'deepseek-v4-pro', out: 90 }),
    assistant(min(0), [toolUse('d_v1', 'Bash', { command: 'npx vitest run 2>&1 | tail -5' })], '/demo/beta-clinic', { model: 'deepseek-v4-pro', out: 30 }),
    // вызов без результата: deepseek остаётся «в работе»
  ], now - 3000);
  writeJsonl(path.join(codexRoot, 'rollout-2026-10-23T12-00-' + C1 + '.jsonl'), [
    { timestamp: iso(min(90)), type: 'session_meta', payload: { id: C1, cwd: '/demo/beta-clinic' } },
    { timestamp: iso(min(90)), type: 'turn_context', payload: { cwd: '/demo/beta-clinic', model: 'gpt-5-codex' } },
    { timestamp: iso(min(90)), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex exec: обнови зависимости до мажорных версий' }] } },
    { timestamp: iso(min(80)), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Обновил package.json, тесты зелёные.' }] } },
  ], min(80));

  /* gamma-app: самостоятельная сессия, закончилась с ошибкой тестов и структурным отчётом */
  const GA1 = U + '06';
  writeJsonl(path.join(dirs.gamma, GA1 + '.jsonl'), [
    user(min(300), 'ЦЕЛЬ: починить падающий тест пуша gamma-app', '/demo/gamma-app'),
    assistant(min(280), [toolUse('d_b1', 'Bash', { command: 'npx vitest run 2>&1 | tail -5' })], '/demo/gamma-app', { model: 'claude-opus-5-5', out: 20 }),
    toolResult(min(279), 'd_b1', 'Tests  2 failed | 12 passed (14)', true),
    assistant(min(278), [text(reportText('частично', 'нашёл причину: тест ждёт webhook, которого нет в песочнице', 'npx vitest run - 2 failed, нужны права на ci.yml'))], '/demo/gamma-app', { model: 'claude-opus-5-5', out: 15 }),
  ], min(278));

  /* конфиги демо: свой providers.json (deepseek) и team.json (мозг - claude) */
  fs.mkdirSync(path.join(home, 'agents-os'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents-os', 'providers.json'), JSON.stringify({
    profiles: [{ id: 'deepseek', kind: 'claude-like', label: 'DeepSeek', historyDir: path.join(home, 'ds-worker', 'projects'), baseUrl: 'https://api.deepseek.com/anthropic' }],
  }, null, 2));
  fs.writeFileSync(path.join(home, 'agents-os', 'team.json'), JSON.stringify({
    version: 1,
    brain: 'claude',
    executors: [{ profile: 'glm', projects: ['*'] }, { profile: 'deepseek', projects: ['*'] }],
    updatedAt: new Date().toISOString(),
    updatedBy: 'demo',
  }, null, 2));

  return { claudeRoot, glmRoot, codexRoot };
}

/* ---------- запуск ---------- */

function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-os-demo-'));
  const dirs = generate(home);
  const wanted = parseInt(process.env.PORT || '3939', 10);
  // PORT=0: свободный порт выбираем сами и печатаем его (для тестов)
  pickPort(wanted, (port) => {
    const child = spawn(process.execPath, ['--max-old-space-size=384', 'server.js'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: Object.assign({}, process.env, {
        PORT: String(port),
        AGENTS_OS_HOME: path.join(home, 'agents-os'),
        CLAUDE_PROJECTS_DIR: dirs.claudeRoot,
        GLM_PROJECTS_DIR: dirs.glmRoot,
        CODEX_SESSIONS_DIR: dirs.codexRoot,
      }),
    });
    console.log(`Демо-данные: ${home}`);
    console.log(`Agents OS demo: http://127.0.0.1:${port}`);
    const stop = () => {
      child.kill('SIGTERM');
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    child.on('exit', (code) => {
      console.log(`Демо остановлено (код ${code == null ? '?' : code}). Данные: ${home}`);
      process.exit(code == null ? 0 : code);
    });
  });
}

function pickPort(wanted, cb) {
  if (wanted > 0) return cb(wanted);
  const net = require('net');
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const p = probe.address().port;
    probe.close(() => cb(p));
  });
}

main();
