/**
 * Host 入口：解析配置、挂载远程实例服务、注册设置面板端点与 `remote_instance` 工具。
 * Host entry: resolve config, mount the remote instance service, and register
 * the Settings-panel endpoints plus the `remote_instance` tool.
 */
import { startBridge } from './bridge.js'
import { ACTION_PATH, createActionHandler, createObserveHandler, OBSERVE_PATH } from './http.js'
import { resolveSettings } from './settings.js'
import { dirname } from 'node:path'
import { RemoteInstanceService } from './service.js'
import { parameters, READ_ACTIONS, TOOL_DESCRIPTION } from './tool.js'
import type { HostContext } from './contracts.js'

export { startBridge } from './bridge.js'
export { BridgeClient } from './bridge-client.js'
export { SessionBridge } from './session-bridge.js'
export { AcpClient, AcpConnectionError } from './acp.js'
export { decompressFrames, historyCommand, parseSessionLog, MAX_LOG_BYTES } from './history.js'
export { createTaskParser } from './headless.js'
export { ACTION_PATH, createActionHandler, createObserveHandler, OBSERVE_PATH, sameLoopbackOrigin } from './http.js'
export { InstanceStore, instanceSummary, displayTarget, NAME_PATTERN, restoreInstance, validateInstance } from './instances.js'
export { createRunner } from './runner.js'
export { RemoteInstanceService } from './service.js'
export { displayPath, resolveDshHome, resolveSettings } from './settings.js'
export { askpassEnv, ASKPASS_SCRIPT, parseProbeOutput, shellQuote, sshArgv, sshForwardArgv } from './shell.js'
export { encodePowerShell, posixProbeCommand, posixTaskCommand, powershellCommand, probeCommand, psQuote, taskCommand, windowsProbeCommand, windowsTaskCommand } from './platform.js'
export { posixProbeCommand as remoteProbeCommand, posixTaskCommand as remoteTaskCommand } from './platform.js'
export { assertSecret, SecretStore, secretsPathFor } from './secrets.js'
export { ACTIONS, READ_ACTIONS, TOOL_DESCRIPTION, validateRequest } from './tool.js'

/** 插件身份。 / Plugin identity. */
export const name = 'remote-instance'
/** 依赖的 Host 服务：工具、托管进程、作业、沙箱与审批、Agent 注册表、HTTP 与连接准入。 / Host services this plugin needs. */
export const inject = ['tools', 'subprocess', 'jobs', 'sandboxPolicy', 'approval', 'agents', 'webServer', 'connection']
/** 工具名。 / The tool name. */
export const TOOL_NAME = 'remote_instance'

/**
 * 挂载插件。端点、工具与作业控制器都绑定在本次 effect 生命周期上，卸载时一并撤销并等待进程退出。
 * Mount the plugin. Endpoints, tool, and job controller belong to this effect
 * lifetime and are withdrawn on unload after live processes exit.
 */
export function apply(ctx: HostContext, config?: unknown): void {
  const settings = resolveSettings(config)
  const service = new RemoteInstanceService(ctx, settings)

  ctx.effect(() => () => service.dispose(), 'remote-instance.dispose')
  if (settings.bridgePort > 0) {
    void startBridge(
      { get: name => ctx.get?.(name), ...(ctx.logger === undefined ? {} : { logger: ctx.logger }) },
      { port: settings.bridgePort, tokenFile: settings.bridgeTokenFile, dshHome: dirname(settings.storeFile) },
    ).then(bridge => {
      ctx.effect(() => () => bridge.close(), 'remote-instance.bridge')
    }, error => {
      ctx.logger?.warn(`remote-instance bridge failed to start: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  ctx.effect(() => ctx.jobs.attachController('remote-instance'), 'remote-instance.jobs')

  const originOf = () => {
    try { return ctx.webServer.getOrigin() } catch { return '' }
  }
  if (typeof ctx.webServer?.register === 'function') {
    ctx.effect(() => {
      const routes = [
        ctx.webServer.register({ kind: 'exact', path: OBSERVE_PATH, handler: createObserveHandler(service, originOf) }),
        ctx.webServer.register({ kind: 'exact', path: ACTION_PATH, handler: createActionHandler(service, originOf) }),
      ]
      return () => { for (const dispose of routes.reverse()) dispose() }
    }, 'remote-instance.http')
  }

  ctx.on('agent/disposed', ({ agent }) => {
    for (const [id, owner] of service.ownedJobs) {
      if (owner !== agent.id) continue
      service.ownedJobs.delete(id)
      service.contexts.delete(id)
      service.results.delete(id)
    }
  })

  ctx.effect(() => ctx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: args => READ_ACTIONS.has(String(args?.action)),
    execute: async (args, exec) => service.execute(args, {
      agent: exec.agent,
      signal: exec.signal,
      callId: exec.callId,
      rootCallId: exec.rootCallId,
      source: 'tool',
    }),
  }), 'remote-instance.tool')
}
