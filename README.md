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

### 安装

```sh
dsh plugin --profile web add @kaus-io/dsh-remote-instance@1.0.0-alpha03
```

本地开发用 `link:` 指向仓库目录，两种来源互斥；`patchReload: startup` 的 profile 需要重启 `dsh web` 才会加载新 bundle。

### 使用

添加设备填账号、IP、密码，然后：

- `probe`：只读检查远端系统、`dsh` 版本、`$DSH_HOME` 与目标 `profile` 目录，同时确定平台。
- `ask`：把 prompt 交给远端 `dsh --profile headless --json`，返回 `jobId`；`jobs` / `status` / `cancel` 跟踪或停止。
- `add` / `remove`：维护设备清单，`remove` 会同时删掉保存的密码。

远端要有能跑起来的 `dsh`：Linux/macOS 在登录 shell 的 `PATH` 里；Windows 在 PowerShell 里可执行（路径含空格就填绝对路径）。`headless` profile 默认不读 GUI 保存的登录凭据，远端要有 `DEEPSEEK_API_KEY`。

### 安全

- 密码存在 `$DSH_HOME/remote-instances.secrets.json`（`0600`，与设备清单分离），只通过 `SSH_ASKPASS` 注入 ssh 子进程环境。
- 首次连接接受并锁定主机指纹（`StrictHostKeyChecking=accept-new`），指纹变化仍然失败。
- 密码认证要求运行 DSH 的机器有 POSIX `ssh` 客户端（`SSH_ASKPASS`）；Windows 宿主请改用密钥。
- 通过工具传 `password` 会被记进会话日志，优先用设置面板填写。

### 参与贡献

欢迎提 `Issues` 和 `PR`。报问题时带上 `dsh --version`、远端系统与 `probe` 的输出，定位会快很多。
