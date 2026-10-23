'use strict';

// Тесты по находкам ревью .review/glm-security.md: маскировка ответов API (№1),
// форматы секретов (№2), границы путей через realpath (№3), линейная чистка блоков (№4),
// заголовки безопасности (№6), межсайтовые запросы (№7), чтение файлов (№8, №10).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildWorld } = require('./helpers/world');
const { createApp } = require('../server');
const { redact, redactDeep, disabledWarning } = require('../lib/redact');
const { resolveWithin, resolveFileId, isSensitiveHomePath, homeTilde } = require('../lib/sources');
const { cleanBlocks } = require('../lib/sources/claudeLike');
const { newAcc } = require('../lib/acc');
const { user, writeJsonl, tmpDir } = require('./helpers/synth');

/* ---------- №2: форматы секретов ---------- */

const SECRET_LINE = [
  'ключ sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE123456',
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'AIzaSyA-1234567890abcdefghijklmnopqrstu',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9',
  '0123456789abcdef0123456789abcdef.abcDEF123_-xyz987',
].join(' ');

test('№2: AWS AKIA маскируется, значение после имени с SECRET маскируется', () => {
  const out = redact('ключ AKIAIOSFODNN7EXAMPLE и AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!out.includes('wJalrXUtnFEMI'));
  assert.ok(out.includes('AWS_SECRET_ACCESS_KEY=<REDACTED>'));
});

test('№2: Google AIza маскируется', () => {
  const out = redact('ключ AIzaSyA-1234567890abcdefghijklmnopqrstu в конфиге');
  assert.ok(!out.includes('AIzaSyA-1234567890abcdefghijklmnopqrstu'));
  assert.ok(out.includes('<REDACTED>'));
});

test('№2: JWT маскируется целиком', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9';
  const out = redact('Authorization2=Bearer2 ' + jwt + ' конец');
  assert.ok(!out.includes(jwt));
});

test('№2: PEM-блок приватного ключа маскируется целиком, обрезанный - до конца текста', () => {
  const pem = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABGxvbmVfaWQAAAAA',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');
  const out = redact('до ' + pem + ' после');
  assert.ok(!out.includes('b3BlbnNzaC1rZXktdjEAAAAABGxvbmVfaWQAAAAA'));
  assert.ok(out.startsWith('до <REDACTED> после'));
  const cut = redact('до\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA777\n');
  assert.ok(!cut.includes('MIIEpAIBAAKCAQEA777'));
  assert.ok(cut.startsWith('до\n<REDACTED>'));
  // много «BEGIN» без конца: не зависаем (линейный проход)
  const t0 = Date.now();
  redact('-----BEGIN\n'.repeat(20000));
  assert.ok(Date.now() - t0 < 500, 'PEM-поиск линеен');
});

test('№2: имена переменных с PASSWORD/SECRET/TOKEN/API_KEY/ACCESS_KEY маскируются', () => {
  const cases = [
    ['SECRET_KEY=abcd1234', 'abcd1234'],
    ['MY_TOKEN: qqq111zzz', 'qqq111zzz'],
    ['"apiKey": "0123456789"', '0123456789'],
    ['db_PASSWORD="p@ss"', 'p@ss'],
    ['ACCESS_KEY=zzz999yyy', 'zzz999yyy'],
  ];
  for (const [line, value] of cases) {
    const out = redact(line);
    assert.ok(!out.includes(value), line);
    assert.ok(out.includes('<REDACTED>'), line);
  }
});

test('№2: пароль в URL маскируется, обычные URL не трогаются', () => {
  const out = redact('строка postgres://user:pass123@db.internal/x и https://127.0.0.1:3939/api');
  assert.ok(!out.includes('pass123'));
  assert.ok(out.includes('postgres://user:<REDACTED>@db.internal/x'));
  assert.ok(out.includes('https://127.0.0.1:3939/api'));
});

