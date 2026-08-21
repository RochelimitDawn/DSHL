/**
 * 带 TTL 与 LRU 驱逐的进程内缓存。
 * 话题/帖子内容不可变性强，缓存命中可显著降低对站点的请求压力。
 */
export interface CacheStats {
    size: number;
    hits: number;
    misses: number;
    /** 命中率 0~1，无请求时为 0 */
    hitRate: number;
}
export declare class TtlCache<V> {
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly map;
    private hits;
    private misses;
    constructor(ttlMs: number, maxEntries?: number);
    get(key: string): V | undefined;
    set(key: string, value: V): void;
    clear(): void;
    stats(): CacheStats;
    get size(): number;
}
