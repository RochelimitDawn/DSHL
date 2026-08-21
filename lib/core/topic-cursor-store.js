import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
export class TopicCursorStore {
    filePath;
    cursors;
    constructor(filePath) {
        this.filePath =
            filePath && filePath.trim() !== ''
                ? resolve(filePath)
                : resolve(homedir(), '.dsh-plugin-linuxdo', 'topic-cursors.json');
    }
    loadAll() {
        if (this.cursors)
            return this.cursors;
        this.cursors = new Map();
        try {
            const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
            for (const [key, value] of Object.entries(raw)) {
                if (typeof value?.lastPostNumber === 'number' &&
                    typeof value?.lastReadAt === 'string') {
                    this.cursors.set(Number(key), value);
                }
            }
        }
        catch {
            // 首次或损坏时从空开始
        }
        return this.cursors;
    }
    get(topicId) {
        return this.loadAll().get(topicId);
    }
    set(topicId, lastPostNumber) {
        const map = this.loadAll();
        map.set(topicId, { lastPostNumber, lastReadAt: new Date().toISOString() });
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(map)));
        }
        catch {
            // 持久化失败不影响内存态
        }
    }
}
