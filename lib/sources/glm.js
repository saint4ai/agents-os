'use strict';

// Источник: GLM-исполнитель (Claude Code на ключе Z.ai). Папка по умолчанию ~/.glm-worker/projects
// (GLM_PROJECTS_DIR переопределяет). В его транскриптах message.model = claude-opus-…, потому что Z.ai
// подменяет имя, поэтому провайдер здесь определяется по папке, а не по модели.

const os = require('os');
const path = require('path');
const { createClaudeLike } = require('./claudeLike');

function create(env) {
  const e = env || process.env;
  const root = path.resolve(e.GLM_PROJECTS_DIR || path.join(os.homedir(), '.glm-worker', 'projects'));
  return createClaudeLike({ id: 'glm', provider: 'glm', label: 'GLM (через Z.ai)', root });
}

module.exports = { create };
