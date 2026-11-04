/**
 * 远程实例服务：设备清单、探测、并行派发任务，以及作业查询与取消。工具与设置界面共用同一实现。
 * Remote instance service: the device list, probing, parallel task dispatch,
 * and job inspection/cancellation. The tool and the Settings panel share it.
 */
import { createTaskParser } from './headless.js'
import { InstanceStore, instanceSummary, validateInstance } from './instances.js'
import type { ProbeRecord, RemoteInstance, StoreSnapshot } from './instances.js'
import { createRunner } from './runner.js'
import type { Runner } from './runner.js'
import { displayPath } from './settings.js'
import type { ServiceSettings } from './settings.js'
import { parseProbeOutput, remoteProbeCommand, remoteTaskCommand, sshArgv, sshTargetOf } from './shell.js'
import type { ProbeFacts } from './shell.js'
import { approvalSubject, NATIVE_ACTIONS, validateRequest } from './tool.js'
import type { AgentLike, HostContext, JobChunk, SubprocessHandle } from './contracts.js'

/** 一次操作的可选来源信息；`ui` 表示用户直接点击，不再索取一次性审批。 / Optional provenance; `ui` means a direct user click, already a human grant. */
export interface ExecuteOptions {
  readonly agent?: AgentLike
  readonly signal?: AbortSignal
  readonly source?: 'tool' | 'ui'
  readonly callId?: string
  readonly rootCallId?: string
}

/** 单次探测的返回。 / One probe result. */
export interface ProbeResult {
  readonly instance: ReturnType<typeof instanceSummary>
  readonly ok: boolean
  readonly version?: string
  readonly os?: string
  readonly dshPath?: string
  readonly dshHome?: string
  readonly cwd?: string
  readonly profile?: string
  readonly message?: string
  readonly stderr?: string
  readonly elapsedMs: number
}

/** 作业上下文，供 `jobs` 列表还原作业来源。 / Job context letting the `jobs` list explain each job. */
interface JobContext {
  readonly instance: string
  readonly profile: string
  readonly sessionId?: string
  readonly prompt: string
}

