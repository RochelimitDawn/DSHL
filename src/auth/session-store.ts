import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

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

const FILE_MODE = 0o600;

export class SessionStore {
  readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath && filePath.trim() !== ''
        ? resolve(filePath)
        : resolve(homedir(), '.dsh-plugin-linuxdo', 'session.json');
  }

  load(): SessionState {
    if (!existsSync(this.filePath)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as SessionState;
      return {
        tToken: typeof raw.tToken === 'string' ? raw.tToken : undefined,
        username: typeof raw.username === 'string' ? raw.username : undefined,
        savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : undefined,
      };
    } catch {
      return {};
    }
  }

  save(state: SessionState): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const payload: SessionState = { ...state, savedAt: new Date().toISOString() };
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
    try {
      chmodSync(this.filePath, FILE_MODE);
    } catch {
      // Windows 上 chmod 语义受限，忽略
    }
  }

  clear(): void {
    if (existsSync(this.filePath)) {
      writeFileSync(this.filePath, JSON.stringify({}, null, 2), { mode: FILE_MODE });
    }
  }
}
