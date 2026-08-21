// src/core/cache.ts
var TtlCache = class {
  constructor(ttlMs, maxEntries = 200) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    if (ttlMs <= 0) throw new RangeError("ttlMs \u5FC5\u987B > 0");
  }
  ttlMs;
  maxEntries;
  map = /* @__PURE__ */ new Map();
  hits = 0;
  misses = 0;
  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return void 0;
    }
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this.misses += 1;
      return void 0;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
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
      hitRate: total === 0 ? 0 : Math.round(this.hits / total * 100) / 100
    };
  }
  get size() {
    return this.map.size;
  }
};

// src/core/limiter.ts
var RateLimiter = class {
  constructor(options) {
    this.options = options;
    if (options.maxConcurrent < 1) throw new RangeError("maxConcurrent \u5FC5\u987B >= 1");
    if (options.windowMax < 1) throw new RangeError("windowMax \u5FC5\u987B >= 1");
    if (options.windowSeconds <= 0) throw new RangeError("windowSeconds \u5FC5\u987B > 0");
  }
  options;
  active = 0;
  queue = [];
  window = [];
  queuedPeak = 0;
  stats() {
    const now = Date.now();
    const windowMs = this.options.windowSeconds * 1e3;
    const windowUsed = this.window.filter((t) => now - t <= windowMs).length;
    return {
      active: this.active,
      queued: this.queue.length,
      windowUsed,
      queuedPeak: this.queuedPeak
    };
  }
  /** 在限流约束内执行任务；signal 中止时排队任务直接拒绝。 */
  async run(task, signal) {
    if (signal?.aborted) throw new Error("Aborted before scheduling");
    const slot = await this.acquire(signal);
    try {
      return await task();
    } finally {
      slot.release();
    }
  }
  async acquire(signal) {
    return new Promise((resolve5, reject) => {
      const task = {
        run: () => resolve5({ release: () => this.release() }),
        reject,
        signal
      };
      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(task);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new Error("Aborted while waiting for rate limit slot"));
        };
        task.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.queue.push(task);
      this.pump();
    });
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }
  pump() {
    if (this.queue.length > this.queuedPeak) this.queuedPeak = this.queue.length;
    while (this.active < this.options.maxConcurrent && this.queue.length > 0) {
      const now = Date.now();
      const windowMs = this.options.windowSeconds * 1e3;
      while (this.window.length > 0 && now - this.window[0] > windowMs) {
        this.window.shift();
      }
      if (this.window.length >= this.options.windowMax) {
        const waitMs = windowMs - (now - this.window[0]) + 5;
        setTimeout(() => this.pump(), waitMs);
        return;
      }
      const task = this.queue.shift();
      if (!task) break;
      if (task.signal?.aborted) continue;
      if (task.onAbort && task.signal) {
        task.signal.removeEventListener("abort", task.onAbort);
      }
      this.window.push(now);
      this.active += 1;
      task.run();
    }
  }
};

// src/core/transport.ts
import { spawn } from "node:child_process";
var FetchTransport = class {
  constructor(fetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
  }
  fetchImpl;
  name = "fetch";
  async request(req) {
    const response = await this.fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "manual",
      signal: req.signal
    });
    const text = await response.text();
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    return { status: response.status, text, setCookies };
  }
};
function buildCurlArgs(binary, req) {
  const args = ["--silent", "--max-time", "30", "--compressed", "-X", req.method];
  for (const [key, value] of Object.entries(req.headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  if (req.body) {
    args.push("--data-raw", req.body);
  }
  args.push("-D", "-", req.url);
  void binary;
  return args;
}
function parseCurlOutput(raw) {
  const separator = /\r?\n\r?\n/;
  const match = separator.exec(raw);
  const headerBlock = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice(match.index + match[0].length) : "";
  const lines = headerBlock.split(/\r?\n/);
  let status = 0;
  const headers = {};
  for (const line of lines) {
    const statusMatch = /^HTTP\/[\d.]+\s+(\d+)/i.exec(line);
    if (statusMatch && statusMatch[1]) {
      status = Number(statusMatch[1]);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      (headers[key] ??= []).push(value);
    }
  }
  return { status, headers, body };
}
var CurlImpersonateTransport = class {
  constructor(binaryPath) {
    this.binaryPath = binaryPath;
  }
  binaryPath;
  name = "curl-impersonate";
  async request(req) {
    const args = buildCurlArgs(this.binaryPath, req);
    return new Promise((resolve5, reject) => {
      const child = spawn(this.binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Aborted"));
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(new Error(`curl-impersonate \u542F\u52A8\u5931\u8D25\uFF08${this.binaryPath}\uFF09\uFF1A${err.message}`));
      });
      child.on("close", () => {
        if (settled) return;
        settled = true;
        req.signal?.removeEventListener("abort", onAbort);
        try {
          const { status, headers } = parseCurlOutput(stdout);
          resolve5({
            status,
            text: stdoutBody(stdout),
            setCookies: headers["set-cookie"] ?? []
          });
        } catch (err) {
          reject(new Error(`curl-impersonate \u8F93\u51FA\u89E3\u6790\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}\uFF1Bstderr=${stderr.slice(0, 200)}`));
        }
      });
    });
  }
};
function stdoutBody(raw) {
  const separator = /\r?\n\r?\n/;
  const match = separator.exec(raw);
  return match ? raw.slice(match.index + match[0].length) : "";
}

// src/core/errors.ts
var LinuxdoError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "LinuxdoError";
  }
  code;
};
var AuthRequiredError = class extends LinuxdoError {
  constructor(detail = "") {
    super(
      "AUTH_REQUIRED",
      `Linux.do \u767B\u5F55\u6001\u7F3A\u5931\u6216\u5DF2\u5931\u6548${detail ? `\uFF08${detail}\uFF09` : ""}\u3002\u8BF7\u8C03\u7528 linuxdo_login \u5DE5\u5177\u53D1\u8D77\u91CD\u65B0\u6388\u6743\uFF0C\u5F15\u5BFC\u7528\u6237\u5728\u6D4F\u89C8\u5668\u4E2D\u5B8C\u6210\u767B\u5F55\u5E76\u70B9\u51FB\u6388\u6743\u3002`
    );
    this.name = "AuthRequiredError";
  }
};
var ChallengeError = class extends LinuxdoError {
  constructor(status) {
    super(
      "CF_CHALLENGE",
      `\u8BF7\u6C42\u88AB Cloudflare \u62E6\u622A\uFF08HTTP ${status}\uFF09\u3002\u8BF7\u7A0D\u540E\u91CD\u8BD5\uFF1B\u82E5\u6301\u7EED\u51FA\u73B0\uFF0C\u8BF4\u660E\u7AD9\u70B9\u6536\u7D27\u4E86 bot \u9632\u62A4\uFF0C\u53EF\u901A\u8FC7\u73AF\u5883\u53D8\u91CF LINUXDO_USER_AGENT \u5C06 UA \u8BBE\u7F6E\u4E3A\u4E0E\u4F60\u6D4F\u89C8\u5668\u5B8C\u5168\u4E00\u81F4\u7684\u503C\u540E\u91CD\u8BD5\u3002`
    );
    this.name = "ChallengeError";
  }
};
var ApiError = class extends LinuxdoError {
  constructor(status, path, detail) {
    super("API_ERROR", `Discourse API ${path} \u8FD4\u56DE HTTP ${status}${detail ? `\uFF1A${detail}` : ""}`);
    this.status = status;
    this.path = path;
    this.name = "ApiError";
  }
  status;
  path;
};
function looksLikeChallenge(body) {
  const markers = ["Just a moment", "cf-browser-verification", "challenge-platform", "Attention Required"];
  return markers.some((m) => body.includes(m));
}

