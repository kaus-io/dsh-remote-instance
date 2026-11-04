# 远程实例 · 参考手册

返回 [README](../README.md)。

把**其他设备上的 DSH** 通过 SSH 接进当前这台 DSH：登记设备后，agent 用 `remote_instance` 工具把任务派发给远端 DSH agent，作为本会话的普通后台作业并行运行，可随时查看输出或取消；设置里有一个「远程实例」面板管理设备清单。

- 一台设备的任务 = 一次 `ssh <host> dsh --profile <profile> --json`，任务正文（prompt）**只走 stdin**，永远不拼进远端命令行。
- 多台设备、多个任务互不阻塞：每个任务是一个 `remote` 作业，带独立 jobId、进度与结果，可在聊天头部的作业列表里看到。
- 远端 agent 自己拥有那台设备的工具、文件系统与沙箱；本插件不提供任意远端 shell、SFTP 或端口转发。

## 工具动作

| action | 需要审批 | 说明 |
| --- | --- | --- |
| `instances` | 否 | 列出登记的设备、解析后的 `user@host:port`、profile/工作目录与上次探测结论 |
| `add` | 是 | 新增或替换设备；只接受连接参数，从不接收密码或私钥内容 |
| `remove` | 是 | 移除设备（不触碰远端任何数据） |
| `probe` | 否 | 跑一段固定的只读探测脚本：远端 `dsh --version`、`uname`、`command -v dsh`、`$DSH_HOME`、`profiles/<profile>` 是否存在 |
| `ask` | 是 | 把 prompt 派发给远端 DSH agent，返回 `jobId`；可带 `sessionId` 续接远端会话 |
| `jobs` | 否 | 本会话的远程作业（最多 20 条，最新的在前） |
| `status` | 否 | 读作业状态与保留输出；继续读用上次的 `output.next`，最终答案在 `result` |
| `cancel` | 否 | 停止作业（本地生效，终止 ssh 进程树） |

审批规则：`add`/`remove`/`ask` 属于原生操作，Full Access 会话直接放行，否则要求**本次**一次性批准；设置面板里的按钮是用户本人在点，不会再弹审批。只读动作从不需要审批。

## 远端要求

1. 远端装好 `dsh`（Node 20+），并且**非交互** ssh 能拿到它的 PATH。nvm 之类的 PATH 由登录 shell 注入，所以默认用 `'bash' -lc '<命令>'` 包一层；如果登录 shell 里看不到 `dsh`，把 `dsh` 填成绝对路径，或把 `shell` 改成别的登录 shell；填空串表示不包，直接执行。
2. 目标 profile 必须已存在。默认 `headless`：一次性任务、把最终回答打到 stdout、`--json` 时输出逐行事件流。headless profile 默认**不读** GUI 保存的登录凭据，远端要么有 `DEEPSEEK_API_KEY`（环境变量、`<cwd>/.env`、`$DSH_HOME/.env`），要么在远端 headless profile 里恢复凭据相关行，否则 `ask` 会以模型鉴权失败结束——`probe` 能把版本和 profile 目录先查出来。
3. SSH 认证必须免交互：密钥或 ssh-agent（`BatchMode=yes`，永不提示密码）。首次连接未知主机指纹会失败，需要先在终端手动 `ssh <host>` 接受一次；本插件不替你修改 `known_hosts` 策略。

## 设备清单

存放在 `$DSH_HOME/remote-instances.json`（默认 `~/.dsh/remote-instances.json`），目录自动创建，文件权限 `0600`，写入走「临时文件 + rename」。

```json
{
  "version": 1,
  "instances": [
    {
      "name": "laptop",
      "host": "laptop.lan",
      "user": "alice",
      "port": 2222,
      "identityFile": "~/.ssh/id_ed25519",
      "proxyJump": "bastion.lan",
      "profile": "headless",
      "dsh": "dsh",
      "shell": "bash",
      "cwd": "~/work",
      "note": "开发本",
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000,
      "lastProbe": { "at": 1700000000000, "ok": true, "version": "0.2.1-rc.5", "os": "Linux 6.8 x86_64" }
    }
  ]
}
```

字段约束（Host 与界面共用同一份校验）：`name` 小写字母开头、`a-z0-9-_`、≤32；`host` 是主机名/IP/ssh 别名（不得以 `-` 开头）；`port` 1–65535；`identityFile` 绝对路径或 `~/` 开头；`profile` 小写 dsh profile 名；`dsh`/`shell` 是名字或绝对路径；`cwd` 绝对路径或 `~/`；`note` ≤500 字符。损坏的行会被跳过并在 `instances` 的 `skipped` 里报告；整个文件不是合法 JSON 时直接报错，不会静默清空。

插件配置（写在 profile 的 `cordis.patch.yml` 该行下）只调参，并可在清单文件**尚不存在**时写入首轮设备：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `storeFile` | `$DSH_HOME/remote-instances.json` | 清单文件路径（绝对路径或 `~/`） |
| `connectTimeoutMs` | `10000` | ssh 建连超时 |
| `probeTimeoutMs` | `30000` | 单次探测总超时 |
| `taskTimeoutMs` | `3600000` | 单个远程任务上限 |
| `maxOutputBytes` | `262144` | 作业输出保留上限 |
| `instances` | `[]` | 清单文件不存在时写入的初始设备（最多 64 条） |

