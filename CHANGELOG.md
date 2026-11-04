# 更新日志

## 1.0.0-alpha01

首个 alpha 版本。

- `remote_instance` 工具：`instances`、`add`、`remove`、`probe`、`ask`、`jobs`、`status`、`cancel`；远程任务作为本会话后台作业运行，可并行、可取消。
- 设备清单存 `$DSH_HOME/remote-instances.json`（`0600`、临时文件 + rename、写入串行化），字段严格校验，坏行跳过并报告，文件损坏直接报错。
- 设置面板「远程实例」分区：登记/替换、探测、两步确认移除；端点为鉴权后的浏览器 Peer 专用。
- 安全边界：prompt 只走 `stdin`，远端命令固定片段 + POSIX 单引号转义，无任意远端 shell；`add`/`remove`/`ask` 需 Full Access 或一次性审批。
- 发布为 `@kaus-io/dsh-remote-instance`，`engines.dsh` 为 `>=0.2.1-rc.5 <0.3.0`。
