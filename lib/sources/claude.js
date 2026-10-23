'use strict';

// Источник: Claude Code. Папка по умолчанию ~/.claude/projects (CLAUDE_PROJECTS_DIR переопределяет).

const os = require('os');
const path = require('path');
const { createClaudeLike } = require('./claudeLike');

function create(env) {
  const e = env || process.env;
  const root = path.resolve(e.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects'));
  return createClaudeLike({ id: 'claude', provider: 'claude', label: 'Claude', root });
}

module.exports = { create };
