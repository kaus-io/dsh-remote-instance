/**
 * 本插件读取的 Host 服务面：不依赖任何 `@deepseek-ai/*` 运行时包，只声明实际用到的成员。
 * Narrow faces of the Host services this plugin consumes: no runtime dependency on any
 * `@deepseek-ai/*` package, only the members actually used.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 本插件视角下的一个活跃 Agent。 / One live Agent as this plugin reads it. */
export interface AgentLike {
  readonly id: string
  readonly session: unknown
}

/** 一次性审批结果；只有 `allowed-once` 视为授权。 / Approval outcome token; only `allowed-once` grants. */
export type ApprovalOutcome = 'allowed-once' | 'allowed-always' | 'denied' | 'cancelled' | 'unavailable' | string

/** 一次原生操作的用户决策请求。 / One pending user decision for a native operation. */
export interface ApprovalRequest {
  readonly agent: AgentLike
  readonly toolName: string
  readonly callId?: string
  readonly signal?: AbortSignal
  readonly reason: string
  readonly displayReason: { readonly en: string; readonly zh: string }
}

/** `ctx.approval` 面：为原生操作索取一次性授权。 / `ctx.approval` face used to require a one-shot grant. */
export interface ApprovalService {
  request(request: ApprovalRequest): Promise<ApprovalOutcome>
}

/** `ctx.sandboxPolicy` 面：识别已授予 Full Access 的会话。 / `ctx.sandboxPolicy` face used to detect Full Access. */
export interface SandboxPolicyService {
  resolve(input: { readonly session: unknown }): { readonly mode: string }
}

/** 托管子进程的标准输入输出约定。 / Stdio dispositions accepted by the managed subprocess provider. */
export interface SubprocessStdio {
  readonly stdin: 'ignore' | 'pipe' | { readonly data: string }
  readonly stdout: 'pipe' | 'inherit'
  readonly stderr: 'pipe' | 'inherit'
}

/** 完整指定的托管进程；provider 不补任何默认值。 / Fully specified managed process; the provider applies no defaults. */
export interface SubprocessSpawnSpec {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly graceMs?: number
  readonly stdio: SubprocessStdio
}

/** 托管进程上报的退出事实。 / Exit facts reported by a managed process. */
export interface SubprocessOutcome {
  readonly exitCode: number | null
  readonly signal?: string | null
}

/** 活跃托管进程句柄。 / Live managed process handle. */
export interface SubprocessHandle {
  /** 子进程 stdin；仅在 `stdin: 'pipe'` 时存在。 / The child stdin, present only for `stdin: 'pipe'`. */
  readonly stdin?: { write(chunk: string): boolean; end(): void; on(event: 'error', listener: (error: Error) => void): unknown }
  readonly stdout?: AsyncIterable<Uint8Array>
  readonly stderr?: AsyncIterable<Uint8Array>
  readonly done: Promise<SubprocessOutcome>
  terminate(): void
  waitForExit(): Promise<unknown>
}