// src/core/client.ts
var DiscourseClient = class {
  constructor(config, session, fetchImpl = fetch) {
    this.config = config;
    this.session = session;
    this.limiter = new RateLimiter({
      maxConcurrent: config.maxConcurrent,
      windowMax: config.windowMax,
      windowSeconds: config.windowSeconds
    });
    this.cache = new TtlCache(Math.max(config.topicCacheTtlMs, config.searchCacheTtlMs));
    if (typeof fetchImpl === "function") {
      this.transport = new FetchTransport(fetchImpl);
    } else {
      this.transport = fetchImpl;
    }
    if (config.curlImpersonatePath.trim() !== "") {
      this.impersonate = new CurlImpersonateTransport(config.curlImpersonatePath.trim());
    }
  }
  config;
  session;
  limiter;
  cache;
  transport;
  impersonate;
  totalRequests = 0;
  challenges = 0;
  impersonateFallbacks = 0;
  sessionInvalidated = false;
  get baseUrl() {
    return this.config.baseUrl.replace(/\/+$/, "");
  }
  /** 是否持有有效登录态（含失效标记判断）。 */
  hasSession() {
    return Boolean(this.session.load().tToken) && !this.sessionInvalidated;
  }
  stats() {
    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cache.stats().hits,
      challenges: this.challenges,
      impersonateFallbacks: this.impersonateFallbacks,
      activeTransport: this.transport.name,
      sessionInvalidated: this.sessionInvalidated,
      limiter: this.limiter.stats(),
      cache: this.cache.stats()
    };
  }
  buildUrl(path, query) {
    const url = new URL(path, `${this.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === void 0) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
  /** 浏览器形态的基础请求头（不含登录态）。 */
  baseHeaders() {
    return {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": this.config.userAgent
    };
  }
  authHeaders() {
    const headers = this.baseHeaders();
    const { tToken } = this.session.load();
    if (tToken) headers.Cookie = `_t=${tToken}`;
    return headers;
  }
  /** 发起 GET 请求并解析 JSON 响应。 */
  async getJson(path, options = {}) {
    const url = this.buildUrl(path, options.query);
    const ttl = options.cacheTtlMs ?? this.config.topicCacheTtlMs;
    if (ttl > 0) {
      const cached = this.cache.get(url);
      if (cached !== void 0) return cached;
    }
    const data = await this.limiter.run(
      () => this.requestJson(url, options.signal),
      options.signal
    );
    if (ttl > 0) this.cache.set(url, data);
    return data;
  }
  /** 绕过缓存直接请求（登录流程等敏感路径使用）。 */
  async postForm(path, body, headers = {}, signal) {
    const merged = { ...this.baseHeaders(), ...headers };
    return this.limiter.run(
      () => this.requestRaw("POST", this.buildUrl(path), body, merged, signal),
      signal
    );
  }
  async requestJson(url, signal) {
    const { status, json, text, setCookies } = await this.requestRaw(
      "GET",
      url,
      void 0,
      this.authHeaders(),
      signal
    );
    this.absorbCookies(setCookies);
    if (status === 200) {
      return json;
    }
    this.throwForStatus(status, url, text);
  }
  async requestRaw(method, url, formBody, headers, signal) {
    this.totalRequests += 1;
    const body = formBody ? new URLSearchParams(formBody).toString() : void 0;
    let response = await this.transport.request({
      method,
      url,
      headers: {
        ...headers,
        ...body ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}
      },
      body,
      signal
    });
    if (this.isChallenge(response) && this.impersonate && this.transport !== this.impersonate) {
      this.challenges += 1;
      this.impersonateFallbacks += 1;
      response = await this.impersonate.request({
        method,
        url,
        headers: {
          ...headers,
          ...body ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}
        },
        body,
        signal
      });
      if (!this.isChallenge(response)) {
        this.transport = this.impersonate;
      }
    }
    let json = null;
    try {
      json = response.text ? JSON.parse(response.text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text: response.text, setCookies: response.setCookies };
  }
  isChallenge(response) {
    return response.status === 403 && looksLikeChallenge(response.text);
  }
  throwForStatus(status, url, text) {
    if (looksLikeChallenge(text)) {
      this.challenges += 1;
      throw new ChallengeError(status);
    }
    if (status === 401 || status === 403) {
      this.sessionInvalidated = true;
      throw new AuthRequiredError(`HTTP ${status} ${url}`);
    }
    if (status === 429) {
      throw new ApiError(status, url, "\u89E6\u53D1\u7AD9\u70B9\u9650\u6D41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    }
    let detail = text.slice(0, 200);
    if (detail.startsWith("{")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.errors)) detail = parsed.errors.join("; ");
      } catch {
      }
    }
    throw new ApiError(status, url, detail);
  }
  /** Discourse 会在响应中滚动续期 _t，捕获并回写。 */
  absorbCookies(setCookies) {
    for (const cookie of setCookies) {
      const match = /(?:^|;\s*)_t=([^;]+)/.exec(cookie);
      if (match && match[1] && match[1] !== this.session.load().tToken) {
        this.session.save({ ...this.session.load(), tToken: match[1] });
      }
    }
  }
  /** 手动写入登录态（OTP 兑换成功后调用）。 */
  adoptToken(tToken, username) {
    this.session.save({ ...this.session.load(), tToken, ...username ? { username } : {} });
    this.sessionInvalidated = false;
    this.cache.clear();
  }
};

// src/auth/session-store.ts
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
var FILE_MODE = 384;
var SessionStore = class {
  filePath;
  constructor(filePath) {
    this.filePath = filePath && filePath.trim() !== "" ? resolve(filePath) : resolve(homedir(), ".dsh-plugin-linuxdo", "session.json");
  }
  load() {
    if (!existsSync(this.filePath)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      return {
        tToken: typeof raw.tToken === "string" ? raw.tToken : void 0,
        username: typeof raw.username === "string" ? raw.username : void 0,
        savedAt: typeof raw.savedAt === "string" ? raw.savedAt : void 0
      };
    } catch {
      return {};
    }
  }
  save(state) {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const payload = { ...state, savedAt: (/* @__PURE__ */ new Date()).toISOString() };
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
    try {
      chmodSync(this.filePath, FILE_MODE);
    } catch {
    }
  }
  clear() {
    if (existsSync(this.filePath)) {
      writeFileSync(this.filePath, JSON.stringify({}, null, 2), { mode: FILE_MODE });
    }
  }
};

// src/core/local-index.ts
import { mkdirSync as mkdirSync2 } from "node:fs";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
import { homedir as homedir2 } from "node:os";
import { DatabaseSync } from "node:sqlite";
var SCHEMA = `
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
function cjkBigram(text) {
  const out = [];
  let latinRun = "";
  let cjkRun = [];
  const flushLatin = () => {
    if (latinRun !== "") {
      out.push(latinRun);
      latinRun = "";
    }
  };
  const flushCjk = () => {
    if (cjkRun.length === 1) {
      out.push(cjkRun[0]);
    }
    for (let i = 0; i + 1 < cjkRun.length; i++) {
      out.push(cjkRun[i] + cjkRun[i + 1]);
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
  return out.join(" ");
}
function isCjk(ch) {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 19968 && code <= 40959 || code >= 13312 && code <= 19903 || code >= 63744 && code <= 64255;
}
function toMatchQuery(query) {
  const bigrammed = cjkBigram(query);
  const tokens = bigrammed.split(/\s+/).filter((t) => t.length > 0 && !/["'^*]/.test(t));
  return tokens.map((t) => `"${t}"`).join(" ");
}
var LocalIndex = class {
  db;
  insertStmt;
  ftsDeleteStmt;
  searchStmt;
  countStmt;
  constructor(dbPath) {
    const isInMemory = dbPath === ":memory:";
    const path = isInMemory ? ":memory:" : resolve2(
      dbPath && dbPath.trim() !== "" ? dbPath : resolve2(homedir2(), ".dsh-plugin-linuxdo", "knowledge.db")
    );
    if (!isInMemory) {
      mkdirSync2(dirname2(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO posts (site, topic_id, post_id, post_number, title, author, content, url, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.ftsDeleteStmt = this.db.prepare("DELETE FROM posts_fts WHERE rowid = ?");
    this.searchStmt = this.db.prepare(`
      SELECT p.topic_id, p.post_id, p.post_number, p.title, p.author, p.url,
             bm25(posts_fts, 3.0, 1.0, 2.0) AS rank
      FROM posts_fts f
      JOIN posts p ON p.rowid = f.rowid
      WHERE posts_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.countStmt = this.db.prepare("SELECT COUNT(*) AS n FROM posts");
  }
  /** 写入或更新一条帖子索引（双写主表与 FTS 表）。 */
  index(post) {
    const existing = this.db.prepare("SELECT rowid FROM posts WHERE site = ? AND post_id = ?").get(post.site, post.postId);
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
      (/* @__PURE__ */ new Date()).toISOString()
    );
    this.db.prepare("INSERT INTO posts_fts (rowid, title, content, author) VALUES (?, ?, ?, ?)").run(result.lastInsertRowid, title, content, author);
  }
  /** 全文检索；查询词经同一 bigram 管线处理。 */
  search(query, options = {}) {
    const match = toMatchQuery(query);
    if (match === "") return [];
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const rows = this.searchStmt.all(match, limit);
    const hits = rows.map((row) => ({
      topicId: row.topic_id,
      postId: row.post_id,
      postNumber: row.post_number,
      title: row.title,
      author: row.author,
      url: row.url,
      rank: row.rank
    }));
    if (options.site) {
      const filtered = this.db.prepare("SELECT post_id FROM posts WHERE site = ?").all(options.site);
      const allowed = new Set(filtered.map((r) => r.post_id));
      return hits.filter((hit) => allowed.has(hit.postId));
    }
    return hits;
  }
  count() {
    const row = this.countStmt.get();
    return row?.n ?? 0;
  }
  close() {
    this.db.close();
  }
};

// src/core/topic-cursor-store.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname3, resolve as resolve3 } from "node:path";
import { homedir as homedir3 } from "node:os";
var TopicCursorStore = class {
  filePath;
  cursors;
  constructor(filePath) {
    this.filePath = filePath && filePath.trim() !== "" ? resolve3(filePath) : resolve3(homedir3(), ".dsh-plugin-linuxdo", "topic-cursors.json");
  }
  loadAll() {
    if (this.cursors) return this.cursors;
    this.cursors = /* @__PURE__ */ new Map();
    try {
      const raw = JSON.parse(readFileSync2(this.filePath, "utf8"));
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value?.lastPostNumber === "number" && typeof value?.lastReadAt === "string") {
          this.cursors.set(Number(key), value);
        }
      }
    } catch {
    }
    return this.cursors;
  }
  get(topicId) {
    return this.loadAll().get(topicId);
  }
  set(topicId, lastPostNumber) {
    const map = this.loadAll();
    map.set(topicId, { lastPostNumber, lastReadAt: (/* @__PURE__ */ new Date()).toISOString() });
    try {
      mkdirSync3(dirname3(this.filePath), { recursive: true });
      writeFileSync2(this.filePath, JSON.stringify(Object.fromEntries(map)));
    } catch {
    }
  }
};

// src/config.ts
var DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var DEFAULT_CONFIG = {
  baseUrl: "https://linux.do",
  userAgent: DEFAULT_USER_AGENT,
  maxConcurrent: 2,
  windowMax: 4,
  windowSeconds: 3,
  topicCacheTtlMs: 10 * 60 * 1e3,
  searchCacheTtlMs: 60 * 1e3,
  maxOutputChars: 8e3,
  sessionFile: "",
  callbackHost: "127.0.0.1",
  callbackPort: 0,
  callbackTimeoutMs: 10 * 60 * 1e3,
  curlImpersonatePath: "",
  localIndexEnabled: true,
  sites: []
};
function num(value) {
  if (value === void 0 || value.trim() === "") return void 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : void 0;
}
function bool(value) {
  if (value === void 0 || value.trim() === "") return void 0;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
function resolveSites(config) {
  if (config.sites.length > 0) {
    return config.sites.map((site, i) => ({
      ...site,
      name: site.name || `site-${i}`
    }));
  }
  const host = safeHost(config.baseUrl);
  return [
    {
      name: host || "default",
      baseUrl: config.baseUrl,
      sessionFile: config.sessionFile || void 0
    }
  ];
}
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
function resolveConfig(inline, env = process.env) {
  const fromEnv = {};
  if (env.LINUXDO_BASE_URL) fromEnv.baseUrl = env.LINUXDO_BASE_URL;
  if (env.LINUXDO_USER_AGENT) fromEnv.userAgent = env.LINUXDO_USER_AGENT;
  const concurrent = num(env.LINUXDO_MAX_CONCURRENT);
  if (concurrent !== void 0) fromEnv.maxConcurrent = Math.max(1, Math.floor(concurrent));
  const windowMax = num(env.LINUXDO_WINDOW_MAX);
  if (windowMax !== void 0) fromEnv.windowMax = Math.floor(windowMax);
  const windowSeconds = num(env.LINUXDO_WINDOW_SECONDS);
  if (windowSeconds !== void 0) fromEnv.windowSeconds = Math.floor(windowSeconds);
  const maxChars = num(env.LINUXDO_MAX_OUTPUT_CHARS);
  if (maxChars !== void 0) fromEnv.maxOutputChars = Math.floor(maxChars);
  if (env.LINUXDO_SESSION_FILE) fromEnv.sessionFile = env.LINUXDO_SESSION_FILE;
  if (env.LINUXDO_CURL_IMPERSONATE) fromEnv.curlImpersonatePath = env.LINUXDO_CURL_IMPERSONATE;
  const localIndex = bool(env.LINUXDO_LOCAL_INDEX);
  if (localIndex !== void 0) fromEnv.localIndexEnabled = localIndex;
  return {
    ...DEFAULT_CONFIG,
    ...fromEnv,
    ...inline ?? {}
  };
}

// node_modules/@deepseek-ai/cosmokit/lib/index.js
function isNullable(value) {
  return value === null || value === void 0;
}
function isPlainObject(data) {
  return data && typeof data === "object" && !Array.isArray(data);
}
function filterKeys(object, filter) {
  return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
function mapValues(object, transform) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
function pick(source, keys, forced) {
  if (!keys) return { ...source };
  const result = {};
  for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
  return result;
}
function defineProperty(object, key, value) {
  return Object.defineProperty(object, key, {
    writable: true,
    value,
    enumerable: false
  });
}
function is(type, value) {
  if (arguments.length === 1) return (value2) => is(type, value2);
  return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
  return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
  return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
var Binary;
(function(Binary2) {
  Binary2.is = isArrayBufferLike;
  Binary2.isSource = isArrayBufferSource;
  function fromSource(source) {
    if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    else return source;
  }
  Binary2.fromSource = fromSource;
  function toBase64(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
    let binary = "";
    const bytes = new Uint8Array(source);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  Binary2.toBase64 = toBase64;
  function fromBase64(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
    return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
  }
  Binary2.fromBase64 = fromBase64;
  function toHex(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
    return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  Binary2.toHex = toHex;
  function fromHex(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
    const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
    const buffer = [];
    for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
    return Uint8Array.from(buffer).buffer;
  }
  Binary2.fromHex = fromHex;
})(Binary || (Binary = {}));
var base64ToArrayBuffer = Binary.fromBase64;
var arrayBufferToBase64 = Binary.toBase64;
var hexToArrayBuffer = Binary.fromHex;
var arrayBufferToHex = Binary.toHex;
function clone(source, refs = /* @__PURE__ */ new Map()) {
  if (!source || typeof source !== "object") return source;
  if (is("Date", source)) return new Date(source.valueOf());
  if (is("RegExp", source)) return new RegExp(source.source, source.flags);
  if (isArrayBufferLike(source)) return source.slice(0);
  if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const cached = refs.get(source);
  if (cached) return cached;
  if (Array.isArray(source)) {
    const result2 = [];
    refs.set(source, result2);
    source.forEach((value, index) => {
      result2[index] = Reflect.apply(clone, null, [value, refs]);
    });
    return result2;
  }
  const result = Object.create(Object.getPrototypeOf(source));
  refs.set(source, result);
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
    if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
    Reflect.defineProperty(result, key, descriptor);
  }
  return result;
}
function deepEqual(a, b, strict) {
  if (a === b) return true;
  if (!strict && isNullable(a) && isNullable(b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (!a || !b) return false;
  function check(test, then) {
    return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
  }
  return check(Array.isArray, (a2, b2) => a2.length === b2.length && a2.every((item, index) => deepEqual(item, b2[index]))) ?? check(is("Date"), (a2, b2) => a2.valueOf() === b2.valueOf()) ?? check(is("RegExp"), (a2, b2) => a2.source === b2.source && a2.flags === b2.flags) ?? check(isArrayBufferLike, (a2, b2) => {
    if (a2.byteLength !== b2.byteLength) return false;
    const viewA = new Uint8Array(a2);
    const viewB = new Uint8Array(b2);
    for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
    return true;
  }) ?? Object.keys({
    ...a,
    ...b
  }).every((key) => deepEqual(a[key], b[key], strict));
}
function tokenize(source, delimiters, delimiter) {
  const output = [];
  let state = 0;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      if (state === 1) {
        const next = source.charCodeAt(i + 1);
        if (next >= 97 && next <= 122) output.push(delimiter);
        output.push(code + 32);
      } else {
        if (state !== 0) output.push(delimiter);
        output.push(code + 32);
      }
      state = 1;
    } else if (code >= 97 && code <= 122) {
      output.push(code);
      state = 2;
    } else if (delimiters.includes(code)) {
      if (state !== 0) output.push(delimiter);
      state = 0;
    } else output.push(code);
  }
  return String.fromCharCode(...output);
}
function paramCase(source) {
  return tokenize(source, [45, 95], 45);
}
var hyphenate = paramCase;
var Time;
(function(Time2) {
  Time2.millisecond = 1;
  Time2.second = 1e3;
  Time2.minute = Time2.second * 60;
  Time2.hour = Time2.minute * 60;
  Time2.day = Time2.hour * 24;
  Time2.week = Time2.day * 7;
  let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
  function setTimezoneOffset(offset) {
    timezoneOffset = offset;
  }
  Time2.setTimezoneOffset = setTimezoneOffset;
  function getTimezoneOffset() {
    return timezoneOffset;
  }
  Time2.getTimezoneOffset = getTimezoneOffset;
  function getDateNumber(date2 = /* @__PURE__ */ new Date(), offset) {
    if (typeof date2 === "number") date2 = new Date(date2);
    if (offset === void 0) offset = timezoneOffset;
    return Math.floor((date2.valueOf() / Time2.minute - offset) / 1440);
  }
  Time2.getDateNumber = getDateNumber;
  function fromDateNumber(value, offset) {
    const date2 = new Date(value * Time2.day);
    if (offset === void 0) offset = timezoneOffset;
    return new Date(+date2 + offset * Time2.minute);
  }
  Time2.fromDateNumber = fromDateNumber;
  const numeric = /\d+(?:\.\d+)?/.source;
  const timeRegExp = new RegExp(`^${[
    "w(?:eek(?:s)?)?",
    "d(?:ay(?:s)?)?",
    "h(?:our(?:s)?)?",
    "m(?:in(?:ute)?(?:s)?)?",
    "s(?:ec(?:ond)?(?:s)?)?"
  ].map((unit) => `(${numeric}${unit})?`).join("")}$`);
  function parseTime(source) {
    const capture = timeRegExp.exec(source);
    if (!capture) return 0;
    return (parseFloat(capture[1]) * Time2.week || 0) + (parseFloat(capture[2]) * Time2.day || 0) + (parseFloat(capture[3]) * Time2.hour || 0) + (parseFloat(capture[4]) * Time2.minute || 0) + (parseFloat(capture[5]) * Time2.second || 0);
  }
  Time2.parseTime = parseTime;
  function parseDate(date2) {
    const parsed = parseTime(date2);
    if (parsed) date2 = Date.now() + parsed;
    else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date2}`;
    else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date2}`;
    return date2 ? new Date(date2) : /* @__PURE__ */ new Date();
  }
  Time2.parseDate = parseDate;
  function format(ms) {
    const abs = Math.abs(ms);
    if (abs >= Time2.day - Time2.hour / 2) return Math.round(ms / Time2.day) + "d";
    else if (abs >= Time2.hour - Time2.minute / 2) return Math.round(ms / Time2.hour) + "h";
    else if (abs >= Time2.minute - Time2.second / 2) return Math.round(ms / Time2.minute) + "m";
    else if (abs >= Time2.second) return Math.round(ms / Time2.second) + "s";
    return ms + "ms";
  }
  Time2.format = format;
  function toDigits(source, length = 2) {
    return source.toString().padStart(length, "0");
  }
  Time2.toDigits = toDigits;
  function template(template2, time = /* @__PURE__ */ new Date()) {
    return template2.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
  }
  Time2.template = template;
})(Time || (Time = {}));

// node_modules/@deepseek-ai/cordis/lib/index.js
var DisposableList = class {
  sn = 0;
  map = /* @__PURE__ */ new Map();
  weak = /* @__PURE__ */ new WeakMap();
  get length() {
    return this.map.size;
  }
  push(value) {
    const sn = ++this.sn;
    this.map.set(sn, value);
    this.weak.set(value, sn);
    return () => this.map.delete(sn);
  }
  delete(value) {
    const sn = this.weak.get(value);
    if (!sn) return false;
    return this.map.delete(sn);
  }
  clear() {
    const values = [...this.map.values()];
    this.map.clear();
    return values.reverse();
  }
  [Symbol.iterator]() {
    return this.map.values();
  }
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return [...this];
  }
};
var symbols = {
  shadow: /* @__PURE__ */ Symbol.for("cordis.shadow"),
  receiver: /* @__PURE__ */ Symbol.for("cordis.receiver"),
  original: /* @__PURE__ */ Symbol.for("cordis.original"),
  metadata: /* @__PURE__ */ Symbol.for("cordis.metadata"),
  initHooks: /* @__PURE__ */ Symbol.for("cordis.initHooks"),
  checkProto: /* @__PURE__ */ Symbol.for("cordis.checkProto"),
  effect: /* @__PURE__ */ Symbol.for("cordis.effect"),
  filter: /* @__PURE__ */ Symbol.for("cordis.filter"),
  isolate: /* @__PURE__ */ Symbol.for("cordis.isolate"),
  intercept: /* @__PURE__ */ Symbol.for("cordis.intercept"),
  init: /* @__PURE__ */ Symbol.for("cordis.init"),
  check: /* @__PURE__ */ Symbol.for("cordis.check"),
  config: /* @__PURE__ */ Symbol.for("cordis.config"),
  invoke: /* @__PURE__ */ Symbol.for("cordis.invoke"),
  extend: /* @__PURE__ */ Symbol.for("cordis.extend"),
  tracker: /* @__PURE__ */ Symbol.for("cordis.tracker"),
  resolveConfig: /* @__PURE__ */ Symbol.for("cordis.resolveConfig")
};
var GeneratorFunction = function* () {
}.constructor;
var AsyncGeneratorFunction = async function* () {
}.constructor;
function isConstructor(func) {
  if (!func.prototype) return false;
  if (func instanceof GeneratorFunction) return false;
  if (AsyncGeneratorFunction !== Function && func instanceof AsyncGeneratorFunction) return false;
  return true;
}
function joinPrototype(proto1, proto2) {
  if (proto1 === Object.prototype) return proto2;
  const result = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2));
  for (const key of Reflect.ownKeys(proto1)) Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto1, key));
  return result;
}
function isObject(value) {
  return value && (typeof value === "object" || typeof value === "function");
}
function getPropertyDescriptor(target, prop) {
  let proto = target;
  while (proto) {
    const desc = Reflect.getOwnPropertyDescriptor(proto, prop);
    if (desc) return desc;
    proto = Object.getPrototypeOf(proto);
  }
}
function getTraceable(ctx, value) {
  if (!isObject(value)) return value;
  if (Object.hasOwn(value, symbols.shadow)) return Object.getPrototypeOf(value);
  const tracker = value[symbols.tracker];
  if (!tracker) return value;
  return createTraceable(ctx, value, tracker);
}
function withProps(target, props) {
  if (!props) return target;
  return new Proxy(target, {
    get: (target2, prop, receiver) => {
      if (prop in props && prop !== "constructor") return Reflect.get(props, prop, receiver);
      return Reflect.get(target2, prop, receiver);
    },
    set: (target2, prop, value, receiver) => {
      if (prop in props && prop !== "constructor") return Reflect.set(props, prop, value, receiver);
      return Reflect.set(target2, prop, value, receiver);
    }
  });
}
function withProp(target, prop, value) {
  return withProps(target, Object.defineProperty(/* @__PURE__ */ Object.create(null), prop, {
    value,
    writable: false
  }));
}
function createShadow(ctx, target, property2, receiver) {
  if (!property2) return receiver;
  const origin = Reflect.getOwnPropertyDescriptor(target, property2)?.value;
  if (!origin) return receiver;
  return withProp(receiver, property2, ctx.extend({ [symbols.shadow]: origin }));
}
function createShadowMethod(ctx, value, outer, shadow) {
  return new Proxy(value, { apply: (target, thisArg, args) => {
    if (thisArg === outer) thisArg = shadow;
    return getTraceable(ctx, Reflect.apply(target, thisArg, args));
  } });
}
function createTraceable(ctx, value, tracker) {
  if (ctx[symbols.shadow] && !tracker.noShadow) ctx = Object.getPrototypeOf(ctx);
  const proxy = new Proxy(value, {
    get: (target, prop, receiver) => {
      if (prop === symbols.original) return target;
      if (prop === tracker.property) return ctx;
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      if (tracker.associate && ctx.reflect.props[`${tracker.associate}.${prop}`]) return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver));
      let shadow, innerValue;
      const desc = getPropertyDescriptor(target, prop);
      if (desc && "value" in desc) innerValue = desc.value;
      else {
        shadow = createShadow(ctx, target, tracker.property, receiver);
        innerValue = Reflect.get(target, prop, shadow);
      }
      const innerTracker = innerValue?.[symbols.tracker];
      if (innerTracker) return createTraceable(ctx, innerValue, innerTracker);
      else if (!tracker.noShadow && typeof innerValue === "function") {
        shadow ??= createShadow(ctx, target, tracker.property, receiver);
        return createShadowMethod(ctx, innerValue, receiver, shadow);
      } else return innerValue;
    },
    set: (target, prop, value2, receiver) => {
      if (prop === symbols.original) return false;
      if (prop === tracker.property) return false;
      if (typeof prop === "symbol") return Reflect.set(target, prop, value2, receiver);
      if (tracker.associate && ctx.reflect.props[`${tracker.associate}.${prop}`]) return Reflect.set(ctx, `${tracker.associate}.${prop}`, value2, withProp(ctx, symbols.receiver, receiver));
      const shadow = createShadow(ctx, target, tracker.property, receiver);
      return Reflect.set(target, prop, value2, shadow);
    },
    apply: (target, thisArg, args) => {
      return applyTraceable(proxy, target, thisArg, args);
    }
  });
  return proxy;
}
function applyTraceable(proxy, value, thisArg, args) {
  if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args);
  return value[symbols.invoke].apply(proxy, args);
}
function createCallable(name2, proto, tracker) {
  const self = function(...args) {
    return applyTraceable(createTraceable(self["ctx"], self, tracker), self, this, args);
  };
  defineProperty(self, "name", name2);
  return Object.setPrototypeOf(self, proto);
}
function handleError(info, reason, getOuterStack) {
  const innerLines = info.error.stack.split("\n");
  if (typeof reason?.stack !== "string") {
    const outerError = new Error(reason);
    const lines2 = outerError.stack.split("\n");
    lines2.splice(1, Infinity, ...getOuterStack());
    outerError.stack = lines2.join("\n");
    throw outerError;
  }
  const lines = reason.stack.split("\n");
  let index = lines.indexOf(innerLines[2]);
  if (index === -1) throw reason;
  index -= info.offset;
  while (index > 0) {
    if (!lines[index - 1].endsWith(" (<anonymous>)")) break;
    index -= 1;
  }
  lines.splice(index, Infinity, ...getOuterStack());
  reason.stack = lines.join("\n");
  throw reason;
}
function composeError(callback, getOuterStack = buildOuterStack()) {
  const info = {
    offset: 1,
    error: /* @__PURE__ */ new Error()
  };
  try {
    const result = callback(info);
    if (isObject(result) && "then" in result) return result.then(void 0, (reason) => handleError(info, reason, getOuterStack));
    else return result;
  } catch (reason) {
    handleError(info, reason, getOuterStack);
  }
}
function buildOuterStack(offset = 0) {
  const outerError = /* @__PURE__ */ new Error();
  return () => outerError.stack.split("\n").slice(3 + offset);
}
function isBailed(value) {
  return value !== null && value !== false && value !== void 0;
}
var EventsService = class {
  ctx;
  _hooks = {};
  constructor(ctx) {
    this.ctx = ctx;
    defineProperty(this, symbols.tracker, {
      property: "ctx",
      noShadow: true
    });
    this.on("internal/listener", function(name2, listener, options) {
      if (name2 === "internal/update" && !options.global) return (this.fiber._hooks["internal/update"] ??= new DisposableList())[options.prepend ? "unshift" : "push"](listener);
    });
    this.on("internal/update", function(config, noSave, next) {
      const cbs = [...this._hooks["internal/update"] || []];
      const _next = () => {
        return (cbs.shift() ?? next).call(this, config, noSave, _next);
      };
      return _next();
    }, {
      global: true,
      prepend: true
    });
  }
  /**
  * Resolve listeners for one dispatch and apply context filtering.
  *
  * @param type — the dispatch mode, reported on `internal/dispatch`.
  * @param args — the raw dispatch arguments; consumed up to the event name.
  * @returns the matching listener callbacks, bound to the dispatch `this`.
  */
  dispatch(type, args) {
    const thisArg = typeof args[0] === "object" || typeof args[0] === "function" ? args.shift() : null;
    const name2 = args.shift();
    if (!name2.startsWith("internal/")) this.emit("internal/dispatch", type, name2, args, thisArg);
    const filter = thisArg?.[Context.filter];
    return (this._hooks[name2] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx)).map((hook) => hook.callback.bind(thisArg));
  }
  /**
  * Run listeners concurrently and wait for all of them.
  *
  * @param args — optional `this`, the event name, then listener arguments.
  * @returns a promise resolving once every listener has settled.
  */
  async parallel(...args) {
    const errors = (await Promise.allSettled(this.dispatch("emit", args).map(async (cb) => cb(...args)))).filter((result) => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map((error) => error.reason));
  }
  /**
  * Run listeners synchronously without waiting for returned promises.
  *
  * @param args — optional `this`, the event name, then listener arguments.
  */
  emit(...args) {
    this.dispatch("emit", args).map((cb) => cb(...args));
  }
  /**
  * Run listeners in order, awaiting each, until one returns a bail value.
  *
  * @param args — optional `this`, the event name, then listener arguments.
  * @returns the first bail value (see {@link isBailed}), if any.
  */
  async serial(...args) {
    for (const cb of this.dispatch("serial", args)) {
      const result = await cb(...args);
      if (isBailed(result)) return result;
    }
  }
  /**
  * Run listeners synchronously until one returns a bail value.
  *
  * @param args — optional `this`, the event name, then listener arguments.
  * @returns the first bail value (see {@link isBailed}), if any.
  */
  bail(...args) {
    for (const cb of this.dispatch("bail", args)) {
      const result = cb(...args);
      if (isBailed(result)) return result;
    }
  }
  /**
  * Compose listeners around the final `next` callback.
  *
  * The last dispatch argument is treated as the innermost `next`. Listeners
  * run outermost-first; a listener that does not call `next()` vetoes the
  * rest of the chain, including the built-in behavior.
  *
  * @param args — optional `this`, the event name, listener arguments, then `next`.
  * @returns the outermost listener's return value.
  */
  waterfall(...args) {
    const cbs = this.dispatch("waterfall", args);
    const inner = args.pop();
    const next = () => {
      return (cbs.shift() ?? inner)(...args);
    };
    args.push(next);
    return next();
  }
  /**
  * Store a listener record as an effect on the current fiber.
  *
  * @param label — effect label shown in fiber diagnostics.
  * @param hooks — the listener list for one event.
  * @param callback — the listener to store.
  * @param options — placement and filtering options.
  * @returns a disposer that unregisters the listener.
  */
  register(label, hooks, callback, options) {
    const method = options.prepend ? "unshift" : "push";
    return this.ctx.fiber.effect(() => {
      hooks[method]({
        ctx: this.ctx,
        callback,
        ...options
      });
      return () => this.unregister(hooks, callback);
    }, label);
  }
  /**
  * Remove a stored listener record.
  *
  * @param hooks — the listener list for one event.
  * @param callback — the listener to remove.
  * @returns `true` if the listener was found and removed.
  */
  unregister(hooks, callback) {
    const index = hooks.findIndex((hook) => hook.callback === callback);
    if (index >= 0) {
      hooks.splice(index, 1);
      return true;
    }
  }
  /**
  * Register an event listener owned by the current fiber.
  *
  * The listener is removed automatically when the fiber unloads. Throws
  * `CordisError('INACTIVE_EFFECT')` if the fiber is already disposed.
  *
  * @param name — the event name to listen for.
  * @param listener — called with the dispatch arguments.
  * @param options — listener options; a boolean is shorthand for `prepend`.
  * @returns a disposer removing the listener; `true` if it was still registered.
  */
  on(name2, listener, options) {
    if (typeof options !== "object") options = { prepend: options };
    this.ctx.fiber.assertActive();
    listener = this.ctx.reflect.bind(listener);
    const result = this.bail(this.ctx, "internal/listener", name2, listener, options);
    if (result) return result;
    const hooks = this._hooks[name2] ||= [];
    const label = `ctx.on(${typeof name2 === "string" ? JSON.stringify(name2) : name2.toString()})`;
    return this.register(label, hooks, listener, options);
  }
  /**
  * Register an event listener that disposes itself after the first call.
  *
  * @param name — the event name to listen for.
  * @param listener — called at most once with the dispatch arguments.
  * @param options — listener options; a boolean is shorthand for `prepend`.
  * @returns a disposer removing the listener; `true` if it was still registered.
  */
  once(name2, listener, options) {
    const dispose = this.on(name2, function(...args) {
      dispose();
      return listener.apply(this, args);
    }, options);
    return dispose;
  }
};
var defaultFormatters = {
  s: (value) => String(value),
  d: (value) => Math.trunc(Number(value)),
  i: (value) => Math.trunc(Number(value)),
  f: (value) => Number(value),
  o: (value) => JSON.stringify(value),
  O: (value) => JSON.stringify(value),
  c: () => "",
  C: (value, exporter, message) => {
    return Logger.color(exporter, Logger.code(message.name, exporter.colors), value);
  }
};
function isAggregateError(error) {
  return error instanceof Error && Array.isArray(error["errors"]);
}
var Logger = class {
  service;
  static color(exporter, code, value, decoration = "") {
    if (!exporter.colors) return "" + value;
    return `\x1B[3${code < 8 ? code : "8;5;" + code}${exporter.colors >= 2 ? decoration : ""}m${value}\x1B[0m`;
  }
  static code(name2, level) {
    let hash = 0;
    for (let i = 0; i < name2.length; i++) {
      hash = (hash << 3) - hash + name2.charCodeAt(i) + 13;
      hash |= 0;
    }
    const colors = !level ? [] : level >= 2 ? c256 : c16;
    return colors[Math.abs(hash) % colors.length];
  }
  static format(exporter, message) {
    const args = message.args.slice();
    if (args[0] instanceof Error) {
      args[0] = args[0].stack || args[0].message;
      args.unshift("%s");
    } else if (typeof args[0] !== "string") args.unshift("%o");
    let format = args.shift();
    format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
      if (match === "%%") return "%";
      const formatter = exporter.formatters?.[char] ?? defaultFormatters[char];
      if (typeof formatter === "function") return formatter(args.shift(), exporter, message);
      return match;
    });
    const oFormatter = exporter.formatters?.o ?? defaultFormatters.o;
    for (let arg of args) {
      if (typeof arg === "object" && arg) arg = oFormatter(arg, exporter, message);
      format += " " + arg;
    }
    const { maxLength = 10240 } = exporter;
    return format.split(/\r?\n/g).map((line) => {
      return line.slice(0, maxLength) + (line.length > maxLength ? "..." : "");
    }).join("\n");
  }
  constructor(options, service) {
    this.service = service;
    Object.assign(this, options);
    this.error = this._method("error", 0);
    this.info = this._method("info", 1);
    this.warn = this._method("warn", 2);
    this.debug = this._method("debug", 3);
  }
  _method(type, level) {
    return (...args) => {
      if (args.length === 1 && args[0] instanceof Error) {
        if (args[0].cause) this[type](args[0].cause);
        else if (isAggregateError(args[0])) {
          args[0].errors.forEach((error) => this[type](error));
          return;
        }
      }
      const sn = ++this.service._snMessage;
      const ts = Date.now();
      for (const exporter of this.service.exporters.values()) {
        if ((exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? 1) < level) continue;
        const message = {
          sn,
          ts,
          type,
          level,
          name: this.name,
          ...this.meta,
          args
        };
        exporter.export(message);
      }
    };
  }
};
var c16 = [
  6,
  2,
  3,
  4,
  5,
  1
];
var c256 = [
  20,
  21,
  26,
  27,
  32,
  33,
  38,
  39,
  40,
  41,
  42,
  43,
  44,
  45,
  56,
  57,
  62,
  63,
  68,
  69,
  74,
  75,
  76,
  77,
  78,
  79,
  80,
  81,
  92,
  93,
  98,
  99,
  112,
  113,
  129,
  134,
  135,
  148,
  149,
  160,
  161,
  162,
  163,
  164,
  165,
  166,
  167,
  168,
  169,
  170,
  171,
  172,
  173,
  178,
  179,
  184,
  185,
  196,
  197,
  198,
  199,
  200,
  201,
  202,
  203,
  204,
  205,
  206,
  207,
  208,
  209,
  214,
  215,
  220,
  221
];
var LoggerService = class LoggerService2 {
  bufferSize = 1e3;
  buffer = [];
  ctx;
  _snMessage = 0;
  _snExporter = 0;
  exporters = /* @__PURE__ */ new Map();
  constructor(ctx) {
    const tracker = {
      property: "ctx",
      noShadow: true
    };
    const self = createCallable("logger", joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
    Object.assign(self, this);
    self.ctx = ctx;
    defineProperty(self, symbols.tracker, tracker);
    self.exporter({
      colors: 3,
      export: (message) => {
        self.buffer.push(message);
        if (self.buffer.length > self.bufferSize) self.buffer = self.buffer.slice(-self.bufferSize);
      }
    });
    return self;
  }
  /**
  * Register an exporter and dispose it with the current fiber.
  *
  * @param exporter — the sink that receives structured log messages.
  * @returns a disposer that removes the exporter.
  */
  exporter(exporter) {
    return this.ctx.effect(() => {
      this.exporters.set(++this._snExporter, exporter);
      return () => this.exporters.delete(this._snExporter);
    }, "ctx.logger.exporter()");
  }
  _resolveConfig() {
    let intercept = this.ctx[symbols.intercept];
    const configs = [];
    while ("logger" in intercept) {
      if (Object.hasOwn(intercept, "logger")) configs.unshift(intercept["logger"]);
      intercept = Object.getPrototypeOf(intercept);
    }
    return Object.assign({}, ...configs);
  }
  [symbols.invoke](name2) {
    const config = this._resolveConfig();
    const fiber = (this.ctx[symbols.shadow] ?? this.ctx).fiber;
    name2 ??= config.name;
    name2 ??= hyphenate(fiber.name);
    return new Logger({
      name: name2,
      level: config.level,
      meta: { fiber: new WeakRef(fiber) }
    }, this);
  }
  static {
    for (const type of [
      "error",
      "info",
      "warn",
      "debug"
    ]) LoggerService2.prototype[type] = function(...args) {
      return this()[type](...args);
    };
  }
};
function enhanceError(error) {
  const lines = error.stack.split("\n");
  lines.splice(0, 2, `Error: ${error.message}`);
  error.stack = lines.join("\n");
  return error;
}
var RESERVED_WORDS = ["prototype", "then"];
function isSpecialProperty(prop) {
  return typeof prop === "symbol" || RESERVED_WORDS.includes(prop) || parseInt(prop).toString() === prop || prop.startsWith("_");
}
var ReflectService = class {
  ctx;
  /** Proxy traps implementing service resolution for every context object. */
  static handler = {
    get: (target, prop, ctx) => {
      if (isSpecialProperty(prop)) return Reflect.get(target, prop, ctx);
      if (Reflect.has(target, prop)) return getTraceable(ctx, Reflect.get(target, prop, ctx));
      const error = /* @__PURE__ */ new Error(`cannot get property "${prop}" without inject`);
      try {
        const def = target.reflect.props[prop];
        if (def?.type === "accessor") return def.get.call(ctx, ctx[symbols.receiver], error);
        if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false);
        return ctx.events.waterfall("internal/get", ctx, prop, error, () => {
          const key = target[symbols.isolate][prop];
          let fiber = (ctx[symbols.shadow] ?? ctx).fiber;
          while (true) {
            const impl = fiber.store?.[prop];
            if (impl) return getTraceable(ctx, impl.value);
            if (prop in fiber.inject) {
              error.message = `cannot get required service "${prop}" in inactive context`;
              throw error;
            }
            if (!fiber.runtime) throw error;
            if (fiber.parent[symbols.isolate][prop] !== key) throw error;
            fiber = fiber.parent.fiber;
          }
        });
      } catch (e) {
        throw e === error ? enhanceError(e) : e;
      }
    },
    set: (target, prop, value, ctx) => {
      if (isSpecialProperty(prop)) return Reflect.set(target, prop, value, ctx);
      const error = /* @__PURE__ */ new Error(`cannot set property "${prop}" without provide`);
      const def = target.reflect.props[prop];
      if (!def) {
        if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx);
        throw enhanceError(error);
      }
      try {
        if (def.type === "accessor") {
          if (!def.set) return false;
          return def.set.call(ctx, value, ctx[symbols.receiver], error);
        }
        return ctx.events.waterfall("internal/set", ctx, prop, value, error, () => {
          return ctx.reflect.set(prop, value, error);
        });
      } catch (e) {
        throw e === error ? enhanceError(e) : e;
      }
    },
    has: (target, prop) => {
      if (isSpecialProperty(prop)) return Reflect.has(target, prop);
      if (Reflect.has(target, prop)) return true;
      return !!target.reflect.props[prop];
    }
  };
  /** Service implementations, keyed by isolation label. */
  store = /* @__PURE__ */ Object.create(null);
  /** Declared context properties (services and accessors), by name. */
  props = /* @__PURE__ */ Object.create(null);
  constructor(ctx) {
    this.ctx = ctx;
    defineProperty(this, symbols.tracker, {
      property: "ctx",
      noShadow: true
    });
    this.mixin("reflect", [
      "get",
      "set",
      "provide",
      "accessor",
      "mixin"
    ]);
    this.mixin("fiber", ["runtime", "effect"]);
    this.mixin("registry", ["inject", "plugin"]);
    this.mixin("events", [
      "on",
      "once",
      "parallel",
      "emit",
      "serial",
      "bail",
      "waterfall"
    ]);
  }
  /**
  * Read a service from the store without the inject requirement.
  *
  * @param name — the service name.
  * @param strict — when `true`, only return implementations whose providing
  * fiber is currently active.
  * @returns the service value, or `undefined` when not (yet) provided.
  */
  get(name2, strict = true) {
    return getTraceable(this.ctx, this._getImpl(name2, strict)?.value);
  }
  _getImpl(name2, strict = true) {
    const key = this.ctx[symbols.isolate][name2];
    const impl = key && this.store[key];
    if (!impl) return;
    if (strict && impl.fiber.state !== 2) return;
    return impl;
  }
  /**
  * Overwrite a provided service's value.
  *
  * @param name — the service name.
  * @param value — the new service value.
  * @param error — carrier for the caller stack in diagnostics.
  * @returns `true` on success.
  * @throws when `name` was never provided, or was provided by another fiber.
  */
  set(name2, value, error) {
    const key = this.ctx[symbols.isolate][name2];
    const impl = this.store[key];
    if (!impl) throw new Error(`cannot set property "${name2}" without provide`);
    if (impl.fiber !== this.ctx.fiber) throw new Error(`cannot set property "${name2}" in multiple fibers`);
    impl.value = value;
    return true;
  }
  /**
  * Register a service implementation owned by the current fiber.
  *
  * See the `ctx.provide()` overload above for the full contract.
  *
  * @param name — the service name.
  * @param value — the service value.
  * @param check — optional availability predicate for dependents.
  * @returns a disposer that unregisters the service.
  */
  provide(name2, value, check) {
    return this.ctx.fiber.effect(() => {
      if (!this.props[name2]) this.props[name2] ??= { type: "service" };
      else if (this.props[name2].type !== "service") throw new Error(`property "${name2}" is already declared as ${this.props[name2].type}`);
      this.props[name2] = { type: "service" };
      this.ctx.root[symbols.isolate][name2] ??= Symbol(name2);
      const key = this.ctx[symbols.isolate][name2];
      const impl = {
        name: name2,
        value,
        fiber: this.ctx.fiber,
        check
      };
      if (this.store[key]) throw new Error(`service "${name2}" has been registered at <${this.store[key].fiber.name}>`);
      this.store[key] = impl;
      this.ctx.fiber.store[name2] = impl;
      if (this.ctx.fiber.state === 2) this.notify([name2]);
      return async () => {
        delete this.store[key];
        const fibers = this.notify([name2]);
        await Promise.allSettled(fibers.map((fiber) => fiber.await()));
        delete this.ctx.fiber.store[name2];
      };
    }, `ctx.provide(${JSON.stringify(name2)})`);
  }
  /**
  * Re-evaluate every fiber that requires one of the given services.
  *
  * @param names — the service names that changed.
  * @param filter — restricts notification to matching isolation scopes.
  * @returns the fibers whose dependency state was refreshed.
  */
  notify(names, filter = (ctx, name2) => ctx[symbols.isolate][name2] === this.ctx[symbols.isolate][name2]) {
    const fibers = [];
    for (const runtime of this.ctx.registry.values()) for (const fiber of runtime.fibers) {
      let hasUpdate = false;
      for (const name2 of names) {
        if (!(name2 in fiber.inject)) continue;
        if (!filter(fiber.ctx, name2)) continue;
        hasUpdate = true;
        fiber._checkImpl(name2);
      }
      if (!hasUpdate) continue;
      fiber._refresh();
      fibers.push(fiber);
    }
    for (const name2 of names) {
      const self = Object.create(this.ctx);
      self[symbols.filter] = (target) => filter(target, name2);
      this.ctx.events.emit(self, "internal/service", name2, this._getImpl(name2, false)?.value);
    }
    return fibers;
  }
  /**
  * Define a computed context property backed by get/set hooks.
  *
  * @param name — the context property name.
  * @param options — the `get` hook and optional `set` hook.
  * @returns a disposer that removes the accessor.
  */
  accessor(name2, options) {
    return this.ctx.fiber.effect(() => {
      if (name2 in this.props) throw new Error(`property "${name2}" is already declared as ${this.props[name2].type}`);
      this.props[name2] = {
        type: "accessor",
        ...options
      };
      return () => delete this.props[name2];
    }, `ctx.accessor(${JSON.stringify(name2)})`);
  }
  /**
  * Expose selected members of a service directly on `ctx`.
  *
  * See the `ctx.mixin()` overload above for the full contract.
  *
  * @param source — a context property name or a source object.
  * @param mixins — keys to forward, or a source-key → ctx-key map.
  * @returns a disposer that removes all created accessors.
  */
  mixin(source, mixins) {
    const self = this;
    return this.ctx.fiber.effect(function* () {
      const entries = Array.isArray(mixins) ? mixins.map((key) => [key, key]) : Object.entries(mixins);
      const getTarget = (ctx, error) => {
        return ctx[source];
      };
      for (const [key, value] of entries) yield self.accessor(value, {
        get(receiver, error) {
          const service = getTarget(this, error);
          if (isNullable(service)) return service;
          const mixin = receiver ? withProps(receiver, service) : service;
          const value2 = Reflect.get(service, key, mixin);
          if (typeof value2 !== "function") return value2;
          return value2.bind(mixin ?? service);
        },
        set(value2, receiver, error) {
          const service = getTarget(this, error);
          const mixin = receiver ? withProps(receiver, service) : service;
          return Reflect.set(service, key, value2, mixin);
        }
      });
    }, `ctx.mixin(${JSON.stringify(source)})`);
  }
  /**
  * Attach this context's tracing wrapper to a value.
  *
  * @param value — the value to wrap.
  * @returns the traceable wrapper (or the value itself when not applicable).
  */
  trace(value) {
    return getTraceable(this.ctx, value);
  }
  /**
  * Wrap a callback so calls trace `this` and arguments to this context.
  *
  * @param callback — the function to wrap.
  * @returns a proxy delegating to `callback` with traced values.
  */
  bind(callback) {
    return new Proxy(callback, {
      apply: (target, thisArg, args) => {
        return Reflect.apply(target, this.trace(thisArg), args.map((arg) => this.trace(arg)));
      },
      construct: (target, args, newTarget) => {
        return Reflect.construct(target, args.map((arg) => this.trace(arg)), newTarget);
      }
    });
  }
};
var kValidationError = /* @__PURE__ */ Symbol.for("ValidationError");
var ValidationError = class extends TypeError {
  name = "ValidationError";
  /**
  * Build the aggregated message from schema issues.
  *
  * @param issues — the standard-schema issues, one message line each.
  */
  constructor(issues) {
    super(`invalid config:
` + issues.map((issue) => {
      if (issue.path) return `  - ${issue.message} (at ${issue.path.join(".")})`;
      else return `  - ${issue.message}`;
    }).join("\n"));
  }
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
function resolveConfig2(runtime, config) {
  if (!runtime.Config) return config;
  const result = runtime.Config["~standard"].validate(config);
  if ("then" in result) throw new TypeError("Async config validation is not supported");
  if (result.issues) throw new ValidationError(result.issues);
  else return result.value;
}
var effectInertia = /* @__PURE__ */ new WeakMap();
function runDisposable(dispose) {
  const result = dispose();
  return effectInertia.get(dispose)?.() ?? result;
}
function emitPluginDisposed(context, fiber) {
  const args = ["internal/plugin", fiber];
  let callbacks;
  try {
    callbacks = context.events.dispatch("emit", args);
  } catch (error) {
    context.logger.error(error);
    return;
  }
  for (const callback of callbacks) try {
    const returned = callback(...args);
    Promise.resolve(returned).catch((error) => context.logger.error(error));
  } catch (error) {
    context.logger.error(error);
  }
}
var CordisError = class CordisError2 extends Error {
  code;
  /**
  * @param code — the stable error code; also the default message.
  * @param message — optional human-readable override.
  */
  constructor(code, message) {
    super(message ?? CordisError2.Code[code]);
    this.code = code;
  }
};
(function(CordisError3) {
  CordisError3.Code = { INACTIVE_EFFECT: "cannot create effect on inactive context" };
})(CordisError || (CordisError = {}));
var INACTIVE = "__INACTIVE__";
var Fiber = class {
  parent;
  inject;
  runtime;
  /** Unique id within the registry; 0 for the root fiber, `null` once disposed. */
  uid;
  /** The context this fiber's plugin runs in (extends the parent context). */
  ctx;
  /** The validated plugin config (updated by `update()`). */
  config;
  /** The raw plugin config, re-resolved before each activation. */
  _config;
  /** Current lifecycle state; transitions emit `internal/status`. */
  state = 0;
  /** Dispose this fiber: unload the plugin, then settle once cleanup finished. */
  dispose;
  /** Snapshot of required service implementations while loaded; `undefined` otherwise. */
  store;
  /** The in-flight load/unload transition, if one is currently running. */
  inertia;
  _hooks = /* @__PURE__ */ Object.create(null);
  _disposables = new DisposableList();
  context;
  _error;
  _runner;
  _store = /* @__PURE__ */ Object.create(null);
  /**
  * Create a fiber. Plugin authors normally obtain fibers from `ctx.plugin()`
  * rather than constructing them directly.
  *
  * @param parent — the context the plugin was loaded from.
  * @param config — raw config, validated against the runtime's schema.
  * @param inject — resolved dependency map (service name → intercept config).
  * @param runtime — the shared plugin runtime, or `null` for the root fiber.
  * @param getOuterStack — captures the caller stack for effect diagnostics.
  */
  constructor(parent, config, inject2, runtime, getOuterStack) {
    this.parent = parent;
    this.inject = inject2;
    this.runtime = runtime;
    this._config = config;
    const collect = (dispose) => {
      this._disposables.push(dispose);
    };
    if (runtime) {
      this.uid = parent.registry.counter;
      this.ctx = this.context = parent.extend({ fiber: this });
      const injectEntries = Object.entries(this.inject);
      if (injectEntries.length) {
        this.ctx[Context.intercept] = Object.create(parent[Context.intercept]);
        for (const [name2, config2] of injectEntries) {
          if (isNullable(config2)) continue;
          this.ctx[Context.intercept][name2] = config2;
        }
      }
      this._runner = {
        epoch: INACTIVE,
        getOuterStack,
        execute: function() {
          if (isConstructor(runtime.callback)) {
            const instance = new runtime.callback(this.ctx, this.config);
            for (const hook of instance?.[symbols.initHooks] ?? []) hook();
            return instance?.[symbols.init]?.();
          } else return runtime.callback(this.ctx, this.config);
        },
        collect
      };
      this.dispose = parent.fiber.effect(() => {
        const remove = runtime.fibers.push(this);
        return async () => {
          this.uid = null;
          emitPluginDisposed(this.context, this);
          if (this.ctx.registry.has(runtime.callback)) {
            remove();
            if (!runtime.fibers.length) this.ctx.registry.delete(runtime.callback);
          }
          this._setEpoch(INACTIVE);
          if (!this.inertia) this._updateState(() => {
            this.inertia = this._unload();
            return 5;
          });
          while (this.inertia) await this.inertia;
        };
      }, "ctx.plugin()");
      try {
        this.context.emit("internal/plugin", this);
      } catch (error) {
        Promise.resolve(this.dispose()).catch((reason) => this.ctx.logger.error(reason));
        throw error;
      }
      if (this.uid !== null && parent.fiber.state !== 5) {
        for (const name2 of Object.keys(this.inject)) this._checkImpl(name2);
        this._refresh();
      }
    } else {
      this.uid = 0;
      this.ctx = this.context = parent;
      this.state = 2;
      this.store = /* @__PURE__ */ Object.create(null);
      this._runner = {
        epoch: "",
        getOuterStack,
        execute: () => {
        },
        collect
      };
      this.dispose = () => this.restart();
    }
  }
  /** The plugin's display name, inherited from the nearest named ancestor, else `'root'`. */
  get name() {
    let fiber = this;
    do {
      if (fiber.runtime?.name) return fiber.runtime.name;
      fiber = fiber.parent.fiber;
    } while (fiber !== fiber.parent.fiber);
    return "root";
  }
  /**
  * Throw if the fiber has already been disposed.
  *
  * @returns nothing when the fiber is still active.
  * @throws {CordisError} `INACTIVE_EFFECT` when the fiber's uid has been cleared.
  */
  assertActive() {
    if (this.uid !== null) return;
    throw new CordisError("INACTIVE_EFFECT");
  }
  _execute(runner) {
    const oldEpoch = runner.epoch;
    return composeError((info) => {
      const safeCollect = (dispose) => {
        if (typeof dispose === "function") runner.collect(dispose);
        else if (!isNullable(dispose)) throw new TypeError("Invalid effect");
      };
      const effect = runner.execute.call(this);
      if (typeof effect === "function") return runner.collect(effect);
      else if (isNullable(effect)) {
      } else if (!isObject(effect)) throw new TypeError("Invalid effect");
      else if ("then" in effect) return effect.then(safeCollect);
      else if (Symbol.iterator in effect) {
        info.error = /* @__PURE__ */ new Error();
        const iter = effect[Symbol.iterator]();
        while (true) {
          const result = iter.next();
          safeCollect(result.value);
          if (result.done) return;
        }
      } else if (Symbol.asyncIterator in effect) {
        const iter = effect[Symbol.asyncIterator]();
        return (async () => {
          await Promise.resolve();
          info.error = /* @__PURE__ */ new Error();
          while (true) {
            if (runner.epoch !== oldEpoch) return;
            const result = await iter.next();
            safeCollect(result.value);
            if (result.done) return;
          }
        })();
      } else throw new TypeError("Invalid effect");
    }, runner.getOuterStack);
  }
  effect(execute, label = "anonymous") {
    this.assertActive();
    if (this.state === 5) throw new CordisError("INACTIVE_EFFECT");
    const disposables = [];
    let disposing = false;
    let disposalTask;
    const dispose = () => {
      if (disposing) return disposalTask;
      disposing = true;
      let task2;
      for (const disposable of disposables.splice(0).reverse()) if (task2) task2 = task2.then(() => runDisposable(disposable));
      else {
        const result = runDisposable(disposable);
        if (isObject(result) && "then" in result) task2 = result;
      }
      return disposalTask = task2;
    };
    const meta = {
      label,
      children: []
    };
    const runner = {
      execute,
      epoch: true,
      collect: (dispose2) => {
        disposables.push(dispose2);
        this._disposables.delete(dispose2);
        if (dispose2[symbols.effect]) meta.children.push(dispose2[symbols.effect]);
      },
      getOuterStack: buildOuterStack()
    };
    let task;
    let executing = true;
    let resolveSetup;
    let rejectSetup;
    let setupBarrier;
    let setupFailed = false;
    let inFlight;
    let removeWrapper = () => false;
    const waitForSetup = () => {
      setupBarrier ??= new Promise((resolve5, reject) => {
        resolveSetup = resolve5;
        rejectSetup = reject;
      });
      return setupBarrier;
    };
    const disposeAfter = (setup) => {
      return Promise.resolve(setup).then(() => dispose(), async (reason) => {
        await dispose();
        throw reason;
      });
    };
    const finalizeDisposal = (callback) => {
      let result;
      try {
        result = callback();
      } catch (error) {
        removeWrapper();
        throw error;
      }
      if (isObject(result) && "then" in result) {
        const pending2 = Promise.resolve(result).finally(() => {
          removeWrapper();
          if (inFlight === pending2) inFlight = void 0;
        });
        return inFlight = pending2;
      }
      removeWrapper();
      return result;
    };
    const wrapper = defineProperty(() => {
      if (!runner.epoch) return setupFailed ? inFlight : void 0;
      runner.epoch = false;
      return finalizeDisposal(() => {
        if (executing) return disposeAfter(waitForSetup());
        return task ? disposeAfter(task) : dispose();
      });
    }, symbols.effect, meta);
    effectInertia.set(wrapper, () => inFlight);
    removeWrapper = this._disposables.push(wrapper);
    try {
      task = this._execute(runner);
    } catch (reason) {
      executing = false;
      setupFailed = true;
      runner.epoch = false;
      let cleanup;
      try {
        cleanup = finalizeDisposal(dispose);
      } finally {
        rejectSetup?.(reason);
      }
      if (isObject(cleanup) && "then" in cleanup) cleanup.catch((error) => this.ctx.logger.error(error));
      throw reason;
    }
    executing = false;
    if (setupBarrier) Promise.resolve(task).then(resolveSetup, rejectSetup);
    task?.catch(() => {
      if (!runner.epoch) return dispose();
      return finalizeDisposal(dispose);
    }).catch((error) => this.ctx.logger.error(error));
    const disposeAsync = () => {
      if (!runner.epoch) return;
      runner.epoch = false;
      return finalizeDisposal(dispose);
    };
    wrapper.then = async (onFulfilled, onRejected) => {
      return Promise.resolve(task).then(() => disposeAsync).then(onFulfilled, onRejected);
    };
    return wrapper;
  }
  /**
  * Return metadata for currently registered effects.
  *
  * @returns one {@link EffectMeta} tree per labeled live effect.
  */
  getEffects() {
    return [...this._disposables].map((dispose) => dispose[symbols.effect]).filter(Boolean);
  }
  _getState() {
    if (this.uid === null) return 4;
    if (this._error) return 3;
    if (this._runner.epoch !== INACTIVE) return 2;
    return 0;
  }
  _updateState(callback) {
    const oldState = this.state;
    this.state = callback() ?? this._getState();
    if (oldState === this.state) return;
    this.context.emit("internal/status", this, oldState);
    if (oldState !== 2 && this.state !== 2) return;
    for (const key of Reflect.ownKeys(this.ctx.reflect.store)) {
      const impl = this.ctx.reflect.store[key];
      if (impl.fiber !== this) continue;
      this.ctx.reflect.notify([impl.name]);
    }
  }
  _checkImpl(name2) {
    const impl = this.ctx.reflect._getImpl(name2, true);
    if (!impl) return delete this._store[name2];
    try {
      if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value))) return delete this._store[name2];
    } catch (error) {
      impl.fiber.ctx.logger.error(error);
      return delete this._store[name2];
    }
    this._store[name2] = impl;
  }
  _refresh() {
    let epoch = false;
    epoch = "";
    for (const name2 of Object.keys(this.inject)) {
      const impl = this._store[name2];
      if (!impl) {
        epoch = INACTIVE;
        break;
      }
      epoch += ":" + impl.fiber.uid;
    }
    this._setEpoch(epoch);
  }
  _setEpoch(epoch) {
    const oldEpoch = this._runner.epoch;
    if (epoch === oldEpoch) return;
    this._runner.epoch = epoch;
    if (this.inertia) return;
    this._updateState(() => {
      if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
        this.inertia = this._reload();
        return 1;
      } else {
        this.inertia = this._unload();
        return 5;
      }
    });
  }
  _resolveConfig(config) {
    config = this.context.waterfall(this, "internal/config", config, () => config);
    return this.runtime ? resolveConfig2(this.runtime, config) : config;
  }
  async _reload() {
    this.store = { ...this._store };
    const oldEpoch = this._runner.epoch;
    try {
      await Promise.resolve();
      if (this._runner.epoch === oldEpoch) {
        this.config = this._resolveConfig(this._config);
        await this._execute(this._runner);
        this._error = void 0;
      }
    } catch (reason) {
      this.ctx.logger.error(reason);
      this._error = reason;
      this._runner.epoch = INACTIVE;
    }
    this._updateState(() => {
      if (this._runner.epoch === oldEpoch) this.inertia = void 0;
      else {
        this.inertia = this._unload();
        return 5;
      }
    });
  }
  async _unload() {
    await Promise.all(this._disposables.clear().map(async (dispose) => {
      try {
        await composeError(async (info) => {
          await Promise.resolve();
          info.error = /* @__PURE__ */ new Error();
          await runDisposable(dispose);
        }, this._runner.getOuterStack);
      } catch (reason) {
        this.ctx.logger.error(reason);
      }
    }));
    this.store = void 0;
    this._updateState(() => {
      if (this._runner.epoch === INACTIVE) this.inertia = void 0;
      else {
        this.inertia = this._reload();
        return 1;
      }
    });
  }
  /**
  * Wait for current lifecycle work and rethrow startup errors.
  *
  * @returns this fiber, once it has settled into a stable state.
  * @throws the config-validation or plugin-startup error, if any.
  */
  async await() {
    while (this.inertia) await this.inertia;
    if (this._error) throw this._error;
    return this;
  }
  /**
  * Dispose and immediately reload this plugin with its current config.
  *
  * @returns a promise resolving once the reload settled.
  * @throws {CordisError} `INACTIVE_EFFECT` when the fiber is already disposed.
  */
  async restart() {
    this.assertActive();
    this._setEpoch(INACTIVE);
    this._refresh();
    await this.await();
  }
  /**
  * Validate and apply new config, then restart the plugin.
  *
  * Runs the `internal/update` waterfall first, so update hooks (and HMR)
  * can veto or replace the restart.
  *
  * @param config — the new raw config; validated before anything restarts.
  * @param noSave — hint for persistence hooks not to write the change back.
  * @returns the update waterfall result; the default restart returns a promise.
  * @throws when validation, an update listener, or the restarted plugin fails.
  */
  update(config, noSave = false) {
    this.assertActive();
    this._config = config;
    if (this.state !== 2) {
      this._error = void 0;
      this._setEpoch(INACTIVE);
      this._refresh();
      return;
    }
    config = this._resolveConfig(config);
    return this.context.waterfall(this, "internal/update", config, noSave, () => {
      this.config = config;
      this._error = void 0;
      return this.restart();
    });
  }
};
function isApplicable(object) {
  return object && typeof object === "object" && typeof object.apply === "function";
}
function Inject(name2, config) {
  return function(value, decorator) {
    if (decorator.kind === "class") {
      if (!Object.hasOwn(value, "inject")) {
        defineProperty(value, "inject", Object.create(Object.getPrototypeOf(value).inject ?? null));
        defineProperty(value.inject, symbols.checkProto, true);
      }
      value.inject[name2] = config;
    } else if (decorator.kind === "method") {
      const inject2 = (value[symbols.metadata] ??= {}).inject ??= /* @__PURE__ */ Object.create(null);
      inject2[name2] = config;
      decorator.addInitializer(function() {
        const property2 = this[symbols.tracker]?.property;
        (this[symbols.initHooks] ??= []).push(() => {
          this.ctx.inject(inject2, (ctx) => {
            return value.call(property2 ? withProps(this, { [property2]: ctx }) : this);
          });
        });
      });
    } else throw new Error("@Inject() can only be used on class or class methods");
  };
}
(function(Inject2) {
  function resolve5(inject2, result = /* @__PURE__ */ Object.create(null)) {
    if (!inject2) return result;
    if (Array.isArray(inject2)) for (const name2 of inject2) result[name2] = null;
    else if (Reflect.has(inject2, symbols.checkProto)) {
      Object.assign(result, resolve5(Object.getPrototypeOf(inject2)));
      for (const name2 of Object.keys(inject2)) result[name2] = inject2[name2] ?? null;
    } else for (const name2 of Object.keys(inject2)) result[name2] = inject2[name2] ?? null;
    return result;
  }
  Inject2.resolve = resolve5;
})(Inject || (Inject = {}));
var RegistryService = class {
  ctx;
  _counter = 0;
  _internal = /* @__PURE__ */ new Map();
  constructor(ctx) {
    this.ctx = ctx;
    defineProperty(this, symbols.tracker, {
      property: "ctx",
      noShadow: true
    });
  }
  /** Allocate the next fiber uid (increments on every read). */
  get counter() {
    return ++this._counter;
  }
  /** Number of registered plugin runtimes. */
  get size() {
    return this._internal.size;
  }
  /**
  * Resolve a supported plugin shape to its executable callback.
  *
  * @param plugin — a function, class, or `{ apply }` object plugin.
  * @returns the callback identifying the plugin, or `undefined` if invalid.
  */
  resolve(plugin) {
    try {
      if (typeof plugin === "function") return plugin;
      if (isApplicable(plugin)) return plugin.apply;
    } catch {
    }
  }
  /**
  * Look up the runtime record for a plugin.
  *
  * @param plugin — any supported plugin shape.
  * @returns the runtime, or `undefined` when the plugin is not registered.
  */
  get(plugin) {
    const key = this.resolve(plugin);
    return key && this._internal.get(key);
  }
  /**
  * Check whether a plugin has a registered runtime.
  *
  * @param plugin — any supported plugin shape.
  * @returns `true` when at least one fiber of the plugin exists.
  */
  has(plugin) {
    const key = this.resolve(plugin);
    return !!key && this._internal.has(key);
  }
  /**
  * Dispose every running fiber for a plugin and remove its runtime record.
  *
  * @param plugin — any supported plugin shape.
  * @returns the removed runtime, or `undefined` when none was registered.
  */
  delete(plugin) {
    const key = this.resolve(plugin);
    const runtime = key && this._internal.get(key);
    if (!runtime) return;
    this._internal.delete(key);
    for (const fiber of runtime.fibers) fiber.dispose();
    return runtime;
  }
  /** Iterate the registered plugin callbacks. */
  keys() {
    return this._internal.keys();
  }
  /** Iterate the registered plugin runtimes. */
  values() {
    return this._internal.values();
  }
  /** Iterate `[callback, runtime]` pairs. */
  entries() {
    return this._internal.entries();
  }
  /**
  * Visit every registered runtime.
  *
  * @param callback — receives each runtime and its identifying callback.
  */
  forEach(callback) {
    return this._internal.forEach(callback);
  }
  /**
  * Start a callback once the requested dependencies are available.
  *
  * @param inject — required services, as an array or a name → config map.
  * @param callback — plugin body called with `(ctx, config)`.
  * @returns the fiber; awaiting it settles once loading finished.
  */
  inject(inject2, callback) {
    return this.plugin({
      inject: inject2,
      apply: callback,
      name: callback.name
    });
  }
  /**
  * Start a plugin in the current context and return its fiber.
  *
  * Creates (or reuses) the plugin's runtime record, then starts a new fiber
  * under the current context. Throws if `plugin` is not a supported shape or
  * if the current fiber is already disposed.
  *
  * @param plugin — a function, class, or `{ apply }` object plugin.
  * @param config — the plugin config, validated against its `Config` schema.
  * @param getOuterStack — captures the caller stack for effect diagnostics.
  * @returns the fiber; awaiting it settles once loading finished.
  */
  plugin(plugin, config, getOuterStack = buildOuterStack()) {
    const callback = this.resolve(plugin);
    if (!callback) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin);
    this.ctx.fiber.assertActive();
    let runtime = this._internal.get(callback);
    if (!runtime) {
      let name2 = plugin.name;
      if (name2 === "apply") name2 = void 0;
      runtime = {
        name: name2,
        callback,
        fibers: new DisposableList(),
        Config: plugin.Config
      };
      this._internal.set(callback, runtime);
    }
    const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);
    const wrapped = Object.create(fiber);
    wrapped.then = (onFulfilled, onRejected) => {
      return fiber.await().then(onFulfilled, onRejected);
    };
    return wrapped;
  }
};
var Context = class Context2 {
  /** Symbol key under which a disposer exposes its {@link EffectMeta} diagnostics tree. */
  static effect = symbols.effect;
  /** Symbol key for a context's listener filter, consulted on every event dispatch. */
  static filter = symbols.filter;
  /** Symbol key of the isolation map (see the `Context[symbols.isolate]` property). */
  static isolate = symbols.isolate;
  /** Symbol key of the intercept map (see the `Context[symbols.intercept]` property). */
  static intercept = symbols.intercept;
  /**
  * Returns true for Cordis context proxies and context prototypes.
  *
  * Works across realms and across multiple copies of cordis, because the
  * brand is keyed by a global symbol rather than by `instanceof`.
  *
  * @param value — the value to test.
  * @returns `true` if `value` is a Cordis context, narrowing its type.
  */
  static is(value) {
    return !!value?.[Context2.is];
  }
  static {
    Context2.is[Symbol.toPrimitive] = () => /* @__PURE__ */ Symbol.for("cordis.is");
    Context2.prototype[Context2.is] = true;
  }
  /** Create the root context and install the built-in services. */
  constructor() {
    this[symbols.isolate] = /* @__PURE__ */ Object.create(null);
    this[symbols.intercept] = /* @__PURE__ */ Object.create(null);
    const self = new Proxy(this, ReflectService.handler);
    this.root = self;
    this.baseUrl = void 0;
    this.fiber = new Fiber(self, {}, /* @__PURE__ */ Object.create(null), null, () => []);
    this.reflect = new ReflectService(self);
    this.registry = new RegistryService(self);
    this.events = new EventsService(self);
    this.logger = new LoggerService(self);
    this.fiber._disposables.clear();
    return self;
  }
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return `Context <${this.fiber.name}>`;
  }
  /**
  * Create a child context with extra metadata on top of the current scope.
  *
  * The child prototypally inherits every property of this context; own
  * properties of `meta` shadow the inherited ones. The parent is not mutated.
  *
  * @param meta — own properties (including symbol keys) to define on the child.
  * @returns a child context inheriting from this one.
  */
  extend(meta = {}) {
    const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value;
    const self = Object.create(getTraceable(this, this));
    for (const prop of Reflect.ownKeys(meta)) Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop));
    if (!shadow) return self;
    return Object.assign(Object.create(self), { [symbols.shadow]: shadow });
  }
  /**
  * Create a child context with an independent service scope for `name`.
  *
  * Below the returned context, reads and writes of the service `name`
  * resolve against the new label instead of the parent's, so a different
  * implementation can be provided without affecting the parent scope.
  * Passing the same `label` to two `isolate()` calls joins their scopes.
  *
  * @param name — the service name to isolate.
  * @param label — scope label to join; defaults to a fresh unique symbol.
  * @returns a child context whose `name` service resolves in the new scope.
  */
  isolate(name2, label) {
    const shadow = Object.create(this[symbols.isolate]);
    shadow[name2] = label ?? Symbol(name2);
    return this.extend({ [symbols.isolate]: shadow });
  }
  intercept(name2, config) {
    const intercept = Object.create(this[symbols.intercept]);
    intercept[name2] = config;
    return this.extend({ [symbols.intercept]: intercept });
  }
};
var Service = class Service2 {
  ctx;
  /** Symbol key of an instance method run after construction (class plugins). */
  static init = symbols.init;
  /** Symbol key of the availability predicate passed to `ctx.provide()`. */
  static check = symbols.check;
  /** Symbol key of the phantom intercept-config type parameter. */
  static config = symbols.config;
  /** Symbol key of the call body making a service callable (e.g. `ctx.logger()`). */
  static invoke = symbols.invoke;
  /** Symbol key of the helper deriving an extended service instance. */
  static extend = symbols.extend;
  /** Symbol key of the tracker metadata used for context tracing. */
  static tracker = symbols.tracker;
  /** Symbol key of the intercept-config resolution helper below. */
  static resolveConfig = symbols.resolveConfig;
  /** The service name this instance is registered under. */
  name;
  /**
  * Register this instance as `name` in the current context.
  *
  * Calls `ctx.reflect.provide(name, this, this[Service.check])`, so the
  * service is unregistered automatically when the owning fiber unloads.
  * Services with a `[Service.invoke]` body return a callable instance.
  *
  * @param ctx — the context to register in (stored as `this.ctx`).
  * @param name — the service name; defaults to the static `provide` field.
  */
  constructor(ctx, name2) {
    this.ctx = ctx;
    name2 ??= this.constructor["provide"];
    let self = this;
    const tracker = {
      associate: name2,
      property: "ctx"
    };
    if (self[symbols.invoke]) self = createCallable(name2, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
    self.ctx = ctx;
    self.name = name2;
    defineProperty(self, symbols.tracker, tracker);
    self.ctx.reflect.provide(name2, self, this[symbols.check]);
    return self;
  }
  [symbols.filter](ctx) {
    return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name];
  }
  [symbols.extend](props) {
    let self;
    if (this[Service2.invoke]) self = createCallable(this.name, this, this[symbols.tracker]);
    else self = Object.create(this);
    return Object.assign(self, props);
  }
  /**
  * Merge intercept config from ancestors with optional base and head values.
  *
  * Entries added closer to the root apply first; `base` is prepended and
  * `head` appended. Uses `Config.merge` when the service declares one,
  * otherwise a shallow `Object.assign`.
  *
  * @param base — lowest-precedence config merged before all intercepts.
  * @param head — highest-precedence config merged after all intercepts.
  * @returns the merged config.
  */
  [symbols.resolveConfig](base, head) {
    let intercept = this.ctx[Context.intercept];
    const configs = [];
    while (this.name in intercept) {
      if (Object.hasOwn(intercept, this.name)) configs.unshift(intercept[this.name]);
      intercept = Object.getPrototypeOf(intercept);
    }
    if (base) configs.unshift(base);
    if (head) configs.push(head);
    if (this["Config"]?.merge) return this["Config"].merge(...configs);
    else return Object.assign({}, ...configs);
  }
  static [Symbol.hasInstance](instance) {
    if (!instance) return false;
    let constructor = instance.constructor;
    while (constructor) {
      constructor = constructor.prototype?.constructor;
      if (constructor === this) return true;
      constructor &&= Object.getPrototypeOf(constructor);
    }
    return false;
  }
};

// node_modules/@deepseek-ai/schemastery/lib/index.mjs
var kSchema = /* @__PURE__ */ Symbol.for("schemastery");
var kValidationError2 = /* @__PURE__ */ Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError2 = class extends TypeError {
  options;
  name = "ValidationError";
  constructor(message, options) {
    let prefix = "$";
    for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
    else if (typeof segment === "number") prefix += "[" + segment + "]";
    else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
    if (prefix.startsWith(".")) prefix = prefix.slice(1);
    super((prefix === "$" ? "" : `${prefix} `) + message);
    this.options = options;
  }
  static is(error) {
    return !!error?.[kValidationError2];
  }
};
Object.defineProperty(ValidationError2.prototype, kValidationError2, { value: true });
var Schema = function(options) {
  const schema = function(data, options2 = {}) {
    return Schema.resolve(data, schema, options2)[0];
  };
  if (options.refs) {
    const refs = mapValues(options.refs, (options2) => new Schema(options2));
    const getRef = (uid) => refs[uid];
    for (const key in refs) {
      const options2 = refs[key];
      options2.sKey = getRef(options2.sKey);
      options2.inner = getRef(options2.inner);
      options2.list = options2.list && options2.list.map(getRef);
      options2.dict = options2.dict && mapValues(options2.dict, getRef);
    }
    return refs[options.uid];
  }
  Object.assign(schema, options);
  if (typeof schema.callback === "string") try {
    schema.callback = new Function("return " + schema.callback)();
  } catch {
  }
  Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
  Object.setPrototypeOf(schema, Schema.prototype);
  schema.meta ||= {};
  schema.toString = schema.toString.bind(schema);
  return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
  return {
    version: 1,
    vendor: "schemastery",
    validate: (value) => {
      try {
        return { value: Schema.resolve(value, this, {})[0] };
      } catch (error) {
        if (ValidationError2.is(error)) return { issues: [{
          message: error.message,
          path: error.options.path
        }] };
        throw error;
      }
    }
  };
} });
Schema.ValidationError = ValidationError2;
Schema.prototype.toJSON = function toJSON() {
  if (globalThis.__schemastery_refs__) {
    globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
    return this.uid;
  }
  globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
  globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
  const result = {
    uid: this.uid,
    refs: globalThis.__schemastery_refs__
  };
  globalThis.__schemastery_refs__ = void 0;
  return result;
};
Schema.prototype.set = function set(key, value) {
  this.dict[key] = value;
  return this;
};
Schema.prototype.push = function push(value) {
  this.list.push(value);
  return this;
};
function mergeDesc(original, messages) {
  const result = typeof original === "string" ? { "": original } : { ...original };
  for (const locale in messages) {
    const value = messages[locale];
    if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
    else if (typeof value === "string") result[locale] = value;
  }
  return result;
}
function getInner(value) {
  return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
  return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
  const schema = Schema(this);
  const desc = mergeDesc(schema.meta.description, messages);
  if (Object.keys(desc).length) schema.meta.description = desc;
  if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
    return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
  });
  if (schema.list) schema.list = schema.list.map((inner, index) => {
    return inner.i18n(mapValues(messages, (data = {}) => {
      if (Array.isArray(getInner(data))) return getInner(data)[index];
      if (Array.isArray(data)) return data[index];
      return extractKeys(data);
    }));
  });
  if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
    if (getInner(data)) return getInner(data);
    return extractKeys(data);
  }));
  if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
  return schema;
};
Schema.prototype.extra = function extra(key, value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
};
for (const key of [
  "required",
  "disabled",
  "collapse",
  "hidden",
  "loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
Schema.prototype.deprecated = function deprecated() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "deprecated",
    type: "danger"
  });
  return schema;
};
Schema.prototype.experimental = function experimental() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "experimental",
    type: "warning"
  });
  return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
  const schema = Schema(this);
  const pattern2 = pick(regexp, ["source", "flags"]);
  schema.meta = {
    ...schema.meta,
    pattern: pattern2
  };
  return schema;
};
Schema.prototype.simplify = function simplify(value) {
  if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
  if (isNullable(value)) return value;
  if (this.type === "object" || this.type === "dict") {
    const result = {};
    for (const key in value) {
      const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
      if (this.type === "dict" || !isNullable(item)) result[key] = item;
    }
    if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
    return result;
  } else if (this.type === "array" || this.type === "tuple") {
    const result = [];
    value.forEach((value2, index) => {
      const schema = this.type === "array" ? this.inner : this.list[index];
      const item = schema ? schema.simplify(value2) : value2;
      result.push(item);
    });
    return result;
  } else if (this.type === "intersect") {
    const result = {};
    for (const item of this.list) Object.assign(result, item.simplify(value));
    return result;
  } else if (this.type === "union") for (const schema of this.list) try {
    Schema.resolve(value, schema, {});
    return schema.simplify(value);
  } catch {
  }
  return value;
};
Schema.prototype.toString = function toString(inline) {
  return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra2) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    role,
    extra: extra2
  };
  return schema;
};
for (const key of [
  "default",
  "link",
  "comment",
  "description",
  "max",
  "min",
  "step"
]) Object.assign(Schema.prototype, { [key](value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
var resolvers = {};
Schema.extend = function extend(type, resolve5) {
  resolvers[type] = resolve5;
};
Schema.resolve = function resolve4(data, schema, options = {}, strict = false) {
  if (!schema) return [data];
  if (options.ignore?.(data, schema)) return [data];
  if (isNullable(data) && schema.type !== "lazy") {
    if (schema.meta.required) throw new ValidationError2(`missing required value`, options);
    let current = schema;
    let fallback = schema.meta.default;
    while (current?.type === "intersect" && isNullable(fallback)) {
      current = current.list[0];
      fallback = current?.meta.default;
    }
    if (isNullable(fallback)) return [data];
    data = clone(fallback);
  }
  const callback = resolvers[schema.type];
  if (!callback) throw new ValidationError2(`unsupported type "${schema.type}"`, options);
  try {
    return callback(data, schema, options, strict);
  } catch (error) {
    if (!schema.meta.loose) throw error;
    return [schema.meta.default];
  }
};
Schema.from = function from(source) {
  if (isNullable(source)) return Schema.any();
  else if ([
    "string",
    "number",
    "boolean"
  ].includes(typeof source)) return Schema.const(source).required();
  else if (source[kSchema]) return source;
  else if (typeof source === "function") switch (source) {
    case String:
      return Schema.string().required();
    case Number:
      return Schema.number().required();
    case Boolean:
      return Schema.boolean().required();
    case Function:
      return Schema.function().required();
    default:
      return Schema.is(source).required();
  }
  else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
  const toJSON2 = () => {
    if (!schema.inner[kSchema]) {
      schema.inner = schema.builder();
      schema.inner.meta = {
        ...schema.meta,
        ...schema.inner.meta
      };
    }
    return schema.inner.toJSON();
  };
  const schema = new Schema({
    type: "lazy",
    builder,
    inner: { toJSON: toJSON2 }
  });
  return schema;
};
Schema.natural = function natural() {
  return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
  return Schema.number().step(0.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
  return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
    const date2 = new Date(value);
    if (isNaN(+date2)) throw new ValidationError2(`invalid date "${value}"`, options);
    return date2;
  }, true)]);
};
Schema.regExp = function regExp(flag = "") {
  return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
    try {
      return new RegExp(value, flag);
    } catch (e) {
      throw new ValidationError2(e.message, options);
    }
  }, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
  return Schema.union([
    Schema.is(ArrayBuffer),
    Schema.is(SharedArrayBuffer),
    Schema.transform(Schema.any(), (value, options) => {
      if (Binary.isSource(value)) return Binary.fromSource(value);
      throw new ValidationError2(`expected ArrayBufferSource but got ${value}`, options);
    }, true),
    ...encoding ? [Schema.transform(Schema.string(), (value, options) => {
      try {
        return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
      } catch (e) {
        throw new ValidationError2(e.message, options);
      }
    }, true)] : []
  ]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
  if (!schema.inner[kSchema]) {
    schema.inner = schema.builder();
    schema.inner.meta = {
      ...schema.meta,
      ...schema.inner.meta
    };
  }
  return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
  return [data];
});
Schema.extend("never", (data, _, options) => {
  throw new ValidationError2(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
  if (deepEqual(data, value)) return [value];
  throw new ValidationError2(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
  const { max = Infinity, min = -Infinity } = meta;
  if (data > max) throw new ValidationError2(`expected ${description} <= ${max} but got ${data}`, options);
  if (data < min && !skipMin) throw new ValidationError2(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
  if (typeof data !== "string") throw new ValidationError2(`expected string but got ${data}`, options);
  if (meta.pattern) {
    const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
    if (!regexp.test(data)) throw new ValidationError2(`expect string to match regexp ${regexp}`, options);
  }
  checkWithinRange(data.length, meta, "string length", options);
  return [data];
});
function decimalShift(data, digits) {
  const str = data.toString();
  if (str.includes("e")) return data * Math.pow(10, digits);
  const index = str.indexOf(".");
  if (index === -1) return data * Math.pow(10, digits);
  const frac = str.slice(index + 1);
  const integer = str.slice(0, index);
  if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
  return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
  step = Math.abs(step);
  if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
  const index = step.toString().indexOf(".");
  const digits = step.toString().slice(index + 1).length;
  return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
  if (typeof data !== "number") throw new ValidationError2(`expected number but got ${data}`, options);
  checkWithinRange(data, meta, "number", options);
  const { step } = meta;
  if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError2(`expected number multiple of ${step} but got ${data}`, options);
  return [data];
});
Schema.extend("boolean", (data, _, options) => {
  if (typeof data === "boolean") return [data];
  throw new ValidationError2(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
  let value = 0, keys = [];
  if (typeof data === "number") {
    value = data;
    for (const key in bits) if (data & bits[key]) keys.push(key);
  } else if (Array.isArray(data)) {
    keys = data;
    for (const key of keys) {
      if (typeof key !== "string") throw new ValidationError2(`expected string but got ${key}`, options);
      if (key in bits) value |= bits[key];
    }
  } else throw new ValidationError2(`expected number or array but got ${data}`, options);
  if (value === meta.default) return [value];
  return [value, keys];
});
Schema.extend("function", (data, _, options) => {
  if (typeof data === "function") return [data];
  throw new ValidationError2(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
  if (typeof constructor === "function") {
    if (data instanceof constructor) return [data];
    throw new ValidationError2(`expected ${constructor.name} but got ${data}`, options);
  } else {
    if (isNullable(data)) throw new ValidationError2(`expected ${constructor} but got ${data}`, options);
    let prototype = Object.getPrototypeOf(data);
    while (prototype) {
      if (prototype.constructor?.name === constructor) return [data];
      prototype = Object.getPrototypeOf(prototype);
    }
    throw new ValidationError2(`expected ${constructor} but got ${data}`, options);
  }
});
function property(data, key, schema, options) {
  try {
    const [value, adapted] = Schema.resolve(data[key], schema, {
      ...options,
      path: [...options.path || [], key]
    });
    if (adapted !== void 0) data[key] = adapted;
    return value;
  } catch (e) {
    if (!options?.autofix) throw e;
    delete data[key];
    return schema.meta.default;
  }
}
Schema.extend("array", (data, { inner, meta }, options) => {
  if (!Array.isArray(data)) throw new ValidationError2(`expected array but got ${data}`, options);
  checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
  return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError2(`expected object but got ${data}`, options);
  const result = {};
  for (const key in data) {
    let rKey;
    try {
      rKey = Schema.resolve(key, sKey, options)[0];
    } catch (error) {
      if (strict) continue;
      throw error;
    }
    result[rKey] = property(data, key, inner, options);
    data[rKey] = data[key];
    if (key !== rKey) delete data[key];
  }
  return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
  if (!Array.isArray(data)) throw new ValidationError2(`expected array but got ${data}`, options);
  const result = list.map((inner, index) => property(data, index, inner, options));
  if (strict) return [result];
  result.push(...data.slice(list.length));
  return [result];
});
function merge(result, data) {
  for (const key in data) {
    if (key in result) continue;
    result[key] = data[key];
  }
}
Schema.extend("object", (data, { dict }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError2(`expected object but got ${data}`, options);
  const result = {};
  for (const key in dict) {
    const value = property(data, key, dict[key], options);
    if (!isNullable(value) || key in data) result[key] = value;
  }
  if (!strict) merge(result, data);
  return [result];
});
Schema.extend("union", (data, { list, toString: toString2 }, options, strict) => {
  const messages = [];
  for (const inner of list) try {
    return Schema.resolve(data, inner, options, strict);
  } catch (error) {
    messages.push(error);
  }
  throw new ValidationError2(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString: toString2 }, options, strict) => {
  if (!list.length) return [data];
  let result;
  for (const inner of list) {
    const value = Schema.resolve(data, inner, options, true)[0];
    if (isNullable(value)) continue;
    if (isNullable(result)) result = value;
    else if (typeof result !== typeof value) throw new ValidationError2(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
    else if (typeof value === "object") merge(result ??= {}, value);
    else if (result !== value) throw new ValidationError2(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
  }
  if (!strict && isPlainObject(data)) merge(result, data);
  return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
  const [result, adapted = data] = Schema.resolve(data, inner, options, true);
  if (preserve) return [callback(result)];
  else return [callback(result), callback(adapted)];
});
var formatters = {};
function defineMethod(name2, keys, format) {
  formatters[name2] = format;
  Object.assign(Schema, { [name2](...args) {
    const schema = new Schema({ type: name2 });
    keys.forEach((key, index) => {
      switch (key) {
        case "sKey":
          schema.sKey = args[index] ?? Schema.string();
          break;
        case "inner":
          schema.inner = Schema.from(args[index]);
          break;
        case "list":
          schema.list = args[index].map(Schema.from);
          break;
        case "dict":
          schema.dict = mapValues(args[index], Schema.from);
          break;
        case "bits":
          schema.bits = {};
          for (const key2 in args[index]) {
            if (typeof args[index][key2] !== "number") continue;
            schema.bits[key2] = args[index][key2];
          }
          break;
        case "callback": {
          const callback = schema.callback = args[index];
          callback["toJSON"] ||= () => callback.toString();
          break;
        }
        case "constructor": {
          const constructor = schema.constructor = args[index];
          if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
          break;
        }
        default:
          schema[key] = args[index];
      }
    });
    if (name2 === "object" || name2 === "dict") schema.meta.default = {};
    else if (name2 === "array" || name2 === "tuple") schema.meta.default = [];
    else if (name2 === "bitset") schema.meta.default = 0;
    return schema;
  } });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
  if (typeof constructor === "function") return constructor.name;
  else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
  if (Object.keys(dict).length === 0) return "{}";
  return `{ ${Object.entries(dict).map(([key, inner]) => {
    return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
  }).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
  const result = list.map(({ toString: format }) => format()).join(" | ");
  return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
  return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
  "inner",
  "callback",
  "preserve"
], ({ inner }, isInner) => inner.toString(isInner));

// node_modules/@deepseek-ai/dsh-scope/lib/index.js
var NamedEntries = class {
  duplicateError;
  data = /* @__PURE__ */ new Map();
  constructor(duplicateError) {
    this.duplicateError = duplicateError;
  }
  /**
  * Insert one unique name.
  * @param name - name unique within this table.
  * @param value - borrowed value to retain.
  * @returns an idempotent undo that removes only this insertion.
  */
  insert(name2, value) {
    const data = this.data;
    if (data.has(name2)) throw this.duplicateError(name2);
    data.set(name2, value);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      data.delete(name2);
      if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
    };
  }
  /**
  * Read one named value.
  * @param name - name to resolve.
  * @returns the retained value, or `undefined` when absent.
  */
  get(name2) {
    return this.data.get(name2);
  }
  /**
  * Test one name for membership.
  * @param name - name to test.
  * @returns whether the table contains that name.
  */
  has(name2) {
    return this.data.has(name2);
  }
  /**
  * Iterate live names in insertion order.
  * @returns the native live key iterator.
  */
  keys() {
    return this.data.keys();
  }
  /**
  * Iterate live entries in insertion order.
  * @returns the native live entry iterator.
  */
  entries() {
    return this.data.entries();
  }
  /**
  * Iterate live values in insertion order.
  * @returns the native live value iterator.
  */
  values() {
    return this.data.values();
  }
  /**
  * Test whether this table has no entries.
  * @returns whether the table is empty.
  */
  isEmpty() {
    return this.data.size === 0;
  }
};
var AnonymousEntries = class {
  data = /* @__PURE__ */ new Map();
  /**
  * Append one independently owned value.
  * @param value - borrowed value to retain.
  * @returns an idempotent undo for this exact append.
  */
  append(value) {
    const data = this.data;
    const key = /* @__PURE__ */ Symbol();
    data.set(key, value);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      data.delete(key);
      if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
    };
  }
  /**
  * Iterate live values in insertion order.
  * @returns the native live value iterator.
  */
  values() {
    return this.data.values();
  }
  /**
  * Test whether this table has no entries.
  * @returns whether the table is empty.
  */
  isEmpty() {
    return this.data.size === 0;
  }
};
var ScopedLayers = class {
  createLayer;
  onChange;
  /** The eagerly constructed context-global layer. */
  global;
  scoped = /* @__PURE__ */ new Map();
  constructor(createLayer, onChange) {
    this.createLayer = createLayer;
    this.onChange = onChange;
    this.global = createLayer(void 0);
  }
  /**
  * Read an existing exact-scope overlay. Deliberately chain-blind: callers
  * addressing one scope's OWN contributions (its restrictions, its guards)
  * must not silently pick up an ancestor's — use {@link chainLayers} where
  * inheritance is the point.
  * @param scope - exact scope key; `undefined` denotes no overlay.
  * @returns the existing scoped layer, or `undefined` without creating one.
  */
  peek(scope) {
    if (scope === void 0) return void 0;
    return this.scoped.get(scope);
  }
  /**
  * Existing overlays along the scope's parent chain ({@link scopeChainOf}),
  * farthest ancestor first and the exact scope last, so a caller layering
  * them in order gives the nearest scope the final word.
  * @param scope - viewing scope, or `undefined` for no overlays.
  * @returns the existing layers, nearest last; absent overlays are skipped.
  */
  chainLayers(scope) {
    const layers = [];
    for (const key of scopeChainOf(scope).reverse()) {
      const layer = this.scoped.get(key);
      if (layer !== void 0) layers.push(layer);
    }
    return layers;
  }
  /**
  * Materialize global named entries followed by scope-chain shadows,
  * farthest ancestor first, so the nearest scope's entry wins a name.
  * @param scope - viewing scope, or `undefined` for the global view.
  * @param pick - select the named table from a layer.
  * @returns an insertion-ordered effective map.
  */
  merge(scope, pick2) {
    const merged = new Map(pick2(this.global).entries());
    for (const layer of this.chainLayers(scope)) for (const [name2, value] of pick2(layer).entries()) merged.set(name2, value);
    return merged;
  }
  /**
  * Attach one synchronous layer mutation to its registration context.
  * @param ctx - context that determines both scope visibility and effect ownership.
  * @param action - atomic mutation returning its synchronous undo.
  * @param options - Cordis effect label and optional change notification.
  * @returns the exact disposer returned by `ctx.effect()`.
  */
  effect(ctx, action, options) {
    const scope = scopeOf(ctx);
    const notify = options.notify ?? true;
    return ctx.effect(function* () {
      let layer;
      let created = false;
      if (scope === void 0) layer = this.global;
      else {
        const existing = this.scoped.get(scope);
        if (existing === void 0) {
          layer = this.createLayer(scope);
          this.scoped.set(scope, layer);
          created = true;
        } else layer = existing;
      }
      let undo;
      try {
        undo = action(layer);
      } catch (error) {
        if (scope !== void 0 && created && layer.isEmpty()) this.scoped.delete(scope);
        throw error;
      }
      yield () => {
        undo();
        if (scope !== void 0 && layer.isEmpty()) this.scoped.delete(scope);
        if (notify) this.onChange();
      };
      if (notify) this.onChange();
    }.bind(this), options.label);
  }
};
var kScope = /* @__PURE__ */ Symbol("dsh.scope");
var carrierKeys = /* @__PURE__ */ new WeakMap();
var scopeParents = /* @__PURE__ */ new WeakMap();
function scopeChainOf(key) {
  const chain = [];
  for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) chain.push(cursor);
  return chain;
}
function scopeOf(ctx) {
  return ctx[kScope];
}
function scopeTarget(base, key) {
  const baseFilter = base[Context.filter];
  const carrier = { [Context.filter](ctx) {
    if (baseFilter !== void 0 && !baseFilter.call(base, ctx)) return false;
    const tag = scopeOf(ctx);
    if (tag === void 0) return true;
    for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;
    return false;
  } };
  carrierKeys.set(carrier, key);
  return carrier;
}

// node_modules/@deepseek-ai/dsh-llm/lib/index.js
import { createRequire } from "node:module";

// node_modules/@deepseek-ai/dsh-timeout/lib/index.js
var MAX_TIMER_DELAY_MS = 2147483647;

// node_modules/@deepseek-ai/dsh-llm/lib/index.js
function CallId(id) {
  return id;
}
function deepFreeze(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  const pending2 = [{
    kind: "visit",
    node: value
  }];
  while (pending2.length > 0) {
    const task = pending2.pop();
    if (task === void 0) continue;
    if (task.kind === "property") {
      pending2.push({
        kind: "visit",
        node: task.source[task.key]
      });
      continue;
    }
    const node = task.node;
    if (node === null || typeof node !== "object") continue;
    if (node instanceof AbortSignal) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    const keys = Object.keys(node);
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      if (key === void 0) continue;
      pending2.push({
        kind: "property",
        source: node,
        key
      });
    }
  }
  return value;
}
var HarnessError = class extends Error {
  /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
  code;
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
};
var EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
var STRUCTURED_CONTEXT_OVERFLOW = new RegExp(String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, "i");
var TOO_LARGE_FOR_CONTEXT = new RegExp(String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, "i");
var EXCEEDS_MODEL_CONTEXT = new RegExp(String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, "i");
var DEFAULT_MAX_RETRIES = 2;
var DEFAULT_INITIAL_DELAY_MS = 500;
var DEFAULT_MAX_DELAY_MS = 1e4;
var DEFAULT_JITTER_RATIO = 0.1;
var DEFAULT_RETRYABLE_CODES = Object.freeze([
  EMPTY_RESPONSE_CODE,
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT"
]);
var backoffSchema = Schema.object({
  initialDelayMs: Schema.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
  maxDelayMs: Schema.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
  jitterRatio: Schema.number().min(0).max(1).default(DEFAULT_JITTER_RATIO)
});
var normalPolicySchema = Schema.object({
  mode: Schema.const("normal").required(),
  maxRetries: Schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
  retryableCodes: Schema.array(Schema.string()).default([...DEFAULT_RETRYABLE_CODES]),
  backoff: backoffSchema
});
var alwaysPolicySchema = Schema.object({
  mode: Schema.const("always").required(),
  backoff: backoffSchema
});
var RetryPolicySchema = Schema.union([normalPolicySchema, alwaysPolicySchema]);
var { version } = { version: "0.1.1" };
function assertNever(value, context) {
  const rendered = JSON.stringify(value) ?? String(value);
  throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}

// node_modules/@deepseek-ai/dsh-session/lib/index.js
function hasIntrinsicConstructor(prototype, name2) {
  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  if (typeof constructor !== "function") return false;
  try {
    return constructor.name === name2 && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name2}() { [native code] }`;
  } catch {
    return false;
  }
}
function isIntrinsicObjectPrototype(value) {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, "Object");
}
function hasPlainArrayPrototype(value) {
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
  const objectPrototype = Object.getPrototypeOf(prototype);
  return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype);
}
function hasPlainObjectPrototype(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype(prototype);
}
function enumerableStringKeys(value) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) return void 0;
  return keys;
}
function walkJsonValue(value, detach) {
  const ancestors = /* @__PURE__ */ new Set();
  let root;
  const assign = (destination, item) => {
    if (destination === void 0) return;
    if (destination.kind === "root") root = item;
    else if (destination.kind === "array") destination.target[destination.index] = item;
    else Object.defineProperty(destination.target, destination.key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true
    });
  };
  const tasks = [{
    kind: "visit",
    value,
    ...detach ? { destination: { kind: "root" } } : {}
  }];
  for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
    if (task.kind === "leave") {
      ancestors.delete(task.source);
      continue;
    }
    if (task.kind === "array-item") {
      if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return void 0;
      tasks.push({
        kind: "visit",
        value: task.source[task.index],
        ...task.target === void 0 ? {} : { destination: {
          kind: "array",
          target: task.target,
          index: task.index
        } }
      });
      continue;
    }
    if (task.kind === "object-property") {
      tasks.push({
        kind: "visit",
        value: task.source[task.key],
        ...task.target === void 0 ? {} : { destination: {
          kind: "object",
          target: task.target,
          key: task.key
        } }
      });
      continue;
    }
    const current = task.value;
    if (current === null) {
      assign(task.destination, null);
      continue;
    }
    if (typeof current === "boolean" || typeof current === "string") {
      assign(task.destination, current);
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) return void 0;
      assign(task.destination, current);
      continue;
    }
    if (typeof current !== "object") return void 0;
    if (ancestors.has(current)) return void 0;
    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current)) return void 0;
      const length = current.length;
      if (Reflect.ownKeys(current).length !== length + 1) return void 0;
      const target2 = detach ? [] : void 0;
      if (target2 !== void 0) assign(task.destination, target2);
      ancestors.add(current);
      tasks.push({
        kind: "leave",
        source: current
      });
      for (let index = length - 1; index >= 0; index--) tasks.push({
        kind: "array-item",
        source: current,
        index,
        ...target2 === void 0 ? {} : { target: target2 }
      });
      continue;
    }
    if (!hasPlainObjectPrototype(current)) return void 0;
    const keys = enumerableStringKeys(current);
    if (keys === void 0) return void 0;
    const target = detach ? {} : void 0;
    if (target !== void 0) assign(task.destination, target);
    ancestors.add(current);
    tasks.push({
      kind: "leave",
      source: current
    });
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      if (key === void 0) return void 0;
      tasks.push({
        kind: "object-property",
        source: current,
        key,
        ...target === void 0 ? {} : { target }
      });
    }
  }
  return detach ? root : true;
}
function snapshotJsonValue(value) {
  return walkJsonValue(value, true);
}
function isJsonValue(value) {
  return walkJsonValue(value, false) === true;
}

// node_modules/@deepseek-ai/dsh-tools/lib/index.js
var JsonSchemaError = class extends HarnessError {
  /** Individual schema violations in walk order. */
  violations;
  constructor(violations) {
    super(`unsupported JSON schema: ${violations.join("; ")}`, "UNSUPPORTED_SCHEMA");
    this.name = "JsonSchemaError";
    this.violations = violations;
  }
};
var CONSTRAINT_KEYWORDS = /* @__PURE__ */ new Set([
  "type",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const"
]);
var ANNOTATION_KEYWORDS = /* @__PURE__ */ new Set([
  "description",
  "title",
  "default",
  "examples"
]);
var SCHEMA_TYPES = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null"
];
function hasIntrinsicConstructor2(prototype, name2) {
  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  if (typeof constructor !== "function") return false;
  try {
    return constructor.name === name2 && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name2}() { [native code] }`;
  } catch {
    return false;
  }
}
function isIntrinsicObjectPrototype2(value) {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor2(value, "Object");
}
function isPlainJsonRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype2(prototype);
  } catch {
    return false;
  }
}
function hasPlainArrayPrototype2(value) {
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor2(prototype, "Array")) return false;
  const objectPrototype = Object.getPrototypeOf(prototype);
  return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype2(objectPrototype);
}
function hasOnlyEnumerableStringKeys(value) {
  try {
    return Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key));
  } catch {
    return false;
  }
}
function isJsonSchemaRecord(value) {
  return isPlainJsonRecord(value) && hasOnlyEnumerableStringKeys(value);
}
function isPlainJsonArray(value) {
  if (!Array.isArray(value)) return false;
  try {
    if (!hasPlainArrayPrototype2(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
    return true;
  } catch {
    return false;
  }
}
function isJsonNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}
function scalarMatches(type, value) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return isJsonNumber(value);
    case "integer":
      return isJsonNumber(value) && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    /* v8 ignore next -- JsonSchemaScalarType is closed; this retains compile-time exhaustiveness. */
    default:
      return assertNever(type, "JsonSchemaType");
  }
}
var ONE_OF_SIBLING_KEYWORDS = [
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const"
];
function checkObjectSchemaTail(node, path, properties, violations) {
  const hasRequired = Object.hasOwn(node, "required");
  const required = hasRequired ? node.required : void 0;
  if (hasRequired) if (!isPlainJsonArray(required) || required.some((entry) => typeof entry !== "string")) violations.push(`${path}.required must be an array of strings`);
  else {
    const declared = isJsonSchemaRecord(properties) ? properties : {};
    for (const key of required) if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
  }
  if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") violations.push(`${path}.additionalProperties must be a boolean`);
}
function checkSchemaNode(root, rootPath, violations, seen) {
  const tasks = [{
    kind: "enter",
    node: root,
    path: rootPath
  }];
  for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
    if (task.kind === "leave") {
      seen.delete(task.node);
      continue;
    }
    if (task.kind === "one-of-tail") {
      for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`);
      continue;
    }
    if (task.kind === "object-tail") {
      checkObjectSchemaTail(task.node, task.path, task.properties, violations);
      continue;
    }
    const { node, path } = task;
    if (!isJsonSchemaRecord(node)) {
      violations.push(`${path} must be a schema object`);
      continue;
    }
    if (seen.has(node)) {
      violations.push(`${path} is circular`);
      continue;
    }
    seen.add(node);
    tasks.push({
      kind: "leave",
      node
    });
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue;
      if (ANNOTATION_KEYWORDS.has(key)) {
        try {
          if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
        } catch {
          violations.push(`${path}.${key} annotation must be lossless JSON data`);
        }
        continue;
      }
      violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
    }
    if (Object.hasOwn(node, "description") && typeof node.description !== "string") violations.push(`${path}.description must be a string`);
    if (Object.hasOwn(node, "title") && typeof node.title !== "string") violations.push(`${path}.title must be a string`);
    const hasType = Object.hasOwn(node, "type");
    const hasOneOf = Object.hasOwn(node, "oneOf");
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`);
      continue;
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
      continue;
    }
    if (hasOneOf) {
      const oneOf = node.oneOf;
      tasks.push({
        kind: "one-of-tail",
        node,
        path
      });
      if (!isPlainJsonArray(oneOf) || oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`);
      else for (let index = oneOf.length - 1; index >= 0; index--) tasks.push({
        kind: "enter",
        node: oneOf[index],
        path: `${path}.oneOf[${index}]`
      });
      continue;
    }
    const type = node.type;
    if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) {
      violations.push(Array.isArray(type) ? `${path}.type must be a single type string (type arrays are not supported)` : `${path}.type must be one of ${SCHEMA_TYPES.join("/")}`);
      continue;
    }
    const schemaType = type;
    for (const [key, types] of Object.entries({
      properties: ["object"],
      required: ["object"],
      additionalProperties: ["object"],
      items: ["array"],
      enum: [
        "string",
        "number",
        "integer",
        "boolean",
        "null"
      ],
      const: [
        "string",
        "number",
        "integer",
        "boolean",
        "null"
      ]
    })) if (Object.hasOwn(node, key) && !types.includes(schemaType)) violations.push(`${path}.${key} is not supported on type "${schemaType}"`);
    switch (schemaType) {
      case "object": {
        const properties = Object.hasOwn(node, "properties") ? node.properties : void 0;
        tasks.push({
          kind: "object-tail",
          node,
          path,
          properties
        });
        if (Object.hasOwn(node, "properties")) if (!isJsonSchemaRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
        else {
          const entries = Object.entries(properties);
          for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index];
            if (entry === void 0) continue;
            tasks.push({
              kind: "enter",
              node: entry[1],
              path: `${path}.properties.${entry[0]}`
            });
          }
        }
        break;
      }
      case "array":
        if (Object.hasOwn(node, "items")) tasks.push({
          kind: "enter",
          node: node.items,
          path: `${path}.items`
        });
        break;
      case "string":
      case "number":
      case "integer":
      case "boolean":
      case "null": {
        const hasEnum = Object.hasOwn(node, "enum");
        const allowed = hasEnum ? node.enum : void 0;
        const enumValid = isPlainJsonArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(schemaType, entry));
        if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`);
        const hasConst = Object.hasOwn(node, "const");
        const declaredConst = hasConst ? node.const : void 0;
        const constValid = scalarMatches(schemaType, declaredConst);
        if (hasConst) {
          if (!constValid) violations.push(`${path}.const must be a ${schemaType} value`);
          else if (enumValid && !allowed.includes(declaredConst)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
        }
        break;
      }
      /* v8 ignore next -- schemaType was narrowed from the closed SCHEMA_TYPES table above. */
      default:
        assertNever(schemaType, "JsonSchemaType");
    }
  }
}
function assertSupportedJsonSchema(schema) {
  const violations = [];
  checkSchemaNode(schema, "schema", violations, /* @__PURE__ */ new Set());
  if (violations.length > 0) throw new JsonSchemaError(violations);
}
function safelyIsJsonValue(value) {
  try {
    return isJsonValue(value);
  } catch {
    return false;
  }
}
function diagnosticPath(path) {
  return path === "" ? "arguments" : path;
}
function propertyPath(path, key) {
  return path === "" ? key : `${path}.${key}`;
}
function losslessValueViolation(path) {
  return [`"${diagnosticPath(path)}" must be a lossless JSON value`];
}
function appendViolations(target, source) {
  for (const violation of source) target.push(violation);
}
function valueFrame(node, value, path) {
  return {
    node,
    value,
    path,
    catches: false,
    phase: "start",
    children: [],
    childIndex: 0,
    violations: [],
    tailViolations: [],
    matches: 0
  };
}
function checkScalarValue(node, value, path) {
  const allowed = Object.hasOwn(node, "enum") ? node.enum : void 0;
  if (allowed !== void 0 && !allowed.includes(value)) return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(allowed)}`];
  if (Object.hasOwn(node, "const") && value !== node.const) return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`];
  return [];
}
function checkValue(schema, value, path) {
  const frames = [valueFrame(schema, value, path)];
  let rootResult;
  const receive = (result) => {
    const parent = frames.at(-1);
    if (parent === void 0) {
      rootResult = result;
      return;
    }
    if (parent.kind === "oneOf") {
      if (result.length === 0) parent.matches++;
    } else appendViolations(parent.violations, result);
  };
  const finish = (result) => {
    frames.pop();
    receive(result);
  };
  while (frames.length > 0) {
    const frame = frames.at(-1);
    if (frame === void 0) break;
    try {
      if (frame.phase === "children") {
        if (frame.childIndex < frame.children.length) {
          const child = frame.children[frame.childIndex];
          if (child === void 0) throw new Error("missing schema-value child frame");
          frame.childIndex++;
          frames.push(valueFrame(child.node, child.value, child.path));
          continue;
        }
        if (frame.kind === "oneOf") {
          finish(frame.matches === 1 ? [] : [`"${diagnosticPath(frame.path)}" must match exactly one oneOf branch (matched ${frame.matches})`]);
          continue;
        }
        appendViolations(frame.violations, frame.tailViolations);
        if (frame.violations.length > 0) finish(frame.violations);
        else if (frame.kind === "object") finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a lossless JSON object`]);
        else finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a dense lossless JSON array`]);
        continue;
      }
      const nodeType = Object.hasOwn(frame.node, "type") ? frame.node.type : void 0;
      frame.catches = !(nodeType !== void 0 && !SCHEMA_TYPES.includes(nodeType));
      const oneOf = Object.hasOwn(frame.node, "oneOf") ? frame.node.oneOf : void 0;
      if (oneOf !== void 0) {
        frame.kind = "oneOf";
        frame.children = Array.from(oneOf, (branch) => ({
          node: branch,
          value: frame.value,
          path: frame.path
        }));
        frame.childIndex = 0;
        frame.matches = 0;
        frame.phase = "children";
        continue;
      }
      if (nodeType === void 0) {
        finish(safelyIsJsonValue(frame.value) ? [] : losslessValueViolation(frame.path));
        continue;
      }
      switch (nodeType) {
        case "object": {
          if (!isPlainJsonRecord(frame.value)) {
            finish([`"${diagnosticPath(frame.path)}" must be an object`]);
            break;
          }
          const properties = Object.hasOwn(frame.node, "properties") ? frame.node.properties ?? {} : {};
          const violations = [];
          const required = Object.hasOwn(frame.node, "required") ? frame.node.required ?? [] : [];
          for (const key of required) if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) violations.push(`missing required property "${propertyPath(frame.path, key)}"`);
          const children = [];
          for (const [key, child] of Object.entries(properties)) {
            if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) continue;
            children.push({
              node: child,
              value: frame.value[key],
              path: propertyPath(frame.path, key)
            });
          }
          const tailViolations = [];
          if (Object.hasOwn(frame.node, "additionalProperties") && frame.node.additionalProperties === false) {
            for (const key of Object.keys(frame.value)) if (!Object.hasOwn(properties, key)) tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`);
          }
          frame.kind = "object";
          frame.children = children;
          frame.childIndex = 0;
          frame.violations = violations;
          frame.tailViolations = tailViolations;
          frame.phase = "children";
          break;
        }
        case "array": {
          if (!Array.isArray(frame.value)) {
            finish([`"${diagnosticPath(frame.path)}" must be an array`]);
            break;
          }
          const items = Object.hasOwn(frame.node, "items") ? frame.node.items : void 0;
          const children = items === void 0 ? [] : frame.value.flatMap((entry, index) => [{
            node: items,
            value: entry,
            path: `${frame.path}[${index}]`
          }]);
          frame.kind = "array";
          frame.children = children;
          frame.childIndex = 0;
          frame.violations = [];
          frame.phase = "children";
          break;
        }
        case "string":
          finish(typeof frame.value === "string" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a string`]);
          break;
        case "number":
          finish(typeof frame.value !== "number" ? [`"${diagnosticPath(frame.path)}" must be a number`] : !isJsonNumber(frame.value) ? [`"${diagnosticPath(frame.path)}" must be a finite JSON number`] : checkScalarValue(frame.node, frame.value, frame.path));
          break;
        case "integer":
          finish(!isJsonNumber(frame.value) || !Number.isInteger(frame.value) ? [`"${diagnosticPath(frame.path)}" must be an integer`] : checkScalarValue(frame.node, frame.value, frame.path));
          break;
        case "boolean":
          finish(typeof frame.value === "boolean" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a boolean`]);
          break;
        case "null":
          finish(frame.value === null ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be null`]);
          break;
        default:
          finish(assertNever(nodeType, "JsonSchemaType"));
      }
    } catch (error) {
      let failed = frames.pop();
      while (failed !== void 0 && !failed.catches) failed = frames.pop();
      if (failed === void 0) throw error;
      receive(losslessValueViolation(failed.path));
    }
  }
  return rootResult ?? losslessValueViolation(path);
}
function validateJsonSchemaValue(schema, value, path = "value") {
  return checkValue(schema, value, path);
}
var ANNOTATION_KEYS = [
  "description",
  "title",
  "default",
  "examples"
];
function authorError(message) {
  throw new JsonSchemaError([message]);
}
function copyAnnotations(source, target) {
  if (Object.hasOwn(source, "description")) target.description = source.description;
  if (Object.hasOwn(source, "title")) target.title = source.title;
  if (Object.hasOwn(source, "default")) target.default = source.default;
  if (Object.hasOwn(source, "examples")) target.examples = source.examples;
}
function assertAuthorKeys(source, path, allowed) {
  for (const key of Object.keys(source)) if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
}
function assignCompiledNode(destination, node) {
  switch (destination.kind) {
    case "root":
      destination.holder.value = node;
      break;
    case "property":
      Object.defineProperty(destination.target, destination.key, {
        value: node,
        enumerable: true,
        configurable: true,
        writable: true
      });
      break;
    case "item":
      destination.target.items = node;
      break;
    case "one-of":
      destination.target[destination.index] = node;
      break;
  }
}
function assignCompiledPropertyMap(destination, compiled) {
  if (destination.kind === "root") destination.holder.value = compiled;
  else destination.target.properties = compiled.properties;
}
function runSchemaCompiler(initial) {
  const seen = /* @__PURE__ */ new Set();
  const tasks = [initial];
  for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
    if (task.kind === "leave") {
      seen.delete(task.input);
      continue;
    }
    if (task.kind === "property-map-tail") {
      if (task.required.length > 0) {
        task.compiled.required = task.required;
        if (task.destination.kind === "object") task.destination.target.required = task.required;
      }
      continue;
    }
    if (task.kind === "property") {
      if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`);
      if (Object.hasOwn(task.property, "required") && task.property.required !== true) authorError(`${task.path}.required must be true when present`);
      if (Object.hasOwn(task.property, "required") && task.property.required === true) task.required.push(task.key);
      tasks.push({
        kind: "value",
        input: task.property,
        path: task.path,
        allowRequired: true,
        destination: {
          kind: "property",
          target: task.properties,
          key: task.key
        }
      });
      continue;
    }
    if (task.kind === "property-map") {
      if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`);
      if (seen.has(task.input)) authorError(`${task.path} is circular`);
      seen.add(task.input);
      const compiled = { properties: {} };
      const required = [];
      assignCompiledPropertyMap(task.destination, compiled);
      tasks.push({
        kind: "leave",
        input: task.input
      });
      tasks.push({
        kind: "property-map-tail",
        compiled,
        required,
        destination: task.destination
      });
      const entries = Object.entries(task.input);
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry === void 0) continue;
        tasks.push({
          kind: "property",
          property: entry[1],
          path: `${task.path}.${entry[0]}`,
          key: entry[0],
          properties: compiled.properties,
          required
        });
      }
      continue;
    }
    const { input, path } = task;
    if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`);
    if (seen.has(input)) authorError(`${path} is circular`);
    seen.add(input);
    const authorKeys = [...ANNOTATION_KEYS, ...task.allowRequired ? ["required"] : []];
    const node = {};
    assignCompiledNode(task.destination, node);
    tasks.push({
      kind: "leave",
      input
    });
    if (Object.hasOwn(input, "oneOf")) {
      assertAuthorKeys(input, path, [
        ...authorKeys,
        "oneOf",
        "type"
      ]);
      if (Object.hasOwn(input, "type")) authorError(`${path} cannot declare both type and oneOf`);
      if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`);
      const branches = [];
      node.oneOf = branches;
      copyAnnotations(input, node);
      for (let index = input.oneOf.length - 1; index >= 0; index--) tasks.push({
        kind: "value",
        input: input.oneOf[index],
        path: `${path}.oneOf[${index}]`,
        allowRequired: false,
        destination: {
          kind: "one-of",
          target: branches,
          index
        }
      });
      continue;
    }
    const inputType = Object.hasOwn(input, "type") ? input.type : void 0;
    switch (inputType) {
      case "json":
        assertAuthorKeys(input, path, [...authorKeys, "type"]);
        copyAnnotations(input, node);
        break;
      case "object":
        assertAuthorKeys(input, path, [
          ...authorKeys,
          "type",
          "properties",
          "additionalProperties"
        ]);
        if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean") authorError(`${path}.additionalProperties must be explicitly true or false`);
        node.type = "object";
        copyAnnotations(input, node);
        node.additionalProperties = input.additionalProperties;
        if (Object.hasOwn(input, "properties")) tasks.push({
          kind: "property-map",
          input: input.properties,
          path: `${path}.properties`,
          destination: {
            kind: "object",
            target: node
          }
        });
        break;
      case "array":
        assertAuthorKeys(input, path, [
          ...authorKeys,
          "type",
          "items"
        ]);
        node.type = "array";
        copyAnnotations(input, node);
        if (Object.hasOwn(input, "items")) tasks.push({
          kind: "value",
          input: input.items,
          path: `${path}.items`,
          allowRequired: false,
          destination: {
            kind: "item",
            target: node
          }
        });
        break;
      case "string":
      case "number":
      case "integer":
      case "boolean":
      case "null":
        assertAuthorKeys(input, path, [
          ...authorKeys,
          "type",
          "enum",
          "const"
        ]);
        node.type = inputType;
        copyAnnotations(input, node);
        if (Object.hasOwn(input, "enum")) {
          if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`);
          node.enum = Array.from(input.enum, (entry) => entry);
        }
        if (Object.hasOwn(input, "const")) node.const = input.const;
        break;
      default:
        authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
    }
  }
}
function compilePropertyMap(input, path) {
  const holder = {};
  runSchemaCompiler({
    kind: "property-map",
    input,
    path,
    destination: {
      kind: "root",
      holder
    }
  });
  return holder.value ?? authorError(`${path} did not compile`);
}
function compileValueSchema(input, path) {
  const holder = {};
  runSchemaCompiler({
    kind: "value",
    input,
    path,
    allowRequired: false,
    destination: {
      kind: "root",
      holder
    }
  });
  return holder.value ?? authorError(`${path} did not compile`);
}
function valueSchemaSpecToJsonSchema(spec) {
  const schema = compileValueSchema(spec, "schema");
  assertSupportedJsonSchema(schema);
  return schema;
}
function parameterSchemaSpecToJsonSchema(spec) {
  const compiled = compilePropertyMap(spec, "parameters");
  const schema = {
    type: "object",
    properties: compiled.properties,
    ...compiled.required === void 0 ? {} : { required: compiled.required }
  };
  assertSupportedJsonSchema(schema);
  return schema;
}
var ToolArgsError = class extends HarnessError {
  /** Individual violations in schema-walk order. */
  violations;
  constructor(violations) {
    super(`invalid arguments: ${violations.join("; ")}`, "INVALID_ARGS");
    this.name = "ToolArgsError";
    this.violations = violations;
  }
};
function defineTool(options) {
  const userExecute = options.execute;
  const userFinalizeContent = options.finalizeContent;
  const userRender = options.output.render;
  const userPresentationMeta = options.output.presentationMeta;
  const userPresentCall = options.presentCall;
  const userPresentResult = options.presentResult;
  const userIsConcurrencySafe = options.isConcurrencySafe;
  if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
  const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
  const validate = (args) => validateJsonSchemaValue(parameters, args, "");
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return userRender(args, value);
      },
      ...userPresentationMeta !== void 0 ? { presentationMeta(args, value) {
        return userPresentationMeta(args, value);
      } } : {}
    },
    ...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
    async execute(args, exec) {
      const violations = validate(args);
      if (violations.length > 0) throw new ToolArgsError(violations);
      return userExecute(args, exec);
    }
  };
  if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
  if (userPresentCall) tool.presentCall = (args) => {
    if (validate(args).length > 0) return void 0;
    return userPresentCall(args);
  };
  if (userPresentResult) tool.presentResult = (args, result) => {
    if (validate(args).length > 0) return void 0;
    return userPresentResult(args, result);
  };
  if (userIsConcurrencySafe) tool.isConcurrencySafe = (args) => {
    if (validate(args).length > 0) return false;
    return userIsConcurrencySafe(args);
  };
  return tool;
}
var RUN_CODE_NAME = "run_code";
var TYPESCRIPT_FLAVOR = {
  description: "Execute a TypeScript program against the available tools. Write the BODY of an async function (erasable syntax only; top-level `await` and `return` work) and call tools as `await tools.name(args)` per the declarations in the system prompt. Only what you print or return comes back \u2014 curate it.",
  codeDescription: "The program: the body of an async TypeScript function."
};
var RUN_CODE_FLAVORS = {
  typescript: TYPESCRIPT_FLAVOR,
  python: {
    description: "Execute a Python program against the available tools. Write the BODY of an async function (top-level `await` and `return` work) and call tools as `await tools.name(args)` per the declarations in the system prompt. Answer with `print(...)` and/or `return <value>` \u2014 only that comes back, so curate it.",
    codeDescription: "The program: the body of an async Python function."
  }
};
var RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION = 'Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: "Count TODO markers across packages"; "Read failing test and its fixture"; "Rename config key in every cordis.yml".';
function resolveFlavor(peekRuntime) {
  const runtime = peekRuntime();
  if (runtime === void 0) return TYPESCRIPT_FLAVOR;
  const flavor = RUN_CODE_FLAVORS[runtime.language];
  if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language) || flavor === void 0) {
    const known = Object.keys(RUN_CODE_FLAVORS).map((name2) => JSON.stringify(name2)).join(", ");
    throw new Error(`dsh-tools: no run_code schema flavor registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
  }
  return flavor;
}
var CodeRunFailedError = class extends HarnessError {
  constructor(message) {
    super(message, "CODE_RUN_FAILED");
    this.name = "CodeRunFailedError";
  }
};
function jsonNormalizeArgs(value) {
  let snapshot;
  try {
    snapshot = snapshotJsonValue(value);
  } catch (error) {
    throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (snapshot === void 0) throw new Error("tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)");
  const logged = snapshotJsonValue(snapshot);
  if (logged === void 0) throw new Error("tool arguments could not be detached for durable logging");
  return {
    dispatched: snapshot,
    logged
  };
}
var JSON_INDENT = "  ";
var MAX_JSON_INDENT_CHARS = 10;
function renderJsonValue(value) {
  const chunks = [];
  const tasks = [{
    kind: "value",
    value,
    depth: 0,
    compact: false
  }];
  for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
    if (task.kind === "text") {
      chunks.push(task.text);
      continue;
    }
    const current = task.value;
    if (current === null || typeof current === "boolean" || typeof current === "number") {
      chunks.push(String(current));
      continue;
    }
    if (typeof current === "string") {
      chunks.push(JSON.stringify(current));
      continue;
    }
    const compact = task.compact || (task.depth + 1) * 2 > MAX_JSON_INDENT_CHARS;
    const childDepth = task.depth + 1;
    if (Array.isArray(current)) {
      chunks.push("[");
      if (current.length === 0) {
        chunks.push("]");
        continue;
      }
      tasks.push({
        kind: "text",
        text: compact ? "]" : `
${JSON_INDENT.repeat(task.depth)}]`
      });
      for (let index = current.length - 1; index >= 0; index--) {
        const item = current[index];
        if (item === void 0) throw new Error("cannot render a sparse JSON array");
        tasks.push({
          kind: "value",
          value: item,
          depth: childDepth,
          compact
        });
        tasks.push({
          kind: "text",
          text: compact ? index === 0 ? "" : "," : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}`
        });
      }
      continue;
    }
    const keys = Object.keys(current);
    chunks.push("{");
    if (keys.length === 0) {
      chunks.push("}");
      continue;
    }
    tasks.push({
      kind: "text",
      text: compact ? "}" : `
${JSON_INDENT.repeat(task.depth)}}`
    });
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      if (key === void 0) throw new Error("cannot render a missing JSON object key");
      const item = current[key];
      if (item === void 0) throw new Error("cannot render an undefined JSON object property");
      tasks.push({
        kind: "value",
        value: item,
        depth: childDepth,
        compact
      });
      tasks.push({
        kind: "text",
        text: compact ? `${index === 0 ? "" : ","}${JSON.stringify(key)}:` : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `
      });
    }
  }
  return chunks.join("");
}
function renderValue(value) {
  return typeof value === "string" ? value : renderJsonValue(value);
}
function createRunCodeTool(registry, options) {
  const { requireRuntime, peekRuntime, maxParallel, shapeDispatchLog } = options;
  const definition = defineTool({
    name: RUN_CODE_NAME,
    description: TYPESCRIPT_FLAVOR.description,
    parameters: {
      code: {
        type: "string",
        required: true,
        description: TYPESCRIPT_FLAVOR.codeDescription
      },
      description: {
        type: "string",
        required: true,
        description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          logs: {
            type: "array",
            required: true,
            items: { type: "string" }
          },
          result: { type: "json" }
        }
      },
      render: (_args, value) => {
        const rendered = value.result === void 0 ? "" : renderValue(value.result);
        const parts = [value.logs.join("\n"), rendered].filter((part) => part.length > 0);
        return [{
          type: "text",
          text: parts.length > 0 ? parts.join("\n") : "(run_code completed with no output)"
        }];
      }
    },
    async execute(args, exec) {
      if (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
      const runtime = requireRuntime();
      const runController = new AbortController();
      const onOuterAbort = () => {
        runController.abort(exec.signal.reason);
      };
      exec.signal.addEventListener("abort", onOuterAbort, { once: true });
      let dispatches = 0;
      const pendingQueue = [];
      const inFlight = /* @__PURE__ */ new Set();
      const logWork = /* @__PURE__ */ new Set();
      const commitQueue = [];
      let exclusiveActive = false;
      let driving = false;
      let driverRun = Promise.resolve();
      let wake;
      const wakeup = () => {
        const release = wake;
        wake = void 0;
        release?.();
      };
      const drive = () => {
        if (driving) return driverRun;
        driving = true;
        driverRun = (async () => {
          try {
            for (; ; ) {
              const signal = new Promise((resolve5) => {
                wake = resolve5;
              });
              const commitHead = commitQueue[0];
              if (commitHead !== void 0 && commitHead.settled) {
                commitQueue.shift();
                await commitHead.commit();
                if (commitHead.mode === "exclusive") exclusiveActive = false;
                continue;
              }
              const head = pendingQueue[0];
              if (head !== void 0) {
                if (runController.signal.aborted) {
                  pendingQueue.shift();
                  head.abandon();
                  continue;
                }
                const mode = head.classify();
                if (!exclusiveActive && (mode === "exclusive" ? inFlight.size === 0 : inFlight.size < maxParallel)) {
                  if (mode === "exclusive") exclusiveActive = true;
                  head.mode = mode;
                  pendingQueue.shift();
                  commitQueue.push(head);
                  await head.start();
                  const flight = head.flight.finally(() => {
                    inFlight.delete(flight);
                    wakeup();
                  });
                  inFlight.add(flight);
                  continue;
                }
              }
              if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return;
              await signal;
            }
          } finally {
            driving = false;
            wake = void 0;
          }
        })();
        return driverRun;
      };
      const drainDispatches = async () => {
        await drive();
        while (logWork.size > 0) await Promise.allSettled([...logWork]);
      };
      const runOver = () => runController.signal.aborted;
      const binding = (name2) => async (rawArgs) => {
        if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name2} not dispatched`);
        const normalized = jsonNormalizeArgs(rawArgs);
        const n = ++dispatches;
        const subCallId = CallId(`${String(exec.callId)}:code:${n}`);
        const input = {
          callId: subCallId,
          rootCallId: exec.rootCallId,
          name: name2,
          arguments: normalized.dispatched,
          ...exec.agent ? { agent: exec.agent } : {},
          parent: exec.token,
          signal: runController.signal
        };
        const scheduler = registry[TOOL_REGISTRY_SCHEDULER];
        const outcome = await new Promise((resolve5, reject) => {
          let parked;
          const settle = (result) => {
            resolve5(result.isError ? {
              isError: true,
              message: result.error.message
            } : {
              isError: false,
              value: result.value
            });
            const agent = exec.agent;
            if (agent === void 0) return;
            const task = (async () => {
              const logged = await shapeDispatchLog({
                exec,
                agent,
                subCallId,
                name: name2,
                isError: result.isError,
                content: result.content
              });
              agent.session.append("tool/code-dispatch", {
                rootCallId: exec.rootCallId,
                parentCallId: exec.callId,
                subCallId,
                name: name2,
                arguments: normalized.logged,
                isError: result.isError,
                content: logged
              });
            })().finally(() => {
              logWork.delete(task);
            });
            logWork.add(task);
          };
          pendingQueue.push({
            flight: Promise.resolve(),
            settled: false,
            classify: () => registry.executionMode(input).kind,
            abandon: () => {
              reject(/* @__PURE__ */ new Error(`run_code run is over (${String(runController.signal.reason)}); ${name2} tool call abandoned`));
            },
            async start() {
              exec.agent?.session.append("tool/code-dispatch-start", {
                rootCallId: exec.rootCallId,
                parentCallId: exec.callId,
                subCallId,
                name: name2,
                arguments: normalized.logged
              });
              const prepared = await scheduler.prepare(input);
              if (prepared.kind === "dispatch") {
                this.flight = scheduler.dispatch(prepared.exec).then((dispatchOutcome) => {
                  parked = {
                    kind: dispatchOutcome.kind,
                    exec: prepared.exec,
                    result: dispatchOutcome.result
                  };
                  this.settled = true;
                });
                return;
              }
              parked = {
                kind: prepared.kind,
                exec: prepared.exec,
                result: prepared.result
              };
              this.settled = true;
            },
            async commit() {
              if (parked === void 0) return;
              const result = parked.kind === "post-result" ? await scheduler.finalize(parked.exec, parked.result) : scheduler.finish(parked.exec, parked.result);
              for (const context of result.additionalContexts ?? []) exec.deferContext(context);
              if (result.concludesTurn) exec.concludeTurn();
              settle(result);
              while (logWork.size > maxParallel) await Promise.race(logWork);
            }
          });
          wakeup();
          drive();
        });
        if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name2} result discarded`);
        if (outcome.isError) throw new Error(outcome.message);
        return outcome.value;
      };
      const functions = /* @__PURE__ */ Object.create(null);
      for (const schema of registry.schemas(exec.agent)) {
        if (schema.name === "run_code") continue;
        Object.defineProperty(functions, schema.name, {
          enumerable: true,
          value: binding(schema.name)
        });
      }
      try {
        let result;
        try {
          result = await runtime.run({
            program: args.code,
            bindings: [{
              global: "tools",
              functions,
              errorClass: {
                name: "ToolCallError",
                memberNameProperty: "toolName"
              }
            }],
            signal: runController.signal
          });
        } finally {
          runController.abort("run_code settled");
          await drainDispatches();
        }
        if (result.error) {
          const logsText = result.logs.length > 0 ? `
Captured output:
${result.logs.join("\n")}` : "";
          throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}`);
        }
        return {
          logs: result.logs,
          ...result.value !== void 0 ? { result: result.value } : {}
        };
      } finally {
        exec.signal.removeEventListener("abort", onOuterAbort);
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: args.description,
      kind: "execute",
      rawInput: args.code
    })
  });
  Object.defineProperty(definition, "description", {
    enumerable: true,
    get: () => resolveFlavor(peekRuntime).description
  });
  Object.defineProperty(definition, "parameters", {
    enumerable: true,
    get: () => parameterSchemaSpecToJsonSchema({
      code: {
        type: "string",
        required: true,
        description: resolveFlavor(peekRuntime).codeDescription
      },
      description: {
        type: "string",
        required: true,
        description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
      }
    })
  });
  return definition;
}
var IDENTIFIER$1 = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function renderKey(name2) {
  return IDENTIFIER$1.test(name2) ? name2 : JSON.stringify(name2);
}
function pad$1(indent) {
  return "  ".repeat(indent);
}
function docLines$1(description, indent) {
  if (typeof description !== "string" || description.length === 0) return [];
  const collapsed = description.replace(/\s+/g, " ").trim();
  return [`${pad$1(indent)}/** ${collapsed.replaceAll("*/", String.raw`*\/`)} */`];
}
function renderScalar(value) {
  return JSON.stringify(value);
}
function renderConstrainedScalar$1(node, type) {
  const broad = type === "integer" ? "number" : type;
  if (Object.hasOwn(node, "const")) return renderScalar(node.const);
  if (Object.hasOwn(node, "enum")) return node.enum.map(renderScalar).join(" | ");
  return broad;
}
function typeDocumentFrom(parts) {
  return {
    parts,
    containsUnionOrIntersection: parts.some((part) => typeof part === "string" ? part.includes("|") || part.includes("&") : part.containsUnionOrIntersection)
  };
}
function typeDocument(...parts) {
  return typeDocumentFrom(parts);
}
function flattenTypeDocument(document) {
  const chunks = [];
  const tasks = [document];
  for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
    if (typeof task === "string") {
      chunks.push(task);
      continue;
    }
    for (let index = task.parts.length - 1; index >= 0; index--) {
      const part = task.parts[index];
      if (part !== void 0) tasks.push(part);
    }
  }
  return chunks.join("");
}
function schemaRenderFrame(node, indent) {
  return {
    node,
    indent,
    phase: "start",
    children: [],
    childIndex: 0,
    childDocuments: [],
    entries: []
  };
}
function renderSupportedSchema(schema, indent) {
  const frames = [schemaRenderFrame(schema, indent)];
  let rootDocument;
  const finish = (document) => {
    frames.pop();
    const parent = frames.at(-1);
    if (parent === void 0) rootDocument = document;
    else parent.childDocuments.push(document);
  };
  while (frames.length > 0) {
    const frame = frames.at(-1);
    if (frame === void 0) break;
    if (frame.phase === "children") {
      if (frame.childIndex < frame.children.length) {
        const child = frame.children[frame.childIndex];
        if (child === void 0) throw new Error("missing schema render child");
        frame.childIndex++;
        frames.push(schemaRenderFrame(child.node, child.indent));
        continue;
      }
      if (frame.kind === "oneOf") {
        const parts2 = [];
        for (let index = 0; index < frame.childDocuments.length; index++) {
          if (index > 0) parts2.push(" | ");
          const child = frame.childDocuments[index];
          if (child !== void 0) parts2.push(child);
        }
        finish(typeDocumentFrom(parts2));
        continue;
      }
      if (frame.kind === "array") {
        const child = frame.childDocuments[0];
        if (child === void 0) throw new Error("missing array item type");
        finish(child.containsUnionOrIntersection ? typeDocument("(", child, ")[]") : typeDocument(child, "[]"));
        continue;
      }
      const required = new Set(frame.node.required);
      const parts = ["{"];
      for (let index = 0; index < frame.entries.length; index++) {
        const entry = frame.entries[index];
        const child = frame.childDocuments[index];
        if (entry === void 0 || child === void 0) throw new Error("missing object property type");
        const [name2, prop] = entry;
        for (const line of docLines$1(prop.description, frame.indent + 1)) parts.push("\n", line);
        parts.push("\n", `${pad$1(frame.indent + 1)}${renderKey(name2)}${required.has(name2) ? "" : "?"}: `, child, ";");
      }
      parts.push("\n", `${pad$1(frame.indent)}}`);
      const declared = typeDocumentFrom(parts);
      finish(frame.node.additionalProperties === false ? declared : typeDocument(declared, " & Record<string, JsonValue>"));
      continue;
    }
    const node = frame.node;
    if (node.oneOf !== void 0) {
      frame.kind = "oneOf";
      frame.children = Array.from(node.oneOf, (child) => ({
        node: child,
        indent: frame.indent
      }));
      frame.childIndex = 0;
      frame.childDocuments = [];
      frame.phase = "children";
      continue;
    }
    if (node.type === void 0) {
      finish(typeDocument("JsonValue"));
      continue;
    }
    switch (node.type) {
      case "string":
      case "number":
      case "integer":
      case "boolean":
      case "null":
        finish(typeDocument(renderConstrainedScalar$1(node, node.type)));
        break;
      case "array":
        if (node.items === void 0) finish(typeDocument("JsonValue[]"));
        else {
          frame.kind = "array";
          frame.children = [{
            node: node.items,
            indent: frame.indent
          }];
          frame.childIndex = 0;
          frame.childDocuments = [];
          frame.phase = "children";
        }
        break;
      case "object": {
        const open = node.additionalProperties !== false;
        const entries = Object.entries(node.properties ?? {});
        if (entries.length === 0) finish(typeDocument(open ? "Record<string, JsonValue>" : "Record<string, never>"));
        else {
          frame.kind = "object";
          frame.entries = entries;
          frame.children = entries.map(([, child]) => ({
            node: child,
            indent: frame.indent + 1
          }));
          frame.childIndex = 0;
          frame.childDocuments = [];
          frame.phase = "children";
        }
        break;
      }
      /* v8 ignore next -- assertSupportedJsonSchema narrowed this closed type union. */
      default:
        finish(typeDocument("unknown"));
    }
  }
  return rootDocument ?? typeDocument("unknown");
}
function jsonSchemaToTs(schema, indent = 0) {
  try {
    assertSupportedJsonSchema(schema);
    return flattenTypeDocument(renderSupportedSchema(schema, indent));
  } catch {
    return "unknown";
  }
}
var SDK_INSTRUCTIONS$1 = `## Writing code for run_code

Pass \`run_code\` the body of an async TypeScript function (erasable syntax only \u2014 no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped). Inside the program:

- Call tools as \`await tools.name(args)\` \u2014 quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable \u2014 \`try/catch\` it to handle and continue.
- Independent read-only calls MAY overlap under \`Promise.all\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit results with \`return\` and/or \`console.log(...)\`. ONLY what you print or return comes back to you \u2014 intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`;
function renderToolsSdk(schemas) {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const argsMembers = [];
  const outputMembers = [];
  for (const schema of sorted) {
    argsMembers.push(...docLines$1(schema.description, 1));
    argsMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`);
    outputMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`);
  }
  return `${SDK_INSTRUCTIONS$1}

\`\`\`ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

${[
    `interface ToolArgsMap {${argsMembers.length > 0 ? `
${argsMembers.join("\n")}
` : ""}}`,
    `interface ToolOutputMap {${outputMembers.length > 0 ? `
${outputMembers.join("\n")}
` : ""}}`,
    "type ToolName = keyof ToolOutputMap",
    [
      "declare class ToolCallError extends Error {",
      '  readonly name: "ToolCallError";',
      "  readonly toolName: ToolName;",
      "}"
    ].join("\n"),
    [
      "declare const tools: {",
      "  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;",
      "}"
    ].join("\n")
  ].join("\n\n")}
\`\`\``;
}
var IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
function isBareIdentifier(name2) {
  return IDENTIFIER.test(name2) && name2.normalize("NFKC") === name2;
}
var RESERVED = /* @__PURE__ */ new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "__debug__"
]);
var TYPING_ORDER = [
  "Any",
  "Literal",
  "NotRequired",
  "Protocol",
  "TypedDict"
];
function pad(indent) {
  return "    ".repeat(indent);
}
var UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
var LONE_SURROGATE = /[\ud800-\udfff]/gu;
function describe(schema) {
  const description = schema.description;
  if (typeof description !== "string") return void 0;
  const collapsed = description.replace(/\s+/g, " ").replace(UNPRINTABLE, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`).replace(LONE_SURROGATE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).trim();
  return collapsed.length === 0 ? void 0 : collapsed;
}
function docLines(description, indent) {
  const collapsed = describe({ description });
  if (collapsed === void 0) return [];
  const escaped = collapsed.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return [`${pad(indent)}"""${escaped}"""`];
}
function camelCase(raw) {
  const joined = raw.split(/[^\p{XID_Continue}]+|_+/u).filter((part) => part.length > 0).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("").normalize("NFKC");
  return (/^\p{XID_Start}/u.test(joined) ? joined : `Tool${joined}`).normalize("NFKC");
}
var MAX_CLASS_NAME_BASE = 120;
var MAX_LIST_NESTING = 180;
function capClassNameBase(base) {
  if (base.length <= MAX_CLASS_NAME_BASE) return base;
  const capped = base.slice(0, MAX_CLASS_NAME_BASE);
  return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped;
}
function allocateClassName(base, state) {
  const capped = capClassNameBase(base);
  let name2 = capped;
  if (state.usedClassNames.has(name2)) {
    let n = state.nextClassCounter.get(capped) ?? 2;
    while (state.usedClassNames.has(`${capped}${n}`)) n++;
    name2 = `${capped}${n}`;
    state.nextClassCounter.set(capped, n + 1);
  }
  state.usedClassNames.add(name2);
  return name2;
}
function childClassName(base, segment) {
  return capClassNameBase(`${base}${segment}`.normalize("NFKC"));
}
function pyScalar(value) {
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) return BigInt(value).toString();
  return String(value);
}
function renderConstrainedScalar(node, broad, state) {
  if (node.const !== void 0) {
    state.typing.add("Literal");
    return `Literal[${pyScalar(node.const)}]`;
  }
  if (node.enum !== void 0) {
    state.typing.add("Literal");
    return `Literal[${node.enum.map(pyScalar).join(", ")}]`;
  }
  return broad;
}
function renderType(schema, className, state) {
  const newFrame = (schema2, className2, listDepth) => ({
    schema: schema2,
    className: className2,
    phase: "start",
    listDepth,
    children: [],
    childIndex: 0,
    childTypes: [],
    entries: []
  });
  try {
    assertSupportedJsonSchema(schema);
    const frames = [newFrame(schema, className, 0)];
    let result;
    const finish = (type) => {
      frames.pop();
      const parent = frames.at(-1);
      if (parent === void 0) result = type;
      else parent.childTypes.push(type);
    };
    while (frames.length > 0) {
      const frame = frames.at(-1);
      if (frame === void 0) break;
      if (frame.phase === "children") {
        if (frame.childIndex < frame.children.length) {
          const child = frame.children[frame.childIndex];
          if (child === void 0) throw new Error("missing python render child");
          frame.childIndex++;
          frames.push(newFrame(child.schema, child.className, child.listDepth));
          continue;
        }
        if (frame.kind === "oneOf") {
          let union = "";
          for (const [index, childType] of frame.childTypes.entries()) union = index === 0 ? childType : `${union} | ${childType}`;
          finish(union);
          continue;
        }
        if (frame.kind === "array") {
          finish(`list[${frame.childTypes[0] ?? "Any"}]`);
          continue;
        }
        const node2 = frame.node;
        const name2 = frame.allocated;
        if (node2 === void 0 || name2 === void 0) throw new Error("missing typeddict frame state");
        const required = new Set(node2.required);
        const lines = [`class ${name2}(TypedDict):`];
        for (let index = 0; index < frame.entries.length; index++) {
          const entry = frame.entries[index];
          const fieldType = frame.childTypes[index];
          if (entry === void 0 || fieldType === void 0) throw new Error("missing typeddict field type");
          const [field, fieldSchema] = entry;
          const description = describe(fieldSchema);
          if (description !== void 0) lines.push(`${pad(1)}# ${description}`);
          if (required.has(field)) lines.push(`${pad(1)}${field}: ${fieldType}`);
          else {
            state.typing.add("NotRequired");
            lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`);
          }
        }
        if (node2.additionalProperties !== false) lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`);
        if (lines.length === 1) lines.push(`${pad(1)}pass`);
        state.classes.push(lines.join("\n"));
        finish(name2);
        continue;
      }
      frame.phase = "children";
      const node = frame.schema;
      if (node.oneOf !== void 0) {
        frame.kind = "oneOf";
        frame.children = node.oneOf.map((branch, index) => ({
          schema: branch,
          className: childClassName(frame.className, `${index + 1}`),
          listDepth: frame.listDepth
        }));
        continue;
      }
      if (node.type === void 0) {
        state.typing.add("Any");
        finish("Any");
        continue;
      }
      switch (node.type) {
        case "string":
          finish(renderConstrainedScalar(node, "str", state));
          break;
        case "number":
          finish(renderConstrainedScalar(node, "float", state));
          break;
        case "integer":
          finish(renderConstrainedScalar(node, "int", state));
          break;
        case "boolean":
          finish(renderConstrainedScalar(node, "bool", state));
          break;
        case "null":
          finish("None");
          break;
        case "array":
          if (node.items === void 0) {
            state.typing.add("Any");
            finish("list[Any]");
            break;
          }
          if (frame.listDepth >= MAX_LIST_NESTING) {
            state.typing.add("Any");
            finish("Any");
            break;
          }
          frame.kind = "array";
          frame.children = [{
            schema: node.items,
            className: frame.className,
            listDepth: frame.listDepth + 1
          }];
          break;
        case "object": {
          const entries = Object.entries(node.properties ?? {});
          if (className === "" || !entries.every(([name2]) => isBareIdentifier(name2) && !RESERVED.has(name2) && !(name2.startsWith("__") && !name2.endsWith("__")))) {
            state.typing.add("Any");
            finish("dict[str, Any]");
            break;
          }
          if (entries.length === 0 && node.additionalProperties !== false) {
            state.typing.add("Any");
            finish("dict[str, Any]");
            break;
          }
          frame.kind = "typeddict";
          frame.node = node;
          frame.allocated = allocateClassName(frame.className, state);
          state.typing.add("TypedDict");
          frame.entries = entries;
          frame.children = entries.map(([field, child]) => ({
            schema: child,
            className: childClassName(frame.allocated ?? "", camelCase(field)),
            listDepth: 1
          }));
          break;
        }
        /* v8 ignore next 4 -- assertSupportedJsonSchema narrowed this closed type union. */
        default:
          state.typing.add("Any");
          finish("Any");
      }
    }
    return result ?? "Any";
  } catch {
    state.typing.add("Any");
    return "Any";
  }
}
var SDK_INSTRUCTIONS = `## Writing code for run_code

Pass \`run_code\` the body of an async Python function (top-level \`await\` and \`return\` both work). At run time exactly two of the names declared below are bound: \`tools\` and \`ToolCallError\`. Everything else is a STATIC STUB describing argument and return types \u2014 in particular the \`TypedDict\` classes do NOT exist at run time, so build arguments as plain \`dict\`/\`list\` JSON values: \`await tools.name({"field": 1})\`, never \`FooArgs(field=1)\`, which raises \`NameError\`. Inside the program:

- Call tools as \`await tools.name(args)\` \u2014 subscript access for exotic, reserved, or underscore-leading names: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable \u2014 wrap in \`try/except\` to handle and continue.
- Independent read-only calls MAY overlap under \`asyncio.gather\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit the run's answer with \`print(...)\` and/or a top-level \`return <value>\`; the returned value must be lossless JSON. ONLY what you print and the returned value come back \u2014 intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`;
function renderToolsSdkPy(schemas) {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const state = {
    classes: [],
    usedClassNames: /* @__PURE__ */ new Set(),
    nextClassCounter: /* @__PURE__ */ new Map(),
    typing: /* @__PURE__ */ new Set(["Protocol"])
  };
  const members = [];
  let statements = 0;
  for (const schema of sorted) {
    const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state);
    const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state);
    if (isBareIdentifier(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith("_")) {
      const doc = docLines(schema.description, 2);
      members.push(doc.length > 0 ? `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}:` : `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}: ...`);
      members.push(...doc);
      statements += 1;
    } else {
      members.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`);
      const description = describe(schema);
      if (description !== void 0) members.push(`${pad(1)}#   ${description}`);
    }
  }
  const body = (statements > 0 ? members : [`${pad(1)}pass`, ...members]).join("\n");
  const imports = TYPING_ORDER.filter((symbol) => state.typing.has(symbol));
  const classBlock = state.classes.length > 0 ? `${state.classes.join("\n\n")}

` : "";
  return `${SDK_INSTRUCTIONS}

\`\`\`python
${`from typing import ${imports.join(", ")}

