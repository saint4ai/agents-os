'use strict';

// Дочерний процесс для замера памяти: node --max-old-space-size=384 rss-run.js <файл> [--no-extra]
// Строит индекс файла потоком и печатает JSON с пиковым RSS.
// --no-extra: записи Edit, Bash и их результаты до разбора вычёркиваются: это тот же файл и тот же поток чтения
// без новых полей индекса («как выполнял», проверки). Разница пиков RSS и есть цена новых полей.

const { Indexer } = require('../../lib/indexer');
const { create } = require('../../lib/sources/claude');
const { totals } = require('../../lib/acc');
const fs = require('fs');

(async () => {
  const file = process.argv[2];
  const st = fs.statSync(file);
  const adapter = create({ CLAUDE_PROJECTS_DIR: require('path').dirname(file) });
  if (process.argv[3] === '--no-extra') {
    const scan = adapter.scanRecord;
    adapter.scanRecord = (rec, acc) => {
      const m = rec && rec.message;
      if (m && Array.isArray(m.content)) m.content = m.content.filter((b) => !(b && (b.type === 'tool_result' || (b.type === 'tool_use' && (b.name === 'Edit' || b.name === 'Bash')))));
      scan(rec, acc);
    };
  }
  const idx = new Indexer();
  let peak = process.memoryUsage().rss;
  const t = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
  const t0 = Date.now();
  const acc = await idx.get(adapter, { path: file, size: st.size, mtimeMs: st.mtimeMs });
  clearInterval(t);
  peak = Math.max(peak, process.memoryUsage().rss);
  const tot = totals(acc);
  // удерживаемая куча после полной сборки мусора: точная цена индекса, в отличие от пика RSS (его шум около 10 МБ)
  if (global.gc) global.gc();
  const heapKb = Math.round(process.memoryUsage().heapUsed / 1024);
  // размер полей «как выполнял»: то, что индекс хранит сверх счётчиков
  const extra = { files: acc.files, cmds: acc.cmds, toolCounts: acc.toolCounts, pendingChecks: acc.pendingChecks, checks: acc.checks };
  console.log(JSON.stringify({ rssPeakMb: Math.round(peak / 1048576), ms: Date.now() - t0, records: acc.records, skippedLong: acc.skippedLong, bytes: st.size, indexedBytes: acc.indexedBytes, out: tot.out, title: acc.title, cwd: acc.cwd, heapKb, extraBytes: JSON.stringify(extra).length, files: Object.keys(acc.files).length, cmds: acc.cmds.length, checks: acc.checks.length, edits: acc.toolCounts.Edit || 0 }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
