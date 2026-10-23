'use strict';

// Страховка по памяти. Консоль запускается с --max-old-space-size=384; кроме того, при RSS выше порога
// тяжёлые запросы (всё, что читает транскрипты) отклоняются ответом 503 с причиной.

const MB = 1024 * 1024;

function limitMb(env) {
  const n = parseInt((env || process.env).RSS_LIMIT_MB || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 450;
}

function rssMb() {
  return process.memoryUsage().rss / MB;
}

// { ok, rssMb, limitMb }
function check(env) {
  const limit = limitMb(env);
  const rss = rssMb();
  return { ok: rss <= limit, rssMb: Math.round(rss), limitMb: limit };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Фоновые задачи ждут, пока память опустится ниже порога (до maxWaitMs), и только потом стартуют.
async function waitForMemory(maxWaitMs, env) {
  const until = Date.now() + (maxWaitMs || 15000);
  while (!check(env).ok && Date.now() < until) {
    if (global.gc) global.gc();
    await sleep(300);
  }
}

module.exports = { check, rssMb, waitForMemory, limitMb };