class ToolCallError(Exception):
    toolName: str

${classBlock}class Tools(Protocol):
${body}

tools: Tools`}
\`\`\``;
}
var SDK_RENDERERS = {
  typescript: renderToolsSdk,
  python: renderToolsSdkPy
};
var TOOL_REGISTRY_SCHEDULER = /* @__PURE__ */ Symbol("@deepseek-ai/dsh-tools.scheduler");
var TOOL_ABORTED = "ABORTED";
var TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH";
var ToolNotFoundError = class extends HarnessError {
  constructor(toolName) {
    super(`unknown tool "${toolName}"`, "UNKNOWN_TOOL");
    this.name = "ToolNotFoundError";
  }
};
var ToolOutputError = class extends HarnessError {
  /** Schema/value violations in validation order. */
  violations;
  constructor(toolName, violations) {
    super(`tool "${toolName}" returned invalid output: ${violations.join("; ")}`, "INVALID_TOOL_OUTPUT");
    this.name = "ToolOutputError";
    this.violations = violations;
  }
};
function projectionError(toolName, projector, error) {
  return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`]);
}
function snapshotProjection(toolName, projector, candidate) {
  try {
    const detached = snapshotJsonValue(candidate);
    if (detached === void 0) throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`]);
    return detached;
  } catch (error) {
    if (error instanceof ToolOutputError) throw error;
    throw projectionError(toolName, projector, error);
  }
}
function snapshotToolValue(toolName, candidate) {
  try {
    const detached = snapshotJsonValue(candidate);
    if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"]);
    return detached;
  } catch (error) {
    if (error instanceof ToolOutputError) throw error;
    throw new ToolOutputError(toolName, [`value snapshot failed: ${errorMessage(error)}`]);
  }
}
function errorMessage(error) {
  try {
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
    return String(error);
  } catch {
    return "<unprintable thrown value>";
  }
}
function failureMessageFromContent(content) {
  const text = content.map((block) => block.type === "text" ? block.text : `[${block.type} content]`).join("\n");
  return text.length > 0 ? text : "tool result blocked by post-execute policy";
}
function materializePresentation(candidate) {
  const detached = snapshotJsonValue(candidate);
  if (detached === void 0) throw new TypeError("tool result must be losslessly JSON-serializable");
  return deepFreeze(detached);
}
function errorInfo(error) {
  try {
    return error instanceof HarnessError ? {
      name: error.name,
      code: error.code
    } : void 0;
  } catch {
    return;
  }
}
var ToolLayer = class {
  tools;
  restrictions = new AnonymousEntries();
  guards = new AnonymousEntries();
  /**
  * Presentation this scope's agent declared for itself, shadowing the
  * deployment default. One cell rather than an entry table: two answers to
  * "which form does the model see" is a contradiction, not a merge.
  */
  mode;
  constructor(scope) {
    this.tools = new NamedEntries((name2) => /* @__PURE__ */ new Error(scope === void 0 ? `tool "${name2}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name2}" is already registered in this scope`));
  }
  /** Whether every contribution table in this aggregate layer is empty. */
  isEmpty() {
    return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty() && this.mode === void 0;
  }
  /** Whether every compiled restriction in this layer admits an inherited tool name. */
  admits(name2) {
    for (const filter of this.restrictions.values()) if (filter.allow !== void 0 && !filter.allow.has(name2) || filter.deny !== void 0 && filter.deny.has(name2)) return false;
    return true;
  }
  /** First monotonic denial from this layer's live guard registrations. */
  guardReason(exec) {
    for (const guard of this.guards.values()) {
      const reason = guard(exec);
      if (reason !== void 0) return reason;
    }
  }
};
function resolveMaxParallelSubCalls(value) {
  const maxParallelSubCalls = value ?? 10;
  if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) throw new Error("maxParallelSubCalls must be a positive integer");
  return maxParallelSubCalls;
}
var ToolRegistry = class extends Service {
  static inject = ["systemPrompt"];
  static Config = Schema.object({
    mode: Schema.union([
      "native",
      "code",
      "both"
    ]).default("native"),
    maxParallelSubCalls: Schema.natural().min(1).default(10)
  });
  /** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
  [TOOL_REGISTRY_SCHEDULER] = {
    prepare: (exec) => this.prepareScheduledExecution(exec),
    dispatch: (exec) => this.dispatchScheduledExecution(exec),
    finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
    finish: (exec, result) => this.finishScheduledExecution(exec, result)
  };
  /** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
  deferredContexts = /* @__PURE__ */ new WeakMap();
  /** Executions whose tool body declared the current turn complete. */
  concludingExecutions = /* @__PURE__ */ new WeakSet();
  /** Original caller cancellation, kept outside the wrapper-mutable execution object. */
  cancellationStates = /* @__PURE__ */ new WeakMap();
  /** Definition-owned final content transform snapshotted before policy begins. */
  contentFinalizers = /* @__PURE__ */ new WeakMap();
  layers = new ScopedLayers((scope) => new ToolLayer(scope), () => {
    this.ctx.emit("tools/change");
  });
  /** Presentation for agents that declare none; {@link presentAs} shadows it per agent. */
  defaultMode;
  maxParallelSubCalls;
  /**
  * Reserved presentation transport, kept outside the filterable registration
  * layers. Built on first need rather than at construction: which agents run
  * a code mode is no longer known when the service is constructed, and the
  * transport is stateless beyond its closures over `this`.
  */
  codeTransport;
  constructor(ctx, config = {}) {
    super(ctx, "tools");
    this.defaultMode = config.mode ?? "native";
    this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls);
    ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope));
    if (this.defaultMode !== "native") ctx.systemPrompt.section(this.sdkSection());
  }
  /**
  * The generated-SDK prompt section, registered globally by a code-mode
  * deployment and per agent by {@link presentAs}.
  *
  * The body regenerates from the CALLING scope, and renders empty for an
  * agent presenting natively — an agent that opted out under a code-mode
  * deployment still sees the global registration, and an empty section is
  * dropped from the rendered prompt.
  * @returns the section registration.
  */
  sdkSection() {
    return {
      name: "tools:sdk",
      order: 150,
      text: (context) => {
        const mode = this.modeFor(context.scope);
        if (mode === "native") return "";
        const runtime = this.requireCodeRuntime(mode);
        const render = SDK_RENDERERS[runtime.language];
        if (render === void 0) throw new Error(`dsh-tools: no SDK renderer for ${runtime.language}`);
        return render(this.sdkSchemas(context.scope));
      }
    };
  }
  /**
  * The presentation one scope's agent sees: its own declaration, else the
  * deployment default.
  * @param scope - the calling agent, or undefined for the global view.
  * @returns the resolved presentation mode.
  */
  modeFor(scope) {
    const layers = this.layers.chainLayers(scope);
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const mode = layers[index]?.mode;
      if (mode !== void 0) return mode;
    }
    return this.defaultMode;
  }
  /**
  * The reserved `run_code` transport, built on first need.
  *
  * It never enters the global layer: per-agent restrictions must not remove
  * it, and a scoped registration must not shadow it. The visibility resolver
  * appends it after resolving the filterable global/scoped capability layers,
  * and only for scopes whose mode actually presents it.
  * @returns the shared transport definition.
  */
  requireCodeTransport() {
    this.codeTransport ??= createRunCodeTool(this, {
      requireRuntime: () => this.requireCodeRuntime(this.defaultMode),
      peekRuntime: () => this.ctx.get("codeRuntime"),
      maxParallel: this.maxParallelSubCalls,
      shapeDispatchLog: (dispatch) => this.shapeDispatchLog(dispatch)
    });
    return this.codeTransport;
  }
  /**
  * Present this agent's tools in `mode` instead of the deployment default.
  *
  * Scoped only, and one declaration per agent: this is how an agent preset
  * composes a Code Mode agent beside native ones in the same process, and a
  * process-global override would be the `mode` config field instead.
  * @param mode - the presentation this agent's model sees.
  * @returns the exact disposer that restores the deployment default.
  */
  presentAs(mode) {
    const ctx = this.ctx;
    if (scopeOf(ctx) === void 0) throw new Error("tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the `mode` config field on the tools row");
    return ctx.effect(function* () {
      yield this.layers.effect(ctx, (layer) => {
        if (layer.mode !== void 0) throw new Error(`tools.presentAs("${mode}") conflicts with "${layer.mode}" already declared for this agent; one composition selects one presentation`);
        layer.mode = mode;
        return () => {
          layer.mode = void 0;
        };
      }, { label: "tools.presentAs()" });
      if (mode !== "native") yield ctx.systemPrompt.section(this.sdkSection());
    }.bind(this), "tools.presentAs()");
  }
  /**
  * Build one scope's wire schemas and names for prompt-order validation.
  * Restrictions do not make known tools invalid, but a mode collapse does.
  */
  wireSchemas(scope) {
    const view = this.view(scope);
    const mode = this.modeFor(scope);
    if (mode === "native") return {
      schemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false)),
      knownNames: [...view.knownNames]
    };
    this.requireCodeRuntime(mode);
    const schemas = [...view.visible.values()].map((definition) => this.schemaOf(definition, false));
    if (mode === "code") return {
      schemas: schemas.filter((schema) => schema.name === RUN_CODE_NAME),
      knownNames: [RUN_CODE_NAME]
    };
    return {
      schemas,
      knownNames: [...view.knownNames, RUN_CODE_NAME]
    };
  }
  /**
  * Resolve the code runtime or throw the actionable misconfiguration error.
  * Read at use time (assembly / run_code execution), NOT via static
  * `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
  * behind it — hostage to a code runtime existing even under `mode:
  * 'native'` (the loop's optional-backend idiom, same as
  * `sessionPersistence`).
  *
  * Assembly and `run_code` execution read separately, so the language is not
  * bound to a request. Harmless while one published backend exists — both
  * reads return the same flavor — but a reload that swapped in a second
  * language between them would hand a program written against one SDK to the
  * other. Binding it is deferred until a second backend ships (the first
  * point it is testable); rationale in the
  * [language-dispatch note](../../../../.agents/notes/implemented/feature/2026-07-31-code-mode-language-dispatch.md).
  */
  requireCodeRuntime(mode) {
    const runtime = this.ctx.get("codeRuntime");
    if (!runtime) throw new Error(`dsh-tools: mode "${mode}" requires a code runtime \u2014 load a ctx.codeRuntime implementation (e.g. @deepseek-ai/dsh-code-runtime-worker) or set tools mode to "native"`);
    if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
      const known = Object.keys(SDK_RENDERERS).map((name2) => JSON.stringify(name2)).join(", ");
      throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
    }
    return runtime;
  }
  /**
  * Register globally or in the calling agent scope. Scoped tools shadow
  * globals; duplicates within one layer and the reserved `run_code` name fail.
  * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
  * @returns the exact disposer that unregisters the tool.
  */
  register(definition) {
    const name2 = definition.name;
    const output = definition.output;
    if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name2}" must declare output { schema, render, presentationMeta? }`);
    assertSupportedJsonSchema(output.schema);
    const timeoutMs = definition.timeoutMs;
    if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name2}" timeoutMs must be a positive finite number`);
    if (name2 === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the Code Mode presentation transport and cannot be registered or shadowed`);
    return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name2, definition), { label: "tools.register()" });
  }
  /**
  * Restrict global tools for the calling agent scope. Empty filters, unknown
  * names, scope-local names, and reserved transport names fail. Restrictions
  * intersect; scoped registrations remain visible.
  * @param filter - global-surface mask: `allow` (keep only) and/or `deny` (remove).
  * @returns the exact disposer that lifts this restriction.
  */
  restrict(filter) {
    const scope = scopeOf(this.ctx);
    if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent \u2014 deny the tool for the intended agent instead");
    const allow = filter.allow;
    const deny = filter.deny;
    if (allow === void 0 && deny === void 0) throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)");
    const compiled = {
      ...allow !== void 0 ? { allow: new Set(allow) } : {},
      ...deny !== void 0 ? { deny: new Set(deny) } : {}
    };
    if ([...allow ?? [], ...deny ?? []].includes("run_code")) throw new Error(`tools.restrict() cannot name reserved Code Mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`);
    const known = this.view(scope).restrictableNames;
    const unknown = [...allow ?? [], ...deny ?? []].filter((name2) => !known.has(name2));
    if (unknown.length > 0) throw new Error(`tools.restrict() names unknown inherited tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}; a restriction filters what this scope inherits, never what it registers itself. Restrictable tools: ${[...known].sort().join(", ") || "(none)"}`);
    return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), { label: "tools.restrict()" });
  }
  /**
  * Register a monotonic guard after the extensible `tools/pre-execute`
  * waterfall. A plain-context guard applies globally; one registered through
  * `agent.ctx` applies only to that agent. Any matching guard may deny by
  * returning a reason, while no guard can force-allow a call another guard
  * denied. The exact effect disposer is returned for ordered ownership and
  * HMR cleanup.
  * @param guard - synchronous check; a returned string denies the execution.
  * @returns the exact disposer that unregisters the guard.
  */
  guard(guard) {
    return this.layers.effect(this.ctx, (layer) => layer.guards.append(guard), {
      label: "tools.guard()",
      notify: false
    });
  }
  /** First monotonic denial from the global then the scope chain's guard layers, farthest first. */
  guardReason(exec) {
    const globalReason = this.layers.global.guardReason(exec);
    if (globalReason !== void 0) return globalReason;
    if (exec.agent === void 0) return void 0;
    for (const layer of this.layers.chainLayers(exec.agent)) {
      const reason = layer.guardReason(exec);
      if (reason !== void 0) return reason;
    }
  }
  /**
  * Resolve every registry fact one scope needs in one layer traversal. The
  * visible map applies restrictions to the INHERITED surface, then the
  * scope's own registrations and the reserved presentation transport; the
  * other sets retain the pre-restriction facts needed by restriction and
  * prompt-order validation.
  *
  * A restriction filters what a scope inherits — the global layer and every
  * ancestor layer on its chain — and never what its OWN layer registers.
  * That exemption is what a per-child capability filter has to keep intact:
  * the delegation runtime registers a child's reporting and structured-output
  * tools into the child's own layer, and a filter naming the capabilities the
  * child may use must not strip the machinery it answers through.
  *
  * Reading the exempt set as "the global layer" instead of "not mine" held
  * only while every model-facing tool sat in the host composition. Once
  * presets moved them onto the agent plane they became an ANCESTOR
  * contribution, so a child's filter silently stopped constraining anything
  * it was given.
  * @param scope - the viewing scope (the agent), or undefined for the global view.
  * @returns the complete derived view for that scope.
  */
  view(scope) {
    const layers = this.layers.chainLayers(scope);
    const own = this.layers.peek(scope);
    const inherited = new Map(this.layers.global.tools.entries());
    for (const layer of layers) {
      if (layer === own) continue;
      for (const [name2, definition] of layer.tools.entries()) inherited.set(name2, definition);
    }
    const visible = /* @__PURE__ */ new Map();
    const knownNames = /* @__PURE__ */ new Set();
    const restrictableNames = /* @__PURE__ */ new Set();
    for (const [name2, definition] of inherited) {
      knownNames.add(name2);
      restrictableNames.add(name2);
      if (layers.every((layer) => layer.admits(name2))) visible.set(name2, definition);
    }
    if (own !== void 0) for (const [name2, definition] of own.tools.entries()) {
      knownNames.add(name2);
      visible.set(name2, definition);
    }
    if (this.modeFor(scope) !== "native") visible.set(RUN_CODE_NAME, this.requireCodeTransport());
    return {
      visible,
      knownNames,
      restrictableNames
    };
  }
  /**
  * Look up a tool as one scope sees it (scoped
  * shadows global; a restricted-away global reads as absent). Presenters pass
  * the calling agent so the rendered card matches the definition that
  * actually executed.
  * @param name - the tool name as registered.
  * @param scope - the viewing scope (the agent); omitted = the global view.
  * @returns the definition the scope resolves, or undefined when none is visible.
  */
  get(name2, scope) {
    return this.view(scope).visible.get(name2);
  }
  /**
  * Project visible definitions onto the allowlisted model-facing schema fields,
  * excluding execution and presentation callbacks.
  * @param scope - the viewing scope (the agent); omitted = the global view.
  * @returns one deep-cloned schema per visible tool.
  */
  schemas(scope) {
    return [...this.view(scope).visible.values()].map((definition) => this.schemaOf(definition, true));
  }
  /** Project visible callable tools onto the generated Code Mode SDK contract. */
  sdkSchemas(scope) {
    return [...this.view(scope).visible.values()].filter((definition) => definition.name !== RUN_CODE_NAME).map((definition) => {
      const output = snapshotJsonValue(definition.output.schema);
      if (output === void 0) throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`);
      return {
        ...this.schemaOf(definition, true),
        output
      };
    });
  }
  /** Project one definition onto the model-facing schema fields. */
  schemaOf(definition, detachParameters) {
    const { name: name2, description, parameters } = definition;
    const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
    if (detached === void 0) throw new Error(`tool "${name2}" parameters must be lossless JSON before schema projection`);
    return {
      name: name2,
      description,
      parameters: detached
    };
  }
  /**
  * Classify a pending call through the caller's visible tool definition. Only
  * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
  * throwing classifiers are exclusive.
  * @param exec - call name, parsed arguments, and optional agent scope.
  * @returns the fail-closed scheduling mode.
  */
  executionMode(exec) {
    const tool = this.get(exec.name, exec.agent);
    if (!tool?.isConcurrencySafe) return { kind: "exclusive" };
    try {
      return tool.isConcurrencySafe(exec.arguments) === true ? { kind: "parallel" } : { kind: "exclusive" };
    } catch {
      return { kind: "exclusive" };
    }
  }
  /**
  * Run the `tools/code-dispatch-log` waterfall over one settled sub-dispatch
  * and return the content the bridge should log on `tool/code-dispatch`.
  * Contained: when a listener throws, the method logs the original settled
  * content; that failure must not fail the dispatch or omit the settle event. Private:
  * the ONE consumer is the `run_code` bridge this registry constructs, which
  * receives it as a capability parameter (the `requireRuntime` idiom) — the
  * waterfall, not this invoker, is the public extension point.
  */
  async shapeDispatchLog(dispatch) {
    try {
      return await this.ctx.waterfall(scopeTarget(this, dispatch.agent), "tools/code-dispatch-log", dispatch, () => Promise.resolve(dispatch.content));
    } catch (error) {
      this.ctx.logger.warn(`tools: code-dispatch-log listener failed for ${dispatch.name}: ${errorMessage(error)}; logging the original settled content`);
      return dispatch.content;
    }
  }
  /**
  * Execute through pre-policy, guards, around-dispatch, post-policy,
  * definition-owned content finalization, and final notification. Tool and
  * listener failures resolve as materialized error results; an invisible tool
  * reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
  * snapshot final observers receive. Cancellation
  * arriving after entry and before final result materialization skips a
  * not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
  * successful started outcome with `ABORTED`; already-started work is still
  * drained and may retain a tool-owned structured error.
  * @param exec - the typed same-process call input. The registry assigns its
  *   correlation token before policy begins.
  * @returns the materialized final result.
  */
  async execute(exec) {
    return this.prepareExecution(exec, (prepared) => this.completeScheduledExecution(prepared));
  }
  async completeScheduledExecution(prepared) {
    switch (prepared.kind) {
      case "dispatch": {
        const dispatched = await this.dispatchScheduledExecution(prepared.exec);
        return dispatched.kind === "post-result" ? await this.finalizeScheduledExecution(prepared.exec, dispatched.result) : this.finishScheduledExecution(prepared.exec, dispatched.result);
      }
      case "post-result":
        return await this.finalizeScheduledExecution(prepared.exec, prepared.result);
      case "final-result":
        return this.finishScheduledExecution(prepared.exec, prepared.result);
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(prepared, "scheduled tool preparation");
    }
  }
  createExecution(exec) {
    const deferredContexts = [];
    const token = createExecutionToken();
    const callId = exec.callId;
    const rootCallId = exec.rootCallId ?? callId;
    const name2 = exec.name;
    const agent = exec.agent;
    const parent = exec.parent;
    const signal = exec.signal;
    const definition = this.get(name2, agent);
    const finalizeContent = definition?.finalizeContent?.bind(definition);
    const concludingExecutions = this.concludingExecutions;
    const base = {
      token,
      callId,
      rootCallId,
      name: name2,
      signal,
      ...agent !== void 0 ? { agent } : {},
      ...parent !== void 0 ? { parent } : {},
      deferContext(context) {
        deferredContexts.push(context);
      },
      concludeTurn() {
        concludingExecutions.add(this);
      }
    };
    try {
      const detached = snapshotJsonValue(exec.arguments);
      if (detached === void 0) throw new TypeError("tool execution arguments must be losslessly JSON-serializable");
      const execution = {
        ...base,
        arguments: deepFreeze(detached)
      };
      this.deferredContexts.set(execution, deferredContexts);
      this.contentFinalizers.set(execution, finalizeContent);
      this.cancellationStates.set(execution, {
        callerSignal: signal,
        bodyInvoked: false
      });
      return {
        kind: "ready",
        exec: execution
      };
    } catch (error) {
      const execution = {
        ...base,
        arguments: void 0
      };
      this.contentFinalizers.set(execution, finalizeContent);
      return {
        kind: "final-result",
        exec: execution,
        result: toolErrorResult(error)
      };
    }
  }
  /**
  * Run the ordered pre-execute and monotonic guard stages for the scheduler.
  * @param input - the caller-supplied execution input.
  * @returns the prepared execution plus the next scheduler stage.
  * @internal
  */
  async prepareScheduledExecution(input) {
    return this.prepareExecution(input, (prepared) => prepared);
  }
  async prepareExecution(input, next) {
    const created = this.createExecution(input);
    if (created.kind !== "ready") return next(created);
    const exec = created.exec;
    if (this.callerCancelled(exec)) return next({
      kind: "final-result",
      exec,
      result: toolAbortedBeforeDispatchResult()
    });
    try {
      const carrier = scopeTarget(this, exec.agent);
      const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
      const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
        decision: gate,
        approvalCancelled: false
      };
      const { decision } = askResolution;
      if (this.callerCancelled(exec) && askResolution.approvalCancelled) return await next({
        kind: "post-result",
        exec,
        result: toolAbortedBeforeDispatchResult()
      });
      const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
      if (denialReason !== void 0) return await next({
        kind: "post-result",
        exec,
        result: this.materializeFinalResult({
          content: [{
            type: "text",
            text: `Error: ${denialReason}`
          }],
          isError: true,
          error: { message: denialReason }
        })
      });
      if (this.callerCancelled(exec)) return await next({
        kind: "post-result",
        exec,
        result: toolAbortedBeforeDispatchResult()
      });
      return await next({
        kind: "dispatch",
        exec
      });
    } catch (error) {
      return next({
        kind: "final-result",
        exec,
        result: toolErrorResult(error)
      });
    }
  }
  /** Whether the original caller signal is currently aborted. */
  callerCancelled(exec) {
    const state = this.cancellationStates.get(exec);
    if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
    return state.callerSignal.aborted;
  }
  /** Canonical cancellation outcome selected by whether the tool body started. */
  cancellationResult(exec, prior) {
    const state = this.cancellationStates.get(exec);
    if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
    return state.bodyInvoked ? toolAbortedResult(prior) : toolAbortedBeforeDispatchResult(prior);
  }
  /**
  * Dispatch the registered body with the original caller signal fused back
  * into any around-wrapper replacement. Cancellation never abandons the body:
  * a started promise reaches quiescence before its outcome becomes `ABORTED`.
  */
  async dispatchToolBody(exec) {
    const state = this.cancellationStates.get(exec);
    if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
    const wrapperSignal = exec.signal;
    const fused = fuseToolSignals(state.callerSignal, wrapperSignal);
    const signal = fused.signal;
    if (isAborted(signal)) {
      fused.dispose();
      return toolAbortedBeforeDispatchResult();
    }
    exec.signal = signal;
    try {
      const tool = this.get(exec.name, exec.agent);
      if (!tool) throw new ToolNotFoundError(exec.name);
      state.bodyInvoked = true;
      const returned = await tool.execute(exec.arguments, exec);
      const result = this.createSuccessResult(exec, tool, returned);
      return isAborted(signal) ? toolAbortedResult(result) : result;
    } catch (error) {
      return toolErrorResult(error);
    } finally {
      fused.dispose();
      exec.signal = wrapperSignal;
    }
  }
  /**
  * Run around-dispatch and the tool body. Tool and unknown-tool failures still
  * receive post-execute; pipeline failures are already final.
  * @param exec - the prepared execution.
  * @returns whether the result still needs post-execute.
  * @internal
  */
  async dispatchScheduledExecution(exec) {
    try {
      const mutableExec = exec;
      const carrier = scopeTarget(this, exec.agent);
      const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));
      const normalized = this.normalizeDispatchResult(exec, result);
      const deferredContexts = this.deferredContexts.get(exec);
      if (deferredContexts === void 0) throw new Error("tool registry scheduler invariant violated: unprepared execution");
      const resultWithDeferredContexts = deferredContexts.length === 0 ? normalized : this.markCanonical(exec, {
        ...normalized,
        additionalContexts: [...deferredContexts, ...normalized.additionalContexts ?? []]
      });
      return {
        kind: "post-result",
        result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError ? this.cancellationResult(exec, resultWithDeferredContexts) : resultWithDeferredContexts
      };
    } catch (error) {
      return {
        kind: "final-result",
        result: toolErrorResult(error)
      };
    }
  }
  /**
  * Run ordered post-execute, then apply definition-owned content finalization,
  * materialize, and notify the final outcome.
  * @param exec - the prepared execution.
  * @param result - dispatch/pre result that still needs post-execute.
  * @returns the materialized final result.
  * @internal
  */
  async finalizeScheduledExecution(exec, result) {
    try {
      const postResult = await this.postExecute(exec, result);
      return this.finishScheduledExecution(exec, this.callerCancelled(exec) && !postResult.isError ? this.cancellationResult(exec, postResult) : postResult);
    } catch (error) {
      return this.finishScheduledExecution(exec, toolErrorResult(error));
    }
  }
  /**
  * Materialize the candidate, apply definition-owned content finalization,
  * then materialize and notify the authoritative result.
  * @param exec - the prepared execution.
  * @param result - final result.
  * @returns the materialized final result.
  * @internal
  */
  finishScheduledExecution(exec, result) {
    let materializedResult;
    try {
      materializedResult = this.materializeFinalResult(result);
    } catch (error) {
      materializedResult = this.materializeFinalResult(toolErrorResult(error));
    }
    let finalResult;
    try {
      finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult));
    } catch (error) {
      finalResult = this.materializeFinalResult(toolErrorResult(error));
    }
    this.notifyResult(exec, finalResult);
    return finalResult;
  }
  /** Apply the snapshotted tool-owned content transform without exposing other result fields. */
  applyFinalContent(exec, result) {
    const finalizeContent = this.contentFinalizers.get(exec);
    if (finalizeContent === void 0) return result;
    const content = finalizeContent(exec, result);
    return content === void 0 ? result : {
      ...result,
      content
    };
  }
  /** Notify observers without exposing a mutation or error channel into the outcome. */
  notifyResult(exec, result) {
    Object.freeze(exec);
    const { name: toolName, callId } = exec;
    const reportFailure = (error) => {
      this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`);
    };
    const callbacks = this.ctx.events.dispatch("emit", [
      scopeTarget(this, exec.agent),
      "tools/result",
      exec,
      result
    ]);
    for (const callback of callbacks) try {
      const returned = callback(exec, result);
      Promise.resolve(returned).catch(reportFailure);
    } catch (error) {
      reportFailure(error);
    }
  }
  /**
  * Resolve an `ask` decision to allow/deny through the approval seam. The
  * seam is consumed opportunistically with `ctx.get('approval')` — a
  * deployment that composes no ApprovalService keeps the historical degrade
  * to deny, and an unmount mid-session degrades the same way on the next ask.
  * An agent-less execution also degrades: without an agent there is no
  * session to audit to and no UI to route to. Otherwise the outcome maps
  * one-to-one — `allowed-once` proceeds; the three non-grants deny with
  * distinct reasons so the model can tell a human "no" from an absent
  * approval channel.
  */
  async serviceAsk(exec, ask) {
    const approval = this.ctx.get("approval");
    if (approval === void 0) return {
      decision: {
        kind: "deny",
        reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`
      },
      approvalCancelled: false
    };
    if (exec.agent === void 0) return {
      decision: {
        kind: "deny",
        reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through`
      },
      approvalCancelled: false
    };
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      ...ask.reason !== void 0 ? { reason: ask.reason } : {},
      signal: exec.signal
    });
    switch (outcome) {
      case "allowed-once":
        return {
          decision: { kind: "allow" },
          approvalCancelled: false
        };
      case "rejected":
        return {
          decision: {
            kind: "deny",
            reason: `the user rejected tool "${exec.name}"`
          },
          approvalCancelled: false
        };
      case "cancelled":
        return {
          decision: {
            kind: "deny",
            reason: `approval for tool "${exec.name}" was cancelled`
          },
          approvalCancelled: true
        };
      case "unavailable":
        return {
          decision: {
            kind: "deny",
            reason: `tool "${exec.name}" requires approval, but no approval channel is available`
          },
          approvalCancelled: false
        };
      default:
        return assertNever(outcome, "ApprovalOutcome");
    }
  }
  /**
  * Run the `tools/post-execute` waterfall over a dispatched `result` and apply
  * its {@link PostToolDecision}: `accept` keeps the call successful (replacing
  * `content` when given), `block` turns it into an `isError` whose content is
  * the corrective `feedback`. Either decision may attach `additionalContexts`,
  * which are ferried on the returned result for the loop's active-batch FIFO.
  * Context deferred by the tool body survives an accepted result but is
  * discarded when the outer call is blocked; a block exposes only context the
  * blocking decision explicitly supplied.
  * Runs inside `execute`'s outer try/catch (a throwing listener → isError).
  */
  async postExecute(exec, result) {
    const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
    const decisionContexts = decision.additionalContexts ?? [];
    if (decision.kind === "block") {
      const message = failureMessageFromContent(decision.feedback);
      return this.markCanonical(exec, {
        content: decision.feedback,
        isError: true,
        error: { message },
        ...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {}
      });
    }
    if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
    const additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];
    if (Object.hasOwn(decision, "value")) {
      if (result.isError) throw new TypeError("tools/post-execute cannot replace the value of a failed result");
      const tool = this.get(exec.name, exec.agent);
      if (tool === void 0) throw new ToolNotFoundError(exec.name);
      const replaced = this.createSuccessResult(exec, tool, decision.value);
      return this.markCanonical(exec, {
        ...replaced,
        ...additionalContexts.length > 0 ? { additionalContexts } : {}
      });
    }
    return this.markCanonical(exec, {
      ...result,
      ...decision.content !== void 0 ? { content: decision.content } : {},
      ...additionalContexts.length > 0 ? { additionalContexts } : {}
    });
  }
  /** Registry-normalized results and the exact dispatch that validated each value. */
  canonicalResults = /* @__PURE__ */ new WeakMap();
  /** Mark one registry-normalized result as canonical only for its owning dispatch. */
  markCanonical(exec, result) {
    this.canonicalResults.set(result, exec.token);
    return result;
  }
  /** Snapshot, validate, render, and optionally project one successful body value. */
  createSuccessResult(exec, tool, candidate) {
    const detached = snapshotToolValue(tool.name, candidate);
    const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
    if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
    const value = deepFreeze(detached);
    let rendered;
    try {
      rendered = tool.output.render(exec.arguments, value);
    } catch (error) {
      throw projectionError(tool.name, "render", error);
    }
    const content = snapshotProjection(tool.name, "render", rendered);
    let meta;
    if (exec.parent === void 0 && tool.output.presentationMeta !== void 0) {
      let projected;
      try {
        projected = tool.output.presentationMeta(exec.arguments, value);
      } catch (error) {
        throw projectionError(tool.name, "presentationMeta", error);
      }
      meta = snapshotProjection(tool.name, "presentationMeta", projected);
    }
    const concludesTurn = this.concludingExecutions.has(exec);
    return this.markCanonical(exec, this.materializeFinalResult({
      isError: false,
      value,
      content,
      ...meta !== void 0 ? { meta } : {},
      ...concludesTurn ? { concludesTurn: true } : {}
    }));
  }
  /** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
  normalizeDispatchResult(exec, result) {
    if (this.canonicalResults.get(result) === exec.token) return result;
    if (result.isError) return this.markCanonical(exec, {
      isError: true,
      error: result.error,
      content: result.content,
      ...result.meta !== void 0 ? { meta: result.meta } : {},
      ...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
    });
    const tool = this.get(exec.name, exec.agent);
    if (tool === void 0) throw new ToolNotFoundError(exec.name);
    const normalized = this.createSuccessResult(exec, tool, result.value);
    return this.markCanonical(exec, {
      ...normalized,
      ...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
    });
  }
  /** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
  materializeFinalResult(result) {
    const presentation = {
      content: result.content,
      ...result.meta !== void 0 ? { meta: result.meta } : {},
      ...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
    };
    if (result.isError) return materializePresentation({
      isError: true,
      error: result.error,
      ...presentation
    });
    return deepFreeze({
      ...materializePresentation({
        isError: false,
        ...presentation,
        ...result.concludesTurn === true ? { concludesTurn: true } : {}
      }),
      value: result.value
    });
  }
};
function createExecutionToken() {
  return /* @__PURE__ */ Symbol("dsh.tool.execution");
}
function toolErrorResult(error) {
  const info = errorInfo(error);
  const message = errorMessage(error);
  return {
    content: [{
      type: "text",
      text: `Error: ${message}`
    }],
    isError: true,
    error: {
      message,
      ...info ? { info } : {}
    }
  };
}
function isAborted(signal) {
  return signal.aborted;
}
function fuseToolSignals(caller, wrapper) {
  if (caller === wrapper) return {
    signal: caller,
    dispose() {
    }
  };
  const controller = new AbortController();
  let listening = false;
  const dispose = () => {
    if (!listening) return;
    listening = false;
    caller.removeEventListener("abort", abortFromCaller);
    wrapper.removeEventListener("abort", abortFromWrapper);
  };
  const abortFrom = (source) => {
    const reason = source.reason;
    controller.abort(reason);
    dispose();
  };
  const abortFromCaller = () => {
    abortFrom(caller);
  };
  const abortFromWrapper = () => {
    abortFrom(wrapper);
  };
  if (wrapper.aborted) abortFromWrapper();
  else if (caller.aborted) abortFromCaller();
  else {
    listening = true;
    caller.addEventListener("abort", abortFromCaller, { once: true });
    wrapper.addEventListener("abort", abortFromWrapper, { once: true });
  }
  return {
    signal: controller.signal,
    dispose
  };
}
function toolAbortedResult(prior) {
  const additionalContexts = prior?.additionalContexts ?? [];
  return {
    content: [{
      type: "text",
      text: "Error: tool call aborted"
    }],
    isError: true,
    error: {
      message: "tool call aborted",
      info: {
        name: "AbortError",
        code: TOOL_ABORTED
      }
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {}
  };
}
function toolAbortedBeforeDispatchResult(prior) {
  const additionalContexts = prior?.additionalContexts ?? [];
  return {
    content: [{
      type: "text",
      text: "Error: tool call aborted before dispatch"
    }],
    isError: true,
    error: {
      message: "tool call aborted before dispatch",
      info: {
        name: "AbortError",
        code: TOOL_ABORTED_BEFORE_DISPATCH
      }
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {}
  };
}

// src/transform/html.ts
var NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  laquo: "\xAB",
  raquo: "\xBB",
  ldquo: "\u201C",
  rdquo: "\u201D",
  lsquo: "\u2018",
  rsquo: "\u2019",
  copy: "\xA9",
  reg: "\xAE",
  trade: "\u2122",
  times: "\xD7",
  middot: "\xB7"
};
function decodeEntities(input) {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
function extractCodeBlocks(html) {
  const blocks = [];
  const stripped = html.replace(
    /<pre>(?:\s*<code[^>]*>)?([\s\S]*?)(?:<\/code>\s*)?<\/pre>/gi,
    (_match, inner) => {
      const index = blocks.length;
      blocks.push({ token: `\0CODE${index}\0`, text: inner });
      return `\0CODE${index}\0`;
    }
  );
  return { stripped, blocks };
}
function decodeCodeBlock(inner) {
  const withoutTags = inner.replace(/<[^>]+>/g, "");
  const decoded = decodeEntities(withoutTags);
  const lines = decoded.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
function inlineToText(html) {
  let text = html;
  text = text.replace(/<img\s[^>]*>/gi, (tag) => {
    const src = /(?:\bsrc|data-large-src)="([^"]+)"/i.exec(tag)?.[1] ?? "";
    const alt = /\balt="([^"]*)"/i.exec(tag)?.[1] ?? "\u56FE\u7247";
    return src ? `[\u56FE\u7247:${decodeEntities(alt)}](${src})` : `[\u56FE\u7247:${decodeEntities(alt)}]`;
  });
  text = text.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const label = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const url = decodeEntities(href);
    if (!label) return url;
    if (url === label || url.startsWith("#")) return label;
    return `${label} (${url})`;
  });
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/ ?\n ?/g, "\n");
  return text.trim();
}
function htmlToText(html) {
  if (!html) return "";
  let text = html;
  text = text.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, "");
  const { stripped, blocks } = extractCodeBlocks(text);
  text = stripped;
  text = foldQuotes(text);
  text = text.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_m, inner) => {
      const innerText = inner.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n").replace(/<[^>]+>/g, "");
      const lines = decodeEntities(innerText).replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line.length > 0).map((line) => `> ${line}`);
      return `
${lines.join("\n")}
`;
    }
  );
  text = text.replace(/<h([1-6])[^>]*>/gi, "\n\n").replace(/<\/h[1-6]>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
  text = text.replace(/<\/(p|div|ul|ol|table|tr|section|article|aside|header|footer)>/gi, "\n");
  text = text.replace(/<(p|div|ul|ol|table|section|article|aside|header|footer)[^>]*>/gi, "\n");
  text = text.replace(/<\/?(td|th)[^>]*>/gi, " ");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  text = inlineToText(text);
  for (const block of blocks) {
    const code = decodeCodeBlock(block.text);
    const fence = "```";
    text = text.replace(block.token, `
${fence}
${code}
${fence}
`);
  }
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/^\n+|\n+$/g, "");
  return text;
}
var QUOTE_SUMMARY_MAX_CHARS = 80;
function foldQuotes(html) {
  return html.replace(
    /<aside\s+class="quote[^"]*"[^>]*>([\s\S]*?)<\/aside>/gi,
    (match, inner) => {
      const username = /\bdata-username="([^"]*)"/i.exec(match)?.[1] ?? "";
      const postNumber = /\bdata-post="([^"]*)"/i.exec(match)?.[1] ?? "";
      const quoteBody = inner.replace(/<div class="title">[\s\S]*?<\/div>/i, "").replace(/<blockquote[^>]*>|<\/blockquote>/gi, "").replace(/<[^>]+>/g, " ");
      const summary = decodeEntities(quoteBody).replace(/\s+/g, " ").trim().slice(0, QUOTE_SUMMARY_MAX_CHARS);
      const ellipsis = summary.length >= QUOTE_SUMMARY_MAX_CHARS ? "\u2026" : "";
      const parts = [
        username ? `@${username}` : "",
        postNumber ? `#${postNumber}` : ""
      ].filter(Boolean);
      return `
[\u5F15\u7528${parts.length > 0 ? ` ${parts.join(" ")}` : ""}: ${summary}${ellipsis}]
`;
    }
  );
}
function truncateText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const chars = Array.from(text);
  if (chars.length <= maxChars) return { text, truncated: false };
  return { text: chars.slice(0, maxChars).join(""), truncated: true };
}

