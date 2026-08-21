/**
 * Discourse cooked HTML → 纯文本清洗器。
 *
 * 目标是 token 效率：保留语义结构（代码块、引用、链接、图片），
 * 剥离全部标记噪声，输出可直接进入 LLM 上下文的紧凑文本。
 */
export declare function decodeEntities(input: string): string;
/**
 * 主入口：把 cooked HTML 转成紧凑纯文本。
 */
export declare function htmlToText(html: string): string;
/**
 * 折叠 Discourse 引用块：
 * <aside class="quote" data-username="x" data-post="N">…<blockquote>原文</blockquote></aside>
 * → [引用 @x #N: 首行摘要…]
 * 引用全文与被引内容高度重复，完整保留只会浪费 token。
 */
export declare function foldQuotes(html: string): string;
/**
 * 截断到 maxChars 并保证不切断多字节代理对。
 * 返回截断后的文本与是否发生截断。
 */
export declare function truncateText(text: string, maxChars: number): {
    text: string;
    truncated: boolean;
};
