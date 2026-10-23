'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { user, assistant, toolResult, toolUse, text, writeJsonl, tmpDir } = require('./helpers/synth');
const { parseDid, readTask, lastAssistantText, howView, checksView, lastTests } = require('../lib/report');
const { parseRecord } = require('../lib/parse');

const STRUCTURED = `**Сделано полностью.** Тесты 362 из 362 зелёные.

## СТАТУС
Сделано полностью. Тесты 362 из 362 зелёные.

## СДЕЛАНО
| Что | Доказательство |
|---|---|
| getCompany(id): только GET, write-методов нет | lib/altegio-client.ts |
| altegioBranches кеш 5 минут | test/branches.test.ts |

## СДЕЛАНО МИМО ТЗ (по необходимости)
- Поправил опечатку в README

## БЛОКЕРЫ
нет

## НЕ СДЕЛАНО / ЗАМЕЧАНИЯ
- Усечение подписи на десктопе (ограничено 280 px)
- Смоук живой страницы не гонял

## ДАЛЬШЕ Я
Ничего.
`;

test('структурный отчёт: статус, тезисы из таблицы с доказательством, разделы по порядку', () => {
  const d = parseDid(STRUCTURED);
  assert.strictEqual(d.structured, true);
  assert.strictEqual(d.fallback, false);
  assert.strictEqual(d.status, 'Сделано полностью. Тесты 362 из 362 зелёные.');
  assert.deepStrictEqual(d.sections.map((s) => s.key), ['done', 'extra', 'blockers', 'notdone']);
  const done = d.sections.find((s) => s.key === 'done');
  assert.deepStrictEqual(done.bullets, [
    'getCompany(id): только GET, write-методов нет · lib/altegio-client.ts',
    'altegioBranches кеш 5 минут · test/branches.test.ts',
  ]);
  assert.strictEqual(d.sections.find((s) => s.key === 'extra').label, 'Сделано мимо плана');
  assert.deepStrictEqual(d.sections.find((s) => s.key === 'blockers').bullets, ['нет']);
  assert.strictEqual(d.sections.find((s) => s.key === 'notdone').bullets.length, 2);
  assert.ok(!d.sections.some((s) => s.key === 'next'), '«Дальше» только граница раздела, не тезисы');
});

test('статус до первого заголовка: строка «**Сделано полностью.**» заголовком не считается', () => {
  const d = parseDid('**Сделано полностью.**\n\n## СДЕЛАНО\n- Раз\n- Два\n\n## БЛОКЕРЫ\nнет\n');
  assert.strictEqual(d.structured, true);
  assert.strictEqual(d.status, 'Сделано полностью.');
  assert.deepStrictEqual(d.sections.find((s) => s.key === 'done').bullets, ['Раз', 'Два']);
});

test('заголовки с двоеточием и текстом в той же строке, разные регистры и «НУЖНО ТВОЁ РЕШЕНИЕ»', () => {
  const d = parseDid('Статус: готово, тесты зелёные\n\n**Сделано:** правки в двух файлах\n\nНУЖНО ТВОЁ РЕШЕНИЕ\n- Выбрать вариант А или Б\n');
  assert.strictEqual(d.structured, true);
  assert.strictEqual(d.status, 'готово, тесты зелёные');
  assert.deepStrictEqual(d.sections.map((s) => [s.key, s.bullets[0]]), [['done', 'правки в двух файлах'], ['decision', 'Выбрать вариант А или Б']]);
});

test('длинная строка «**СТАТУС:** …» (живой образец): заголовок найден, статус без метки', () => {
  const long = 'картинки: причина найдена и починена; видео: превью объявления играет в окне креатива на реальной фикстуре. Что у клиента стоит блокировщик рекламы, я не подтвердил.';
  const d = parseDid(`**СТАТУС:** ${long}\n\n**Диагноз.** Текст диагноза.\n\n## СДЕЛАНО\n- Раз\n\n## НЕ СДЕЛАНО\n- Два\n`);
  assert.strictEqual(d.structured, true);
  assert.strictEqual(d.status, long);
  assert.deepStrictEqual(d.sections.map((s) => s.key), ['done', 'notdone']);
});