// src/core/time.ts
function relativeTime(iso, now = Date.now()) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diffMs = now - then;
  if (diffMs < 0) return "\u521A\u521A";
  const minute = 6e4;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "\u521A\u521A";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} \u5206\u949F\u524D`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)} \u5C0F\u65F6\u524D`;
  if (diffMs < 30 * day) return `${Math.floor(diffMs / day)} \u5929\u524D`;
  const months = Math.floor(diffMs / (30 * day));
  if (months < 12) return `${months} \u4E2A\u6708\u524D`;
  const d = new Date(then);
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function topicPermalink(baseUrl, slug, topicId, postNumber) {
  const base = baseUrl.replace(/\/+$/, "");
  const slugPart = slug && slug !== "" ? slug : "topic";
  return postNumber !== void 0 && postNumber > 0 ? `${base}/t/${slugPart}/${topicId}/${postNumber}` : `${base}/t/${slugPart}/${topicId}`;
}

// src/tools/shared.ts
function pruneUndefined(value) {
  function walk(item) {
    if (Array.isArray(item)) return item.map((entry) => walk(entry));
    if (item !== null && typeof item === "object") {
      const out = {};
      for (const [key, entry] of Object.entries(item)) {
        if (entry !== void 0) out[key] = walk(entry);
      }
      return out;
    }
    return item === void 0 ? null : item;
  }
  return value !== null && typeof value === "object" ? walk(value) : {};
}
function renderAsText(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}
function compactSearchResult(data, categoryNameById) {
  const topicsById = /* @__PURE__ */ new Map();
  for (const topic of data.topics ?? []) {
    if (typeof topic.id === "number") topicsById.set(topic.id, topic);
  }
  const results = [];
  for (const post of data.posts ?? []) {
    const topic = typeof post.topic_id === "number" ? topicsById.get(post.topic_id) : void 0;
    results.push({
      topicId: post.topic_id ?? null,
      title: topic?.title ?? "(\u672A\u77E5\u8BDD\u9898)",
      postNumber: post.post_number ?? null,
      author: post.username ?? null,
      excerpt: post.blurb ?? "",
      likes: post.like_count ?? null,
      category: typeof topic?.category_id === "number" ? categoryNameById.get(topic.category_id) ?? null : null,
      tags: topic?.tags ?? []
    });
  }
  return {
    query: "",
    resultCount: results.length,
    results
  };
}
function formatPost(post, maxChars, context) {
  const timeLabel = relativeTime(post.created_at);
  const headerParts = [
    `## ${post.post_number ?? "?"} \u697C \xB7 ${post.username ?? "\u533F\u540D"}`,
    timeLabel ? `(${timeLabel})` : post.created_at ? `(${post.created_at})` : ""
  ].filter(Boolean);
  let header = headerParts.join(" ");
  if (context?.topicId !== void 0) {
    const link = topicPermalink(context.baseUrl, context.slug, context.topicId, post.post_number);
    header += `
${link}`;
  }
  const body = htmlToTextSafe(post.cooked ?? "");
  const full = `${header}
${body}`;
  if (full.length <= maxChars) return { text: full, truncated: false };
  return { text: `${full.slice(0, maxChars)}
[\u5185\u5BB9\u5DF2\u622A\u65AD]`, truncated: true };
}
function htmlToTextSafe(html) {
  return htmlToText(html);
}

