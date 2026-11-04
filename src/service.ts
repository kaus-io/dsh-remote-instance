/**
 * 远程实例服务：设备清单、密码/密钥认证、跨平台探测、并行派发与作业管理。
 * 密码只存在于独立的 0600 文件与 ssh 子进程环境里，绝不进入清单、结果或日志。
 *
 * Remote instance service: device list, password or key authentication,
 * cross-platform probing, parallel dispatch, and job management. A password
 * lives only in a separate 0600 file and the ssh child environment; it never
 * enters the list, a result, or a log.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskParser } from './headless.js'
import { InstanceStore, instanceSummary, validateInstance } from './instances.js'
import type { ProbeRecord, RemoteInstance, StoreSnapshot } from './instances.js'
import { probeCommand, taskCommand } from './platform.js'
import type { Platform } from './platform.js'
import { createRunner } from './runner.js'
import type { Runner } from './runner.js'
import { secretsPathFor, SecretStore, assertSecret } from './secrets.js'
import { displayPath } from './settings.js'
import type { ServiceSettings } from './settings.js'
import { ASKPASS_SCRIPT, askpassEnv, parseProbeOutput, sshArgv, sshTargetOf } from './shell.js'
import type { ProbeFacts } from './shell.js'
import { approvalSubject, NATIVE_ACTIONS, validateRequest } from './tool.js'
import type { AgentLike, HostContext, JobChunk, SubprocessHandle } from './contracts.js'

/** 一次操作的可选来源信息；`ui` 表示用户直接点击，不再索取一次性审批。 / Optional provenance; `ui` means a direct user click. */
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
  readonly platform: Platform
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