## 安全边界

- 远端命令只由固定片段拼装：`ssh ... -- <host> '<shell>' -lc '<cd + exec dsh ...>'`；参数一律 POSIX 单引号转义，`host`/`user`/`port`/`identityFile`/`proxyJump` 先过字符白名单，`sessionId` 只允许 `A-Za-z0-9_-`。
- prompt 只经 stdin 传输；作业 label 只保留首行前 60 字符，作业上下文只保留首行前 200 字符。
- 没有任意远端 shell、没有 sudo、没有文件上传/下载、没有端口转发；`probe` 的脚本内容固定。
- 设置面板的两个端点（`POST /remote-instance/observe`、`POST /remote-instance/action`）只接受 `connection.admit` 认证出的**浏览器 Peer**，校验同源 `Origin`、自定义请求头与 JSON Content-Type，各自动作白名单分开；`connection` 不可用时失败关闭（503）。
- 只允许「主机对远端」单向发起；远端 dsh 不会反向调用本机。

## 安装

发布版直接装（`@kaus-io/dsh-remote-instance`，npm 组织 `kaus-io`）：

```sh
dsh plugin --profile web add @kaus-io/dsh-remote-instance@1.0.0-alpha01
```

本地开发用 `link:` 指向本仓库目录，两种来源互斥，换装前先卸掉旧源：

```sh
cd ~/.dsh/profiles/web
pnpm add link:/home/zxhhyj/AndroidStudioProjects/kaus-workspace/projects/dsh-remote-instance
```

然后把 `@kaus-io/dsh-remote-instance` 追加到该 `package.json` 的 `dsh.profile.bundles`；用 Harness 的 plugin manager（`install_bundle`）安装会自动完成这一步。`patchReload: startup` 的 profile 需要重启 `dsh web` 才会加载新 bundle。

## 发布

```sh
pnpm run typecheck && node scripts/build.mjs --check && pnpm test
npm pack --dry-run                # 核对 tarball：index.js、client.js、cordis.patch.yml、locale、icon 必须在
npm publish                       # scoped 包已声明 publishConfig.access=public，无需再加 --access
```

- 兼容范围在 `engines.dsh`（当前 `>=0.2.1-rc.5 <0.3.0`）：安装器在 pnpm 之前就检查。DSH 升到 0.3 之前必须同步改，否则新装会被拒；旧版本用户也装不上。
- 版本号遵循工作区版本号规范：`1.0.0-alpha01` 这类 `-alphaNN`/`-betaNN`/`-rcNN` 预发布；npm 预发布不会成为默认安装版本，正式版发布用 `npm publish --tag latest` 或事后 `npm dist-tag add`。
- 想出现在 Discover：托管一份插件市场索引 JSON（format 1，用 `@deepseek-ai/dsh-plugin-market-index` 校验），在其中列 `name@version` 和可选 `registry`，用户把索引 URL 加到 Discover。
- 刚发布的版本可能被 pnpm 的 `minimumReleaseAge` 供应链策略暂时挡住，装到的可能不是最新版。

## 源码与构建

| 源码 | 产物 | 说明 |
| --- | --- | --- |
| `src/host.ts` | `index.js` | Host 入口：配置、服务、两个端点、`remote_instance` 工具 |
| `src/service.ts` | ↑ | 设备清单、探测、并行派发、作业查询/取消、审批 |
| `src/instances.ts` | ↑ | 校验、`$DSH_HOME` 清单文件、摘要投影 |
| `src/shell.ts` | ↑ | ssh argv、远端任务/探测命令、单引号转义 |
| `src/headless.ts` | ↑ | 远端 `--json` 事件流解析 |
| `src/runner.ts` | ↑ | 托管子进程运行器（超时、取消、有界输出） |
| `src/http.ts` | ↑ | 鉴权端点 |
| `src/client.tsx` | `client.js` | 设置面板「远程实例」分区 |

产物已提交，profile 直接加载 `index.js` / `client.js`。改源码后：

```sh
pnpm install
pnpm run typecheck        # tsc --noEmit，strict
pnpm run build            # esbuild：Host 走 ESM，Client 走 CJS + __ModuleLoader__ 包装
node scripts/build.mjs --check   # 产物是否最新
pnpm test                 # 构建 + node --test（校验、清单、ssh 命令、事件解析、服务流程、端点、Client bundle）
```

`react`、`react/jsx-runtime` 是 external，由宿主模块表提供，不打包第二份 React。

## 已知边界

- 远端必须是 POSIX shell（macOS/Linux/BSD）。Windows 远端可用 WSL 或 ssh 到 POSIX 环境，但本插件不识别 PowerShell。
- 每次任务是一个独立 `ssh` 进程，没有连接池；延迟主要是 ssh 建连。
- `headless` 一次任务一轮结束，多轮协作靠 `sessionId` 续接；远端同一 session 被占用时会拒绝。
- 主机指纹、`ProxyCommand` 等进阶 ssh 配置交给 `~/.ssh/config`；本插件只传 `-i`/`-J`/`-p`/`-l`。
