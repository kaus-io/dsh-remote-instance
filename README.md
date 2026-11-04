```text
 本机 DSH ── remote_instance ──ssh──▶ 远端 dsh --profile headless --json
    ▲                                        │
    └──────── jobId · 进度输出 · 最终回答 ◀───┘
```

### DSH Remote Instance

![language-typescript](https://img.shields.io/badge/language-typescript-orange.svg)
[![license-MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![dsh-plugin](https://img.shields.io/badge/dsh-plugin-4D6BFE)
[![updates-更新日志](https://img.shields.io/badge/updates-%E6%9B%B4%E6%96%B0%E6%97%A5%E5%BF%97-brightgreen)](CHANGELOG.md)

### 介绍

`DSH Remote Instance` 是把其他设备上的 `DSH` 通过 `SSH` 接进当前 DSH 的插件。登记一台设备只需要**账号、IP、密码**（名字可留空，按 IP 自动生成）；agent 用 `remote_instance` 工具把任务派给远端 `dsh`，作为本会话的普通后台作业并行运行：多台设备、多个任务互不阻塞，可随时查看输出或取消。设置里的「远程实例」面板负责管理设备清单。

远端支持 **Linux / macOS / Windows**：POSIX 系统走登录 shell，Windows 走 PowerShell，平台由 `probe` 自动识别并记住。任务正文只走 `stdin`；密码只交给 `SSH_ASKPASS`，不进 `argv`、日志、作业输出或工具结果。

会话卡片上的「远程」入口把一台设备当成可操作的实例：列出它自己的会话、读历史、直接对话、停止当前回合，也能在指定目录新开一个会话。

### 安装

```sh
dsh plugin --profile web add @kaus-io/dsh-remote-instance@1.0.0-alpha05
```

本地开发用 `link:` 指向仓库目录，两种来源互斥；`patchReload: startup` 的 profile 需要重启 `dsh web` 才会加载新 bundle。

### 使用

添加设备填账号、IP、密码，然后：

- `probe`：只读检查远端系统、`dsh` 版本、`$DSH_HOME` 与目标 `profile` 目录，同时确定平台。
- `ask`：把 prompt 交给远端 `dsh --profile headless --json`，返回 `jobId`；`jobs` / `status` / `cancel` 跟踪或停止。
- `add` / `remove`：维护设备清单，`remove` 会同时删掉保存的密码。
- `sessions`：列出这台远端 DSH 自己的会话（标题 / 工作目录 / 最近活动）。
- `new`：在某个远端目录新开一个会话，可带首条消息。
- `history`：读远端会话历史；能读到远端日志时来自日志，否则只显示打开之后的消息。
- `send` / `stop` / `close`：发消息、停当前回合、关闭会话。

会话操作不再需要远端 `dsh` 命令：**每台装了这个插件的 DSH 都会在自己的进程里起一个只绑 `127.0.0.1` 的 HTTP 服务**（端口自动分配，端点 `/v1/info`、`/v1/sessions`、`/v1/history`、`/v1/create`、`/v1/prompt`、`/v1/cancel`），把端口与 token 写进 `$DSH_HOME/remote-instance-bridge.json`（`0600`）。对端插件读这个文件、拉一条 `ssh -N -L` 隧道进去调用，所以桌面版（只有 Electron、没有 CLI）也能被当设备用。

会话能力走 Host 公共的 `sessionController`；历史读本机 `$DSH_HOME/sessions/**` 的日志（zstd 多帧 + JSONL v4，上限 8 MB）。

远端要有能跑起来的 `dsh`：Linux/macOS 在登录 shell 的 `PATH` 里；Windows 在 PowerShell 里可执行（路径含空格就填绝对路径）。`headless` profile 默认不读 GUI 保存的登录凭据，远端要有 `DEEPSEEK_API_KEY`。

### 安全

- 密码存在 `$DSH_HOME/remote-instances.secrets.json`（`0600`，与设备清单分离），只通过 `SSH_ASKPASS` 注入 ssh 子进程环境。
- 首次连接接受并锁定主机指纹（`StrictHostKeyChecking=accept-new`），指纹变化仍然失败。
- 密码认证要求运行 DSH 的机器有 POSIX `ssh` 客户端（`SSH_ASKPASS`）；Windows 宿主请改用密钥。
- 通过工具传 `password` 会被记进会话日志，优先用设置面板填写。
- 桥接服务只绑回环、全部端点要 Bearer token；token 只有同用户可读，隧道只在使用时建立。
- 历史读取是固定只读命令 + 会话 id 白名单 + 8 MB 压缩上限，不会变成任意文件读取。

### 参与贡献

欢迎提 `Issues` 和 `PR`。报问题时带上 `dsh --version`、远端系统与 `probe` 的输出，定位会快很多。
