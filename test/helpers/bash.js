'use strict';

// Поиск bash для тестов скриптов tools/. На Windows нужен именно Git Bash: слово `bash` в PATH может
// указывать на bash.exe из WSL (C:\Windows\System32), а он ждёт пути Linux. Нет bash - null.

const path = require('path');
const cp = require('child_process');

const WIN = process.platform === 'win32';

function findBash() {
  const cands = WIN
    ? [
        process.env.CLAUDE_CODE_GIT_BASH_PATH,
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
      ]
    : ['bash'];
  for (const c of cands) {
    if (!c) continue;
    const r = cp.spawnSync(c, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'ok') return c;
  }
  return null;
}

module.exports = { findBash, WIN };
