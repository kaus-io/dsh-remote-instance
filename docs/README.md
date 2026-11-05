# DSH Remote Instance 使用文档

[返回项目首页](<../README.md>) · [更新日志](<../CHANGELOG.md>)

## 安装

插件声明兼容 DSH `>=0.2.1-rc.3 <0.3.0`。在运行 Web 的 profile 中安装，`web` 可替换为实际 profile 名：

```sh
dsh plugin --profile web add @kaus-io/dsh-remote-instance@1.0.0-alpha05
```

安装后可通过会话卡片标题栏的**远程**入口访问远端会话。若要从源码开发，先在仓库目录构建：

```sh
git clone https://github.com/kaus-io/dsh-remote-instance.git
cd dsh-remote-instance
pnpm install
pnpm run build
```

然后在 DSH 插件管理中安装组合包 `link:/绝对路径/dsh-remote-instance`。npm 与本地链接二选一，替换前先移除旧来源。安装后刷新页面，并按宿主提示重新启用插件或重启；本地链接目录需保留。

## 准备与连接

1. 本机安装 SSH 客户端，远端启用 SSH 服务，确保账号可以登录。密码认证要求本机是 Linux / macOS；Windows 宿主请使用密钥。
2. 在**设置 → 远程实例**添加设备，填写主机地址、账号、端口与密码；名称可留空自动生成。不填密码时使用 SSH 配置或 ssh-agent 的密钥。指定私钥、跳板机、远端工作目录、DSH 路径或 profile 等高级选项，可通过工具 `add` 配置；未指定工作目录时默认使用 SSH 登录目录。
3. **单次任务**需要远端可执行 `dsh`、存在指定 profile（默认 `headless`），并为该 profile 配好模型凭据。默认 headless 不读取 GUI 登录凭据，需准备 `DEEPSEEK_API_KEY`。使用 `probe` 检查版本、profile 与平台；命令不在 PATH 时填写绝对路径。
4. **会话直连**需要两端安装并启用支持桥接的本插件，远端 DSH 持续运行且提供会话控制能力。它不依赖远端 CLI，因此也可接入只有桌面版的设备；桥接默认开启，无需把 HTTP 端口暴露到公网。

## 快速使用

可以直接对代理说：

> 查看已登记设备，探测 laptop，然后让它在指定工作目录检查项目并汇报结果。

也可调用 `remote_instance`，例如对已登记的 `laptop` 派发任务：

```json
{"action":"ask","name":"laptop","prompt":"检查当前项目的测试配置，只读分析并给出建议。"}
```

| 操作 | 用途 |
| --- | --- |
| `instances` / `add` / `remove` / `probe` | 查看、登记、移除和检测设备；移除时同时删除已保存密码 |
| `ask` / `jobs` / `status` / `cancel` | 派发一次任务并跟踪本会话的后台作业；`ask` 可带已有 `sessionId` 续接 |
| `sessions` / `new` / `history` | 列出远端会话、在指定目录新建、读取历史摘要 |
| `send` / `stop` / `close` | 发送消息、停止当前回合、清理本地会话缓存；当前桥接的 `close` 不删除远端会话 |

图形界面中，点击会话卡片标题栏的**远程**入口，选择设备与会话后即可阅读历史并继续交流。桥接发送成功只表示已接受消息，不表示回答完成；请刷新或等待历史更新。历史来自远端日志，可能为空或不完整，最多保留 240 条消息、每条最多 20,000 字符，不是完整日志备份。

## 安全与限制

- 首次 SSH 连接会自动接受并记录主机指纹，指纹变化仍会拒绝。请先确认目标地址和可信身份。
- 设备清单默认位于 `$DSH_HOME/remote-instances.json`，密码单独以明文 JSON 保存在 `$DSH_HOME/remote-instances.secrets.json`（权限 `0600`，不是加密密钥库）；`$DSH_HOME` 默认是 `~/.dsh`。
- **优先在设置面板填写密码**：工具参数中的 `password` 会进入会话日志。连接密码通过 `SSH_ASKPASS` 交给 SSH，不放进命令行或作业输出。
- `ask` 的任务正文只走 stdin；会话消息经 SSH 隧道发送到插件桥接。桥接仅绑定 `127.0.0.1` 并要求 Bearer token，描述文件 `remote-instance-bridge.json` 权限为 `0600`，不要共享其中的 token。
- 代理发起的设备增删、派发与发送等原生操作需要 Full Access 或一次性审批。远端执行使用远端的权限和配置，本机的文件沙箱不是远端隔离边界，只连接可信设备与账号。
- 不提供任意远端 shell、文件上传下载或通用端口转发；历史按会话 ID 读取固定日志。关闭对话面板不等于停止任务，请使用 `stop` 或 `cancel`。

## 开发与验证

在本仓库目录执行：

```sh
pnpm install
pnpm run typecheck
node scripts/build.mjs --check
pnpm run check:versions
```

单元测试使用 SSH 替身；运行 `pnpm test` 会先重建产物，不代替真实远端连接验收。报告问题请附 DSH 版本、两端系统、复现步骤与已脱敏的 `probe` 输出，不要上传密码或桥接 token。许可证见 [MIT License](<../LICENSE>)。
