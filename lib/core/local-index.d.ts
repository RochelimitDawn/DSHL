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
/** 连续 CJK 字符两两成组；拉丁词原样保留；token 之间以空格分隔供 unicode61 分词。 */
export declare function cjkBigram(text: string): string;
export declare class LocalIndex {
    private readonly db;
    private readonly insertStmt;
    private readonly ftsDeleteStmt;
    private readonly searchStmt;
    private readonly countStmt;
    constructor(dbPath?: string);
    /** 写入或更新一条帖子索引（双写主表与 FTS 表）。 */
    index(post: IndexedPost): void;
    /** 全文检索；查询词经同一 bigram 管线处理。 */
    search(query: string, options?: {
        site?: string;
        limit?: number;
    }): LocalSearchHit[];
    count(): number;
    close(): void;
}