test('№2: ключ Z.ai с - и _ в токенной части маскируется целиком', () => {
  const out = redact('токен 0123456789abcdef0123456789abcdef.abcDEF123_-xyz987 в файле');
  assert.ok(!out.includes('abcDEF123_-xyz987'));
  assert.ok(out.startsWith('токен ') && out.includes(' <REDACTED> в файле'));
});

test('№2: обычный текст не портится', () => {
  const cases = [
    'Открой файл src/app.js и исправь функцию parseLine на строке 42',
    'commit 0123456789abcdef0123456789abcdef01234567 (fix: тесты)',
    'сессия 11111111-1111-4111-8111-111111111111 в проекте /work/alpha',
    'версия 2.0.0, число 12345, дата 2026-10-22',
    'Правки в lib/acc.js и lib/checks.js, README обновлён',
  ];
  for (const t of cases) assert.strictEqual(redact(t), t, t);
});

test('№2: маскировка идемпотентна (повтор на замаскированном ничего не меняет)', () => {
  const once = redactDeep({ text: SECRET_LINE, nested: { command: 'x AWS_SECRET_ACCESS_KEY=abcd1234' }, n: 3 });
  const twice = redactDeep(JSON.parse(JSON.stringify(once)));
  assert.deepStrictEqual(twice, once);
});

test('№2: маскировка линейна - 512 КБ обычного текста быстрее 300 мс', () => {
  for (const s of ['y'.repeat(512 * 1024), 'y'.repeat(500000) + 'token=abc', 'token '.repeat(85000), Array.from({ length: 30000 }, (_, i) => 's' + i + '://a').join(' ')]) {
    const t0 = Date.now();
    redact(s);
    const ms = Date.now() - t0;
    assert.ok(ms < 300, 'redact занял ' + ms + ' мс на строке ' + s.length + ' символов');
  }
});

test('№2/№9: предупреждение при REDACT=0, одна строка', () => {
  const w = disabledWarning({ REDACT: '0' });
  assert.ok(typeof w === 'string' && w.split('\n').length === 1 && /REDACT=0/.test(w));
  assert.strictEqual(disabledWarning({}), null);
});

/* ---------- №3: границы путей через realpath ---------- */

