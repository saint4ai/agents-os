'use strict';

// Регрессия вида ролей: строка агента в зоне не меняет сетку, метка «мозг» - одна пилюля,
// в разметке нет текста «null». DOM - минимальный стаб: из zones.js нужен только build дерева.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ESM-стаб DOM до импорта zones.js: append записывает детей, строки - как текстовые узлы
// (Element.append(null) в браузере пишет слово «null» - именно это ловим).
function makeEl(tag) {
  return {
    tag,
    children: [],
    className: '',
    textContentSet: null,
    dataset: {},
    style: {},
    attrs: {},
    set className(v) {
      this._cls = String(v);
    },
    get className() {
      return this._cls || '';
    },
    set textContent(v) {
      this.textContentSet = v;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    setAttributeNS(_ns, k, v) {
      this.attrs[k] = String(v);
    },
    addEventListener() {},
    append(...args) {
      for (const a of args) this.children.push(a === null || typeof a !== 'object' ? { text: String(a) } : a);
    },
    replaceChildren(...args) {
      this.children = args;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
  };
}

global.document = {
  createElement: (t) => makeEl(t),
  createElementNS: (_ns, t) => makeEl(t),
  createTextNode: (s) => ({ text: String(s) }),
};

// zones.js - ESM: копируем нужные модули во временную папку с "type": "module"
function loadZones() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-os-dom-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const f of ['util.js', 'maps.js', 'zones.js']) {
    fs.copyFileSync(path.resolve(__dirname, '..', 'public', f), path.join(dir, f));
  }
  return import(pathToFileURL(path.join(dir, 'zones.js')).href).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const now = Date.now();
const node = (provider, model, group) => ({
  id: 'x:' + provider,
  kind: 'session',
  provider,
  group: group || { id: provider, label: provider, provider },
  model,
  title: 'ЦЕЛЬ: сделать страницу',
  status: 'working',
  taskCount: null,
  lastStep: 'запускает тесты',
  lastMs: now,
  durationMs: 60000,
  tokens: { in: 1, out: 2 },
  sendsIn: 0,
  glmRuns: 0,
  project: { name: 'demo', key: 'demo' },
});

const ctx = (brainProvider) => ({
  selectedId: null,
  justDone: new Set(),
  showProject: false,
  onSelect() {},
  brainProvider: brainProvider || null,
});

// Всё текстовое содержимое строки одним списком
function texts(el, out) {
  const acc = out || [];
  if (el.text != null) acc.push(String(el.text));
  if (el.textContentSet != null) acc.push(String(el.textContentSet));
  for (const c of el.children) texts(c, acc);
  return acc;
}

function count(el, cls, acc) {
  const seen = acc || [];
  if (String(el.className || '').split(' ').includes(cls)) seen.push(el);
  for (const c of el.children || []) count(c, cls, seen);
  return seen;
}

test('в строке нет текста «null», метка мозга - одна пилюля, число колонок строки не меняется', async () => {
  const { liveRow, doneRow } = await loadZones();
  const n = node('claude', 'claude-opus-5-5', { id: 'claude-opus', label: 'Claude Opus', provider: 'claude' });

  const withBrain = liveRow(n, ctx('claude'));
  const without = liveRow(n, ctx(null));

  assert.deepStrictEqual(texts(withBrain).filter((t) => t.includes('null')), [], 'слова «null» в разметке нет');
  assert.strictEqual(count(withBrain, 'tm-brain').length, 1, 'метка «мозг» - один элемент');
  assert.deepStrictEqual(texts(withBrain).filter((t) => t === 'мозг'), ['мозг']);
  assert.strictEqual(count(without, 'tm-brain').length, 0, 'без ролей метки нет');
  assert.strictEqual(withBrain.children.length, without.children.length, 'сетка строки: число детей не изменилось');
  assert.strictEqual(withBrain.children[1].className, 'r-badges', 'метка живёт в ячейке чипа модели');

  const done = doneRow(n, ctx('claude'));
  assert.strictEqual(count(done, 'tm-brain').length, 1);
  assert.strictEqual(done.children.length, doneRow(n, ctx(null)).children.length);
});

test('чип провайдера из конфига: label профиля, не обрезанная модель', async () => {
  const { liveRow } = await loadZones();
  const ds = liveRow(node('deepseek', 'deepseek-v4-pro', { id: 'deepseek', label: 'DeepSeek', provider: 'deepseek' }), ctx(null));
  const badge = ds.children[1].children.find((c) => String(c.className).includes('pbadge'));
  assert.strictEqual(badge.textContentSet, 'DeepSeek', 'на чипе label профиля');
  assert.deepStrictEqual(texts(ds).filter((t) => t.includes('DEEPSEEK-V4') || t.includes('deepseek-v4-p')), [], 'модель на чип не попадает');
});

test('строка ролей: чипы с именами провайдеров, без исполнителей - «пока никого»', async () => {
  const { teamLine, withLabels } = await loadZones();
  const team = { brain: { profile: 'claude', provider: 'claude', label: null }, executors: [{ profile: 'deepseek', provider: 'deepseek', label: null }, { profile: 'glm', provider: 'glm', label: null }] };
  // правильные имена профилей приходят с узлов карты (providerLabel)
  const nodes = [{ provider: 'deepseek', providerLabel: 'DeepSeek' }, { provider: 'glm', providerLabel: 'GLM (через Z.ai)' }, { provider: 'claude', providerLabel: 'Claude' }];
  const line = teamLine(withLabels(JSON.parse(JSON.stringify(team)), nodes));
  assert.deepStrictEqual(texts(line).filter((t) => t.includes('null')), [], 'нет «null»');
  assert.deepStrictEqual(texts(line).filter((t) => t === 'DeepSeek' || t === 'GLM (через Z.ai)'), ['DeepSeek', 'GLM (через Z.ai)'], 'в чипах имена провайдеров');
  const badges = count(line, 'pbadge');
  assert.strictEqual(badges.length, 3, 'мозг и два исполнителя - три чипа');
  assert.ok(badges.every((b) => String(b.className).match(/p-(claude|deepseek|glm)/)), 'цвет чипа - класс провайдера');

  const empty = teamLine(withLabels({ brain: { profile: 'claude', provider: 'claude', label: null }, executors: [] }, nodes));
  assert.deepStrictEqual(texts(empty).filter((t) => t === 'пока никого'), ['пока никого']);
});
