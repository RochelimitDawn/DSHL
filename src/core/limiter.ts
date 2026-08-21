/**
 * 请求限流器：并发上限 + 滑动窗口速率限制。
 *
 * 参数量级对齐 FluxDO 客户端（每 host 3 并发、3 秒窗口 6 请求）并更保守，
 * 使插件的流量形态贴近人工浏览，降低触发站点风控的概率。
 */
export interface LimiterOptions {
  maxConcurrent: number;
  windowMax: number;
  windowSeconds: number;
}

interface QueueTask {
  run: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface LimiterStats {
  /** 当前正在执行的请求数 */
  active: number;
  /** 排队等待的任务数 */
  queued: number;
  /** 当前滑动窗口内已用请求数 */
  windowUsed: number;
  /** 累计排队峰值 */
  queuedPeak: number;
}

export class RateLimiter {
  private active = 0;
  private readonly queue: QueueTask[] = [];
  private readonly window: number[] = [];
  private queuedPeak = 0;

  constructor(private readonly options: LimiterOptions) {
    if (options.maxConcurrent < 1) throw new RangeError('maxConcurrent 必须 >= 1');
    if (options.windowMax < 1) throw new RangeError('windowMax 必须 >= 1');
    if (options.windowSeconds <= 0) throw new RangeError('windowSeconds 必须 > 0');
  }

  stats(): LimiterStats {
    const now = Date.now();
    const windowMs = this.options.windowSeconds * 1000;
    const windowUsed = this.window.filter((t) => now - t <= windowMs).length;
    return {
      active: this.active,
      queued: this.queue.length,
      windowUsed,
      queuedPeak: this.queuedPeak,
    };
  }

  /** 在限流约束内执行任务；signal 中止时排队任务直接拒绝。 */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('Aborted before scheduling');
    const slot = await this.acquire(signal);
    try {
      return await task();
    } finally {
      slot.release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<{ release: () => void }> {
    return new Promise((resolve, reject) => {
      const task: QueueTask = {
        run: () => resolve({ release: () => this.release() }),
        reject,
        signal,
      };
      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(task);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new Error('Aborted while waiting for rate limit slot'));
        };
        task.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.queue.push(task);
      this.pump();
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  private pump(): void {
    if (this.queue.length > this.queuedPeak) this.queuedPeak = this.queue.length;
    while (this.active < this.options.maxConcurrent && this.queue.length > 0) {
      const now = Date.now();
      const windowMs = this.options.windowSeconds * 1000;
      while (this.window.length > 0 && now - (this.window[0] as number) > windowMs) {
        this.window.shift();
      }
      if (this.window.length >= this.options.windowMax) {
        const waitMs = windowMs - (now - (this.window[0] as number)) + 5;
        setTimeout(() => this.pump(), waitMs);
        return;
      }
      const task = this.queue.shift();
      if (!task) break;
      if (task.signal?.aborted) continue;
      if (task.onAbort && task.signal) {
        task.signal.removeEventListener('abort', task.onAbort);
      }
      this.window.push(now);
      this.active += 1;
      task.run();
    }
  }
}