// src/tools/search.ts
var categoryCache;
async function loadCategoryNames(deps, signal) {
  if (!categoryCache) categoryCache = new TtlCache(30 * 60 * 1e3, 4);
  const cached = categoryCache.get("categories");
  if (cached) return cached;
  const names = /* @__PURE__ */ new Map();
  try {
    const data = await deps.client.getJson(
      "/categories.json",
      { cacheTtlMs: 30 * 60 * 1e3, signal }
    );
    for (const category of data.category_list?.categories ?? []) {
      if (typeof category.id === "number") {
        names.set(category.id, category.name ?? category.slug ?? String(category.id));
      }
    }
  } catch {
  }
  categoryCache.set("categories", names);
  return names;
}
function buildSearchTool(deps) {
  return defineTool({
    name: "linuxdo_search",
    description: '\u5728 Linux.do \u7AD9\u5185\u641C\u7D22\u8BDD\u9898\u4E0E\u5E16\u5B50\uFF08Discourse \u5168\u6587\u68C0\u7D22\uFF09\u3002\u652F\u6301 Discourse \u641C\u7D22\u8BED\u6CD5\uFF1A@\u7528\u6237\u540D \u9650\u5B9A\u4F5C\u8005\u3001category:\u5206\u7C7B\u540D \u9650\u5B9A\u5206\u7C7B\u3001"\u7CBE\u786E\u77ED\u8BED"\u3001order:latest|likes|views \u6392\u5E8F\u3001in:title \u4EC5\u641C\u6807\u9898\u3002\u9700\u8981\u8BFB\u53D6\u67D0\u4E2A\u8BDD\u9898\u7684\u5B8C\u6574\u5185\u5BB9\u65F6\uFF0C\u7528\u8FD4\u56DE\u7684 topicId \u8C03\u7528 linuxdo_get_topic\u3002',
    parameters: {
      query: { type: "string", required: true, description: "\u641C\u7D22\u8BCD\uFF0C\u652F\u6301 Discourse \u641C\u7D22\u8BED\u6CD5" },
      page: { type: "integer", description: "\u9875\u7801\uFF0C\u4ECE 1 \u5F00\u59CB\uFF0C\u9ED8\u8BA4 1" },
      typeFilter: {
        type: "string",
        enum: ["topic", "user", "category"],
        description: "\u7ED3\u679C\u7C7B\u578B\u8FC7\u6EE4\uFF1B\u6307\u5B9A\u540E\u5206\u9875\u624D\u751F\u6548"
      }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(args, exec) {
      const { query, page, typeFilter } = args;
      const data = await deps.client.getJson("/search.json", {
        query: {
          q: query,
          page: page && page > 1 ? page : void 0,
          type_filter: typeFilter
        },
        cacheTtlMs: deps.config.searchCacheTtlMs,
        signal: exec.signal
      });
      const categories = await loadCategoryNames(deps, exec.signal);
      const view = compactSearchResult(
        data,
        categories
      );
      view.query = query;
      return pruneUndefined(view);
    },
    isConcurrencySafe: () => true
  });
}

// src/tools/semantic-search.ts
function buildSemanticSearchTool(deps) {
  return defineTool({
    name: "linuxdo_semantic_search",
    description: '\u5728 Linux.do \u7AD9\u5185\u505A\u8BED\u4E49\u641C\u7D22\uFF08\u57FA\u4E8E\u7AD9\u65B9 AI \u5411\u91CF\uFF09\uFF0C\u6309\u542B\u4E49\u800C\u975E\u5173\u952E\u8BCD\u5339\u914D\u3002\u9002\u5408\u7528\u81EA\u7136\u8BED\u8A00\u63CF\u8FF0\u610F\u56FE\u7684\u6A21\u7CCA\u67E5\u627E\uFF0C\u4F8B\u5982"\u600E\u4E48\u89E3\u51B3 Docker \u7AEF\u53E3\u6620\u5C04\u4E0D\u901A"\u3002\u5173\u952E\u8BCD\u7CBE\u786E\u5339\u914D\u573A\u666F\u8BF7\u6539\u7528 linuxdo_search\u3002',
    parameters: {
      query: { type: "string", required: true, description: "\u81EA\u7136\u8BED\u8A00\u67E5\u8BE2" }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(args, exec) {
      const { query } = args;
      const data = await deps.client.getJson(
        "/discourse-ai/embeddings/semantic-search",
        {
          query: { q: query },
          cacheTtlMs: deps.config.searchCacheTtlMs,
          signal: exec.signal
        }
      );
      const categories = await loadCategoryNames(deps, exec.signal);
      const view = compactSearchResult(
        data,
        categories
      );
      view.query = query;
      if (view.resultCount === 0) {
        return {
          query,
          resultCount: 0,
          results: [],
          hint: "\u8BED\u4E49\u641C\u7D22\u65E0\u7ED3\u679C\u3002\u7AD9\u70B9\u53EF\u80FD\u672A\u5F00\u542F discourse-ai \u63D2\u4EF6\uFF0C\u8BF7\u6539\u7528 linuxdo_search \u5173\u952E\u8BCD\u641C\u7D22\u3002"
        };
      }
      return pruneUndefined(view);
    },
    isConcurrencySafe: () => true
  });
}

// src/tools/topic.ts
function buildGetTopicTool(deps, extras) {
  return defineTool({
    name: "linuxdo_get_topic",
    description: '\u8BFB\u53D6 Linux.do \u4E00\u4E2A\u8BDD\u9898\u7684\u5B8C\u6574\u5185\u5BB9\uFF08\u6309\u697C\u5C42\uFF09\u3002\u5927\u8BDD\u9898\u81EA\u52A8\u5206\u9875\uFF1A\u9996\u6B21\u8C03\u7528\u7701\u7565 fromPostNumber \u4ECE\u7B2C 1 \u697C\u5F00\u59CB\uFF1B\u82E5\u7ED3\u679C\u5E26 nextFromPostNumber \u5B57\u6BB5\uFF0C\u7528\u5B83\u7EE7\u7EED\u8C03\u7528\u5373\u53EF\u8BFB\u540E\u7EED\u697C\u5C42\u3002\u8DDF\u8E2A\u5DF2\u8BFB\u8FC7\u7684\u8BDD\u9898\u6709\u65E0\u66F4\u65B0\u65F6\u7528 mode="incremental"\uFF0C\u53EA\u8FD4\u56DE\u65B0\u697C\uFF0C\u5927\u5E45\u8282\u7701 token\u3002',
    parameters: {
      topicId: { type: "integer", required: true, description: "\u8BDD\u9898 ID\uFF08linuxdo_search \u7ED3\u679C\u4E2D\u7684 topicId\uFF09" },
      fromPostNumber: { type: "integer", description: "\u8D77\u59CB\u697C\u5C42\u53F7\uFF0C\u9ED8\u8BA4 1\uFF1B\u7EED\u8BFB\u65F6\u4F20\u4E0A\u4E00\u6B21\u8FD4\u56DE\u7684 nextFromPostNumber" },
      maxPosts: { type: "integer", description: "\u672C\u6B21\u6700\u591A\u8BFB\u53D6\u7684\u697C\u5C42\u6570\uFF0C\u9ED8\u8BA4 20\uFF0C\u4E0A\u9650 50" },
      mode: {
        type: "string",
        enum: ["full", "incremental"],
        description: "incremental = \u4ECE\u4E0A\u6B21\u8BFB\u53D6\u4F4D\u7F6E\u7EE7\u7EED\uFF0C\u53EA\u53D6\u65B0\u697C\uFF1B\u9ED8\u8BA4 full"
      }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(args, exec) {
      const { topicId, fromPostNumber, maxPosts, mode } = args;
      const effectiveMaxPosts = Math.min(Math.max(maxPosts ?? 20, 1), 50);
      let effectiveFrom = fromPostNumber;
      if (mode === "incremental" && fromPostNumber === void 0) {
        const cursor = extras.cursors.get(topicId);
        if (cursor) {
          const probe = await deps.client.getJson(`/t/${topicId}.json`, {
            cacheTtlMs: 0,
            signal: exec.signal
          });
          const total = probe.post_stream?.stream?.length ?? probe.posts_count ?? 0;
          if (total <= cursor.lastPostNumber) {
            return pruneUndefined({
              topicId,
              title: probe.title,
              noNewPosts: true,
              totalPosts: total,
              lastReadAtLabel: relativeTime(cursor.lastReadAt),
              hint: `\u81EA\u4E0A\u6B21\u9605\u8BFB\uFF08${relativeTime(cursor.lastReadAt)}\uFF09\u4EE5\u6765\u6CA1\u6709\u65B0\u56DE\u590D\u3002`
            });
          }
          effectiveFrom = cursor.lastPostNumber + 1;
          return renderTopic(deps, extras, probe, effectiveFrom, effectiveMaxPosts, true);
        }
      }
      const path = effectiveFrom !== void 0 && effectiveFrom > 1 ? `/t/${topicId}/${effectiveFrom}.json` : `/t/${topicId}.json`;
      const data = await deps.client.getJson(path, {
        cacheTtlMs: deps.config.topicCacheTtlMs,
        signal: exec.signal
      });
      return renderTopic(deps, extras, data, effectiveFrom ?? 1, effectiveMaxPosts, false);
    },
    isConcurrencySafe: () => true
  });
}
async function renderTopic(deps, extras, data, fromPostNumber, effectiveMaxPosts, incremental) {
  const topicId = data.id ?? 0;
  const allPosts = data.post_stream?.posts ?? [];
  const totalPosts = data.post_stream?.stream?.length ?? data.posts_count ?? allPosts.length;
  const visiblePosts = incremental || fromPostNumber > 1 ? allPosts.filter((p) => (p.post_number ?? 0) >= fromPostNumber) : allPosts;
  const context = {
    baseUrl: deps.client.baseUrl,
    topicId: data.id,
    slug: data.slug
  };
  let budget = deps.config.maxOutputChars;
  const rendered = [];
  let lastPostNumber = fromPostNumber - 1;
  let truncatedByBudget = false;
  for (const post of visiblePosts.slice(0, effectiveMaxPosts)) {
    const formatted = formatPost(post, Math.max(budget, 500), context);
    if (formatted.text.length > budget) {
      truncatedByBudget = true;
      break;
    }
    rendered.push(formatted.text);
    budget -= formatted.text.length + 1;
    lastPostNumber = post.post_number ?? lastPostNumber;
    if (formatted.truncated) break;
  }
  if (extras.localIndex && data.id !== void 0) {
    for (const post of visiblePosts.slice(0, rendered.length)) {
      try {
        extras.localIndex.index({
          site: new URL(deps.client.baseUrl).host,
          topicId: data.id,
          postId: Number(`${data.id}${String(post.post_number ?? 0).padStart(5, "0")}`),
          postNumber: post.post_number ?? 0,
          title: data.title ?? "",
          author: post.username ?? "",
          content: stripMarkdownHeaders(formatPost(post, 4e3).text),
          url: topicPermalink(deps.client.baseUrl, data.slug, data.id, post.post_number)
        });
      } catch {
      }
    }
  }
  if (lastPostNumber >= fromPostNumber) {
    extras.cursors.set(topicId, Math.max(lastPostNumber, fromPostNumber));
  }
  const hasMoreFloors = lastPostNumber < totalPosts;
  const result = {
    topicId: data.id ?? topicId,
    title: data.title,
    category_id: data.category_id,
    tags: data.tags ?? [],
    createdBy: data.details?.created_by?.username,
    createdAt: relativeTime(data.created_at) || data.created_at,
    totalPosts,
    postsRead: rendered.length,
    ...incremental ? { mode: "incremental" } : {},
    permalink: topicPermalink(deps.client.baseUrl, data.slug, data.id ?? topicId),
    floors: rendered.join("\n\n")
  };
  if (rendered.length < Math.min(visiblePosts.length, effectiveMaxPosts) || truncatedByBudget && hasMoreFloors) {
    result.truncated = true;
  }
  if (hasMoreFloors && rendered.length > 0) {
    result.nextFromPostNumber = lastPostNumber + 1;
  }
  if (rendered.length === 0) {
    result.floors = "(\u8BE5\u697C\u5C42\u8303\u56F4\u5185\u6CA1\u6709\u53EF\u663E\u793A\u7684\u5185\u5BB9)";
  }
  return pruneUndefined(result);
}
function stripMarkdownHeaders(text) {
  return text.replace(/^## .*$/m, "").trim();
}

// src/tools/post.ts
function buildGetPostTool(deps) {
  return defineTool({
    name: "linuxdo_get_post",
    description: "\u6309\u5E16\u5B50 ID \u8BFB\u53D6 Linux.do \u5355\u4E2A\u697C\u5C42\u7684\u5185\u5BB9\u3002\u901A\u5E38\u7528 linuxdo_get_topic \u6309\u8BDD\u9898\u9605\u8BFB\u5373\u53EF\uFF1B\u672C\u5DE5\u5177\u7528\u4E8E\u641C\u7D22\u7ED3\u679C\u4E2D\u53EA\u6709 postId \u7684\u573A\u666F\u3002",
    parameters: {
      postId: { type: "integer", required: true, description: "\u5E16\u5B50 ID" }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(args, exec) {
      const { postId } = args;
      const data = await deps.client.getJson(`/posts/${postId}.json`, {
        cacheTtlMs: deps.config.topicCacheTtlMs,
        signal: exec.signal
      });
      const text = htmlToText(data.cooked ?? "");
      const clipped = truncateText(text, deps.config.maxOutputChars);
      return pruneUndefined({
        postId: data.id ?? postId,
        topicId: data.topic_id,
        postNumber: data.post_number,
        author: data.username,
        createdAt: data.created_at,
        likes: data.like_count,
        content: clipped.text,
        truncated: clipped.truncated
      });
    },
    isConcurrencySafe: () => true
  });
}

// src/tools/user.ts
function buildGetUserTool(deps) {
  return defineTool({
    name: "linuxdo_get_user",
    description: "\u67E5\u8BE2 Linux.do \u7AD9\u5185\u7528\u6237\u7684\u516C\u5F00\u8D44\u6599\uFF1A\u5934\u8854\u3001\u4FE1\u4EFB\u7B49\u7EA7\u3001\u53D1\u5E16/\u8BDD\u9898\u6570\u3001\u5FBD\u7AE0\u6570\u3001\u7B80\u4ECB\u7B49\u3002",
    parameters: {
      username: { type: "string", required: true, description: "\u7528\u6237\u540D" }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(args, exec) {
      const { username } = args;
      const data = await deps.client.getJson(
        `/u/${encodeURIComponent(username)}.json`,
        { cacheTtlMs: deps.config.searchCacheTtlMs, signal: exec.signal }
      );
      const user = data.user ?? {};
      return pruneUndefined({
        username: user.username ?? username,
        displayName: user.name,
        title: user.title,
        trustLevel: user.trust_level,
        badgeCount: user.badge_count,
        postCount: user.post_count,
        topicCount: user.topic_count,
        memberSince: user.created_at,
        lastSeenAt: user.last_seen_at,
        website: user.website_name,
        bio: (user.bio_raw ?? "").slice(0, 500),
        groups: (user.groups ?? []).map((g) => g.full_name || g.name).filter((n) => Boolean(n)).slice(0, 10)
      });
    },
    isConcurrencySafe: () => true
  });
}

// src/tools/categories.ts
function buildListCategoriesTool(deps) {
  return defineTool({
    name: "linuxdo_list_categories",
    description: "\u5217\u51FA Linux.do \u7684\u5168\u90E8\u5206\u7C7B\uFF08\u542B\u63CF\u8FF0\u4E0E\u8BDD\u9898\u91CF\uFF09\u3002\u5728\u6784\u9020 linuxdo_search \u7684 category: \u8FC7\u6EE4\u6761\u4EF6\u524D\u53EF\u5148\u8C03\u7528\u672C\u5DE5\u5177\u4E86\u89E3\u5206\u7C7B\u4F53\u7CFB\u3002",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(_args, exec) {
      const data = await deps.client.getJson(
        "/categories.json",
        { cacheTtlMs: 30 * 60 * 1e3, signal: exec.signal }
      );
      const categories = (data.category_list?.categories ?? []).map((category) => ({
        id: category.id,
        name: category.name ?? category.slug,
        slug: category.slug,
        topics: category.topic_count,
        description: (category.description_text ?? category.description_excerpt ?? "").slice(0, 200),
        restricted: category.read_restricted === true
      }));
      return pruneUndefined({
        total: categories.length,
        categories
      });
    },
    isConcurrencySafe: () => true
  });
}

// src/tools/browse.ts
function buildBrowseTool(deps) {
  return defineTool({
    name: "linuxdo_browse",
    description: '\u6D4F\u89C8 Linux.do \u7684\u8BDD\u9898\u6D41\uFF1Alatest\uFF08\u6700\u65B0\uFF09\u3001top\uFF08\u70ED\u95E8\u699C\uFF0C\u53EF\u6309\u65E5/\u5468/\u6708/\u5168\u671F\uFF09\u3001hot\uFF08\u5F53\u524D\u70ED\u5EA6\uFF09\u3001new\uFF08\u65B0\u8BDD\u9898\uFF09\u3002\u9002\u5408"\u6700\u8FD1\u7AD9\u5185\u6709\u4EC0\u4E48\u70ED\u70B9/\u65B0\u8BA8\u8BBA"\u8FD9\u7C7B\u5F00\u653E\u6D4F\u89C8\u9700\u6C42\uFF1B\u6709\u660E\u786E\u76EE\u6807\u65F6\u7528 linuxdo_search \u6216 linuxdo_semantic_search\u3002',
    parameters: {
      stream: {
        type: "string",
        enum: ["latest", "top", "hot", "new"],
        required: true,
        description: "\u8981\u6D4F\u89C8\u7684\u6D41"
      },
      period: {
        type: "string",
        enum: ["daily", "weekly", "monthly", "all"],
        description: "\u4EC5 top \u6D41\u6709\u6548\uFF0C\u9ED8\u8BA4 daily"
      },
      limit: { type: "integer", description: "\u8FD4\u56DE\u6761\u6570\uFF0C\u9ED8\u8BA4 20\uFF0C\u4E0A\u9650 50" }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(args, exec) {
      const { stream, period, limit } = args;
      const effectiveLimit = Math.min(Math.max(limit ?? 20, 1), 50);
      const path = stream === "top" ? `/top.json?period=${period ?? "daily"}` : `/${stream}.json`;
      const data = await deps.client.getJson(path, {
        cacheTtlMs: deps.config.searchCacheTtlMs,
        signal: exec.signal
      });
      const categories = await loadCategoryNames(deps, exec.signal);
      const baseUrl = deps.client.baseUrl;
      const topics = (data.topic_list?.topics ?? []).slice(0, effectiveLimit).map((topic) => ({
        topicId: topic.id,
        title: topic.title,
        category: typeof topic.category_id === "number" ? categories.get(topic.category_id) ?? null : null,
        tags: topic.tags ?? [],
        posts: topic.posts_count,
        views: topic.views,
        likes: topic.like_count,
        activeAt: relativeTime(topic.bumped_at) || relativeTime(topic.created_at),
        pinned: topic.pinned === true ? true : void 0,
        permalink: topic.id !== void 0 ? `${baseUrl.replace(/\/+$/, "")}/t/${topic.slug ?? "topic"}/${topic.id}` : void 0
      }));
      return pruneUndefined({ stream, ...stream === "top" ? { period: period ?? "daily" } : {}, count: topics.length, topics });
    },
    isConcurrencySafe: () => true
  });
}

// src/tools/notifications.ts
var NOTIFICATION_TYPES = {
  1: "\u56DE\u590D\u4E86\u4F60\u53C2\u4E0E\u7684\u8BDD\u9898",
  2: "\u5728\u5E16\u5B50\u4E2D\u63D0\u5230\u4E86\u4F60",
  3: "\u5F15\u7528\u4E86\u4F60\u7684\u5E16\u5B50",
  4: "\u8D5E\u4E86\u4F60\u7684\u5E16\u5B50",
  5: "\u8D5E\u4E86\u4F60\u7684\u56DE\u590D",
  6: "\u7ED9\u4F60\u53D1\u6765\u4E86\u79C1\u4FE1",
  7: "\u9080\u8BF7\u4F60\u53C2\u4E0E\u8BDD\u9898",
  8: "\u53D1\u6765\u4E86\u6D88\u606F",
  9: "\u94FE\u63A5\u4E86\u4F60\u7684\u5E16\u5B50",
  11: "\u5411\u4F60\u53D1\u51FA\u4E86\u9080\u8BF7",
  12: "\u7F16\u8F91\u4E86\u4F60\u7684\u5E16\u5B50",
  13: "\u6388\u4E88\u4F60\u5FBD\u7AE0",
  15: "\u5728\u7FA4\u7EC4\u6D88\u606F\u4E2D\u63D0\u5230\u4E86\u4F60",
  16: "\u5728\u5E16\u5B50\u4E2D @ \u4E86\u4F60\u7684\u7FA4\u7EC4"
};
function buildNotificationsTool(deps) {
  return defineTool({
    name: "linuxdo_get_notifications",
    description: '\u8BFB\u53D6\u5F53\u524D\u767B\u5F55\u7528\u6237\u5728 Linux.do \u7684\u7AD9\u5185\u901A\u77E5\uFF08\u88AB\u56DE\u590D\u3001\u88AB @\u3001\u88AB\u70B9\u8D5E\u3001\u79C1\u4FE1\u7B49\uFF09\u3002\u8FD9\u662F\u7528\u6237\u4E2A\u4EBA\u6570\u636E\uFF0C\u5E94\u5728\u7528\u6237\u4E3B\u52A8\u8BE2\u95EE"\u6211\u7684\u901A\u77E5/\u6211\u9519\u8FC7\u4E86\u4EC0\u4E48"\u65F6\u8C03\u7528\u3002\u9700\u8981\u5148\u5B8C\u6210\u767B\u5F55\uFF08linuxdo_login\uFF09\u3002',
    parameters: {
      limit: { type: "integer", description: "\u8FD4\u56DE\u6761\u6570\uFF0C\u9ED8\u8BA4 15\uFF0C\u4E0A\u9650 30" },
      unreadOnly: { type: "boolean", description: "\u53EA\u770B\u672A\u8BFB\uFF0C\u9ED8\u8BA4 false" }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(args, exec) {
      const { limit, unreadOnly } = args;
      const effectiveLimit = Math.min(Math.max(limit ?? 15, 1), 30);
      const data = await deps.client.getJson(
        "/notifications.json",
        { cacheTtlMs: 0, signal: exec.signal }
      );
      const all = data.notifications ?? [];
      const filtered = unreadOnly ? all.filter((n) => n.read !== true) : all;
      const notifications = filtered.slice(0, effectiveLimit).map((item) => ({
        id: item.id,
        type: NOTIFICATION_TYPES[item.notification_type ?? -1] ?? `\u672A\u77E5\u7C7B\u578B(${item.notification_type})`,
        actor: item.data?.display_username ?? item.data?.original_username,
        topicTitle: item.data?.topic_title,
        message: item.data?.message,
        read: item.read !== false ? true : false,
        timeLabel: relativeTime(item.created_at)
      }));
      const unreadCount = all.filter((n) => n.read !== true).length;
      return pruneUndefined({
        total: all.length,
        unreadCount,
        showing: notifications.length,
        notifications
      });
    }
  });
}

// src/tools/stats.ts
function buildStatsTool(deps, sources) {
  return defineTool({
    name: "linuxdo_stats",
    description: "\u67E5\u770B\u672C\u63D2\u4EF6\u7684\u8BF7\u6C42\u7EDF\u8BA1\uFF1A\u5404\u7AD9\u70B9\u8BF7\u6C42\u6B21\u6570\u3001\u7F13\u5B58\u547D\u4E2D\u7387\u3001\u9650\u6D41\u6392\u961F\u3001\u5F53\u524D\u7F51\u7EDC\u901A\u9053\u3001\u672C\u5730\u77E5\u8BC6\u5E93\u6761\u76EE\u6570\u3002\u957F\u4EFB\u52A1\u4E2D\u53EF\u7528\u6765\u5224\u65AD\u662F\u5426\u5E94\u8BE5\u51CF\u5C11\u7AD9\u5185\u8BF7\u6C42\u3001\u591A\u7528\u672C\u5730\u68C0\u7D22\u3002",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(_args) {
      return pruneUndefined({
        sites: sources.clients.map(({ name: name2, client }) => ({
          site: name2,
          ...client.stats()
        })),
        localIndex: sources.localIndex ? { enabled: true, entries: sources.localIndex.count() } : { enabled: false },
        tips: "cacheHits \u9AD8\u8BF4\u660E\u91CD\u590D\u67E5\u8BE2\u6B63\u5728\u88AB\u7F13\u5B58\u5438\u6536\uFF1Bqueued \u5CF0\u503C\u9AD8\u8BF4\u660E\u8BF7\u6C42\u8FC7\u4E8E\u5BC6\u96C6\uFF0C\u5EFA\u8BAE\u653E\u6162\u8282\u594F\u6216\u6539\u7528 linuxdo_search_local\u3002"
      });
    }
  });
}

// src/tools/local-search.ts
function buildLocalSearchTool(deps, localIndex) {
  return defineTool({
    name: "linuxdo_search_local",
    description: "\u5728\u672C\u5730\u77E5\u8BC6\u5E93\u4E2D\u68C0\u7D22\u4E4B\u524D\u8BFB\u8FC7\u7684 Linux.do \u8BDD\u9898\u4E0E\u5E16\u5B50\u3002\u5B8C\u5168\u79BB\u7EBF\u3001\u4E0D\u6D88\u8017\u7AD9\u70B9\u8BF7\u6C42\u9884\u7B97\uFF0C\u9002\u5408\u590D\u67E5\u5DF2\u770B\u8FC7\u7684\u5185\u5BB9\u6216\u7AD9\u5185\u641C\u7D22\u4E0D\u53EF\u7528\u65F6\u515C\u5E95\u3002\u8986\u76D6\u8303\u56F4\u4EC5\u9650\u672C\u4F1A\u8BDD/\u672C\u673A\u8BFB\u53D6\u8FC7\u7684\u697C\u5C42\uFF1B\u67E5\u5168\u7AD9\u8BF7\u7528 linuxdo_search\u3002",
    parameters: {
      query: { type: "string", required: true, description: "\u68C0\u7D22\u8BCD\uFF08\u4E2D\u6587\u81F3\u5C11 2 \u5B57\uFF09" },
      limit: { type: "integer", description: "\u8FD4\u56DE\u6761\u6570\uFF0C\u9ED8\u8BA4 15\uFF0C\u4E0A\u9650 50" }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(args) {
      const { query, limit } = args;
      const effectiveLimit = Math.min(Math.max(limit ?? 15, 1), 50);
      const hits = localIndex.search(query, { limit: effectiveLimit });
      return pruneUndefined({
        query,
        totalIndexed: localIndex.count(),
        resultCount: hits.length,
        ...hits.length > 0 ? { hint: "\u7528 linuxdo_get_topic \u53EF\u91CD\u65B0\u8BFB\u53D6\u8BDD\u9898\u5168\u6587" } : {},
        results: hits.map((hit) => ({
          topicId: hit.topicId,
          postId: hit.postId,
          postNumber: hit.postNumber,
          title: hit.title.replace(/\s+/g, "").length > 0 ? hit.title : "(\u65E0\u6807\u9898)",
          author: hit.author,
          url: hit.url,
          rank: Math.round(hit.rank * 100) / 100
        }))
      });
    },
    isConcurrencySafe: () => true
  });
}

// src/auth/rsa.ts
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  constants as cryptoConstants
} from "node:crypto";
function generateRsaKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}
function normalizeBase64(input) {
  return input.replace(/\s+/g, "");
}
function decryptRsaPayload(privateKeyPem, base64Payload) {
  const key = createPrivateKey(privateKeyPem);
  const cipher = Buffer.from(normalizeBase64(base64Payload), "base64");
  const plain = privateDecrypt(
    { key, padding: cryptoConstants.RSA_PKCS1_PADDING },
    cipher
  );
  return plain.toString("utf8");
}

// src/auth/authorize.ts
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
var AUTH_REDIRECT_DEEP_LINK = "discourse://auth_redirect";
var SCOPES = "one_time_password";
var APPLICATION_NAME = "DSH Linux.do Plugin";
function createAuthorizeContext(config, redirectUri) {
  const keys = generateRsaKeyPair();
  const nonce = randomUUID();
  const params = new URLSearchParams({
    application_name: APPLICATION_NAME,
    client_id: randomUUID(),
    scopes: SCOPES,
    public_key: keys.publicKeyPem,
    nonce,
    auth_redirect: redirectUri
  });
  const authorizeUrl = `${config.baseUrl.replace(/\/+$/, "")}/user-api-key/new?${params.toString()}`;
  return {
    authorizeUrl,
    nonce,
    privateKeyPem: keys.privateKeyPem,
    publicKeyPem: keys.publicKeyPem
  };
}
function extractPayload(raw) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("\u8F93\u5165\u4E3A\u7A7A");
  const match = /[?&]payload=([^&\s]+)/.exec(trimmed);
  if (match && match[1]) return decodeURIComponent(match[1]);
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) return trimmed;
  throw new Error(
    "\u65E0\u6CD5\u4ECE\u8F93\u5165\u4E2D\u8BC6\u522B payload\u3002\u8BF7\u7C98\u8D34\u6D4F\u89C8\u5668\u5730\u5740\u680F\u4E2D\u7684\u5B8C\u6574\u56DE\u8C03 URL\uFF08\u542B ?payload=... \u53C2\u6570\uFF09"
  );
}
function decryptAuthorizePayload(privateKeyPem, encryptedPayload, expectedNonce) {
  const plain = decryptRsaPayload(privateKeyPem, encryptedPayload);
  const parsed = JSON.parse(plain);
  if (!parsed.key || typeof parsed.key !== "string") {
    throw new Error("\u6388\u6743\u7ED3\u679C\u4E2D\u7F3A\u5C11 API Key");
  }
  if (parsed.nonce && parsed.nonce !== expectedNonce) {
    throw new Error(`nonce \u6821\u9A8C\u5931\u8D25\uFF08\u671F\u671B ${expectedNonce}\uFF0C\u6536\u5230 ${parsed.nonce}\uFF09\uFF0C\u53EF\u80FD\u5B58\u5728\u91CD\u653E\u98CE\u9669`);
  }
  return parsed;
}
function startCallbackServer(config) {
  return new Promise((resolvePromise, rejectPromise) => {
    let payloadResolve;
    let payloadReject;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${config.callbackHost}`);
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      const payload = url.searchParams.get("payload") ?? "";
      const ok = payload.length > 0;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderCallbackPage(ok));
      if (ok) {
        payloadResolve?.(payload);
        payloadResolve = void 0;
        payloadReject = void 0;
      }
    });
    server.on("error", (err) => rejectPromise(err));
    server.listen(config.callbackPort, config.callbackHost, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : config.callbackPort;
      resolvePromise({
        url: `http://${config.callbackHost}:${port}`,
        port,
        waitForPayload: (timeoutMs, signal) => new Promise((res, rej) => {
          const timer = setTimeout(() => {
            payloadReject = void 0;
            rej(new Error(`\u7B49\u5F85\u6388\u6743\u56DE\u8C03\u8D85\u65F6\uFF08${Math.round(timeoutMs / 1e3)} \u79D2\uFF09`));
          }, timeoutMs);
          payloadResolve = (value) => {
            clearTimeout(timer);
            res(value);
          };
          payloadReject = (err) => {
            clearTimeout(timer);
            rej(err);
          };
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              rej(new Error("\u5DF2\u53D6\u6D88\u7B49\u5F85\u6388\u6743\u56DE\u8C03"));
            },
            { once: true }
          );
        }),
        close: () => server.close()
      });
    });
  });
}
function renderCallbackPage(ok) {
  const message = ok ? "\u6388\u6743\u6210\u529F\uFF01\u51ED\u8BC1\u5DF2\u9001\u8FBE\u63D2\u4EF6\uFF0C\u672C\u9875\u9762\u53EF\u4EE5\u5173\u95ED\uFF0C\u56DE\u5230 DeepSeek Harness \u7EE7\u7EED\u4F7F\u7528\u3002" : "\u56DE\u8C03\u7F3A\u5C11 payload \u53C2\u6570\uFF0C\u8BF7\u4ECE\u6388\u6743\u9875\u91CD\u65B0\u53D1\u8D77\u3002";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Linux.do \u6388\u6743${ok ? "\u6210\u529F" : "\u5F02\u5E38"}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f7f9}