const MAX_PROMPT = 65_536
const MAX_JOBS_LISTED = 20
const MAX_STATUS_BYTES = 32_000
const MAX_REMEMBERED = 64

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} is required`)
  return value
}

function firstLine(text: string): string {
  return (text.split('\n').find(line => line.trim()) ?? '').replace(/\s+/g, ' ').trim()
}

function tailChunks(chunks: readonly JobChunk[], budget: number): { chunks: JobChunk[]; truncated: boolean } {
  let remaining = budget
  let truncated = false
  const kept: JobChunk[] = []
  for (const chunk of [...chunks].reverse()) {
    if (remaining <= 0) { truncated = true; break }
    const text = chunk.text.slice(-remaining)
    remaining -= text.length
    if (text.length < chunk.text.length) truncated = true
    kept.unshift({ ...chunk, text })
  }
  if (truncated) kept.unshift({ at: kept[0]?.at ?? 0, text: '…[earlier output omitted]\n' })
  return { chunks: kept, truncated }
}

export class RemoteInstanceService {
  /** 本插件启动的作业及其 owner 会话。 / Jobs this plugin started keyed by owning session. */
  readonly ownedJobs = new Map<string, string>()
  /** 已结束作业的最终负载。 / Final payloads of settled jobs. */
  readonly results = new Map<string, unknown>()
  /** 作业上下文。 / Job contexts. */
  readonly contexts = new Map<string, JobContext>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly active = new Set<SubprocessHandle>()
  private readonly lifetime = new AbortController()
  private readonly store: InstanceStore
  private readonly runner: Runner
  private sealed = false
  private seeded = false

  constructor(
    readonly ctx: HostContext,
    readonly settings: ServiceSettings,
    overrides: { readonly runner?: Runner; readonly store?: InstanceStore } = {},
  ) {
    this.store = overrides.store ?? new InstanceStore({ file: settings.storeFile })
    this.runner = overrides.runner ?? createRunner(ctx.subprocess, { active: this.active })
  }

  /** 设备清单文件路径。 / The device-list path. */
  get storeDisplayPath(): string {
    return displayPath(this.store.path)
  }

  /**
   * 执行一个动作。`ui` 来源只允许清单与探测，且不索取审批。
   * Execute one action. The `ui` source may only manage the list and probe, and
   * never asks for approval.
   */
  async execute(input: unknown, options: ExecuteOptions = {}): Promise<unknown> {
    const args = validateRequest(input)
    if (this.sealed) throw new Error('Remote instance plugin is unloading')
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal
    signal.throwIfAborted()
    switch (args.action) {
      case 'instances':
        return this.list()
      case 'probe':
        return this.probe(args, signal)
      case 'add':
        return this.add(args, { ...options, signal })
      case 'remove':
        return this.remove(args, { ...options, signal })
      case 'ask':
        return this.ask(args, { ...options, signal })
      case 'jobs':
        return this.listJobs(this.requireAgent(options.agent))
      case 'status':
        return this.status(args, this.requireAgent(options.agent))
      case 'cancel':
        return this.cancel(args, this.requireAgent(options.agent))
      default:
        throw new Error('Unknown remote instance action')
    }
  }

  /** 已登记的设备及其最近探测结论。 / Registered devices with their last probe. */
  async list(): Promise<{ store: string; instances: ReturnType<typeof instanceSummary>[]; skipped?: readonly string[] }> {
    const snapshot = await this.load()
    return {
      store: this.storeDisplayPath,
      instances: [...snapshot.instances.values()].sort((left, right) => left.name.localeCompare(right.name)).map(instanceSummary),
      ...(snapshot.skipped.length === 0 ? {} : { skipped: snapshot.skipped }),
    }
  }

  /** 探测一台设备：ssh 连通性、远端 dsh 版本、profile 目录与工作目录。 / Probe one device. */
  async probe(args: Record<string, unknown>, signal: AbortSignal): Promise<ProbeResult> {
    const instance = await this.findInstance(requireString(args.name, 'name'))
    const started = Date.now()
    let facts: ProbeFacts | undefined
    let stderr = ''
    let message: string | undefined
    let ok = false
    try {
      const result = await this.runner(
        sshArgv(sshTargetOf(instance), remoteProbeCommand(instance), { connectTimeoutMs: this.settings.connectTimeoutMs }),
        { signal, timeoutMs: this.settings.probeTimeoutMs },
      )
      facts = parseProbeOutput(result.stdout)
      stderr = result.stderr.trim().slice(-4_000)
      ok = result.exitCode === 0 && facts.version !== undefined && facts.version !== 'missing' && !/not found/i.test(facts.version)
      if (!ok) message = stderr || (result.exitCode === 0 ? 'the remote device reported no dsh version' : `ssh exited with code ${String(result.exitCode)}`)
      else if (facts.profile === 'missing') message = `the remote device has no profile "${instance.profile}"; create it there or register another profile`
    } catch (error) {
      if (signal.aborted) throw error
      message = safeMessage(error)
    }
    const probe: ProbeRecord = {
      at: Date.now(),
      ok,
      ...(facts?.version === undefined ? {} : { version: facts.version }),
      ...(facts?.os === undefined ? {} : { os: facts.os }),
      ...(message === undefined ? {} : { message }),
    }
    const stored = await this.recordProbe(instance, probe)
    return {
      instance: instanceSummary(stored),
      ok,
      ...(facts?.version === undefined ? {} : { version: facts.version }),
      ...(facts?.os === undefined ? {} : { os: facts.os }),
      ...(facts?.dshPath === undefined ? {} : { dshPath: facts.dshPath }),
      ...(facts?.dshHome === undefined ? {} : { dshHome: facts.dshHome }),
      ...(facts?.cwd === undefined ? {} : { cwd: facts.cwd }),
      ...(facts?.profile === undefined ? {} : { profile: facts.profile }),
      ...(message === undefined ? {} : { message }),
      ...(stderr ? { stderr } : {}),
      elapsedMs: Date.now() - started,
    }
  }

  /** 新增或替换一台设备。 / Add or replace one device. */
  async add(args: Record<string, unknown>, options: ExecuteOptions): Promise<{ instance: ReturnType<typeof instanceSummary>; replaced: boolean }> {
    const snapshot = await this.load()
    const existing = snapshot.instances.get(String(args.name ?? ''))
    await this.authorize(args, options)
    const instance = validateInstance(
      {
        name: args.name,
        host: args.host,
        user: args.user,
        port: args.port,
        identityFile: args.identityFile,
        proxyJump: args.proxyJump,
        profile: args.profile,
        dsh: args.dsh,
        shell: args.shell,
        cwd: args.cwd,
        note: args.note,
      },
      { existing },
    )
    await this.store.update(instances => { instances.set(instance.name, instance) })
    return { instance: instanceSummary(instance), replaced: existing !== undefined }
  }

  /** 移除一台设备。 / Remove one device. */
  async remove(args: Record<string, unknown>, options: ExecuteOptions): Promise<{ removed: string; existed: boolean }> {
    const name = requireString(args.name, 'name')
    await this.authorize(args, options)
    let existed = false
    await this.store.update(instances => {
      existed = instances.delete(name)
    })
    return { removed: name, existed }
  }

  /** 把一次任务派发给远端 DSH agent，作为本会话的并行后台作业。 / Dispatch one task as a parallel background job. */
  async ask(args: Record<string, unknown>, options: ExecuteOptions): Promise<{ jobId: string; instance: string; status: 'running'; sessionId?: string }> {
    const agent = this.requireAgent(options.agent)
    const instance = await this.findInstance(requireString(args.name, 'name'))
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    if (!prompt.trim()) throw new Error('prompt is required')
    if (prompt.length > MAX_PROMPT) throw new Error(`prompt is too large (max ${MAX_PROMPT} characters)`)
    const sessionId = args.sessionId === undefined ? undefined : String(args.sessionId)
    const command = remoteTaskCommand(instance, sessionId)
    await this.authorize(args, options)
    const argv = sshArgv(sshTargetOf(instance), command, { connectTimeoutMs: this.settings.connectTimeoutMs })
    const controller = new AbortController()
    const owner = agent.id
    const label = `Remote ${instance.name}: ${firstLine(prompt).slice(0, 60)}`
    const jobId = this.ctx.jobs.start({
      kind: 'remote',
      owner,
      label,
      outputLimitBytes: this.settings.maxOutputBytes,
      ...(options.source === 'tool' && options.callId ? { toolCall: { callId: options.callId, rootCallId: options.rootCallId ?? options.callId } } : {}),
      run: job => {
        const promise = Promise.resolve().then(async () => {
          const parser = createTaskParser()
          let stderr = ''
          try {
            job.updateProgress(`connecting to ${instance.name}`)
            const result = await this.runner(argv, {
              signal: controller.signal,
              stdin: prompt,
              timeoutMs: this.settings.taskTimeoutMs,
              onOutput: ({ stream, text }) => {
                if (stream !== 'stdout') { stderr = (stderr + text).slice(-32_768); return }
                for (const update of parser.push(text)) {
                  if (update.kind === 'progress') job.updateProgress(update.text)
                  else job.append(update.text, { channel: update.kind === 'error' ? 'stderr' : 'log' })
                }
              },
            })
            const parsed = parser.finish({ exitCode: result.exitCode, aborted: controller.signal.aborted, stderr })
            const payload = {
              instance: instance.name,
              status: parsed.status,
              answer: parsed.answer,
              toolCalls: parsed.toolCalls,
              exitCode: result.exitCode,
              ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
            }
            this.remember(job.id, payload)
            if (parsed.status === 'completed') {
              job.updateProgress('completed')
              return { status: 'completed' as const, result: JSON.stringify(payload) }
            }
            const detail = (parsed.error ?? '').slice(-8_000) || `remote dsh exited with code ${String(result.exitCode)}`
            job.append(`\n${detail}\n`, { channel: 'stderr' })
            return { status: parsed.status, detail: detail.slice(0, 2_000) }
          } catch (error) {
            const killed = controller.signal.aborted
            const message = safeMessage(error).slice(-8_000)
            this.remember(job.id, { instance: instance.name, status: killed ? 'killed' : 'failed', answer: '', error: message })
            if (!killed) job.append(`\n${message}\n`, { channel: 'stderr' })
            return { status: killed ? 'killed' as const : 'failed' as const, detail: message.slice(0, 2_000) }
          }
        })
        this.pending.add(promise)
        promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise))
        return { cancel: reason => controller.abort(new Error(reason ?? 'Remote task cancelled')), done: promise }
      },
    })
    this.ownedJobs.set(jobId, owner)
    this.contexts.set(jobId, {
      instance: instance.name,
      profile: instance.profile,
      ...(sessionId === undefined ? {} : { sessionId }),
      prompt: firstLine(prompt).slice(0, 200),
    })
    return { jobId, instance: instance.name, status: 'running', ...(sessionId === undefined ? {} : { sessionId }) }
  }

  /** 本会话的远程作业。 / Remote jobs of this session. */
  listJobs(agent: AgentLike): { jobs: unknown[] } {
    const jobs: unknown[] = []
    for (const [id, owner] of [...this.ownedJobs].reverse()) {
      if (owner !== agent.id) continue
      const context = this.contexts.get(id)
      if (!context) continue
      try {
        jobs.push({ ...this.ctx.jobs.get(id, agent.id), context: { ...context } })
      } catch {
        this.forget(id)
      }
      if (jobs.length === MAX_JOBS_LISTED) break
    }
    return { jobs }
  }

  /** 读取作业状态与保留输出。 / Read one job's state and retained output. */
  status(args: Record<string, unknown>, agent: AgentLike): { job: unknown; output: { chunks: JobChunk[]; next: number; lossy: boolean }; result: unknown } {
    const jobId = this.owned(requireString(args.jobId, 'jobId'), agent)
    const job = this.ctx.jobs.get(jobId, agent.id)
    const output = this.ctx.jobs.readAt(jobId, typeof args.from === 'number' ? args.from : 0, agent.id)
    const { chunks, truncated } = tailChunks(output.chunks, MAX_STATUS_BYTES)
    return { job, output: { chunks, next: output.next, lossy: output.lossy || truncated }, result: this.results.get(jobId) ?? null }
  }

  /** 取消一个远程作业。 / Cancel one remote job. */
  cancel(args: Record<string, unknown>, agent: AgentLike): { jobId: string; status: 'requested' | 'already-finished' } {
    const jobId = this.owned(requireString(args.jobId, 'jobId'), agent)
    return { jobId, status: this.ctx.jobs.kill(jobId, agent.id, 'Remote task cancelled by caller') }
  }

  /** 停止全部在跑任务并等待进程退出。 / Stop every live task and wait for the processes. */
  async dispose(): Promise<void> {
    this.sealed = true
    this.lifetime.abort(new Error('Remote instance plugin unloaded'))
    for (const [id, owner] of this.ownedJobs) {
      try { this.ctx.jobs.kill(id, owner, 'Remote instance plugin unloaded') } catch { /* Agent disposal may have removed it already. / Agent 释放可能已移除。 */ }
    }
    for (const child of this.active) child.terminate()
    await Promise.allSettled([...this.pending, ...[...this.active].map(child => child.waitForExit())])
    this.results.clear()
    this.ownedJobs.clear()
    this.contexts.clear()
  }

  private requireAgent(agent: AgentLike | undefined): AgentLike {
    if (!agent) throw new Error('Choose a live session first')
    return agent
  }

  private async load(): Promise<StoreSnapshot> {
    const snapshot = await this.store.load()
    if (snapshot.exists || this.seeded || this.settings.seed.length === 0) return snapshot
    this.seeded = true
    const instances = new Map<string, RemoteInstance>()
    for (const entry of this.settings.seed) {
      const instance = validateInstance(entry)
      instances.set(instance.name, instance)
    }
    await this.store.save(instances)
    return { instances, exists: true, skipped: snapshot.skipped }
  }

  private async findInstance(name: string): Promise<RemoteInstance> {
    if (!name) throw new Error('name is required')
    const snapshot = await this.load()
    const instance = snapshot.instances.get(name)
    if (!instance) throw new Error(`Unknown remote instance "${name}"; call instances to list the registered devices`)
    return instance
  }

  private async recordProbe(instance: RemoteInstance, probe: ProbeRecord): Promise<RemoteInstance> {
    const updated: RemoteInstance = { ...instance, lastProbe: probe }
    await this.store.update(instances => {
      if (instances.has(instance.name)) instances.set(instance.name, updated)
    })
    return updated
  }

  private owned(jobId: string, agent: AgentLike): string {
    if (this.ownedJobs.get(jobId) !== agent.id) throw new Error('Unknown or foreign remote job')
    return jobId
  }

  private remember(jobId: string, payload: unknown): void {
    this.results.set(jobId, payload)
    while (this.results.size > MAX_REMEMBERED) {
      const oldest = this.results.keys().next().value
      if (oldest === undefined) break
      this.results.delete(oldest)
    }
  }

  private forget(jobId: string): void {
    this.ownedJobs.delete(jobId)
    this.contexts.delete(jobId)
    this.results.delete(jobId)
  }

  /**
   * 原生操作授权：Full Access 会话直接放行，否则要求一次明确的一次性批准；界面点击已由用户本人完成。
   * Native-operation grant: a Full Access session passes, otherwise one explicit
   * one-shot approval is required. A UI click is already the human decision.
   */
  private async authorize(args: Record<string, unknown>, options: ExecuteOptions): Promise<void> {
    if (!NATIVE_ACTIONS.has(String(args.action))) return
    if (options.source === 'ui') return
    const agent = this.requireAgent(options.agent)
    options.signal?.throwIfAborted()
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    if (policy.mode === 'danger-full-access') return
    const subject = approvalSubject(args)
    const outcome = await this.ctx.approval.request({
      agent,
      toolName: 'remote_instance',
      callId: options.callId,
      signal: options.signal,
      reason: `Remote instance ${subject}. This uses native ssh from this host to another device, runs that device's dsh agent, and may write configuration, caches, and session state there. Allow this exact operation once?`,
      displayReason: {
        en: `Allow ${subject} over SSH for this operation?`,
        zh: `是否允许本次通过 SSH 执行 ${subject}？`,
      },
    })
    if (outcome !== 'allowed-once') throw new Error(`Remote instance operation not authorized (${outcome})`)
  }
}
