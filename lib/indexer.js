'use strict';

// Потоковый индекс транскриптов. Каждый файл читается построчным потоком (lib/lines.js), одна строка = один
// JSON.parse; в память файл целиком не попадает. Результат (acc) кэшируется по (путь, size, mtime).
// Файл дописался - дочитываются только новые байты. Параллельно идёт не больше двух индексаций.

const { readLines } = require('./lines');
const { newAcc } = require('./acc');
const guard = require('./guard');

class Indexer {
  constructor(opts) {
    const o = opts || {};
    this.concurrency = o.concurrency || 2;
    this.cache = new Map(); // путь → acc
    this.running = new Map(); // путь → acc (в процессе: indexedBytes виден для прогресса)
    this.inflight = new Map(); // путь → Promise<acc>
    this.active = 0;
    this.waiters = []; // очередь ожидающих слота
    this.env = o.env;
  }

  // Кэш без обращения к диску: актуален ли acc для этого stat.
  fresh(file) {
    const acc = this.cache.get(file.path);
    return !!acc && acc.size === file.size && acc.mtimeMs === file.mtimeMs;
  }

  // Любая версия из кэша (может отставать от файла), либо идущая индексация.
  cached(filePath) {
    return this.cache.get(filePath) || this.running.get(filePath) || null;
  }

  // Индекс файла. priority=true - в начало очереди (пользователь ждёт именно этот файл).
  get(adapter, file, priority) {
    if (this.fresh(file)) return Promise.resolve(this.cache.get(file.path));
    const key = file.path;
    const cur = this.inflight.get(key);
    // идущая индексация того же размера подойдёт; иначе после неё запустится дочитывание
    if (cur && cur.size === file.size && cur.mtimeMs === file.mtimeMs) return cur.promise;
    const run = (cur ? cur.promise.catch(() => null) : Promise.resolve()).then(() => this._run(adapter, file, priority));
    const entry = { promise: run, size: file.size, mtimeMs: file.mtimeMs };
    this.inflight.set(key, entry);
    const clear = () => {
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    };
    run.then(clear, clear);
    return run;
  }

  async _run(adapter, file, priority) {
    if (this.fresh(file)) return this.cache.get(file.path);
    await this._acquire(priority);
    try {
      await guard.waitForMemory(15000, this.env);
      return await this._index(adapter, file);
    } finally {
      this._release();
    }
  }

  _acquire(priority) {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => (priority ? this.waiters.unshift(resolve) : this.waiters.push(resolve)));
  }

  _release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  async _index(adapter, file) {
    const prev = this.cache.get(file.path);
    // дописанный файл: продолжаем с места, где остановились; сжатый или переписанный - с нуля
    const append = prev && file.size >= prev.size && prev.indexedBytes <= file.size && file.size > prev.size;
    const acc = append ? prev : newAcc(file);
    const start = append ? prev.indexedBytes : 0;
    this.running.set(file.path, acc);
    try {
      for await (const line of readLines(file.path, { start, end: file.size })) {
        acc.indexedBytes = line.end;
        if (line.skipped) {
          acc.skippedLong++;
          continue;
        }
        let rec;
        try {
          rec = JSON.parse(line.text);
        } catch {
          continue; // битая строка: пропускаем
        }
        acc.records++;
        adapter.scanRecord(rec, acc);
      }
      acc.size = file.size;
      acc.mtimeMs = file.mtimeMs;
      this.cache.set(file.path, acc);
      return acc;
    } finally {
      this.running.delete(file.path);
    }
  }

  // Прогресс по набору файлов: доля 0..1 с учётом байт.
  progress(files) {
    let bytesDone = 0;
    let bytesTotal = 0;
    let done = 0;
    for (const f of files) {
      bytesTotal += f.size;
      if (this.fresh(f)) {
        bytesDone += f.size;
        done++;
        continue;
      }
      const acc = this.running.get(f.path) || this.cache.get(f.path);
      if (acc) bytesDone += Math.min(acc.indexedBytes, f.size);
    }
    const pct = bytesTotal ? Math.floor((bytesDone / bytesTotal) * 100) : 100;
    return { done, total: files.length, bytesDone, bytesTotal, pct: done === files.length ? 100 : Math.min(pct, 99) };
  }

  // Дожидается индексации набора (для тестов и прогрева); ошибки отдельных файлов не роняют остальных.
  async ensure(entries, priority) {
    const res = await Promise.allSettled(entries.map(({ adapter, file }) => this.get(adapter, file, priority)));
    return res.filter((r) => r.status === 'rejected').length;
  }
}

module.exports = { Indexer };
