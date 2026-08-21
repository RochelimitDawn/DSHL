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
export declare class RateLimiter {
    private readonly options;
    private active;
    private readonly queue;
    private readonly window;
    private queuedPeak;
    constructor(options: LimiterOptions);
    stats(): LimiterStats;
    /** 在限流约束内执行任务；signal 中止时排队任务直接拒绝。 */
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    private acquire;
    private release;
    private pump;
}
