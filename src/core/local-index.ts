/**
 * 本地 FTS5 知识库：读过的话题与帖子自动沉淀，供离线检索与重复查询去请求化。
 *
 * 中文检索采用 CJK bigram 方案：入库与查询时把连续 CJK 字符两两成组，
 * 其余 token 原样保留，配合 unicode61 分词器实现中英文混合全文检索。
 * 依赖 Node 22 内置 node:sqlite（实验性），零外部依赖。
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export interface IndexedPost {
  site: string;
  topicId: number;
  postId: number;
  postNumber: number;
  title: string;
  author: string;
  content: string;
  url: string;
}

export interface LocalSearchHit {
  topicId: number;
  postId: number;
  postNumber: number;
  title: string;
  author: string;
  url: string;
  /** FTS5 bm25 相关度，越小越相关 */
  rank: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  site TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  post_number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (site, post_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  title, content, author,
  tokenize = 'unicode61'
);
`;

/** 连续 CJK 字符两两成组；拉丁词原样保留；token 之间以空格分隔供 unicode61 分词。 */
export function cjkBigram(text: string): string {
  const out: string[] = [];
  let latinRun = '';
  let cjkRun: string[] = [];
  const flushLatin = () => {
    if (latinRun !== '') {
      out.push(latinRun);
      latinRun = '';
    }
  };
  const flushCjk = () => {
    if (cjkRun.length === 1) {
      out.push(cjkRun[0]!);
    }
    for (let i = 0; i + 1 < cjkRun.length; i++) {
      out.push(cjkRun[i]! + cjkRun[i + 1]!);
    }
    cjkRun = [];
  };
  for (const ch of text) {
    if (isCjk(ch)) {
      flushLatin();
      cjkRun.push(ch);
    } else if (/[a-zA-Z0-9_]/.test(ch)) {
      flushCjk();
      latinRun += ch;
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return out.join(' ');
}

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/** FTS5 MATCH 查询串转义：bigram 化后以引号包裹避免保留字冲突。 */
function toMatchQuery(query: string): string {
  const bigrammed = cjkBigram(query);
  const tokens = bigrammed.split(/\s+/).filter((t) => t.length > 0 && !/["'^*]/.test(t));
  return tokens.map((t) => `"${t}"`).join(' ');
}

export class LocalIndex {
  private readonly db: DatabaseSync;
  private readonly insertStmt;
  private readonly ftsDeleteStmt;
  private readonly searchStmt;
  private readonly countStmt;

  constructor(dbPath?: string) {
    const isInMemory = dbPath === ':memory:';
    const path = isInMemory
      ? ':memory:'
      : resolve(
          dbPath && dbPath.trim() !== ''
            ? dbPath
            : resolve(homedir(), '.dsh-plugin-linuxdo', 'knowledge.db'),
        );
    if (!isInMemory) {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO posts (site, topic_id, post_id, post_number, title, author, content, url, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.ftsDeleteStmt = this.db.prepare('DELETE FROM posts_fts WHERE rowid = ?');
    this.searchStmt = this.db.prepare(`
      SELECT p.topic_id, p.post_id, p.post_number, p.title, p.author, p.url,
             bm25(posts_fts, 3.0, 1.0, 2.0) AS rank
      FROM posts_fts f
      JOIN posts p ON p.rowid = f.rowid
      WHERE posts_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM posts');
  }

  /** 写入或更新一条帖子索引（双写主表与 FTS 表）。 */
  index(post: IndexedPost): void {
    const existing = this.db
      .prepare('SELECT rowid FROM posts WHERE site = ? AND post_id = ?')
      .get(post.site, post.postId) as { rowid: number | bigint } | undefined;
    const title = cjkBigram(post.title);
    const content = cjkBigram(post.content);
    const author = cjkBigram(post.author);
    if (existing) {
      this.ftsDeleteStmt.run(existing.rowid);
    }
    const result = this.insertStmt.run(
      post.site,
      post.topicId,
      post.postId,
      post.postNumber,
      title,
      author,
      content,
      post.url,
      new Date().toISOString(),
    );
    this.db
      .prepare('INSERT INTO posts_fts (rowid, title, content, author) VALUES (?, ?, ?, ?)')
      .run(result.lastInsertRowid, title, content, author);
  }

  /** 全文检索；查询词经同一 bigram 管线处理。 */
  search(query: string, options: { site?: string; limit?: number } = {}): LocalSearchHit[] {
    const match = toMatchQuery(query);
    if (match === '') return [];
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const rows = this.searchStmt.all(match, limit) as Array<{
      topic_id: number;
      post_id: number;
      post_number: number;
      title: string;
      author: string;
      url: string;
      rank: number;
    }>;
    const hits = rows.map((row) => ({
      topicId: row.topic_id,
      postId: row.post_id,
      postNumber: row.post_number,
      title: row.title,
      author: row.author,
      url: row.url,
      rank: row.rank,
    }));
    // site 过滤在 SQL 之外做（FTS5 JOIN 已按相关度排序，量级小）
    if (options.site) {
      const filtered = this.db
        .prepare('SELECT post_id FROM posts WHERE site = ?')
        .all(options.site) as Array<{ post_id: number }>;
      const allowed = new Set(filtered.map((r) => r.post_id));
      return hits.filter((hit) => allowed.has(hit.postId));
    }
    return hits;
  }

  count(): number {
    const row = this.countStmt.get() as { n: number };
    return row?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
