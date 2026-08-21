# DSHL

**dsh-plugin-linuxdo** — DeepSeek Harness 的 Linux.do 知识库插件

把 [Linux.do](https://linux.do)（Discourse）站内信息变成 AI 可检索的知识库：站内搜索、语义搜索、热点浏览、话题精读、本地知识库沉淀，一次浏览器授权全自动登录。

[![License GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-0eaa5e?style=flat-square)](./LICENSE) [![Release](https://img.shields.io/github/v/release/RochelimitDawn/DSHL?include_prereleases&style=flat-square&color=6366f1)](https://github.com/RochelimitDawn/DSHL/releases) [![Platform](https://img.shields.io/badge/Platform-DeepSeek_Harness-339933?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness) [![Tools](https://img.shields.io/badge/Tools-13-6366f1?style=flat-square)](#工具清单) [![Node.js](https://img.shields.io/badge/Runtime-Node.js_20+-339933?style=flat-square)](https://nodejs.org)

---

> ## ⚠️ 重要声明
>
> **DSHL 是 DeepSeek Harness 的第三方社区插件，与 DeepSeek 及 Linux.do 官方均无关联。**
>
> 本项目基于开源 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）的 Cordis 插件体系构建；Discourse API 交互知识参考开源客户端 [FluxDO](https://github.com/Lingyan000/fluxdo)（GPL-3.0）。仅供个人检索用途，请遵守社区规则、尊重内容版权。

---

## ✦ 一键安装 ✦

> v0.1.1 起插件以**自包含单文件 bundle** 分发：全部依赖已内联，安装后零构建、零依赖解析，任何 Node 20+ 环境（含 DSHM Android 端）直接加载。

把下面整段指令**直接复制发给你的 DSH Agent**，它会自动完成安装与验证：

```text
请帮我安装 dsh-plugin-linuxdo 插件（Linux.do 知识库检索），步骤：
1. 执行：dsh plugin --profile web add https://github.com/RochelimitDawn/DSHL/archive/refs/heads/main.tar.gz
2. 若上述命令失败，改用手动方式：
   下载 https://github.com/RochelimitDawn/DSHL/archive/refs/heads/main.tar.gz
   解压到 ~/.dsh-linuxdo-plugin/DSHL-main/
   然后在我的 dsh 启动配置的插件树中加入
   - id: linuxdo
     name: 'file:///...解压路径.../DSHL-main/lib/index.js'
   （注意指向 lib/index.js 构建产物，Windows 用 file:///D:/ 开头）
3. 重启后调用 linuxdo_auth_status 工具：能返回 JSON 即安装成功
4. 最后调用 linuxdo_login，把返回的 authorizeUrl 展示给我，引导我在浏览器完成授权
5. 报告安装结果；如果任何一步失败，给出具体报错和修复建议
```

> 安装完成后对 Agent 说"登录 Linux.do"，浏览器里点一次授权即可开始检索。

---

## 产品定位

| 项 | 说明 |
|----|------|
| **形态** | DeepSeek Harness 原生 Cordis 工具插件（Host 端，纯后台能力） |
| **能力** | 13 个只读检索工具：搜索 / 语义搜索 / 热点浏览 / 话题精读 / 通知 / 本地知识库 / 会话管理 |
| **认证** | Discourse User API Key 标准授权 + OTP 兑换 `_t`，浏览器点一次"授权"全自动 |
| **知识库** | SQLite FTS5 本地沉淀，中文 CJK bigram 分词，离线可查、零请求预算 |
| **限流** | 每站点 2 并发 + 4 请求/3 秒滑窗，流量形态贴近人工浏览 |
| **当前版本** | `v0.1.0` |

---

## 核心能力

| 模块 | 能力 |
|------|------|
| 全文检索 | Discourse BM25 搜索，支持 `@user`、`category:x`、`order:likes` 等站方搜索语法 |
| 语义搜索 | 站方 discourse-ai 向量检索，自然语言直接问，与关键词搜索互补 |
| 热点浏览 | latest / top（日·周·月榜）/ hot / new 四条话题流 |
| 话题精读 | 引用自动折叠、相对时间、每楼深链；楼层分页 + 续读游标 + 字符硬上限 |
| 增量跟踪 | `mode="incremental"` 只返回新楼，跟踪长帖几乎零 token |
| 本地知识库 | 读过的楼层自动入 SQLite FTS5，`search_local` 离线检索、重复查询零请求 |
| 通知读取 | 被回复 / 被 @ / 被点赞 / 私信，类型码转可读文案 |
| 自动登录 | RSA 授权 + OTP 兑换 `_t`，本地回调全自动，深链粘贴手动兜底 |
| 会话健康 | 401/403 主动标记失效，`auth_status` 提前预警而非报错时才发现 |
| CF 降级链 | 配置 curl-impersonate 后遇挑战页自动切换 Chrome TLS 指纹并 sticky |
| 请求预算 | `stats` 工具暴露请求数 / 缓存命中率 / 限流排队，Agent 可自主节流 |
| 多站点 | `sites` Profile 数组，同一插件接入任意 Discourse 实例 |
| 系统提示 | 内置使用指南注入，Agent 首次接触即可正确选型，零试错 |

---

## 工具清单

| 工具 | 说明 |
|------|------|
| `linuxdo_search` | 站内全文搜索（BM25 + 搜索语法） |
| `linuxdo_semantic_search` | 站方 AI 语义搜索 |
| `linuxdo_browse` | 话题流浏览（latest / top / hot / new） |
| `linuxdo_get_topic` | 按楼层读话题（分页 / 增量 / 深链） |
| `linuxdo_get_post` | 按帖子 ID 读单楼 |
| `linuxdo_get_user` | 用户公开资料 |
| `linuxdo_list_categories` | 分类体系 |
| `linuxdo_get_notifications` | 当前用户站内通知 |
| `linuxdo_search_local` | 本地 FTS5 知识库检索（离线） |
| `linuxdo_stats` | 请求预算自观测 |
| `linuxdo_login` | 发起授权登录 |
| `linuxdo_login_complete` | 手动粘贴回调 URL 完成登录 |
| `linuxdo_auth_status` | 会话状态与健康预检 |

---

## 手动安装（开发者）

```bash
git clone https://github.com/RochelimitDawn/DSHL.git
cd DSHL
npm install
npm run build    # tsc 编译 + esbuild 自包含 bundle（lib/index.js）

# 方式一：--patch 加载（推荐开发调试）
pnpm dsh web --patch /path/to/DSHL/cordis.yml

# 方式二：dsh plugin add 本地目录
dsh plugin --profile web add /path/to/DSHL
```

Windows 下 `cordis.yml` 中的 `file://` 路径必须使用完整协议格式。

### 故障排查

| 现象 | 处理 |
|------|------|
| `ERR_MODULE_NOT_FOUND ... src/core/client.js` | 使用了 v0.1.0 源码直载形态，升级到 v0.1.1+（bundle 分发）或自行 `npm run build` 后确认 cordis.yml 指向 `lib/index.js` |
| `Cannot find module '@deepseek-ai/cordis'` | 同上，v0.1.1+ 已内联全部依赖 |
| 工具报 `AUTH_REQUIRED` | 正常流程：调用 `linuxdo_login` 走授权 |
| 工具报 `CF_CHALLENGE` | 站点风控收紧：配置 `LINUXDO_CURL_IMPERSONATE` 指向 curl-impersonate 二进制 |

### 登录流程

1. 对 Agent 说"登录 Linux.do"，Agent 调用 `linuxdo_login` 返回授权链接
2. 浏览器打开链接，登录并点击"授权"
3. **自动模式**：浏览器回连本机回调，即刻完成；**手动模式**：把地址栏 `discourse://auth_redirect?payload=...` 完整 URL 复制交给 Agent

登录态存于 `~/.dsh-plugin-linuxdo/session.json`（0600），约 60 天滚动续期。

---

## 配置

三层来源（优先级从高到低）：cordis.yml 行内 `config` → 环境变量 → 默认值。

| 配置项 | 环境变量 | 默认值 | 说明 |
|--------|---------|--------|------|
| `baseUrl` | `LINUXDO_BASE_URL` | `https://linux.do` | 可指向任意 Discourse 实例 |
| `userAgent` | `LINUXDO_USER_AGENT` | Chrome 131 UA | 建议与登录用浏览器一致 |
| `maxConcurrent` | `LINUXDO_MAX_CONCURRENT` | `2` | 最大并发请求 |
| `maxOutputChars` | `LINUXDO_MAX_OUTPUT_CHARS` | `8000` | 单次输出硬上限 |
| `curlImpersonatePath` | `LINUXDO_CURL_IMPERSONATE` | （空） | curl-impersonate 二进制路径，启用 CF 指纹降级 |
| `localIndexEnabled` | `LINUXDO_LOCAL_INDEX` | `true` | 本地知识库沉淀开关 |
| `sites` | — | （空） | 多站点 Profile 数组 |

完整配置项见 [`src/config.ts`](./src/config.ts)。

---

## 认证链路（技术说明）

```
插件生成 RSA-2048 密钥对 + nonce
  → 浏览器打开 /user-api-key/new（登录态、CF、2FA 全部天然通过）
  → 服务端 302 回调携带 RSA 加密 payload
  → 插件解密得 one_time_password scope 的 key（校验 nonce）
  → POST /user-api-key/otp（User-Api-Key 头豁免 CSRF）→ 解密得一次性 OTP
  → POST /session/otp/{otp} → Set-Cookie _t
  → key 用完即焚（POST /user-api-key/revoke 自我吊销）
```

日常检索流量使用 `_t` cookie。linux.do 将 User API Key scopes 收窄为仅 `one_time_password`，key 本身读不了任何 API——这正是它只适合当"兑票凭证"的原因。

---

## 目录结构

```
DSHL/
|-- cordis.yml                    # DSH 插件组合声明（指向 lib/index.js）
|-- package.json / tsconfig.json
|-- lib/index.js                  # 自包含 bundle（入库，零构建分发）
|-- scripts/inline-version.mjs    # 构建后处理：内联版本号
|-- src/
|   |-- index.ts                  # 插件入口：工具注册 + 系统提示注入
|   |-- config.ts                 # 三层配置合并
|   |-- core/                     # HTTP 客户端 / 限流 / 缓存 / Transport / 本地索引
|   |-- auth/                     # RSA / 授权流程 / OTP 兑换 / 会话存储
|   |-- transform/                # cooked HTML 清洗（引用折叠 / 实体解码 / 截断）
|   `-- tools/                    # 13 个工具定义
`-- README.md
```

---

## 版本

| 项 | 说明 |
|----|------|
| **产品** | DSHL（dsh-plugin-linuxdo） |
| **版本** | `v0.1.1` |
| **分发形态** | esbuild 自包含单文件 bundle（`lib/index.js`，约 284 KB），仅依赖 node: 内置模块 |
| **运行时** | Node.js ≥ 20（node:sqlite 需 22.5+） |
| **依赖** | 构建期 `@deepseek-ai/cordis` · `@deepseek-ai/dsh-tools`；运行时零外部依赖 |

---

## 致谢与版权说明

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）：插件体系与 Cordis 运行时
- [FluxDO](https://github.com/Lingyan000/fluxdo)（GPL-3.0）：Discourse API 交互知识、认证链路设计、限流参数参照
- [Linux.do](https://linux.do) 社区：真诚、友善、团结、专业

---

## 许可证

本项目采用 **[GPL-3.0](./LICENSE)**。第三方依赖以各自许可证为准。

```
Required Notice: Copyright RochelimitDawn (https://github.com/RochelimitDawn/DSHL)
```

---

## ✦ 支持项目 ✦

如果这个项目帮到了你，欢迎 **Star** 支持一下。

> 合作 · 反馈 · 支持，欢迎提交 [Issue](https://github.com/RochelimitDawn/DSHL/issues)