test('отчёт GLM в блоке кода: заголовки СТАТУС, ИЗМЕНЕНЫ ФАЙЛЫ, ПРОВЕРКА, ВОПРОСЫ И РИСКИ, строка = пункт', () => {
  const t = '```\nСТАТУС: готово\nИЗМЕНЕНЫ ФАЙЛЫ:\n  public/style.css — тёмная тема старых блоков\n  public/app.js — новые тексты ru и kk\nПРОВЕРКА: make build-dashboard → сборка прошла\nВОПРОСЫ И РИСКИ: нет\n```';
  const d = parseDid(t);
  assert.strictEqual(d.structured, true);
  assert.strictEqual(d.status, 'готово');
  assert.deepStrictEqual(d.sections.map((s) => s.key), ['files', 'verify', 'risks']);
  assert.deepStrictEqual(d.sections[0].bullets, ['public/style.css — тёмная тема старых блоков', 'public/app.js — новые тексты ru и kk']);
  assert.deepStrictEqual(d.sections[2].bullets, ['нет']);
});

test('блок отчёта после вступления: вступление остаётся статусом, обычные блоки кода не трогаются', () => {
  const d = parseDid('Работа завершена, проверки зелёные. Отчёт:\n```\nСТАТУС: готово\nВОПРОСЫ И РИСКИ: нет\n```');
  assert.strictEqual(d.structured, true);
  const plain = parseDid('Вот пример:\n```js\nconst a = 1;\n```\nГотово.');
  assert.strictEqual(plain.structured, false);
});

test('таблица с 4 столбцами: короткий номер склеивается со второй ячейкой, доказательство берётся из «Файл»', () => {
  const t = '## СДЕЛАНО\n| № | Правка | Файлы | Готово |\n|---|---|---|---|\n| R-01 | Копить правки в acc | lib/acc.js | да |\n| R-02 | Вердикты проверок | lib/checks.js | да |\n\n## НЕ СДЕЛАНО\nнет\n';
  const d = parseDid(t);
  assert.deepStrictEqual(d.sections[0].bullets, ['R-01 Копить правки в acc · lib/acc.js', 'R-02 Вердикты проверок · lib/checks.js']);
});

test('больше пяти пунктов: пять тезисов, остальное счётчиком; длинный тезис режется до 160 знаков', () => {
  const items = Array.from({ length: 8 }, (_, i) => `- Пункт ${i + 1} ${'слово '.repeat(i === 0 ? 60 : 1)}`).join('\n');
  const d = parseDid('## СДЕЛАНО\n' + items + '\n\n## БЛОКЕРЫ\nнет\n');
  const done = d.sections[0];
  assert.strictEqual(done.bullets.length, 5);
  assert.strictEqual(done.more, 3);
  assert.ok(done.bullets[0].length <= 160 && done.bullets[0].endsWith('…'));
});

test('порог «структурный»: два разных заголовка да, один нет', () => {
  assert.strictEqual(parseDid('## СДЕЛАНО\n- Раз\n\n## БЛОКЕРЫ\nнет\n').structured, true);
  const one = parseDid('Починил сборку.\n\n## СДЕЛАНО\n- Раз\n- Два\n');
  assert.strictEqual(one.structured, false);
  assert.strictEqual(one.fallback, true);
  assert.strictEqual(one.status, 'Починил сборку.');
  assert.deepStrictEqual(one.sections[0].bullets, ['Раз', 'Два'].map((x) => x), 'запасной вариант берёт пункты списка');
});

test('свободный текст без разметки: первый абзац, потом пункты списка', () => {
  const d = parseDid('Я починил фильтр по филиалам и прогнал тесты, все зелёные.\n\nЧто поменял:\n- lib/filter.ts: учёт пустого списка\n- test/filter.test.ts: три новых кейса\n* README: пример\n');
  assert.strictEqual(d.structured, false);
  assert.strictEqual(d.fallback, true);
  assert.strictEqual(d.status, 'Я починил фильтр по филиалам и прогнал тесты, все зелёные.');
  assert.deepStrictEqual(d.sections[0].bullets, ['lib/filter.ts: учёт пустого списка', 'test/filter.test.ts: три новых кейса', 'README: пример']);
});

