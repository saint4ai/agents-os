'use strict';

// Маскировка секретов в тексте. Применяется на сервере до отдачи в браузер.
// Повторный вызов на уже замаскированном тексте ничего не меняет (идемпотентен).

// [ключ, на что заменить]
const PATTERNS = [
  // ключи вида <32 hex>.<12+ алфанумерных, включая - и _> (ключ Z.ai)
  [/[0-9a-f]{32}\.[A-Za-z0-9_-]{12,}/g, '<REDACTED>'],
  // OpenAI-подобные ключи
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '<REDACTED>'],
  // GitHub personal access tokens
  [/\bghp_[A-Za-z0-9]{8,}/g, '<REDACTED>'],
  // Slack tokens (префикс оставляем для читаемости)
  [/\bxox[bp]-[A-Za-z0-9-]{8,}/g, (m) => m.slice(0, 5) + '<REDACTED>'],
  // AWS access key id
  [/\bAKIA[0-9A-Z]{16}\b/g, '<REDACTED>'],
  // Google API key
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '<REDACTED>'],
  // JWT: три сегмента base64url
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<REDACTED>'],
  // Authorization: Bearer <...> (регистр слова сохраняем)
  [/\bBearer\s+\S+/gi, (m) => m.replace(/\S+$/, '<REDACTED>')],
  // пароль в URL: scheme://user:pass@ → pass маскируем, схему и пользователя оставляем.
  // Схема ограничена {0,20}: без потолка жадный префикс на длинных строках деградирует квадратично.
  [/\b[A-Za-z][A-Za-z0-9+.-]{0,20}:\/\/[^\s/:@]+:[^\s/@]+@/g, (m) => m.replace(/:[^:@]+@$/, ':<REDACTED>@')],
];

// Имена полей, значения которых маскируем целиком в redactDeep.
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key)/i;

const KEYWORD = /(password|passwd|secret|token|api[_-]?key|access[_-]?key)/gi;
const NAME_CHAR = /[A-Za-z0-9_-]/;
const VALUE_END = /[\s"',;]/;
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

// password=..., "token": "...", AWS_SECRET_ACCESS_KEY=... и т.п.: имя переменной или поля,
// содержащее чувствительное слово, в любом регистре и обрамлении. Регуляркой с жадным
// префиксом [A-Za-z0-9_-]* это делать нельзя: на длинной строке без ключевых слов откат
// деградирует квадратично. Здесь линейный проход: ключевые слова ищет /g-регулярка без
// переменных частей, границы имени и разделителя достраиваются посимвольно.
function redactKeyValue(text) {
  const kw = new RegExp(KEYWORD.source, 'gi');
  let out = '';
  let copied = 0; // сколько исходного текста уже ушло в out
  let m;
  while ((m = kw.exec(text))) {
    let nameStart = m.index;
    while (nameStart > copied && NAME_CHAR.test(text[nameStart - 1])) nameStart--;
    let p = m.index + m[0].length;
    while (p < text.length && NAME_CHAR.test(text[p])) p++; // ключевое слово может быть частью имени: SECRET_KEY=
    while (p < text.length && isSpace(text[p])) p++;
    if (p < text.length && (text[p] === '"' || text[p] === "'")) p++;
    while (p < text.length && isSpace(text[p])) p++;
    if (p >= text.length || (text[p] !== ':' && text[p] !== '=')) continue;
    let q = p + 1;
    while (q < text.length && isSpace(text[q])) q++;
    if (q < text.length && (text[q] === '"' || text[q] === "'")) q++;
    let v = q;
    while (v < text.length && !VALUE_END.test(text[v])) v++;
    if (v === q) continue; // значение пустое - маскировать нечего
    out += text.slice(copied, q) + '<REDACTED>';
    copied = v;
    kw.lastIndex = v;
  }
  return out + text.slice(copied);
}

// PEM-блок приватного ключа целиком. Ищется проходом по indexOf, а не регуляркой с [\s\S]*?:
// на строке из десятков тысяч «-----BEGIN» без конца ленивая регулярка деградирует квадратично.
const PEM_BEGIN = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\s*$/;

function redactPem(text) {
  let out = text;
  let from = 0;
  for (;;) {
    const begin = out.indexOf('-----BEGIN', from);
    if (begin === -1) break;
    const nl = out.indexOf('\n', begin);
    const head = (nl === -1 ? out.slice(begin) : out.slice(begin, nl)).trim();
    if (!PEM_BEGIN.test(head)) {
      from = begin + 10;
      continue;
    }
    const endMarker = head.replace('BEGIN', 'END');
    const end = out.indexOf(endMarker, nl === -1 ? begin : nl);
    if (end === -1) {
      // закрывающей строки нет (обрезан вывод): маскируем всё от BEGIN до конца
      out = out.slice(0, begin) + '<REDACTED>';
      break;
    }
    out = out.slice(0, begin) + '<REDACTED>' + out.slice(end + endMarker.length);
    from = begin + 10;
  }
  return out;
}

function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = redactPem(text);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return redactKeyValue(out);
}

// Рекурсивная маскировка всех строк внутри объекта/массива (для input инструментов).
// Значение поля с чувствительным именем (token, secret, password, api_key) маскируется целиком.
function redactDeep(value, key) {
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEY.test(key)) return '<REDACTED>';
    return redact(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, k);
    return out;
  }
  return value;
}

// Включена по умолчанию, выключается REDACT=0.
function isEnabled(env) {
  return (env || process.env).REDACT !== '0';
}

// Предупреждение при старте без маскировки: одна строка в лог или null.
function disabledWarning(env) {
  return (env || process.env).REDACT === '0'
    ? 'ВНИМАНИЕ: REDACT=0 — маскирование секретов отключено, ключи из транскриптов уходят в браузер открытым текстом.'
    : null;
}

module.exports = { redact, redactDeep, isEnabled, disabledWarning };