.card{background:#fff;padding:2.5rem 3rem;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:28rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .75rem}p{color:#555;line-height:1.6}</style></head>
<body><div class="card"><h1>${ok ? "\u6388\u6743\u6210\u529F" : "\u6388\u6743\u5F02\u5E38"}</h1><p>${message}</p></div></body></html>`;
}

// src/auth/login-flow.ts
var pending;
function getPendingLogin() {
  if (pending && Date.now() - pending.startedAt > 30 * 60 * 1e3) {
    cleanupPending();
    return void 0;
  }
  return pending;
}
function cleanupPending() {
  pending?.server?.close();
  pending = void 0;
}
async function startLogin(config) {
  cleanupPending();
  let server;
  let redirectUri;
  try {
    server = await startCallbackServer(config);
    redirectUri = `${server.url}/callback`;
  } catch {
    server = void 0;
    redirectUri = AUTH_REDIRECT_DEEP_LINK;
  }
  const context = createAuthorizeContext(config, redirectUri);
  pending = { context, server, startedAt: Date.now() };
  return {
    authorizeUrl: context.authorizeUrl,
    mode: server ? "auto" : "manual",
    ...server ? { callbackUrl: `${server.url}/callback` } : {},
    expiresInSeconds: Math.floor(config.callbackTimeoutMs / 1e3)
  };
}
async function completeLoginFromPayload(client, config, rawInput) {
  const current = getPendingLogin();
  if (!current) {
    throw new LinuxdoError(
      "NO_PENDING_LOGIN",
      "\u5F53\u524D\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u6388\u6743\u3002\u8BF7\u5148\u8C03\u7528 linuxdo_login \u53D1\u8D77\u6388\u6743\u6D41\u7A0B\u3002"
    );
  }
  const encrypted = extractPayload(rawInput);
  return finishLogin(client, config, current, encrypted);
}
async function finishLogin(client, config, pendingLogin, encryptedPayload) {
  const { context } = pendingLogin;
  const payload = decryptAuthorizePayload(context.privateKeyPem, encryptedPayload, context.nonce);
  try {
    const { tToken, username } = await exchangeOtpForSession(client, config, payload.key);
    client.adoptToken(tToken, username);
    await revokeKeyQuietly(client, config, payload.key);
    cleanupPending();
    return {
      ...username ? { username } : {},
      message: `Linux.do \u767B\u5F55\u6210\u529F${username ? `\uFF08${username}\uFF09` : ""}\uFF0C\u68C0\u7D22\u5DE5\u5177\u73B0\u5DF2\u53EF\u7528\u3002\u4E00\u6B21\u6027\u6388\u6743 key \u5DF2\u7528\u5B8C\u5373\u711A\u3002`
    };
  } catch (err) {
    throw err;
  }
}
async function exchangeOtpForSession(client, config, apiKey) {
  const otpResponse = await client.postForm(
    "/user-api-key/otp",
    {},
    { "User-Api-Key": apiKey }
  );
  if (otpResponse.status !== 200) {
    throwChallengeOrApi(otpResponse.status, otpResponse.text, "/user-api-key/otp");
  }
  const encryptedOtp = extractOtp(otpResponse.json, otpResponse.text);
  const otp = decryptRsaPayload(readPendingPrivateKey(), encryptedOtp);
  const sessionResponse = await client.postForm(
    `/session/otp/${encodeURIComponent(otp)}`,
    {}
  );
  if (sessionResponse.status !== 200) {
    throwChallengeOrApi(sessionResponse.status, sessionResponse.text, "/session/otp/:token");
  }
  const tToken = findTokenCookie(sessionResponse.setCookies);
  if (!tToken) {
    throw new LinuxdoError(
      "NO_SESSION_COOKIE",
      "OTP \u5151\u6362\u54CD\u5E94\u4E2D\u672A\u627E\u5230 _t \u4F1A\u8BDD cookie\u3002\u7AD9\u70B9\u884C\u4E3A\u53EF\u80FD\u5DF2\u53D8\u5316\uFF0C\u8BF7\u643A\u5E26\u6B64\u9519\u8BEF\u4FE1\u606F\u53CD\u9988\u3002"
    );
  }
  const username = readUsername(sessionResponse.json);
  return { tToken, ...username ? { username } : {} };
}
function readPendingPrivateKey() {
  const current = getPendingLogin();
  if (!current) throw new LinuxdoError("NO_PENDING_LOGIN", "\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u6388\u6743\u4F1A\u8BDD");
  return current.context.privateKeyPem;
}
function extractOtp(json, text) {
  if (json && typeof json === "object") {
    for (const value of Object.values(json)) {
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  const trimmed = text.trim();
  if (trimmed && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) return trimmed;
  throw new LinuxdoError("OTP_PARSE_FAILED", "\u65E0\u6CD5\u4ECE /user-api-key/otp \u54CD\u5E94\u4E2D\u89E3\u6790\u51FA\u52A0\u5BC6 OTP");
}
function findTokenCookie(setCookies) {
  for (const cookie of setCookies) {
    const match = /(?:^|;\s*)_t=([^;]+)/.exec(cookie);
    if (match && match[1]) return match[1];
  }
  return void 0;
}
function readUsername(json) {
  if (json && typeof json === "object") {
    const user = json.user;
    if (user && typeof user === "object") {
      const username = user.username;
      if (typeof username === "string") return username;
    }
    const direct = json.current_user;
    if (direct && typeof direct === "object") {
      const username = direct.username;
      if (typeof username === "string") return username;
    }
  }
  return void 0;
}
async function revokeKeyQuietly(client, config, apiKey) {
  try {
    await client.postForm("/user-api-key/revoke", {}, { "User-Api-Key": apiKey });
  } catch {
  }
}
function throwChallengeOrApi(status, text, path) {
  const challengeMarkers = ["Just a moment", "challenge-platform", "Attention Required"];
  if (challengeMarkers.some((m) => text.includes(m))) throw new ChallengeError(status);
  throw new ApiError(status, path, text.slice(0, 200));
}

// src/tools/auth-tools.ts
function buildLoginTool(deps, config) {
  return defineTool({
    name: "linuxdo_login",
    description: '\u53D1\u8D77 Linux.do \u6388\u6743\u767B\u5F55\u3002\u8FD4\u56DE\u4E00\u4E2A\u6388\u6743 URL\uFF1A\u8BF7\u628A\u5B83\u5C55\u793A\u7ED9\u7528\u6237\uFF0C\u5F15\u5BFC\u7528\u6237\u5728\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00\u5E76\u70B9\u51FB"\u6388\u6743"\u6309\u94AE\u3002\u81EA\u52A8\u6A21\u5F0F\u4E0B\u7528\u6237\u6388\u6743\u540E\u63D2\u4EF6\u4F1A\u81EA\u52A8\u5B8C\u6210\u767B\u5F55\uFF1B\u82E5 5 \u5206\u949F\u540E\u4ECD\u672A\u5B8C\u6210\uFF0C\u7528 linuxdo_auth_status \u67E5\u8BE2\u72B6\u6001\u6216\u91CD\u65B0\u53D1\u8D77\u3002',
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(_args, exec) {
      const result = await startLogin(config);
      deps.log("info", `\u53D1\u8D77\u6388\u6743\uFF1Amode=${result.mode}`);
      if (result.mode === "auto") {
        return pruneUndefined({
          mode: result.mode,
          authorizeUrl: result.authorizeUrl,
          instruction: `\u8BF7\u628A authorizeUrl \u5C55\u793A\u7ED9\u7528\u6237\u5E76\u5728\u6D4F\u89C8\u5668\u6253\u5F00\u3002\u7528\u6237\u70B9\u51FB\u6388\u6743\u540E\u767B\u5F55\u5C06\u81EA\u52A8\u5B8C\u6210\uFF0C\u7A0D\u540E\u53EF\u7528 linuxdo_auth_status \u786E\u8BA4\u3002\u56DE\u8C03\u7B49\u5F85 ${result.expiresInSeconds} \u79D2\u3002`,
          expiresInSeconds: result.expiresInSeconds
        });
      }
      return pruneUndefined({
        mode: result.mode,
        authorizeUrl: result.authorizeUrl,
        instruction: "\u672C\u5730\u56DE\u8C03\u7AEF\u53E3\u4E0D\u53EF\u7528\uFF0C\u5DF2\u964D\u7EA7\u4E3A\u624B\u52A8\u6A21\u5F0F\u3002\u8BF7\u8BA9\u7528\u6237\u5728\u6D4F\u89C8\u5668\u6253\u5F00 authorizeUrl \u5E76\u6388\u6743\uFF1B\u6388\u6743\u540E\u6D4F\u89C8\u5668\u4F1A\u8DF3\u8F6C\u5230\u4E00\u4E2A discourse:// \u5F00\u5934\u65E0\u6CD5\u6253\u5F00\u7684\u5730\u5740\u2014\u2014\u8BA9\u7528\u6237\u628A\u5730\u5740\u680F\u5B8C\u6574 URL \u590D\u5236\u4E0B\u6765\uFF0C\u4F5C\u4E3A callbackUrlOrPayload \u53C2\u6570\u8C03\u7528 linuxdo_login_complete\u3002",
        expiresInSeconds: result.expiresInSeconds
      });
    }
  });
}
function buildLoginCompleteTool(deps, client, config) {
  return defineTool({
    name: "linuxdo_login_complete",
    description: "\u5B8C\u6210 Linux.do \u624B\u52A8\u6388\u6743\uFF1A\u63A5\u6536\u7528\u6237\u4ECE\u6D4F\u89C8\u5668\u5730\u5740\u680F\u590D\u5236\u7684\u5B8C\u6574\u56DE\u8C03 URL\uFF08discourse://auth_redirect?payload=... \u5F62\u5F0F\uFF09\u6216\u5176\u4E2D\u7684 payload \u53C2\u6570\u3002",
    parameters: {
      callbackUrlOrPayload: {
        type: "string",
        required: true,
        description: "\u5B8C\u6574\u56DE\u8C03 URL \u6216\u88F8 payload \u5B57\u7B26\u4E32"
      }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(args, exec) {
      const { callbackUrlOrPayload } = args;
      const result = await completeLoginFromPayload(client, config, callbackUrlOrPayload);
      return pruneUndefined(result);
    }
  });
}
function buildAuthStatusTool(deps, client) {
  return defineTool({
    name: "linuxdo_auth_status",
    description: "\u67E5\u8BE2 Linux.do \u767B\u5F55\u72B6\u6001\u3002\u68C0\u7D22\u7C7B\u5DE5\u5177\u62A5 AUTH_REQUIRED \u9519\u8BEF\u540E\uFF0C\u5148\u7528\u672C\u5DE5\u5177\u786E\u8BA4\u72B6\u6001\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u8C03\u7528 linuxdo_login\u3002",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderAsText(value)
    },
    async execute(_args, exec) {
      const pending2 = getPendingLogin();
      const hasToken = client.hasSession();
      const stats = client.stats();
      if (!hasToken) {
        const invalidated = stats.sessionInvalidated;
        return pruneUndefined({
          loggedIn: false,
          pendingAuthorization: Boolean(pending2),
          hint: pending2 ? "\u6709\u8FDB\u884C\u4E2D\u7684\u6388\u6743\u4F1A\u8BDD\u3002\u81EA\u52A8\u6A21\u5F0F\u4E0B\u7B49\u7528\u6237\u5728\u6D4F\u89C8\u5668\u5B8C\u6210\u6388\u6743\uFF1B\u624B\u52A8\u6A21\u5F0F\u4E0B\u7528 linuxdo_login_complete \u63D0\u4EA4\u56DE\u8C03 URL\u3002" : invalidated ? "\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF08\u670D\u52A1\u7AEF\u8FD4\u56DE 401/403\uFF09\u3002\u8BF7\u8C03\u7528 linuxdo_login \u53D1\u8D77\u91CD\u65B0\u6388\u6743\u3002" : "\u672A\u767B\u5F55\u3002\u8C03\u7528 linuxdo_login \u53D1\u8D77\u6388\u6743\u3002"
        });
      }
      try {
        const session = await client.getJson(
          "/session/current.json",
          { cacheTtlMs: 0, signal: exec.signal }
        );
        const username = session.current_user?.username;
        return pruneUndefined({
          loggedIn: Boolean(username),
          ...username ? { username } : {},
          hint: username ? void 0 : "token \u5DF2\u5931\u6548\uFF0C\u8BF7\u8C03\u7528 linuxdo_login \u91CD\u65B0\u6388\u6743\u3002"
        });
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return pruneUndefined({
            loggedIn: false,
            pendingAuthorization: Boolean(pending2),
            hint: "token \u5DF2\u5931\u6548\uFF0C\u8BF7\u8C03\u7528 linuxdo_login \u91CD\u65B0\u6388\u6743\u3002"
          });
        }
        throw err;
      }
    }
  });
}

// src/index.ts
var name = "linuxdo";
var inject = ["tools"];
function apply(ctx, inlineConfig) {
  const config = resolveConfig(inlineConfig, process.env);
  const log = (level, message) => {
    ctx.logger[level](`[linuxdo] ${message}`);
  };
  const sites = resolveSites(config);
  const clients = sites.map((site) => {
    const siteConfig = {
      ...config,
      baseUrl: site.baseUrl,
      userAgent: site.userAgent ?? config.userAgent
    };
    const session = new SessionStore(site.sessionFile ?? config.sessionFile);
    return { name: site.name, client: new DiscourseClient(siteConfig, session) };
  });
  const localIndex = config.localIndexEnabled && config.localIndexEnabled === true ? tryCreateLocalIndex(log) : void 0;
  const cursors = new TopicCursorStore();
  const primary = clients[0];
  const defaultClient = primary.client;
  const depsFor = (client) => ({ client, config, log });
  const multiSite = clients.length > 1;
  const tools = [
    buildSearchTool(depsFor(defaultClient)),
    buildSemanticSearchTool(depsFor(defaultClient)),
    buildGetTopicTool(depsFor(defaultClient), { cursors, localIndex }),
    buildGetPostTool(depsFor(defaultClient)),
    buildGetUserTool(depsFor(defaultClient)),
    buildListCategoriesTool(depsFor(defaultClient)),
    buildBrowseTool(depsFor(defaultClient)),
    buildNotificationsTool(depsFor(defaultClient)),
    buildLocalSearchTool(depsFor(defaultClient), localIndex),
    buildStatsTool(depsFor(defaultClient), { clients, localIndex }),
    buildLoginTool(depsFor(defaultClient), config),
    buildLoginCompleteTool(depsFor(defaultClient), defaultClient, config),
    buildAuthStatusTool(depsFor(defaultClient), defaultClient)
  ];
  void multiSite;
  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool));
    log("info", `\u5DF2\u6CE8\u518C ${tools.length} \u4E2A\u5DE5\u5177\uFF08\u7AD9\u70B9\uFF1A${clients.map((c) => c.name).join(", ")}\uFF09`);
    return () => disposers.forEach((dispose) => dispose());
  }, "linuxdo.register-tools");
  ctx.effect(() => {
    const disposer = ctx.systemPrompt.section({
      name: "linuxdo:guide",
      order: 150,
      text: LINUXDO_TOOL_GUIDE
    });
    return disposer;
  }, "linuxdo.system-prompt-guide");
}
function tryCreateLocalIndex(log) {
  try {
    const index = new LocalIndex();
    log("info", `\u672C\u5730\u77E5\u8BC6\u5E93\u5DF2\u542F\u7528\uFF08${index.count()} \u6761\uFF09`);
    return index;
  } catch (err) {
    log("warn", `\u672C\u5730\u77E5\u8BC6\u5E93\u521D\u59CB\u5316\u5931\u8D25\uFF0C\u5DF2\u505C\u7528\uFF1A${err instanceof Error ? err.message : String(err)}`);
    return void 0;
  }
}
var LINUXDO_TOOL_GUIDE = `## Linux.do \u68C0\u7D22\u5DE5\u5177\u4F7F\u7528\u6307\u5357

- \u6A21\u7CCA\u610F\u56FE/\u81EA\u7136\u8BED\u8A00\u63CF\u8FF0\u7528 linuxdo_semantic_search\uFF1B\u7CBE\u786E\u5173\u952E\u8BCD\u3001@\u7528\u6237\u3001category: \u8FC7\u6EE4\u7528 linuxdo_search\uFF1B\u6D4F\u89C8\u70ED\u70B9/\u6700\u65B0\u52A8\u6001\u7528 linuxdo_browse\u3002
- \u8BFB\u8BDD\u9898\u65F6\u82E5\u8FD4\u56DE nextFromPostNumber\uFF0C\u8BF4\u660E\u6709\u540E\u7EED\u697C\u5C42\uFF0C\u9700\u8981\u7EE7\u7EED\u65F6\u7528\u5B83\u518D\u6B21\u8C03\u7528 linuxdo_get_topic\u3002
- \u8DDF\u8E2A\u770B\u8FC7\u7684\u5E16\u5B50\u6709\u65E0\u66F4\u65B0\uFF1Amode="incremental"\uFF0C\u65E0\u65B0\u5185\u5BB9\u65F6\u8FD4\u56DE noNewPosts=true\uFF0C\u51E0\u4E4E\u96F6\u6210\u672C\u3002
- linuxdo_search_local \u67E5\u8BE2\u672C\u673A\u5DF2\u8BFB\u8FC7\u7684\u5185\u5BB9\uFF0C\u79BB\u7EBF\u53EF\u7528\u4E14\u4E0D\u5360\u8BF7\u6C42\u9884\u7B97\uFF1B\u7AD9\u5185\u9650\u6D41\u6216\u79BB\u7EBF\u65F6\u4F18\u5148\u7528\u5B83\u3002
- \u9047\u5230 AUTH_REQUIRED \u9519\u8BEF\uFF1A\u8C03\u7528 linuxdo_login\uFF0C\u628A\u8FD4\u56DE\u7684 authorizeUrl \u5C55\u793A\u7ED9\u7528\u6237\u5E76\u5728\u6D4F\u89C8\u5668\u6253\u5F00\u5B8C\u6210\u6388\u6743\uFF1B\u624B\u52A8\u6A21\u5F0F\u4E0B\u7528\u6237\u4F1A\u7ED9\u4F60\u4E00\u4E2A\u56DE\u8C03 URL\uFF0C\u7528 linuxdo_login_complete \u63D0\u4EA4\u3002
- CF_CHALLENGE \u9519\u8BEF\u8868\u793A\u88AB Cloudflare \u62E6\u622A\uFF1A\u7A0D\u540E\u91CD\u8BD5\uFF0C\u6216\u5EFA\u8BAE\u7528\u6237\u914D\u7F6E LINUXDO_CURL_IMPERSONATE \u6307\u5411 curl-impersonate \u4E8C\u8FDB\u5236\u3002`;
var index_default = apply;
export {
  apply,
  index_default as default,
  inject,
  name
};
