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

`DSH Remote Instance` 是把其他设备上的 `DSH` 通过 `SSH` 接进当前 DSH 的插件。登记设备后，agent 用 `remote_instance` 工具把任务派发给远端 `dsh`，作为本会话的普通后台作业并行运行：多台设备、多个任务互不阻塞，可随时查看输出或取消；设置里的「远程实例」面板负责管理设备清单。

任务正文只走 `stdin`，远端命令由固定片段拼装并做单引号转义，插件不提供任意远端 `shell`、`SFTP` 或端口转发。

### 安装

```sh
dsh plugin --profile web add @kaus-io/dsh-remote-instance@1.0.0-alpha01
```

本地开发用 `link:` 指向仓库目录，两种来源互斥；`patchReload: startup` 的 profile 需要重启 `dsh web` 才会加载新 bundle。

### 使用

先登记再派发：

- `instances`：列出设备与上次探测结论。
- `probe`：只读检查远端 `dsh` 版本、`$DSH_HOME` 与目标 `profile` 目录。
- `ask`：把 prompt 交给远端 `dsh --profile headless --json`，返回 `jobId`；`jobs` / `status` / `cancel` 跟踪或停止。
- `add` / `remove`：维护设备清单。

远端需要装好 `dsh` 并能免交互 `ssh`；`headless` profile 默认不读 GUI 保存的登录凭据，远端要有 `DEEPSEEK_API_KEY`（或恢复该 profile 的凭据行）。

### 参与贡献

欢迎提 `Issues` 和 `PR`。报问题时带上 `dsh --version`、远端系统与 `probe` 的输出，定位会快很多。
