export class RateLimiter {
    options;
    active = 0;
    queue = [];
    window = [];
    queuedPeak = 0;
    constructor(options) {
        this.options = options;
        if (options.maxConcurrent < 1)
            throw new RangeError('maxConcurrent 必须 >= 1');
        if (options.windowMax < 1)
            throw new RangeError('windowMax 必须 >= 1');
        if (options.windowSeconds <= 0)
            throw new RangeError('windowSeconds 必须 > 0');
    }
    stats() {
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
    async run(task, signal) {
        if (signal?.aborted)
            throw new Error('Aborted before scheduling');
        const slot = await this.acquire(signal);
        try {
            return await task();
        }
        finally {
            slot.release();
        }
    }
    async acquire(signal) {
        return new Promise((resolve, reject) => {
            const task = {
                run: () => resolve({ release: () => this.release() }),
                reject,
                signal,
            };
            if (signal) {
                const onAbort = () => {
                    const idx = this.queue.indexOf(task);
                    if (idx >= 0)
                        this.queue.splice(idx, 1);
                    reject(new Error('Aborted while waiting for rate limit slot'));
                };
                task.onAbort = onAbort;
                signal.addEventListener('abort', onAbort, { once: true });
            }
            this.queue.push(task);
            this.pump();
        });
    }
    release() {
        this.active = Math.max(0, this.active - 1);
        this.pump();
    }
    pump() {
        if (this.queue.length > this.queuedPeak)
            this.queuedPeak = this.queue.length;
        while (this.active < this.options.maxConcurrent && this.queue.length > 0) {
            const now = Date.now();
            const windowMs = this.options.windowSeconds * 1000;
            while (this.window.length > 0 && now - this.window[0] > windowMs) {
                this.window.shift();
            }
            if (this.window.length >= this.options.windowMax) {
                const waitMs = windowMs - (now - this.window[0]) + 5;
                setTimeout(() => this.pump(), waitMs);
                return;
            }
            const task = this.queue.shift();
            if (!task)
                break;
            if (task.signal?.aborted)
                continue;
            if (task.onAbort && task.signal) {
                task.signal.removeEventListener('abort', task.onAbort);
            }
            this.window.push(now);
            this.active += 1;
            task.run();
        }
    }
}
