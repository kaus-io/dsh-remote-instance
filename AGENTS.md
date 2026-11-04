# AGENTS.md · dsh-remote-instance

安装到 Harness profile 的持久化插件，不是业务 App 模块。工作区根规则仍适用，这里只记本仓库不能踩的硬约束。

## 远端命令与传输

- 任务正文（prompt）**只能走 ssh 的 stdin**。任何把用户文本拼进远端命令行、`--session-id` 之外的参数、环境变量或文件名里的做法都视为注入缺陷。
- 远端命令只由固定片段拼装，按平台二选一：POSIX 走 `shellQuote`（单引号）+ 登录 shell；Windows 只走 `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <UTF-16LE base64>`，禁止在 cmd/PowerShell 里拼引号。`host`/`user`/`identityFile`/`proxyJump`/`port` 先过白名单，`sessionId` 只允许 `A-Za-z0-9_-`。
- 平台由 `probe` 识别并缓存（`platform: posix|windows`）：先按已知平台探测，拿不到 `dsh` 版本再换另一边；`ask` 按缓存的平台拼命令。
- 不新增任意远端 shell、sudo、文件上传下载、端口转发、`ProxyCommand` 或 `-o` 透传参数；`probe` 的脚本内容固定，只读。
- 认证两种：密钥模式 `BatchMode=yes`；密码模式 `BatchMode=no` + `PreferredAuthentications=password,keyboard-interactive` + `NumberOfPasswordPrompts=1`，密码只经 `SSH_ASKPASS` 从子进程环境读取（`askpassEnv` + `DSH_REMOTE_PASSWORD`），绝不进 argv/日志/结果。
- 两种模式都用 `StrictHostKeyChecking=accept-new`：首次接受并锁定指纹，指纹变化仍然失败；`-o LogLevel=ERROR` 只用来压掉 ssh 自身的噪声警告。
- 所有进程经 `ctx.subprocess` 托管，`createRunner` 负责取消、超时与等待整棵进程树退出；不要直接 `child_process`。

## 远端会话（ACP）

- 会话通道只走 `dsh --profile acp`：换行分帧的 JSON-RPC 2.0，方法集合限定在 `initialize`、`session/list`、`session/new`、`session/resume`、`session/prompt`、`session/cancel`、`session/close`；不要接 `fs/*`、`terminal/*` 等客户端方法。
- 每条设备一条连接，按需建立、失败后下次调用重连、卸载时关闭；请求必须有超时，prompt 用长超时并接受取消。
- `session/request_permission` 必须显式答复并留痕：当前策略是「允许一次」并往对话里写一条记录；不要静默拒绝却不告知用户。
- 历史回放是**只读、固定命令**：`historyCommand` 只按 `sessionId` 白名单找 `$DSH_HOME/sessions/*/<id>/*.jsonl.zstd`，压缩上限 `MAX_LOG_BYTES`，本地按 zstd 帧解压；不得扩展成任意文件读取或写远端。
- ACP 不回放历史是协议限制；任何「历史」实现都必须说明来源（日志 / 打开后实时），不能假装完整。

## 权限与清单

- `add`/`remove`/`ask` 是原生操作：Full Access 会话放行，否则必须 `ctx.approval.request` 得到 `allowed-once`；`ui` 来源来自用户本人点击，不得再弹审批，也不得把审批结果当成模型可伪造的参数。
- 设备清单写在 `$DSH_HOME`（默认 `~/.dsh`）的 `remote-instances.json`，权限 `0600`，写入串行化并走「临时文件 + rename」。不从其它仓库或用户目录借用路径。
- 清单损坏要报错而不是静默清空；单行不合法只跳过并报告。字段校验只有 `src/instances.ts` 一份，工具、界面、配置文件种子共用。
- 密码存 `$DSH_HOME/remote-instances.secrets.json`（`0600`，与清单分离，`SecretStore`）；不得进入清单、工具结果、HTTP 响应、作业输出、日志或 argv，`remove` 必须同时删密码。工具参数里的 `password` 会被会话日志记录，文档提醒优先用设置面板。
- 密码认证要求运行 DSH 的机器是 Linux/macOS（Windows 宿主没有可用的 `SSH_ASKPASS`），界面与工具都要给出可读的失败原因。
- 作业 owner 必须是触发会话：`jobs`/`status`/`cancel` 一律带 `agent.id` 校验，跨会话 id 视为未知；`dispose` 要终止在跑进程并等待退出。

## 客户端

- 业务界面只用 `--dsw-alias-*`、`--dsw-font-*`、`--dsw-radius-*`、`--dsw-focus-ring-*` 令牌，不硬编码颜色；明暗都要看。
- 只注册 `settings.section` 与 `locale`，不替换应用根、不新增第二应用、不用 iframe；不 import `@deepseek-ai/dsh-client-ui-primitives` 等 Harness Client 包。
- 文案走 `ctx.locale`（`remoteInstance` 命名空间），中英 key 对齐；`Escape`、`focus-visible`、`aria-pressed`/`role=status`/`role=alert`、减少动效与宿主一致。
- UI 只调用 `/remote-instance/observe`（只读）与 `/remote-instance/action`（显式操作），必须带 `x-ri-observe: 1` / `x-ri-action: 1` 头；端点鉴权由 Host 的 `connection.admit` 决定，客户端的头不是授权。
- 不手改生成的 `client.js` / `index.js`；改 `src/` 后跑 `node scripts/build.mjs`。

## 发布与 CI

- `.github/workflows/ci.yml`：push 到 `main`/`master` 与 PR 上跑版本一致性、`typecheck`、`build --check`、`pnpm test`；全部必须绿，且产物必须已提交。
- 版本一致性检查是 `scripts/check-versions.mjs`：`package.json`、`client.js` 构建横幅、README 里固定的安装版本、CHANGELOG 顶部条目必须同一个版本；Release 运行时再加 `--tag` 比对 tag（`v<version>` 或裸版本号）。
- `.github/workflows/release.yml`：GitHub Release `published` 触发。先在安装依赖之前跑上面这条检查（失败即停），再跑同一套 CI 检查，拒绝已存在的 npm 版本，最后用 `scripts/dist-tag.mjs` 推导 dist-tag 发布：稳定版 `latest`，预发布 `alpha`/`beta`/`rc`。
- 升版本时必须同时改 README 的安装命令与 CHANGELOG 顶部条目，否则版本检查直接失败；CI 不改写版本号，版本只有 `package.json` 一个来源，顺序固定为「bump → rebuild → 更新 README/CHANGELOG → commit → 打 tag → 建 release」。
- **CI 红过的版本不升号**：修在同一版本上重试——改代码、重新构建、重跑检查，需要时把该版本的 tag 移到修复提交。只有已经发到 npm 或用户明确要求时才 bump。
- 移动/删除远端 tag 是改远端引用，只有用户明确要求才做；做完整理新旧指向，并说明「没发出去」的版本号是否保留。
- 仓库 secret `NPM_TOKEN` 必须能发布 `@kaus-io` 下的包；令牌不写进任何文件。要 provenance 时再加 `id-token: write` 与 `--provenance`。
- 预发布绝不能发成 `latest`，否则用户默认装到 alpha；dist-tag 交给脚本推导，不要在 workflow 里手写 `--tag`。

## 提交前

```sh
pnpm run typecheck && node scripts/build.mjs --check && node scripts/check-versions.mjs && pnpm test
```

测试用独占临时目录与注入的 runner/store 替身，不连真实 ssh、不读写真实设备清单。提交信息格式：`feat: ... / ...`（中文在前）。
