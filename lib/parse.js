'use strict';

// Разбор строки транскрипта (одна JSON-запись) в нормализованные события.
// Одна запись может содержать несколько блоков, поэтому parseLine возвращает МАССИВ событий.
// Событие: {ts, kind, role, text, tool, input, resultFor, isError, id}
// kind: user | assistant | thinking | tool_call | tool_result | system

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

function parseRecord(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : '';
  const role = rec.message && rec.message.role ? rec.message.role : rec.type;
  const content = rec.message ? rec.message.content : undefined;
  const events = [];

  const mk = (kind, extra) =>
    Object.assign(
      { ts, kind, role, text: '', tool: null, input: null, resultFor: null, isError: false, id: null },
      extra || {}
    );

  if (rec.type === 'user') {
    if (typeof content === 'string') {
      events.push(mk('user', { text: content }));
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          events.push(mk('user', { text: b.text || '' }));
        } else if (b.type === 'tool_result') {
          events.push(
            mk('tool_result', {
              resultFor: b.tool_use_id || null,
              isError: b.is_error === true,
              text: blockText(b.content),
            })
          );
        }
      }
    }
  } else if (rec.type === 'assistant') {
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          events.push(mk('assistant', { text: b.text || '' }));
        } else if (b.type === 'thinking') {
          events.push(mk('thinking', { text: b.thinking || '' }));
        } else if (b.type === 'tool_use') {
          events.push(mk('tool_call', { tool: b.name || '', input: b.input || {}, id: b.id || null }));
        }
      }
    } else if (typeof content === 'string') {
      events.push(mk('assistant', { text: content }));
    }
  } else if (rec.type === 'system') {
    const text =
      typeof rec.content === 'string'
        ? rec.content
        : rec.message && typeof rec.message.content === 'string'
          ? rec.message.content
          : '';
    if (text) events.push(mk('system', { role: 'system', text }));
  }

  return events;
}

// parseRec — разбор записи конкретного источника (по умолчанию формат Claude Code).
function parseLine(line, parseRec) {
  if (typeof line !== 'string' || !line.trim()) return [];
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return [];
  }
  return (parseRec || parseRecord)(rec);
}

// Весь транскрипт (текст файла) → массив событий.
function parseTranscript(text) {
  const out = [];
  for (const line of String(text).split('\n')) out.push(...parseLine(line));
  return out;
}

module.exports = { parseLine, parseRecord, parseTranscript, blockText };
