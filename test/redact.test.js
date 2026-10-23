'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { redact, redactDeep, isEnabled } = require('../lib/redact');

test('ключ вида <32 hex>.<12+ алфанумерных> маскируется', () => {
  const out = redact('токен 0123456789abcdef0123456789abcdef.ABCDEFGHIJKL в тексте');
  assert.ok(!out.includes('0123456789abcdef0123456789abcdef.ABCDEFGHIJKL'));
  assert.ok(out.includes('<REDACTED>'));
  assert.ok(out.startsWith('токен ') && out.endsWith(' в тексте'));
});

test('sk-ключ маскируется', () => {
  assert.strictEqual(redact('key: sk-aBcDeFgH12345678'), 'key: <REDACTED>');
});

test('ghp-токен маскируется', () => {
  assert.strictEqual(redact('push с ghp_0123456789abcdefghijklmnop'), 'push с <REDACTED>');
});

test('xoxb/xoxp маскируются', () => {
  assert.strictEqual(redact('xoxb-123456789012-abcdef'), 'xoxb-<REDACTED>');
  assert.ok(!redact('xoxp-abcd1234-abcd1234').includes('abcd1234-abcd1234'));
});

test('Bearer маскируется вместе со значением', () => {
  assert.strictEqual(redact('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer <REDACTED>');
  assert.strictEqual(redact('bearer XYZ'), 'bearer <REDACTED>');
});

test('значения после password/token/secret/api-key маскируются', () => {
  assert.strictEqual(redact('password=hunter2'), 'password=<REDACTED>');
  assert.strictEqual(redact('"api_key": "0123456789abcdef"'), '"api_key": "<REDACTED>"');
  assert.strictEqual(redact("'secret': 'zzz'"), "'secret': '<REDACTED>'");
  assert.ok(!redact('TOKEN: qqq111').includes('qqq111'));
  assert.ok(!redact('my-password: p@ss w0rd!').includes('p@ss'));
});

test('обычный текст не трогается', () => {
  const t = 'Открой файл src/app.js и исправь функцию parseLine на строке 42';
  assert.strictEqual(redact(t), t);
});

test('пустое и не-строчное не ломается', () => {
  assert.strictEqual(redact(''), '');
  assert.strictEqual(redact(null), null);
  assert.strictEqual(redact(undefined), undefined);
});

test('redactDeep чистит вложенные строки в объекте', () => {
  const input = {
    command: 'curl -H "Authorization: Bearer abc.def"',
    nested: { token: 'topsecret123', list: ['ghp_0123456789abcdefghij', 'чисто'] },
    count: 3,
  };
  const out = redactDeep(input);
  assert.ok(!JSON.stringify(out).includes('topsecret123'));
  assert.ok(!JSON.stringify(out).includes('0123456789abcdefghij'));
  assert.strictEqual(out.nested.list[1], 'чисто');
  assert.strictEqual(out.count, 3);
  // исходник не изменён
  assert.strictEqual(input.nested.token, 'topsecret123');
});

test('REDACT=0 выключает маскировку', () => {
  assert.strictEqual(isEnabled({ REDACT: '0' }), false);
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ REDACT: '1' }), true);
});
