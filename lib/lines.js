'use strict';

// Безопасное чтение больших транскриптов. Файл целиком в память не попадает НИКОГДА.
// Здесь живут все примитивы чтения .jsonl:
//   readHead        - первые N байт (по умолчанию 256 КБ);
//   readLines       - потоковое построчное чтение (createReadStream), строки длиннее потолка пропускаются;
//   readBackLines   - чтение полных строк с конца кусками;
//   readForward     - дочитывание новых байт по смещению (не больше окна за раз).
// Остальной код читает транскрипты только через этот модуль.

const fs = require('fs');

const MAX_LINE = 1024 * 1024; // потолок длины строки: длиннее - пропускаем
const HEAD_BYTES = 256 * 1024; // голова файла для заголовка и cwd
const STREAM_CHUNK = 256 * 1024; // размер куска потокового чтения
const BACK_CHUNK = 256 * 1024; // размер куска чтения с конца
const FORWARD_WINDOW = 2 * 1024 * 1024; // сколько максимум дочитываем за один вызов

const NL = 10;

// Первые maxBytes байт файла как строка (последняя строка может быть обрезана - вызывающий это знает).
async function readHead(filePath, maxBytes) {
  const n = maxBytes || HEAD_BYTES;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

// Последние maxBytes байт файла без обрезанной первой строки: когда в голове файла нужного нет
// (например, первое сообщение с картинкой на сотни КБ). Строки тоже режутся по потолку.
async function readTailText(filePath, maxBytes) {
  const n = maxBytes || HEAD_BYTES;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const st = await fh.stat();
    const len = Math.min(n, st.size);
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, st.size - len);
    let b = buf.subarray(0, bytesRead);
    if (st.size > len) {
      const nl = b.indexOf(NL);
      b = nl === -1 ? b.subarray(0, 0) : b.subarray(nl + 1);
    }
    return b.toString('utf8');
  } finally {
    await fh.close();
  }
}

// Потоковое чтение строк: for await (const { text, offset, end } of readLines(file, {start}))
//   text   - строка без \n; для пропущенной (слишком длинной) строки text === null и skipped === true;
//   offset - байтовое начало строки, end - байтовое смещение сразу после её \n.
// Неполная последняя строка (без \n) НЕ выдаётся: её смещение вернёт lastEnd через onEnd.
// opts: { start, end, maxLine, highWaterMark }
async function* readLines(filePath, opts) {
  const o = opts || {};
  const maxLine = o.maxLine || MAX_LINE;
  const start = o.start || 0;
  const streamOpts = { start, highWaterMark: o.highWaterMark || STREAM_CHUNK };
  if (o.end != null) streamOpts.end = o.end - 1; // у createReadStream end включительный
  if (o.end != null && o.end <= start) return;
  const stream = fs.createReadStream(filePath, streamOpts);

  let pieces = []; // куски текущей строки (Buffer)
  let pieceLen = 0;
  let skipping = false; // текущая строка уже длиннее потолка
  let lineStart = start; // байтовое начало текущей строки
  let pos = start; // байтовое смещение начала текущего куска

  try {
    for await (const chunk of stream) {
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(NL, from);
        if (nl === -1) {
          if (!skipping) {
            pieceLen += chunk.length - from;
            if (pieceLen > maxLine) {
              skipping = true;
              pieces = [];
              pieceLen = 0;
            } else {
              pieces.push(from === 0 ? chunk : chunk.subarray(from));
            }
          }
          break;
        }
        const end = pos + nl + 1;
        if (skipping || pieceLen + (nl - from) > maxLine) {
          yield { text: null, skipped: true, offset: lineStart, end };
        } else {
          pieces.push(chunk.subarray(from, nl));
          const buf = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
          const text = buf.toString('utf8');
          if (text.trim()) yield { text, skipped: false, offset: lineStart, end };
        }
        pieces = [];
        pieceLen = 0;
        skipping = false;
        lineStart = end;
        from = nl + 1;
      }
      pos += chunk.length;
    }
  } finally {
    stream.destroy();
  }
}

