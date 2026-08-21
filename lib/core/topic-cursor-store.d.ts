/**
 * 话题读取游标：记录每话题已读的最大楼层号与时间，
 * 支撑 get_topic 增量模式（只返回新楼）。
 */
export interface TopicCursor {
    lastPostNumber: number;
    lastReadAt: string;
}
export declare class TopicCursorStore {
    private readonly filePath;
    private cursors;
    constructor(filePath?: string);
    private loadAll;
    get(topicId: number): TopicCursor | undefined;
    set(topicId: number, lastPostNumber: number): void;
}
