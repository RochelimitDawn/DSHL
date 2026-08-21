/** 相对时间与 Discourse UTC 时间展示辅助。 */
/**
 * ISO 时间戳 → 人性化相对时间。
 * 超过 12 个月退化为具体日期，避免"3 年前"式模糊。
 */
export declare function relativeTime(iso: string | undefined, now?: number): string;
/** 构造话题楼层深链（Discourse 标准 URL 形态）。 */
export declare function topicPermalink(baseUrl: string, slug: string | undefined, topicId: number, postNumber?: number): string;