// Читает до maxLines полных строк, заканчивая на endOffset (по умолчанию - конец файла),
// справа налево кусками. Недописанный хвост (после последнего \n) и строки длиннее
// maxLine не возвращаются. maxBytes (необязательно) - сколько байт максимум просмотреть с конца.
// Ответ: { lines: [{ offset, text }], startOffset, reachedStart, skipped }, skipped - число
// пропущенных слишком длинных строк.
async function readBackLines(filePath, endOffset, maxLines, maxLine, maxBytes) {
  const cap = maxLine || MAX_LINE;
  const budget = maxBytes > 0 ? maxBytes : Infinity;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const st = await fh.stat();
    const end = Math.min(endOffset == null || endOffset < 0 ? st.size : endOffset, st.size);
    const out = []; // справа налево
    let pos = end;
    let right = []; // куски текущей строки слева направо
    let rightLen = 0;
    let over = false; // текущая строка длиннее потолка
    let seenNl = false; // уже прошли первый \n справа: всё правее него - недописанный хвост
    let startOffset = end;
    let skipped = 0;

    const finish = (offset) => {
      if (!over && rightLen > 0 && rightLen <= cap) {
        const text = Buffer.concat(right).toString('utf8');
        if (text.trim()) {
          out.push({ offset, text });
          startOffset = offset;
        }
      } else if (over || rightLen > cap) {
        skipped++;
      }
      right = [];
      rightLen = 0;
      over = false;
    };

    while (pos > 0 && out.length < maxLines && end - pos < budget) {
      const len = Math.min(BACK_CHUNK, pos);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos - len);
      pos -= len;
      let hi = bytesRead;
      while (hi > 0) {
        const nl = buf.lastIndexOf(NL, hi - 1);
        if (nl === -1) {
          if (seenNl && !over) {
            right.unshift(buf.subarray(0, hi));
            rightLen += hi;
            if (rightLen > cap) {
              over = true;
              right = [];
              rightLen = 0;
            }
          }
          hi = 0;
          break;
        }
        if (!seenNl) {
          seenNl = true; // всё правее - недописанный хвост
        } else if (!over) {
          right.unshift(buf.subarray(nl + 1, hi));
          rightLen += hi - (nl + 1);
          finish(pos + nl + 1);
          if (out.length >= maxLines) {
            hi = 0;
            break;
          }
        } else {
          skipped++;
          right = [];
          rightLen = 0;
          over = false;
        }
        hi = nl;
      }
    }
    // дошли до начала файла: накопленное и есть первая строка
    if (pos === 0 && seenNl && out.length < maxLines) finish(0);

    out.reverse();
    return { lines: out, startOffset: out.length ? out[0].offset : end, reachedStart: pos === 0 && out.length < maxLines, skipped };
  } finally {
    await fh.close();
  }
}

// Дочитывание по смещению: не больше windowBytes за вызов, смещение двигается только по полные строки.
// Ответ: { data, offset, truncated, size, more }
//   truncated - файл стал короче смещения (ротация), offset сброшен в 0;
//   more      - после этого окна в файле ещё есть данные;
// Строка длиннее потолка пропускается (в data не попадает), смещение переходит за её \n.
async function readForward(filePath, offset, windowBytes, maxLine) {
  const win = windowBytes || FORWARD_WINDOW;
  const cap = maxLine || MAX_LINE;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const st = await fh.stat();
    if (st.size < offset) return { data: '', offset: 0, truncated: true, size: st.size, more: st.size > 0 };
    if (st.size === offset) return { data: '', offset, truncated: false, size: st.size, more: false };
    const len = Math.min(st.size - offset, win);
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    const cut = buf.lastIndexOf(NL, bytesRead - 1);
    if (cut === -1) {
      // в окне нет ни одного \n: либо строка ещё пишется, либо она длиннее окна
      if (bytesRead >= win || bytesRead > cap) {
        const next = await skipLine(fh, offset + bytesRead, st.size);
        if (next === -1) return { data: '', offset, truncated: false, size: st.size, more: false };
        return { data: '', offset: next, truncated: false, size: st.size, more: next < st.size };
      }
      return { data: '', offset, truncated: false, size: st.size, more: false };
    }
    const body = buf.subarray(0, cut + 1);
    const text = dropLongLines(body, cap);
    return { data: text, offset: offset + cut + 1, truncated: false, size: st.size, more: offset + cut + 1 < st.size };
  } finally {
    await fh.close();
  }
}

// Склеивает только строки не длиннее cap (длинные выбрасывает).
function dropLongLines(body, cap) {
  if (body.length <= cap) return body.toString('utf8');
  const keep = [];
  let from = 0;
  while (from < body.length) {
    let nl = body.indexOf(NL, from);
    if (nl === -1) nl = body.length - 1;
    if (nl + 1 - from <= cap + 1) keep.push(body.subarray(from, nl + 1));
    from = nl + 1;
  }
  return Buffer.concat(keep).toString('utf8');
}

// Находит конец строки, начатой до from: читает кусками вперёд до \n. Возвращает смещение после \n
// или -1, если \n ещё не дописан.
async function skipLine(fh, from, size) {
  const buf = Buffer.allocUnsafe(STREAM_CHUNK);
  let pos = from;
  while (pos < size) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
    if (!bytesRead) break;
    const i = buf.subarray(0, bytesRead).indexOf(NL);
    if (i !== -1) return pos + i + 1;
    pos += bytesRead;
  }
  return -1;
}

module.exports = { MAX_LINE, HEAD_BYTES, FORWARD_WINDOW, readHead, readTailText, readLines, readBackLines, readForward };
