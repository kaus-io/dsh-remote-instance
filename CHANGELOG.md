# 更新日志

## 1.0.0-alpha03

- 新增密码认证：`add` 接受 `password`，保存到 `$DSH_HOME/remote-instances.secrets.json`（`0600`），只经 `SSH_ASKPASS` 交给 ssh 子进程，绝不进 `argv`、日志、作业输出或工具结果。
- 远端平台支持：POSIX（Linux/macOS）与 Windows（PowerShell，命令用 base64 编码避免引号歧义）；`probe` 自动识别并记住平台，之后的 `ask` 按平台拼命令。
- 登记只需账号、IP、密码：省略名字时按 IP 派生（`100.68.98.76` → `100-68-98-76`）。
- 首次连接接受并锁定主机指纹（`accept-new`），指纹变化仍然失败。
- 密码认证要求运行 DSH 的机器有 POSIX `ssh` 客户端；Windows 宿主请用密钥。

## 1.0.0-alpha02

首个发布到 npm 的版本（alpha01 只用于打 tag，未发布）。

- `engines.dsh` 最低支持 `0.2.1-rc.3`（`>=0.2.1-rc.3 <0.3.0`）。
- `remote_instance` 工具：`instances`、`add`、`remove`、`probe`、`ask`、`jobs`、`status`、`cancel`；远程任务作为本会话后台作业运行，可并行、可取消。
- 设备清单存 `$DSH_HOME/remote-instances.json`（`0600`、临时文件 + rename、写入串行化），字段严格校验，坏行跳过并报告，文件损坏直接报错。
- 设置面板「远程实例」分区：登记/替换、探测、两步确认移除；端点为鉴权后的浏览器 Peer 专用。
- 安全边界：prompt 只走 `stdin`，远端命令固定片段 + POSIX 单引号转义，无任意远端 shell；`add`/`remove`/`ask` 需 Full Access 或一次性审批。
- 仓库配套：`scripts/dist-tag.mjs` 推导 dist-tag、`scripts/check-versions.mjs` 校验版本一致、CI 与 Release workflow。

## 1.0.0-alpha01

未发布到 npm，仅供打 tag 使用。