test('№3: resolveWithin раскрывает симлинки: ссылка наружу корня - null, обычный файл - путь', () => {
  const root = tmpDir('agent-console-realpath-');
  try {
    const inside = path.join(root, 'real.md');
    const outsideDir = tmpDir('agent-console-outside-');
    const outside = path.join(outsideDir, 'secret.md');
    fs.writeFileSync(inside, 'ok');
    fs.writeFileSync(outside, 'секрет');
    fs.symlinkSync(outside, path.join(root, 'link.md'));

    assert.strictEqual(resolveWithin(root, path.join(root, 'real.md')), fs.realpathSync(inside));
    assert.strictEqual(resolveWithin(root, path.join(root, 'link.md')), null, 'симлинк наружу корня отклонён');
    assert.strictEqual(resolveWithin(root, path.join(root, 'missing.md')), null, 'несуществующий путь - null');
    assert.strictEqual(resolveWithin(root, path.join(root, '..', 'outside-should-fail.md')), null, 'выход за корень отклонён');
    fs.rmSync(outsideDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('№3: resolveFileId отклоняет *.jsonl-симлинк на файл вне корня источника', () => {
  const root = tmpDir('agent-console-fileid-');
  try {
    const outsideDir = tmpDir('agent-console-outside-');
    const outside = path.join(outsideDir, 'creds.jsonl');
    fs.writeFileSync(outside, '{}\n');
    fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
    fs.writeFileSync(path.join(root, 'proj', 'ok.jsonl'), '{}\n');
    fs.symlinkSync(outside, path.join(root, 'proj', 'evil.jsonl'));

    const adapters = [{ id: 't', root }];
    assert.strictEqual(resolveFileId(adapters, 't:proj/evil.jsonl'), null, 'симлинк наружу - null');
    const ok = resolveFileId(adapters, 't:proj/ok.jsonl');
    assert.ok(ok && ok.abs.endsWith('ok.jsonl'));
    fs.rmSync(outsideDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- №4: линейная чистка служебных блоков ---------- */

test('№4: 1 МБ незакрытых <system-reminder> чистится быстрее 100 мс', () => {
  const evil = '<system-reminder>'.repeat(65000);
  const t0 = process.hrtime.bigint();
  const out = cleanBlocks(evil);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 100, 'cleanBlocks занял ' + ms.toFixed(1) + ' мс');
  assert.ok(!out.includes('<system-reminder>'), 'теги убраны, содержимое сохранено');
});

test('№4: закрытый блок удаляется целиком, незакрытый - только тег, прочие теги чистятся', () => {
  assert.strictEqual(cleanBlocks('до <system-reminder>служебное</system-reminder> после'), 'до   после');
  assert.strictEqual(cleanBlocks('<command-name>/slot</command-name>текст'), ' текст');
  const unclosed = cleanBlocks('задача <system-reminder>хвост без закрытия');
  assert.ok(unclosed.includes('задача') && unclosed.includes('хвост без закрытия'));
  assert.ok(!unclosed.includes('<system-reminder>'));
  assert.strictEqual(cleanBlocks('нет тегов вообще'), 'нет тегов вообще');
  assert.strictEqual(cleanBlocks('обрыв <system-remi'), 'обрыв <system-remi', 'незакрытая скобка не ломает');
});

test('№4: notePrompt разбирает первые 8 КБ записи, смещения - от исходной строки', () => {
  const { scanRecord } = require('../lib/sources/claudeLike');
  const acc = newAcc({ path: '/tmp/x.jsonl' });
  acc.indexedBytes = 123456; // индексатор выставляет до разбора: это конец строки записи
  const pad = 'слово '.repeat(4000); // ~24 КБ: заголовок в первых 8 КБ, секрет - за границей
  const rec = user(0, 'ЦЕЛЬ: починить фильтр\n\n' + pad + '\nСЕКРЕТ: token=abcd1234abcd');
  scanRecord(rec, acc);
  assert.strictEqual(acc.lastGoal.title, 'ЦЕЛЬ: починить фильтр');
  assert.strictEqual(acc.lastUserEnd, 123456, 'смещение - конец исходной строки, не границы разбора');
  assert.ok(!JSON.stringify(acc.prompts).includes('abcd1234'), 'хвост записи за 8 КБ в заголовки не попадает');
});

/* ---------- API: маскировка ответов, заголовки, Origin, лимит ---------- */

function request(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: Object.assign({ Host: '127.0.0.1:' + port }, headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Лента-поток никогда не заканчивается: ждём первый батч событий (или таймаут) и рвём соединение.
function streamPeek(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { Host: '127.0.0.1:' + port } }, (res) => {
      let text = '';
      const finish = () => {
        clearTimeout(timer);
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, text });
      };
      const timer = setTimeout(finish, 2000);
      res.on('data', (c) => {
        text += c.toString('utf8');
        if (text.includes('event: batch')) finish();
      });
      res.on('error', () => {});
      req.on('error', () => {});
    });
    req.on('error', reject);
    req.end();
  });
}

// Секретная сессия: всё из ТЗ - в первой строке запроса, в результате инструмента и в ТЗ через $(cat).
const SECRETS = [
  'sk-ant-api03-FAKE0000FAKE0000FAKE0000FAKE0000-123456',
  'AKIAIOSFODNN7EXAMPLE',
  'AIzaSyA-1234567890abcdefghijklmnopqrstu',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
];

function addSecretSession(w, catFile) {
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  // t0+1ч+: сессия «недавно закончила» (окно recent 2 часа до now = t0+3ч), попадает в /api/now
  const at = (s) => w.t0 + (3600 + s) * 1000;
  const cwd = { cwd: '/work/alpha' };
  const catPart = catFile ? ' "$(cat ' + catFile + ')"' : '';
  writeJsonl(path.join(w.env.CLAUDE_PROJECTS_DIR, '-work-alpha', id + '.jsonl'), [
    user(at(10), 'Проверь доступ: ' + SECRETS.join(', ') + '\nГОТОВО, КОГДА: тесты зелёные', cwd),
    { type: 'assistant', message: { id: 'msg_s1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'claude-glm -p' + catPart + ' --output-format json' } }], usage: { input_tokens: 2, output_tokens: 4 } }, uuid: 's1', timestamp: new Date(at(11)).toISOString(), ...cwd },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: false, content: [{ type: 'text', text: 'вывод: ' + SECRETS.join(' ') }] }] }, uuid: 's2', timestamp: new Date(at(12)).toISOString(), ...cwd },
  ]);
  fs.utimesSync(path.join(w.env.CLAUDE_PROJECTS_DIR, '-work-alpha', id + '.jsonl'), new Date(at(20)), new Date(at(20)));
  return 'claude:-work-alpha/' + id + '.jsonl';
}

const FILE_ID = 'claude:-work-alpha/11111111-1111-4111-8111-111111111111.jsonl';

async function withApp(envExtra, fn) {
  const w = buildWorld();
  const app = await createApp({ env: Object.assign({}, process.env, w.env, envExtra), now: () => w.now });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  try {
    await fn({ port, w, app });
  } finally {
    await new Promise((r) => app.server.close(r));
    w.cleanup();
  }
}

test('№1: ни один эндпоинт не отдаёт секреты открытым текстом', () =>
  withApp({}, async ({ port, w, app }) => {
    const id = addSecretSession(w);
    await app.registry.projectView('/work/alpha', { wait: true });
    const endpoints = [
      '/api/now',
      '/api/projects',
      '/api/cross',
      '/api/project?key=' + encodeURIComponent('/work/alpha'),
      '/api/map?id=' + encodeURIComponent(FILE_ID),
      '/api/session?id=' + encodeURIComponent(id),
      '/api/report?id=' + encodeURIComponent(id),
      '/api/health',
    ];
    for (const ep of endpoints) {
      const r = await request(port, ep);
      assert.strictEqual(r.status, 200, ep);
      for (const s of SECRETS) assert.ok(!r.text.includes(s), ep + ' отдал секрет ' + s.slice(0, 20));
    }
    const now = await request(port, '/api/now');
    assert.ok(now.text.includes('<REDACTED>'), 'заголовок задачи замаскирован в /api/now');
  }));

test('№1: /api/stream не отдаёт секреты', () =>
  withApp({}, async ({ port, w }) => {
    const id = addSecretSession(w);
    const r = await streamPeek(port, '/api/stream?id=' + encodeURIComponent(id) + '&offset=0');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('event: batch'), 'лента прислала события');
    for (const s of SECRETS) assert.ok(!r.text.includes(s), 'поток отдал секрет ' + s.slice(0, 20));
  }));

test('№6: заголовки безопасности на JSON, HTML и потоке', () =>
  withApp({}, async ({ port }) => {
    const api = await request(port, '/api/projects');
    assert.strictEqual(api.headers['x-frame-options'], 'DENY');
    assert.strictEqual(api.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(api.headers['referrer-policy'], 'no-referrer');
    const page = await request(port, '/');
    assert.strictEqual(page.headers['x-frame-options'], 'DENY');
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    const r = await streamPeek(port, '/api/stream?id=' + encodeURIComponent(FILE_ID) + '&offset=0');
    assert.strictEqual(r.headers['x-frame-options'], 'DENY');
  }));

test('№7: чужой Origin и cross-site отклонены, свой Origin и запрос без заголовков работают', () =>
  withApp({}, async ({ port }) => {
    const evil = await request(port, '/api/projects', { Origin: 'https://evil.example' });
    assert.strictEqual(evil.status, 403);
    const cross = await request(port, '/api/projects', { 'Sec-Fetch-Site': 'cross-site' });
    assert.strictEqual(cross.status, 403);
    const own = await request(port, '/api/projects', { Origin: 'http://127.0.0.1:' + port });
    assert.strictEqual(own.status, 200);
    const localhost = await request(port, '/api/projects', { Origin: 'http://localhost:' + port, Host: 'localhost:' + port });
    assert.strictEqual(localhost.status, 200);
    const plain = await request(port, '/api/projects');
    assert.strictEqual(plain.status, 200);
  }));

test('№7: limit сверх MAX_LIMIT обрезан до 500', () =>
  withApp({}, async ({ port, w }) => {
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const at = (s) => w.t0 + s * 1000;
    const cwd = { cwd: '/work/alpha' };
    writeJsonl(
      path.join(w.env.CLAUDE_PROJECTS_DIR, '-work-alpha', id + '.jsonl'),
      Array.from({ length: 501 }, (_, i) => user(at(i), 'запрос ' + i, cwd))
    );
    fs.utimesSync(path.join(w.env.CLAUDE_PROJECTS_DIR, '-work-alpha', id + '.jsonl'), new Date(at(600)), new Date(at(600)));
    const feed = await request(port, '/api/session?id=' + encodeURIComponent('claude:-work-alpha/' + id + '.jsonl') + '&limit=1000');
    assert.strictEqual(feed.status, 200);
    assert.ok(feed.json.events.length <= 500, 'событий: ' + feed.json.events.length);
  }));

/* ---------- №8/№10: /api/file и $(cat) ---------- */

test('№8/№10: /api/file - маскирование, потолок 512 КБ по дескриптору, защищённая папка', () =>
  withApp({}, async ({ port }) => {
    // временная папка в домашней: /api/file читает только внутри home
    const home = os.homedir();
    const tmp = fs.mkdtempSync(path.join(home, 'agents-os-test-'));
    try {
      const secret = path.join(tmp, 'tz.md');
      fs.writeFileSync(secret, 'ТЗ с ключом ' + SECRET_LINE + '\n');
      const r = await request(port, '/api/file?path=' + encodeURIComponent(secret));
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.includes('<REDACTED>'));
      for (const s of SECRETS) assert.ok(!r.text.includes(s), 'api/file отдал секрет');

      const big = path.join(tmp, 'big.md');
      fs.writeFileSync(big, 'x'.repeat(512 * 1024 + 1));
      const tooBig = await request(port, '/api/file?path=' + encodeURIComponent(big));
      assert.strictEqual(tooBig.status, 413);

      const exact = path.join(tmp, 'exact.md');
      fs.writeFileSync(exact, 'y'.repeat(512 * 1024));
      const okBig = await request(port, '/api/file?path=' + encodeURIComponent(exact));
      assert.strictEqual(okBig.status, 200, 'файл ровно 512 КБ читается');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    if (fs.existsSync(path.join(home, '.config'))) {
      const cfgTmp = path.join(home, '.config', 'agents-os-test-' + process.pid);
      fs.mkdirSync(cfgTmp, { recursive: true });
      try {
        fs.writeFileSync(path.join(cfgTmp, 'note.md'), 'заметка');
        const denied = await request(port, '/api/file?path=' + encodeURIComponent(path.join(cfgTmp, 'note.md')));
        assert.strictEqual(denied.status, 403, 'файл в ~/.config не читается');
      } finally {
        fs.rmSync(cfgTmp, { recursive: true, force: true });
      }
    }
    // несуществующий путь в несуществующей защищённой папке: без чтения диска
    const noSsh = await request(port, '/api/file?path=' + encodeURIComponent(path.join(home, '.ssh', 'agents-os-nope.md')));
    assert.ok([400, 403].includes(noSsh.status), '~/.ssh не читается: ' + noSsh.status);
  }));

test('№10: $(cat) - путь как ~/…, маскирование, отказ для защищённой папки', () =>
  withApp({}, async ({ port, w }) => {
    const home = os.homedir();
    const tmp = fs.mkdtempSync(path.join(home, 'agents-os-test-'));
    try {
      const tz = path.join(tmp, 'tz-secret.md');
      fs.writeFileSync(tz, 'ТЗ: сделать с ключом ' + SECRETS[0] + '\n');
      const id = addSecretSession(w, tz);
      const feed = await request(port, '/api/session?id=' + encodeURIComponent(id));
      assert.strictEqual(feed.status, 200);
      const cat = feed.json.events.find((e) => e.input && e.input.__cat);
      assert.ok(cat, 'событие с $(cat) аннотировано');
      assert.ok(cat.input.__cat.path.startsWith('~/'), 'путь показан как ~/…: ' + cat.input.__cat.path);
      assert.ok(!cat.input.__cat.path.includes(tmp), 'полный путь не отдаётся');
      assert.ok(cat.input.__cat.content.includes('<REDACTED>'));
      assert.ok(!cat.input.__cat.content.includes('FAKE0000'));

      const cfgTmp = path.join(home, '.config', 'agents-os-test-' + process.pid);
      const usesConfig = fs.existsSync(path.join(home, '.config'));
      if (usesConfig) {
        fs.mkdirSync(cfgTmp, { recursive: true });
        try {
          fs.writeFileSync(path.join(cfgTmp, 'note.md'), 'заметка');
          fs.utimesSync(path.join(w.env.CLAUDE_PROJECTS_DIR, '-work-alpha', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl'), new Date(w.t0 + 25000), new Date(w.t0 + 25000));
          const id2 = addSecretSession(w, path.join(cfgTmp, 'note.md'));
          const feed2 = await request(port, '/api/session?id=' + encodeURIComponent(id2));
          const cat2 = feed2.json.events.find((e) => e.input && e.input.__cat);
          assert.match(cat2.input.__cat.error, /защищённой папке/);
          assert.strictEqual(cat2.input.__cat.content, undefined);
        } finally {
          fs.rmSync(cfgTmp, { recursive: true, force: true });
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }));

test('№10: isSensitiveHomePath и homeTilde на чистых путях', () => {
  const home = '/home/demo';
  assert.strictEqual(isSensitiveHomePath('/home/demo/.ssh/id_rsa.md', home), true);
  assert.strictEqual(isSensitiveHomePath('/home/demo/.aws/notes.txt', home), true);
  assert.strictEqual(isSensitiveHomePath('/home/demo/.gnupg/x.md', home), true);
  assert.strictEqual(isSensitiveHomePath('/home/demo/.config/app/a.md', home), true);
  assert.strictEqual(isSensitiveHomePath('/home/demo/.claude/заметка.md', home), true);
  assert.strictEqual(isSensitiveHomePath('/home/demo/Library/Keychains/x.md', home), true);
  assert.strictEqual(isSensitiveHomePath('/home/demo/notes/todo.md', home), false);
  assert.strictEqual(isSensitiveHomePath('/home/demo/projects/.config/a.md', home), false, 'глубже первого уровня - не защищённая');
  assert.strictEqual(isSensitiveHomePath('/etc/hosts', home), true, 'вне домашней - отказываем');
  assert.strictEqual(homeTilde('/etc/hosts'), '/etc/hosts', 'путь вне домашней остаётся как есть');
});

test('REDACT=0: маскировка выключена целиком (задокументированный режим)', async () => {
  const prev = process.env.REDACT;
  process.env.REDACT = '0'; // isEnabled() читает process.env
  try {
    await withApp({}, async ({ port, w }) => {
      const id = addSecretSession(w);
      const feed = await request(port, '/api/session?id=' + encodeURIComponent(id));
      assert.ok(feed.text.includes(SECRETS[0]), 'при REDACT=0 текст идёт как есть');
    });
  } finally {
    if (prev === undefined) delete process.env.REDACT;
    else process.env.REDACT = prev;
  }
});
