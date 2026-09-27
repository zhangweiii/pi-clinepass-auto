# pi-clinepass-auto

[![CI](https://github.com/zhangweiii/pi-clinepass-auto/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangweiii/pi-clinepass-auto/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-clinepass-auto)](https://www.npmjs.com/package/pi-clinepass-auto)

[English](https://github.com/zhangweiii/pi-clinepass-auto/blob/main/README.md) · **简体中文**

在 [pi](https://pi.dev) 里使用你的 **Cline Pass** 订阅：ClinePass 模型、按服务端真实账单显示的用量、
以及在同一个账号下可用的网页搜索与页面抓取——不需要额外申请 API key。

```
pi install npm:pi-clinepass-auto
/login        # 选择 ClinePass
```

- **模型目录自动更新** — ClinePass 上架新模型时无需升级本包即可看到。
- **服务端真值用量表** — footer 显示的是 Cline 实际计费的数字。
- **网页工具** — `web_search` 与 `web_fetch`，同样计入这份订阅。
- **零配置** — 如果你已经登录过 Cline CLI，会自动复用。

---

## 快速开始

### 1. 安装

```sh
pi install npm:pi-clinepass-auto                    # 从 npm 安装
pi install git:github.com/zhangweiii/pi-clinepass-auto   # 从 git 安装
pi install ./pi-clinepass-auto                      # 从本地目录安装
pi -e ./pi-clinepass-auto                           # 只试用一次，不写入配置
```

> provider id 是 `clinepass`，与 `pi-clinepass`、`pi-clinepass-provider` 相同。
> **同一时间只安装其中一个**，否则 provider 会被注册两次。

### 2. 登录

在 pi 里执行 `/login`，选择 **ClinePass**。登录流程：

1. **优先复用已有的 Cline CLI 登录**（`~/.cline/data/settings/providers.json`），不用复制粘贴；
2. 否则让你**粘贴 ClinePass API key**（app.cline.bot → Settings → API Keys）。

也可以完全不用 `/login`，直接给静态 key：

```sh
export CLINE_API_KEY="your_key_here"
```

本扩展有意没有重新实现 Cline 的浏览器 OAuth。如果你更喜欢浏览器登录，先执行
`cline auth`，再在 pi 里 `/login` 导入即可。

### 3. 选择模型

```sh
pi --list-models clinepass                  # 账号当前可见的全部模型
pi --model clinepass/cline-pass/glm-5.3     # 用指定模型启动
```

或者直接运行 `pi`，用 `/model` 从列表里挑。

### 4. 查看用量

当前模型属于 `clinepass` 时，footer 会显示 Cline 的计费数字：

```
Cline: $0.01 turn · $0.18 session ($0.05 search) · 5h 12% · 7d 34%
```

`turn` 是最近一次模型请求的成本（pi 自己就把一次模型请求叫一个 turn），`session` 是本次会话
累计（**包含网页搜索**，括号里单独列出搜索占比），百分比是 Cline 报告的套餐窗口用量。
完整报表用 `/cline-usage`（别名 `/usage`），菜单用 `/clinepass`。

---

## 你能得到什么

| 能力 | 说明 |
| --- | --- |
| 模型 | `cline-pass/*` 以及免费的 `cline-free/*` / `stealth/*`，实时更新 → [模型](#模型) |
| 用量表 | footer 计量、`/cline-usage` 报表、套餐窗口、跨会话持久化 → [用量与额度](#用量与额度) |
| 网页工具 | `web_search`（Cline 的 Exa 搜索）与 `web_fetch`（本地、免费） → [网页工具](#网页搜索与页面抓取) |
| 命令 | `/clinepass`、`/cline-usage`、`/usage` → [命令与设置](#命令与设置) |
| 鉴权 | `/login`（复用 Cline CLI 或粘贴 key）、WorkOS token 自动刷新 → [工作原理](#工作原理) |

---

## 模型

provider 注册为 `clinepass`，模型 id 形如 `cline-pass/glm-5.3`、`cline-free/mimo-v2.6-flash`。

```sh
pi --list-models clinepass
pi --model clinepass/cline-pass/deepseek-v4.1-flash
```

- **上架/下架自动同步。** 可用性来自 Cline 的 `recommended-models` 接口：Cline 下架的模型会
  从列表消失，新上架的模型下次刷新就会出现——与本包版本无关。
- **元数据**（价格、上下文窗口、最大输出、推理档位）来自 [models.dev](https://models.dev)。
  models.dev 还不认识的模型照样注册，但使用保守默认值，且**不会凭空编造价格**。
- **按需刷新**：`/clinepass → Refresh model catalog`，无需重启 pi 立即重新注册模型。
- **离线可用**：网络不可用时回退到本地缓存目录（首次运行回退到内置 seed）。provider 永远不会为空。

> 免费档模型（`cline-free/*`、`stealth/*`）会在目录里显示，但 Cline 目前会在 pi 走的 API 路径上
> 拒绝它们（`403 ... only available via Cline product surfaces`）。这是 Cline 侧的限制，
> 目录只是如实反映账号能看到什么。

---

## 用量与额度

Cline 在服务端计费，所以本扩展**不做** token 成本估算，而是读取 Cline 各客户端共用的
`/usages` 账单流，把你每一轮产生的记录采集进来。

```
Cline: $0.01 turn · $0.18 session ($0.05 search) · 5h 12% · 7d 34%
```

| 片段 | 含义 |
| --- | --- |
| `turn` | 最近一次模型请求的成本（pi 把一次模型请求称为一个 turn）。 |
| `session` | 本会话已采集的全部记录之和，含模型对话**和**网页搜索。 |
| `(… search)` | 搜索占会话总额的部分；为 $0 时不显示。 |
| `5h` / `7d` | Cline 报告的套餐窗口用量，具体额度与重置时间见 `/cline-usage`。 |

细节：

- footer 只在当前模型属于 `clinepass` 时显示；可用 `/clinepass → Hide footer meter` 关闭
  （跨会话记住选择）。
- 成本会作为 session entry 持久化，所以 `pi --resume` 后会话总额仍然正确。
- 搜索记录只有在落在"本扩展确实发起过 `web_search` 的时间窗内"才会计入，
  同账号其他 Cline 客户端的搜索不会串进来。
- Cline 的计费管道是异步刷新的，约 12 秒内没出现的记录不会计入，此时 footer 保持上一个已知值。
- 文本是纯文本（没有画框字符），所以 `pi-status-line` 这类 footer 扩展能像自己的 widget 一样
  给它配色——`ext-status` widget 会把它调暗以匹配状态栏。

`/cline-usage`（别名 `/usage`）不占用 footer，直接打印报表：

```
ClinePass — Cline Pass (Annual)
5h   [██░░░░░░░░░░]  12% of $10  resets 13:00
7d   [████░░░░░░░░]  34% of $25  resets 00:41
30d  [█░░░░░░░░░░░]   5% of $50  resets 10-21 00:41

Session  $0.2012 across 12 adopted turns
Search   4 web searches ($0.028, included above)
Catalog  17 models (network, updated 9/27 11:02)
```

`/clinepass` 菜单：

| 菜单项 | 作用 |
| --- | --- |
| **Report** | 把上面的报表显示为 widget。 |
| **Refresh model catalog** | 强制实时刷新目录并立即重新注册模型。 |
| **Hide report** | 清除报表 widget。 |
| **Hide / Show footer meter** | 开关 footer 计量（持久化）。 |
| **Hide / Show web tools** | 开关 `web_search` 与 `web_fetch`（持久化）。 |

---

## 网页搜索与页面抓取

注册两个工具，任何模型都能用——决定可用性的是**凭证**，不是当前模型。

| 工具 | 后端 | 成本 | 可用条件 |
| --- | --- | --- | --- |
| `web_search` | Cline 的 Exa 搜索接口 | 约 **$0.007**/次 | 存在 Cline 凭证 |
| `web_fetch` | 本地 HTTP GET + HTML→文本 | **免费** | 始终可用 |

### `web_search`

```
web_search(query, allowed_domains?, blocked_domains?, fetch_top?)
```

- 接口**只返回标题和 URL，没有摘要**。因此工具会在结果末尾追加提醒，让模型先 `web_fetch`
  打开页面再回答。
- `allowed_domains` / `blocked_domains` 用于收窄搜索范围，二者互斥（接口对同时传两者的请求直接报错）。
- `fetch_top: 0–3` 表示在同一次调用里额外抓取前 N 条的正文。抓取免费，但会增加延迟和上下文，
  且每页只分到 50KB 结果预算中的一份。**建议保持 `0`**，让模型看完 10 条再自己挑页面。
- 一次搜索的成本约等于十次模型请求，所以工具描述里会引导模型不要重复搜索同一个问题。

### `web_fetch`

```
web_fetch(url, prompt?)
```

- 用普通 HTTP 抓取（类浏览器 UA、30 秒超时、5MB 响应上限、跟随重定向），并用与 Cline
  `fetch_web_content` 相同的零依赖提取器把 HTML 转成文本。JSON 会美化输出，其他类型原样返回。
- 输出按 pi 的标准上限截断（50KB / 2000 行）；被截断时会把完整正文写入临时文件，模型可以用
  `read` 继续读。
- `prompt` 是可选的提取说明，会以 `Extract focus: …` 的形式附在返回内容末尾。

### 怎么关掉

| 范围 | 做法 |
| --- | --- |
| 单次运行 | `pi -xt web_search`，或 `pi -t read,bash,web_fetch` |
| 持久关闭 | `/clinepass → Hide web tools` |

`web_search` **只在存在 Cline 凭证时才会激活**。没有凭证时，它既不会出现在发给模型的工具列表里，
也不会出现在系统提示里——模型完全不知道它存在。会话中途登录（例如 `/login`）会立即激活它。
被 `-t` / `-xt` 排除的工具，本扩展**永远不会**擅自加回来；`/clinepass` 开关只恢复它自己隐藏的那些。

---

## 命令与设置

### 斜杠命令

| 命令 | 说明 |
| --- | --- |
| `/clinepass` | 菜单：报表、目录刷新、计量与网页工具开关。 |
| `/cline-usage` | 打印用量/额度报表（不占 footer）。 |
| `/usage` | `/cline-usage` 的别名。 |
| `/login` | 登录——选择 **ClinePass**。 |

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `CLINE_API_KEY` | 静态 ClinePass API key，替代 `/login`。 |
| `CLINE_API_BASE` | 覆盖 API 地址（默认 `https://api.cline.bot`）。 |
| `PI_CODING_AGENT_DIR` | 目录缓存与偏好文件所在目录（pi 标准变量）。 |

### 写入的文件

| 路径 | 内容 |
| --- | --- |
| `<agent 目录>/clinepass-auto-catalog.json` | 模型目录缓存（6 小时 TTL）。 |
| `<agent 目录>/clinepass-auto-prefs.json` | 计量与网页工具的显示偏好。 |

---

## 常见问题排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `No API key found for clinepass` | 执行 `/login` 选 ClinePass，或设置 `CLINE_API_KEY`。 |
| `401 … re-authenticate your Cline account` | 存储的 token 过期且刷新失败，重新 `cline auth` 或 `/login`。 |
| 免费模型报 `403 … only available via Cline product surfaces` | Cline 禁止第三方 API 路径使用免费档，改用 `cline-pass/*`。 |
| 模型的工具列表里没有 `web_search` | 没有 Cline 凭证，或用了 `/clinepass → Hide web tools`，或 `-xt web_search`。 |
| 会话总额里没有某次搜索 | 账单记录约 12 秒内没刷出来，或该搜索来自另一个 Cline 客户端。 |
| 套餐额度显示 unavailable | 访问不到用量接口（离线，或尚未登录）。 |
| footer 计量不显示 | 当前模型不是 `clinepass`，或计量被隐藏了。 |

---

## 工作原理

给想了解内部机制的人看的简版说明。

### 目录发现

```
Cline recommended-models (/api/v1/ai/cline/recommended-models)
        │  "此刻存在哪些 cline-pass/* 和免费模型"
        ▼
models.dev (api.json → provider "cline-pass")
        │  "价格、上下文窗口、最大输出、推理选项"
        ▼
合并后的目录 ──► pi 的 provider 模型列表
        │
        ├─ 本地缓存  <agent 目录>/clinepass-auto-catalog.json（6 小时 TTL）
        └─ 内置 seed（首次运行且无网络）
```

可用性始终以 Cline 为准，所以下架即消失、上架即出现。元数据来自 models.dev，而它只认识付费档；
不认识的模型仍会注册，使用保守默认值且不编造价格。推理档位由 models.dev 的
`reasoning_options` 推导（`effort` 与 pi 的档位 1:1 对应；`off` 只有在 provider 明确声明时才映射为
`none`）；没有元数据时使用保守的默认映射，而不是猜测。

### 凭证

解析顺序：`CLINE_API_KEY` → pi 的凭证库（`<agent 目录>/auth.json`，由 `/login` 写入）→
Cline CLI 登录（`~/.cline/data/settings/providers.json`）。

ClinePass 的 access token 是短时效的 WorkOS JWT，通过 Cline 的 `/api/v1/auth/refresh` 刷新。
刷新后的 refresh token 会用 compare-and-swap 写回它原来的存储位置，所以 pi 与 Cline CLI
可以同时刷新而不会互相覆盖。

### 用量记账

每条 assistant 消息结束后，扩展会轮询 `/usages`，把那次模型请求的账单记录采集进会话计量。
轮询在后台进行，绝不阻塞 agent 循环；采集是串行化的，所以并行的工具循环不会重复采集同一条记录。

搜索记录出现在同一个账单流里（`operation: "web_search"`、`searchProviderName: "exa"`），
走同一条轮询链路并计入会话总额；`turn` 仍保持"最近一次模型请求"的原义。为了避免把别的
Cline 客户端的开销算进来，只有时间戳落在"本扩展确实发起过 `web_search` 的时间窗（±60 秒，
容忍时钟与排队误差）"内的搜索记录才会被采集。

### 网页工具内部

`web_search` 调用 `POST {CLINE_API_BASE}/api/v1/search/websearch`，带账号 bearer token，
遇到 401 会刷新 token 后重试一次。

`web_fetch` 完全不碰 Cline 的 API：本地 GET + 一小段 HTML→文本处理（去 script/style/注释，
块级标签转换成行、去标签、解常见与数字实体、压缩空白）。这是有意与 Cline `fetch_web_content`
保持一致的做法，只修了一个问题：Cline 那版会把刚插入的换行又折叠掉，导致整页变成一行超长文本。

---

## 开发

```sh
npm install           # 开发依赖：typescript、@types/node、typebox
npm test              # node --test，无需构建
npm run typecheck     # tsc --noEmit
npm run generate-seed # 从线上数据重新生成 src/seed.ts
```

代码结构：

| 文件 | 职责 |
| --- | --- |
| `src/discovery.ts` | 抓取/合并/缓存目录，推导推理档位映射（纯函数）。 |
| `src/auth.ts` | 凭证解析、WorkOS 刷新、`/login` 处理器。 |
| `src/usage.ts` | 用量/套餐接口解析，计量与报表格式化（纯函数）。 |
| `src/web.ts` | 搜索请求/响应、URL 校验、HTML→文本（纯函数）。 |
| `src/webtools.ts` | `web_search` / `web_fetch` 工具与激活规则。 |
| `src/index.ts` | provider 注册、pi 事件钩子、`/clinepass`。 |
| `src/seed.ts` | 生成的离线兜底目录。 |

测试用 `node --test` 直接跑 TypeScript（Node 22.19+ 原生支持类型擦除），所以没有构建步骤。
CI 在每次 push 与 PR 时执行 `npm ci`、类型检查与测试。

## 发布

发布由 tag 驱动，在 GitHub Actions 中完成（`.github/workflows/release.yml`）：

| 命令 | 版本 | npm dist-tag |
| --- | --- | --- |
| `npm run release:stable` | `0.2.0` | `latest` |
| `npm run release:beta` | `0.2.0-beta.0` | `beta` |
| `npm version minor && git push --follow-tags` | 任意递增 | `latest` |

工作流会在 tag 与 `package.json` 版本不一致时拒绝发布，随后跑测试、以 provenance 发布，
并创建带自动生成 release notes 的 GitHub Release（`-beta` / `-rc` 版本标记为 prerelease）。

### 鉴权：npm Trusted Publishing（不用 token）

npm 已在 2025 年 11 月移除 classic/Automation token，并将在 2027 年 1 月下线可直接发布的
granular token，所以本仓库只使用
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers)（OIDC）——**仓库里没有任何
`NPM_TOKEN` secret**。

**一次性引导。** Trusted publisher 只能配置在"已经存在于 npm 上的包"上，所以**第一个版本必须
手动发布**：

```sh
# 在你的终端执行，会提示输入 2FA 验证码
npm publish --access public
```

然后在 npmjs.com → 该包 → **Settings**：

1. **Trusted publishing** → 添加 GitHub Actions，填写组织/用户 `zhangweiii`、仓库
   `pi-clinepass-auto`、工作流文件名 `release.yml`，**不要勾选 `npm publish`**——
   npm 官方推荐只允许 staged publishing，即 CI 只能“暂存”一个版本。
2. **Publishing access** → 选择 *Require two-factor authentication and disallow tokens*，
   此后只有这条受信任的工作流可以暂存发布。

之后每次发布是两步：CI 暂存，你用 2FA 批准。

```sh
npm run release:beta        # 通过 GitHub Actions 暂存 0.2.0-beta.0
npm stage list              # 查看 stage id
npm stage approve <id>      # 提示输入 2FA 验证码
```

Actions 运行摘要里会打印同样的指引。公开仓库通过 OIDC 发布时，provenance 证明会自动生成。

如果你希望省掉批准这一步，就在 trusted publisher 配置里勾上 **`npm publish`**，
并把工作流的 `npm stage publish` 改回 `npm publish`。npm 认为这更弱：工作流一旦被入侵，
没有人工环节就能直接发布。

安装预发布版本时用 dist-tag 固定：

```sh
pi install npm:pi-clinepass-auto@beta
```

只要发布时带上 `pi-package` keyword，[Pi 官方包画廊](https://pi.dev/packages) 就会自动收录；
可选的 `pi.image` / `pi.video` 字段可以加预览图。

## 限制与注意事项

- **非文档化接口。** 目录、用量、套餐、搜索四个接口都是 Cline 未公开文档的 API，可能变动。
  解析是防御式且有单测的；`web_search` 在接口异常时会明确报错，而不是编造结果。
- **搜索形态。** `POST /api/v1/search/websearch` 后端是 Exa，会忽略条数参数，固定返回 10 条
  标题 + URL、没有摘要，目前每次约 $0.007。
- **搜索归因**依赖时间窗（±60 秒）：另一个 Cline 客户端恰好在窗口内搜索时，可能被算进本会话。
- **HTML 提取**使用上面描述的正则提取器，因此纯 JS 渲染的页面基本抓不到内容，站点导航也不会被剔除。
  `web_fetch` 完全不访问 Cline 的接口。
- **计费延迟**：Cline 约 12 秒内没刷出的记录不会被计入；`--print` 模式下进程可能在最后一条记录
  被采集前就退出，所以以交互式会话里的 footer 为准。
- **免费档**会在目录中出现，但在 API 路径上被拒绝（见 [模型](#模型)）。
- 本包与 Cline、pi、models.dev **均无隶属关系**。

## 许可证

[MIT](LICENSE)
