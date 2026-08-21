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

export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
  ) {
    if (ttlMs <= 0) throw new RangeError('ttlMs 必须 > 0');
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    // 重新插入实现 LRU 语义
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.map.clear();
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 100) / 100,
    };
  }

  get size(): number {
    return this.map.size;
  }
}
