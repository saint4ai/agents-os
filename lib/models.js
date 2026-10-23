'use strict';

// Провайдеры, семейства моделей и статус узла.

const PROVIDERS = {
  claude: { label: 'Claude' },
  glm: { label: 'GLM' },
  gpt: { label: 'GPT' },
  gemini: { label: 'Gemini' },
};

// Самая частая модель в { имя: число ответов }.
function primaryModel(models) {
  let best = null;
  let n = 0;
  for (const [m, c] of Object.entries(models || {})) {
    if (c > n) {
      best = m;
      n = c;
    }
  }
  return best;
}

// Семейство Claude по имени модели (claude-opus-5-5[1m] → opus).
function claudeFamily(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  return null;
}

// Группа карты проекта: вид ИИ + модель. Провайдер берётся из источника, а не из поля model:
// у GLM Z.ai подменяет имя на claude-opus-…
function groupOf(provider, model, providerLabel) {
  if (provider === 'glm') return { id: 'glm', provider, label: 'GLM', sub: 'через Z.ai' };
  if (provider === 'gpt') return { id: 'gpt', provider, label: 'GPT', sub: model || '' };
  if (provider === 'gemini') return { id: 'gemini', provider, label: 'Gemini', sub: model || '' };
  // провайдер из конфига (deepseek, kimi, …): своя группа, имя - label профиля
  if (provider !== 'claude') return { id: provider, provider, label: providerLabel || provider, sub: model || '' };
  const fam = claudeFamily(model);
  if (fam) return { id: 'claude-' + fam.toLowerCase(), provider: 'claude', label: 'Claude ' + fam, sub: '' };
  if (model) return { id: 'claude-other', provider: 'claude', label: 'Claude', sub: model };
  return { id: 'claude-unknown', provider: 'claude', label: 'Claude', sub: 'модель не определена' };
}

// Порядок групп на карте проекта.
const GROUP_ORDER = ['claude-opus', 'claude-sonnet', 'claude-haiku', 'claude-other', 'claude-unknown', 'glm', 'gpt', 'gemini'];

const PENDING_MS = 15 * 60 * 1000; // висящий вызов инструмента продлевает «в работе» не дольше, чем на это время

// «в работе» - файл менялся за 60 с, либо meta.finished=false и файл менялся за 10 мин, либо последняя
// запись это вызов инструмента без результата (тесты, сборка, ожидание ответа) и файл менялся за 15 мин.
// «ошибка» - последняя запись это ошибочный результат. Остальное - «готово».
function nodeStatus(info, now) {
  const age = now - info.mtimeMs;
  if (age < 60 * 1000) return 'working';
  if (info.meta && info.meta.finished === false && age < 10 * 60 * 1000) return 'working';
  if (info.pending && age < PENDING_MS) return 'working';
  if (info.lastErr) return 'error';
  return 'done';
}

module.exports = { PROVIDERS, primaryModel, claudeFamily, groupOf, GROUP_ORDER, nodeStatus, PENDING_MS };
