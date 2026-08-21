import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './limiter.js';

test('并发上限：同时最多 maxConcurrent 个任务在跑', async () => {
  let running = 0;
  let peak = 0;
  const limiter = new RateLimiter({ maxConcurrent: 2, windowMax: 100, windowSeconds: 1 });
  const task = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 30));
    running -= 1;
  };
  await Promise.all(Array.from({ length: 6 }, () => limiter.run(task)));
  assert.equal(peak, 2);
});

test('滑动窗口：窗口内请求数受 windowMax 约束', async () => {
  const limiter = new RateLimiter({ maxConcurrent: 10, windowMax: 3, windowSeconds: 1 });
  const start = Date.now();
  // 6 个瞬时任务：前 3 个立即放行，后 3 个必须等窗口滑过
  await Promise.all(Array.from({ length: 6 }, () => limiter.run(async () => 1)));
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 900, `6 个任务在 3/1s 窗口下应耗时 >= 900ms，实际 ${elapsed}ms`);
});

test('排队任务可被 AbortSignal 取消', async () => {
  const limiter = new RateLimiter({ maxConcurrent: 1, windowMax: 100, windowSeconds: 1 });
  const releaseFirst = new Promise<void>((resolve) => {
    void limiter.run(async () => {
      await new Promise((r) => setTimeout(r, 100));
      resolve();
    });
  });
  const controller = new AbortController();
  const queued = limiter.run(async () => 2, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(queued, /Aborted/);
  await releaseFirst;
});

test('非法参数抛 RangeError', () => {
  assert.throws(() => new RateLimiter({ maxConcurrent: 0, windowMax: 1, windowSeconds: 1 }), RangeError);
  assert.throws(() => new RateLimiter({ maxConcurrent: 1, windowMax: 0, windowSeconds: 1 }), RangeError);
  assert.throws(() => new RateLimiter({ maxConcurrent: 1, windowMax: 1, windowSeconds: 0 }), RangeError);
});
