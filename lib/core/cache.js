export class TtlCache {
    ttlMs;
    maxEntries;
    map = new Map();
    hits = 0;
    misses = 0;
    constructor(ttlMs, maxEntries = 200) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        if (ttlMs <= 0)
            throw new RangeError('ttlMs 必须 > 0');
    }
    get(key) {
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
    set(key, value) {
        if (this.map.has(key))
            this.map.delete(key);
        while (this.map.size >= this.maxEntries) {
            const oldest = this.map.keys().next();
            if (oldest.done)
                break;
            this.map.delete(oldest.value);
        }
        this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }
    clear() {
        this.map.clear();
    }
    stats() {
        const total = this.hits + this.misses;
        return {
            size: this.map.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 100) / 100,
        };
    }
    get size() {
        return this.map.size;
    }
}
