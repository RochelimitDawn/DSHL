/**
 * 登录态持久化。
 *
 * 存储内容仅为 Discourse 会话 `_t` cookie 与用户名。文件权限收紧为 0600，
 * 路径默认位于用户主目录下的 ~/.dsh-plugin-linuxdo/。
 */
export interface SessionState {
    tToken?: string;
    username?: string;
    savedAt?: string;
}
export declare class SessionStore {
    readonly filePath: string;
    constructor(filePath?: string);
    load(): SessionState;
    save(state: SessionState): void;
    clear(): void;
}