/** `ctx.subprocess` 面：可执行文件解析加托管进程。 / Executable lookup plus managed ranges. */
export interface SubprocessRuntime {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/** 一个已登记后台作业的生产者面。 / Producer face of one registered background job. */
export interface JobProducer {
  readonly id: string
  append(text: string, options?: { readonly channel?: string }): void
  updateProgress(line: string): void
}

/** 生产者通过 `done` 上报的终态。 / Terminal result a producer reports through `done`. */
export interface JobOutcome {
  readonly status: 'completed' | 'killed' | 'failed'
  readonly detail?: string
  readonly result?: string
}

/** 注册表提供的取消与完成句柄。 / Registry-facing hooks for producer-controlled cancellation. */
export interface JobHooks {
  cancel(reason?: string): void
  readonly done: Promise<JobOutcome>
}

/** 作业注册表接受的登记信息。 / Registration facts accepted by the job registry. */
export interface JobSpec {
  readonly kind: string
  readonly label: string
  readonly owner?: string
  readonly toolCall?: { readonly callId: string; readonly rootCallId: string }
  readonly outputLimitBytes?: number
  run(job: JobProducer): JobHooks
}

/** 向所属会话列出的单条作业投影。 / One job projection as listed to its owning session. */
export interface JobView {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly progress?: string
  readonly detail?: string
  readonly [key: string]: unknown
}

/** 不移动模型游标读出的一段保留输出。 / One retained ring chunk read without moving the cursor. */
export interface JobChunk {
  readonly at: number
  readonly text: string
  readonly channel?: string
}

/** 不消费的环形输出读取结果。 / Non-consuming ring read. */
export interface JobOutputRead {
  readonly chunks: readonly JobChunk[]
  readonly next: number
  readonly lossy: boolean
}

/** `ctx.jobs` 面：把远程任务跑成后台作业。 / `ctx.jobs` face used to run remote tasks as background jobs. */
export interface JobsRegistry {
  start(spec: JobSpec): string
  get(id: string, caller?: string): JobView
  readAt(id: string, from: number, caller?: string): JobOutputRead
  kill(id: string, caller?: string, reason?: string): 'requested' | 'already-finished'
  attachController(name: string): () => void
}

/** 工具 `execute` 收到的执行上下文。 / Execution context handed to a tool's `execute`. */
export interface ToolExecutionContext {
  readonly agent: AgentLike
  readonly signal?: AbortSignal
  readonly callId?: string
  readonly rootCallId?: string
}

/** `ctx.tools.register` 接受的模型工具定义。 / Model-facing definition accepted by `ctx.tools.register`. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly output?: {
    readonly schema: unknown
    readonly render: (args: unknown, value: unknown) => readonly { readonly type: 'text'; readonly text: string }[]
  }
  readonly isConcurrencySafe?: (args: Record<string, unknown>) => boolean
  readonly execute: (args: Record<string, unknown>, exec: ToolExecutionContext) => Promise<unknown>
}

/** `ctx.tools` 面。 / `ctx.tools` face. */
export interface ToolRegistry {
  register(definition: ToolDefinition): () => void
}

/** Host web server 上的一条精确路径路由。 / One exact-path HTTP route on the Host web server. */
export interface WebRoute {
  readonly kind: 'exact'
  readonly path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<unknown> | unknown
}

/** `ctx.webServer` 面。 / `ctx.webServer` face. */
export interface WebServer {
  register(route: WebRoute): () => void
  getOrigin(): string
}

/** 单个请求的准入结论。 / Admission decision for one inbound request. */
export interface ConnectionAdmission {
  readonly rejection?: { readonly status: number }
  readonly peer?: { readonly id: string }
}

/** `ctx.connection` 面：请求准入与已认证浏览器 Peer。 / Request admission plus the authed browser peer. */
export interface ConnectionService {
  admit(req: IncomingMessage): ConnectionAdmission
  readonly browserPeer: { readonly id: string }
}

/** 非致命诊断用的最小日志面。 / Minimal logger face used for non-fatal diagnostics. */
export interface Logger {
  warn(message: string): void
}

/** 本插件用到的 Cordis context 成员。 / The Cordis context members this plugin uses. */
export interface HostContext {
  readonly tools: ToolRegistry
  readonly subprocess: SubprocessRuntime
  readonly jobs: JobsRegistry
  readonly approval: ApprovalService
  readonly sandboxPolicy: SandboxPolicyService
  readonly agents: { get(sessionId: string): AgentLike | undefined }
  readonly webServer: WebServer
  readonly connection: ConnectionService
  readonly logger?: Logger
  /** 按名字取一个可选 Host 服务（桥接读 sessionController）。 / Look up an optional Host service by name. */
  get?(name: string): unknown
  effect(factory: () => (() => void) | void, label?: string): void
  on(event: 'agent/disposed', listener: (payload: { readonly agent: AgentLike }) => void): () => void
}
