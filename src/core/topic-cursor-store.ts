import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * 话题读取游标：记录每话题已读的最大楼层号与时间，
 * 支撑 get_topic 增量模式（只返回新楼）。
 */
export interface TopicCursor {
  lastPostNumber: number;
  lastReadAt: string;
}

export class TopicCursorStore {
  private readonly filePath: string;
  private cursors: Map<number, TopicCursor> | undefined;

  constructor(filePath?: string) {
    this.filePath =
      filePath && filePath.trim() !== ''
        ? resolve(filePath)
        : resolve(homedir(), '.dsh-plugin-linuxdo', 'topic-cursors.json');
  }

  private loadAll(): Map<number, TopicCursor> {
    if (this.cursors) return this.cursors;
    this.cursors = new Map();
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, TopicCursor>;
      for (const [key, value] of Object.entries(raw)) {
        if (
          typeof value?.lastPostNumber === 'number' &&
          typeof value?.lastReadAt === 'string'
        ) {
          this.cursors.set(Number(key), value);
        }
      }
    } catch {
      // 首次或损坏时从空开始
    }
    return this.cursors;
  }

  get(topicId: number): TopicCursor | undefined {
    return this.loadAll().get(topicId);
  }

  set(topicId: number, lastPostNumber: number): void {
    const map = this.loadAll();
    map.set(topicId, { lastPostNumber, lastReadAt: new Date().toISOString() });
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(map)));
    } catch {
      // 持久化失败不影响内存态
    }
  }
}