/** 从主机名派生一个合法实例名，便于只填账号/IP/密码。 / Derive a valid instance name from the host. */
function deriveInstanceName(host: string): string {
  const base = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return base || 'remote'
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

/** 探测是否拿到了可用的 dsh 版本。 / Whether a probe found a usable dsh version. */
function probeUsable(facts: ProbeFacts | undefined): boolean {
  const version = facts?.version
  return typeof version === 'string' && version.length > 0 && version !== 'missing' && !/not found|not recognized|CommandNotFound/i.test(version)
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
  private readonly secrets: SecretStore
  private readonly runner: Runner
  private sealed = false
  private seeded = false
  private askpassDirectory?: string
  private askpassPath?: string

  constructor(
    readonly ctx: HostContext,
    readonly settings: ServiceSettings,
    overrides: { readonly runner?: Runner; readonly store?: InstanceStore; readonly secrets?: SecretStore } = {},
  ) {
    this.store = overrides.store ?? new InstanceStore({ file: settings.storeFile })
    this.secrets = overrides.secrets ?? new SecretStore(secretsPathFor(settings.storeFile))
    this.runner = overrides.runner ?? createRunner(ctx.subprocess, { active: this.active })
  }

  /** 设备清单文件路径。 / The device-list path. */
  get storeDisplayPath(): string {
    return displayPath(this.store.path)
  }

  /** 执行一个动作。`ui` 来源只允许清单与探测。 / Execute one action; the `ui` source may only manage the list and probe. */
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
    const passwords = await this.secrets.load()
    const summaries = [...snapshot.instances.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(instance => instanceSummary(this.withAuth(instance, passwords.has(instance.name))))
    return {
      store: this.storeDisplayPath,
      instances: summaries,
      ...(snapshot.skipped.length === 0 ? {} : { skipped: snapshot.skipped }),
    }
  }

  /** 探测一台设备：认证方式由记录决定，平台未知时先试 POSIX 再试 Windows。 / Probe one device. */
  async probe(args: Record<string, unknown>, signal: AbortSignal): Promise<ProbeResult> {
    const instance = await this.findInstance(requireString(args.name, 'name'))
    const started = Date.now()
    let platform: Platform = instance.platform ?? 'posix'
    let facts: ProbeFacts | undefined
    let stderr = ''
    let message: string | undefined
    let ok = false
    try {
      const first = await this.runProbe(instance, platform, signal)
      facts = first.facts
      stderr = first.stderr
      if (!probeUsable(facts)) {
        const other: Platform = platform === 'posix' ? 'windows' : 'posix'
        const second = await this.runProbe(instance, other, signal)
        if (probeUsable(second.facts) || second.facts?.platform !== undefined) {
          facts = second.facts
          stderr = second.stderr
          platform = second.platform
        }
      }
      platform = facts?.platform ?? platform
      ok = probeUsable(facts)
      if (!ok) message = stderr || 'the remote device reported no dsh version'
      else if (facts?.profile === 'missing') message = `the remote device has no profile "${instance.profile}"; create it there or register another profile`
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
    const stored = await this.recordProbe(instance, probe, platform)
    return {
      instance: instanceSummary(this.withAuth(stored, await this.hasPassword(stored.name))),
      ok,
      platform,
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

  /** 新增或替换一台设备；`password` 只写进密码文件。 / Add or replace one device; `password` only reaches the password file. */
  async add(args: Record<string, unknown>, options: ExecuteOptions): Promise<{ instance: ReturnType<typeof instanceSummary>; replaced: boolean; auth: 'password' | 'key' }> {
    const host = typeof args.host === 'string' ? args.host : ''
    const name = typeof args.name === 'string' && args.name ? args.name : deriveInstanceName(host)
    const snapshot = await this.load()
    const existing = snapshot.instances.get(name)
    await this.authorize(args, options)
    const password = args.password === undefined ? undefined : assertSecret(args.password)
    const auth: 'password' | 'key' = password !== undefined ? 'password' : existing?.auth ?? 'key'
    const instance = validateInstance(
      {
        name,
        host,
        user: args.user,
        port: args.port,
        identityFile: args.identityFile,
        proxyJump: args.proxyJump,
        profile: args.profile,
        dsh: args.dsh,
        shell: args.shell,
        cwd: args.cwd,
        note: args.note,
        auth,
        platform: existing?.platform,
      },
      { existing },
    )
    if (password !== undefined) await this.secrets.set(instance.name, password)
    await this.store.update(instances => { instances.set(instance.name, instance) })
    return { instance: instanceSummary(this.withAuth(instance, password !== undefined || await this.hasPassword(instance.name))), replaced: existing !== undefined, auth }
  }

  /** 移除一台设备及其保存的密码。 / Remove one device and its stored password. */
  async remove(args: Record<string, unknown>, options: ExecuteOptions): Promise<{ removed: string; existed: boolean }> {
    const name = requireString(args.name, 'name')
    await this.authorize(args, options)
    let existed = false
    await this.store.update(instances => {
      existed = instances.delete(name)
    })
    await this.secrets.delete(name)
    return { removed: name, existed }
  }

  /** 把一次任务派发给远端 DSH agent，作为本会话的并行后台作业。 / Dispatch one task as a parallel background job. */
  async ask(args: Record<string, unknown>, options: ExecuteOptions): Promise<{ jobId: string; instance: string; status: 'running'; platform: Platform; sessionId?: string }> {
    const agent = this.requireAgent(options.agent)
    const instance = await this.findInstance(requireString(args.name, 'name'))
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    if (!prompt.trim()) throw new Error('prompt is required')
    if (prompt.length > MAX_PROMPT) throw new Error(`prompt is too large (max ${MAX_PROMPT} characters)`)
    const sessionId = args.sessionId === undefined ? undefined : String(args.sessionId)
    const platform: Platform = instance.platform ?? 'posix'
    const command = taskCommand(instance, platform, sessionId)
    await this.authorize(args, options)
    if ((instance.auth ?? 'key') === 'password' && !(await this.hasPassword(instance.name))) {
      throw new Error(`remote instance "${instance.name}" needs a password; re-add it with the password field`)
    }
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
            const result = await this.exec(instance, command, {
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
              platform,
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
            this.remember(job.id, { instance: instance.name, platform, status: killed ? 'killed' : 'failed', answer: '', error: message })
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
    return { jobId, instance: instance.name, status: 'running', platform, ...(sessionId === undefined ? {} : { sessionId }) }
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

  /** 停止全部在跑任务、清理 askpass 临时目录并等待进程退出。 / Stop live work and clean the askpass directory. */
  async dispose(): Promise<void> {
    this.sealed = true
    this.lifetime.abort(new Error('Remote instance plugin unloaded'))
    for (const [id, owner] of this.ownedJobs) {
      try { this.ctx.jobs.kill(id, owner, 'Remote instance plugin unloaded') } catch { /* Agent disposal may have removed it already. / Agent 释放可能已移除。 */ }
    }
    for (const child of this.active) child.terminate()
    await Promise.allSettled([...this.pending, ...[...this.active].map(child => child.waitForExit())])
    if (this.askpassDirectory !== undefined) await rm(this.askpassDirectory, { recursive: true, force: true })
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

  private withAuth(instance: RemoteInstance, hasPassword: boolean): RemoteInstance {
    const auth: 'password' | 'key' = instance.auth ?? (hasPassword ? 'password' : 'key')
    return { ...instance, auth }
  }

  private async hasPassword(name: string): Promise<boolean> {
    return (await this.secrets.get(name)) !== undefined
  }

  private async recordProbe(instance: RemoteInstance, probe: ProbeRecord, platform: Platform): Promise<RemoteInstance> {
    const updated: RemoteInstance = { ...instance, lastProbe: probe, platform }
    await this.store.update(instances => {
      if (instances.has(instance.name)) instances.set(instance.name, updated)
    })
    return updated
  }

  /** 用实例自己的认证方式跑一次探测。 / Run one probe with the instance's own authentication. */
  private async runProbe(instance: RemoteInstance, platform: Platform, signal: AbortSignal): Promise<{ facts?: ProbeFacts; stderr: string; platform: Platform }> {
    const result = await this.exec(instance, probeCommand(instance, platform), {
      signal,
      timeoutMs: this.settings.probeTimeoutMs,
    })
    const facts = parseProbeOutput(result.stdout)
    return { facts, stderr: result.stderr.trim().slice(-4_000), platform: facts.platform ?? platform }
  }

  /** 统一执行：按认证方式注入 askpass，密码只出现在环境里。 / Every run: askpass is injected per authentication mode, password only in the environment. */
  private async exec(
    instance: RemoteInstance,
    command: string,
    options: { signal: AbortSignal; stdin?: string; timeoutMs: number; onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void },
  ) {
    const auth = instance.auth ?? 'key'
    const argv = sshArgv(sshTargetOf(instance), command, { connectTimeoutMs: this.settings.connectTimeoutMs, auth })
    let env: Record<string, string> | undefined
    if (auth === 'password') {
      const password = await this.secrets.get(instance.name)
      if (password === undefined) throw new Error(`remote instance "${instance.name}" needs a password; re-add it with the password field`)
      env = { ...askpassEnv(await this.askpassHelper()), DSH_REMOTE_PASSWORD: password }
    }
    return this.runner(argv, { ...options, ...(env === undefined ? {} : { env }) })
  }

  /** 惰性创建 0700 的 askpass 助手；Windows 宿主没有可用的 askpass。 / Lazily create the 0700 askpass helper. */
  private async askpassHelper(): Promise<string> {
    if (process.platform === 'win32') throw new Error('password authentication needs a POSIX ssh client; on a Windows host use a key instead')
    if (this.askpassPath !== undefined) return this.askpassPath
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ri-askpass-'))
    await chmod(directory, 0o700)
    const file = join(directory, 'askpass.sh')
    await writeFile(file, ASKPASS_SCRIPT, { mode: 0o700 })
    await chmod(file, 0o700)
    this.askpassDirectory = directory
    this.askpassPath = file
    return file
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
