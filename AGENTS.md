# AGENTS.md · dsh-remote-instance

安装到 Harness profile 的持久化插件，不是业务 App 模块。工作区根规则仍适用，这里只记本仓库不能踩的硬约束。

## 远端命令与传输

- 任务正文（prompt）**只能走 ssh 的 stdin**。任何把用户文本拼进远端命令行、`--session-id` 之外的参数、环境变量或文件名里的做法都视为注入缺陷。
- 远端命令只由固定片段拼装，值一律经 `shellQuote`（POSIX 单引号）转义：`ssh ... -T -o BatchMode=yes ... -- <host> '<login shell>' -lc '<cd + exec dsh ...>'`。`host`/`user`/`identityFile`/`proxyJump`/`port` 由 `validateInstance` 的字符白名单先筛，`sessionId` 只允许 `A-Za-z0-9_-`。
- 不新增任意远端 shell、sudo、文件上传下载、端口转发、`ProxyCommand` 或 `-o` 透传参数；`probe` 的脚本内容固定，只读。
- SSH 必须保持免交互：`BatchMode=yes` 加上建连/保活/总超时。不改写 `known_hosts` 策略，首次连接未知指纹就是失败，让用户手动接受。
- 所有进程经 `ctx.subprocess` 托管，`createRunner` 负责取消、超时与等待整棵进程树退出；不要直接 `child_process`。

## 权限与清单

- `add`/`remove`/`ask` 是原生操作：Full Access 会话放行，否则必须 `ctx.approval.request` 得到 `allowed-once`；`ui` 来源来自用户本人点击，不得再弹审批，也不得把审批结果当成模型可伪造的参数。
- 设备清单写在 `$DSH_HOME`（默认 `~/.dsh`）的 `remote-instances.json`，权限 `0600`，写入串行化并走「临时文件 + rename」。不从其它仓库或用户目录借用路径。
- 清单损坏要报错而不是静默清空；单行不合法只跳过并报告。字段校验只有 `src/instances.ts` 一份，工具、界面、配置文件种子共用。
- 作业 owner 必须是触发会话：`jobs`/`status`/`cancel` 一律带 `agent.id` 校验，跨会话 id 视为未知；`dispose` 要终止在跑进程并等待退出。

## 客户端

- 业务界面只用 `--dsw-alias-*`、`--dsw-font-*`、`--dsw-radius-*`、`--dsw-focus-ring-*` 令牌，不硬编码颜色；明暗都要看。
- 只注册 `settings.section` 与 `locale`，不替换应用根、不新增第二应用、不用 iframe；不 import `@deepseek-ai/dsh-client-ui-primitives` 等 Harness Client 包。
- 文案走 `ctx.locale`（`remoteInstance` 命名空间），中英 key 对齐；`Escape`、`focus-visible`、`aria-pressed`/`role=status`/`role=alert`、减少动效与宿主一致。
- UI 只调用 `/remote-instance/observe`（只读）与 `/remote-instance/action`（显式操作），必须带 `x-ri-observe: 1` / `x-ri-action: 1` 头；端点鉴权由 Host 的 `connection.admit` 决定，客户端的头不是授权。
- 不手改生成的 `client.js` / `index.js`；改 `src/` 后跑 `node scripts/build.mjs`。

## 提交前

```sh
pnpm run typecheck && node scripts/build.mjs --check && pnpm test
```

测试用独占临时目录与注入的 runner/store 替身，不连真实 ssh、不读写真实设备清单。提交信息格式：`feat: ... / ...`（中文在前）。