test('свободный текст без списка: первые три предложения после первого абзаца', () => {
  const d = parseDid('Готово.\n\nСначала я прочитал код. Потом поправил одну функцию. Затем прогнал тесты. Потом написал отчёт.');
  assert.strictEqual(d.status, 'Готово.');
  assert.deepStrictEqual(d.sections[0].bullets, ['Сначала я прочитал код.', 'Потом поправил одну функцию.', 'Затем прогнал тесты.']);
});

test('пустой и однострочный текст не падают', () => {
  assert.deepStrictEqual(parseDid(''), { structured: false, fallback: true, status: null, sections: [] });
  const one = parseDid('Готово, всё работает как надо.');
  assert.strictEqual(one.status, 'Готово, всё работает как надо.');
  assert.deepStrictEqual(one.sections, []);
});

test('заголовок внутри блока кода не считается заголовком', () => {
  const d = parseDid('Вот пример отчёта:\n```\n## СДЕЛАНО\n- x\n## БЛОКЕРЫ\nнет\n```\nВсё.');
  assert.strictEqual(d.structured, false);
});

/* ---------- чтение файла: голова и хвост ---------- */

const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);
const A = (n, blocks) => assistant(T0 + n * 1000, blocks, { rec: { cwd: '/work/demo' } });

function withFile(recs, fn) {
  const dir = tmpDir('agent-console-report-');
  const file = path.join(dir, 's.jsonl');
  writeJsonl(file, recs);
  const f = { path: file, size: fs.statSync(file).size };
  return Promise.resolve(fn(f)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('задача: описание плюс первые три непустые строки промпта, системные блоки убраны', () =>
  withFile(
    [
      user(T0, '<system-reminder>служебное</system-reminder>', { cwd: '/work/demo', isMeta: true }),
      user(T0 + 1, 'ЦЕЛЬ: сделать тёмную тему\n\nКОНТЕКСТ: файлы lib/a.js и lib/b.js\n<system-reminder>скрыть</system-reminder>\nМОЖНО МЕНЯТЬ: только public/style.css\nНЕЛЬЗЯ: трогать сервер\nГОТОВО, КОГДА: тесты зелёные', { cwd: '/work/demo' }),
      A(2, [text('ок')]),
    ],
    async (f) => {
      const t = await readTask(f, 'GLM · тёмная тема');
      assert.strictEqual(t.description, 'GLM · тёмная тема');
      assert.strictEqual(t.preview, 'ЦЕЛЬ: сделать тёмную тему\nКОНТЕКСТ: файлы lib/a.js и lib/b.js\nМОЖНО МЕНЯТЬ: только public/style.css');
      assert.ok(t.text.includes('ГОТОВО, КОГДА') && !t.text.includes('скрыть'), 'полный текст без служебных блоков');
      assert.strictEqual(t.long, false);
    }
  ));

test('задача: первая запись длиннее головы файла (256 КБ): помечена как длинная', () =>
  withFile([user(T0, 'я'.repeat(200 * 1024), { cwd: '/work/demo' }), A(1, [text('ок')])], async (f) => {
    const t = await readTask(f, null);
    assert.strictEqual(t.long, true);
    assert.strictEqual(t.preview, '');
  }));

test('последнее сообщение: берётся последний ответ длиннее 40 знаков, короткие реплики пропускаются', () =>
  withFile(
    [
      user(T0, 'Сделай', { cwd: '/work/demo' }),
      A(1, [text('Первый длинный промежуточный комментарий о том, что я собираюсь сделать')]),
      A(2, [toolUse('b1', 'Bash', { command: 'ls' })]),
      toolResult(T0 + 3000, 'b1', 'файлы', false),
      A(4, [text('Итоговый отчёт: всё сделано, тесты проходят, правки в трёх файлах.')]),
      A(5, [text('ок')]),
    ],
    async (f) => {
      const r = await lastAssistantText(f, parseRecord);
      assert.strictEqual(r.text, 'Итоговый отчёт: всё сделано, тесты проходят, правки в трёх файлах.');
      assert.strictEqual(r.tooLarge, false);
    }
  ));

test('последнее сообщение: дальше 80 строк назад, второй проход находит отчёт', () => {
  const recs = [user(T0, 'Сделай', { cwd: '/work/demo' }), A(1, [text('Отчёт агента: готово, всё проверено и записано в файлы проекта.')])];
  for (let i = 0; i < 120; i++) recs.push(A(10 + i, [toolUse('t' + i, 'Read', { file_path: '/x' + i })]));
  return withFile(recs, async (f) => {
    const r = await lastAssistantText(f, parseRecord);
    assert.ok(r.text && r.text.startsWith('Отчёт агента'));
  });
});

test('последнее сообщение: слишком большая строка пропущена, отчёта нет, это видно отдельным признаком', () =>
  withFile([user(T0, 'Сделай', { cwd: '/work/demo' }), A(1, [text('я'.repeat(600 * 1024))])], async (f) => {
    const r = await lastAssistantText(f, parseRecord);
    assert.strictEqual(r.text, null);
    assert.strictEqual(r.tooLarge, true);
  }));

test('агент без текстовых ответов: отчёта нет, строка не слишком большая', () =>
  withFile([user(T0, 'Сделай', { cwd: '/work/demo' }), A(1, [toolUse('b1', 'Bash', { command: 'ls' })])], async (f) => {
    const r = await lastAssistantText(f, parseRecord);
    assert.deepStrictEqual(r, { text: null, tooLarge: false });
  }));

test('как выполнял и проверки: пути относительно cwd, пять самых правленых, красный потом зелёный', () => {
  const acc = {
    cwd: '/work/demo',
    files: Object.fromEntries([['/work/demo/lib/a.js', { edits: 6, writes: 0 }], ['/work/demo/lib/b.js', { edits: 2, writes: 1 }], ['/work/demo/test/a.js', { edits: 2, writes: 0 }], ...[1, 2, 3, 4].map((i) => [`/work/demo/f${i}.js`, { edits: 1, writes: 0 }])]),
    filesOver: false,
    cmds: ['npx vitest run', 'git diff --stat', 'npx vitest run', 'make deploy'],
    toolCounts: { Edit: 9, Bash: 4 },
    checks: [
      { cmd: 'npx vitest run', kind: 'tests', ok: false, summary: '5 failed, 357 passed' },
      { cmd: 'git diff --stat', kind: 'diff', ok: true, summary: '3 файла, +10, -2' },
      { cmd: 'npx vitest run', kind: 'tests', ok: true, summary: '362 passed' },
    ],
    pendingChecks: [{ id: 'x', cmd: 'npx tsc --noEmit', kind: 'types' }],
  };
  const how = howView(acc, acc.cwd);
  assert.strictEqual(how.filesTotal, 7);
  assert.strictEqual(how.files.length, 5);
  assert.deepStrictEqual(how.files.slice(0, 3).map((f) => [f.path, f.name, f.edits + f.writes]), [['lib/a.js', 'lib/a.js', 6], ['lib/b.js', 'b.js', 3], ['test/a.js', 'test/a.js', 2]], 'одинаковые имена a.js показаны с папкой');
  assert.deepStrictEqual(how.cmds, ['git diff --stat', 'npx vitest run', 'make deploy'], 'повторы схлопнуты, порядок по последнему вызову');
  const c = checksView(acc);
  assert.deepStrictEqual(c.map((x) => [x.kind, x.ok, x.summary, x.pending]), [['tests', true, '362 passed', false], ['types', null, null, true], ['diff', true, '3 файла, +10, -2', false]]);
  assert.deepStrictEqual(c[0].runs.map((r) => r.summary), ['5 failed, 357 passed', '362 passed']);
  assert.strictEqual(lastTests(acc), true);
  assert.strictEqual(lastTests({ checks: [{ kind: 'tests', ok: false }, { kind: 'types', ok: true }] }), false);
  assert.strictEqual(lastTests({ checks: [] }), null);
});

test('lib/report.js не читает транскрипт целиком (нет readFile)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'report.js'), 'utf8');
  assert.ok(!/readFile/.test(src));
  assert.ok(!/readFile/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'step.js'), 'utf8')));
});
