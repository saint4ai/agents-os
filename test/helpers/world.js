'use strict';

// Выдуманный «мир» для тестов связей: два проекта, субагент, GLM-исполнитель в другом проекте и --resume.
//
//   проект alpha (/work/alpha), Claude:
//     сессия S ──Agent──▶ субагент A (meta.toolUseId)
//        S ──SendMessage──▶ A
//        A ──cd /work/beta && claude-glm -p "$(cat …/tz.md)"──▶ GLM-сессия G (проект beta)
//        S ──claude-glm -p --resume <G2>──▶ GLM-сессия G2 (проект alpha, старая)
//   проект beta (/work/beta): G
//
// Все времена задаются от t0, который чуть в будущем относительно момента создания файлов
// (так birthtime файлов остаётся раньше первой записи GLM-сессии, как и в жизни).

const fs = require('fs');
const path = require('path');
const { user, assistant, toolResult, toolUse, text, writeJsonl, tmpDir } = require('./synth');

const ALPHA = '/work/alpha';
const BETA = '/work/beta';

function buildWorld() {
  const root = tmpDir('agent-console-world-');
  const claudeRoot = path.join(root, 'claude', 'projects');
  const glmRoot = path.join(root, 'glm', 'projects');
  const t0 = Date.now() + 5 * 60 * 1000;
  const sec = (n) => t0 + n * 1000;
  const S = '11111111-1111-4111-8111-111111111111';
  const G = '22222222-2222-4222-8222-222222222222';
  const G2 = '33333333-3333-4333-8333-333333333333';
  const A = 'a0000000000000001';
  const dirAlpha = path.join(claudeRoot, '-work-alpha');
  const touch = (f, s) => fs.utimesSync(f, new Date(sec(s)), new Date(sec(s)));

  // S: основная сессия (Opus), запускает субагента, пишет ему, перезапускает G2
  const sFile = path.join(dirAlpha, S + '.jsonl');
  writeJsonl(sFile, [
    user(sec(0), 'Собери карту проекта alpha', { cwd: ALPHA }),
    assistant(sec(1), [toolUse('tu_agent1', 'Agent', { description: 'Проверить сборку', subagent_type: 'sonnet-executor', model: 'sonnet' })], { model: 'claude-opus-5-5', out: 30, rec: { cwd: ALPHA } }),
    assistant(sec(20), [toolUse('tu_send1', 'SendMessage', { to: A, summary: 'Уточнение', message: 'Проверь ещё тесты' })], { model: 'claude-opus-5-5', out: 20, rec: { cwd: ALPHA } }),
    assistant(sec(40), [toolUse('tu_glm2', 'Bash', { command: `claude-glm -p --resume ${G2} "$(cat /home/demo/tz-fix.md)" --output-format json`, run_in_background: true })], { model: 'claude-opus-5-5', out: 25, rec: { cwd: ALPHA } }),
    toolResult(sec(41), 'tu_glm2', 'Command running in background', false),
    { type: 'ai-title', aiTitle: 'Карта проекта alpha', sessionId: S },
  ]);
  touch(sFile, 60);

  // A: субагент Sonnet, launches GLM в проекте beta
  const aFile = path.join(dirAlpha, S, 'subagents', 'agent-' + A + '.jsonl');
  writeJsonl(aFile, [
    user(sec(2), 'Проверь сборку alpha', { cwd: ALPHA, isSidechain: true }),
    assistant(sec(10), [toolUse('tu_launch', 'Bash', { command: 'cd /work/beta && /usr/local/bin/claude-glm -p "$(cat /home/demo/tz-beta.md)" --output-format stream-json > /tmp/out.jsonl 2>&1', run_in_background: true })], { model: 'claude-sonnet-5-5', in: 3, out: 100, rec: { cwd: ALPHA } }),
    toolResult(sec(11), 'tu_launch', 'Command running in background', false),
    assistant(sec(30), [text('Не получилось запустить')], { model: 'claude-sonnet-5-5', out: 50, rec: { cwd: ALPHA } }),
    toolResult(sec(31), 'tu_x', 'Error: failed', true),
  ]);
  fs.writeFileSync(aFile.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'sonnet-executor', description: 'Проверить сборку', toolUseId: 'tu_agent1', finished: true, model: 'sonnet' }));
  touch(aFile, 35);

  // G: GLM-сессия в проекте beta; первая запись через 1 с после запуска (t=10 с)
  const gFile = path.join(glmRoot, '-work-beta', G + '.jsonl');
  writeJsonl(gFile, [
    user(sec(11), 'ЦЕЛЬ: сделать страницу beta', { cwd: BETA }),
    assistant(sec(15), [text('Делаю')], { model: 'claude-opus-5-5', out: 70, rec: { cwd: BETA } }),
  ]);
  touch(gFile, 25);

  // G2: старая GLM-сессия проекта alpha, к ней вернулись через --resume
  const g2File = path.join(glmRoot, '-work-alpha', G2 + '.jsonl');
  writeJsonl(g2File, [
    user(sec(-3600), 'ЦЕЛЬ: первая версия', { cwd: ALPHA }),
    assistant(sec(-3590), [text('Готово')], { model: 'claude-opus-5-5', out: 12, rec: { cwd: ALPHA } }),
  ]);
  touch(g2File, 50);

  const env = { CLAUDE_PROJECTS_DIR: claudeRoot, GLM_PROJECTS_DIR: glmRoot, CODEX_SESSIONS_DIR: path.join(root, 'no-codex') };
  return { root, env, t0, S, G, G2, A, now: sec(3 * 3600), ALPHA, BETA, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

module.exports = { buildWorld, ALPHA, BETA };
