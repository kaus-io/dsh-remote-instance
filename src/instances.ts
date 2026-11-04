/**
 * 远程实例清单：严格校验每个字段、原子写入 `$DSH_HOME` 下的 JSON，并把记录投影成模型/界面可读的摘要。
 * The device list: strict per-field validation, atomic JSON writes under
 * `$DSH_HOME`, and projections the model and the Settings panel can read.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 实例名：小写开头，允许 `-`/`_`，最长 32。 / Instance name: lowercase start, `-`/`_` allowed, max 32. */
export const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
/** 远程路径/可执行文件可接受的字符；不允许空白以外的控制字符。 / Characters accepted for remote paths and executables. */
const PLAIN_TEXT = /[\u0000-\u001f\u007f]/
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
const JUMP_PATTERN = /^[A-Za-z0-9._:@-]{1,512}$/
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const EXECUTABLE_PATTERN = /^[A-Za-z0-9._~/-]{1,1024}$/
const ABSOLUTE_REMOTE = /^(?:\/|~\/)/
const MAX_NOTE = 500

/** 最近一次探测的可缓存结论。 / The cached verdict of the latest probe. */
export interface ProbeRecord {
  readonly at: number
  readonly ok: boolean
  readonly version?: string
  readonly os?: string
  readonly message?: string
}

/** 一台被管理的远程设备：全部字段都是连接参数，从不存放密码或私钥内容。 / One managed device; connection parameters only, never a password or key body. */
export interface RemoteInstance {
  readonly name: string
  readonly host: string
  readonly user?: string
  readonly port?: number
  readonly identityFile?: string
  readonly proxyJump?: string
  readonly profile: string
  readonly dsh: string
  /** 登录 shell 名；空串表示直接执行，不套 `-lc`。 / Login shell name; an empty string runs the command directly. */
  readonly shell: string
  readonly cwd?: string
  readonly note?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastProbe?: ProbeRecord
}

/** 模型/界面看到的实例摘要。 / The instance summary the model and the panel see. */
export interface InstanceSummary {
  readonly name: string
  readonly target: string
  readonly host: string
  readonly user?: string
  readonly port?: number
  readonly identityFile?: string
  readonly proxyJump?: string
  readonly profile: string
  readonly dsh: string
  readonly shell: string
  readonly cwd?: string
  readonly note?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastProbe?: ProbeRecord
}

function assertString(value: unknown, field: string, pattern: RegExp, hint: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  const text = value.trim()
  if (text.length > 1024 || PLAIN_TEXT.test(text)) throw new Error(`${field} contains characters that are not allowed`)
  if (!pattern.test(text)) throw new Error(`${field} is invalid: ${hint}`)
  return text
}

function optionalString(value: unknown, field: string, pattern: RegExp, hint: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return assertString(value, field, pattern, hint)
}

/** `user@host:port` 形式的目标展示。 / Target display in `user@host:port` form. */
export function displayTarget(instance: Pick<RemoteInstance, 'host' | 'user' | 'port'>): string {
  return `${instance.user ? `${instance.user}@` : ''}${instance.host}${instance.port ? `:${instance.port}` : ''}`
}

/**
 * 校验一条实例输入；`existing` 保留创建时间与上次探测记录。
 * Validate one instance input; `existing` keeps the creation time and probe record.
 */
export function validateInstance(input: unknown, options: { readonly now?: number; readonly existing?: RemoteInstance } = {}): RemoteInstance {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('An instance must be an object')
  const source = input as Record<string, unknown>
  const now = options.now ?? Date.now()
  const name = assertString(source.name, 'name', NAME_PATTERN, 'start with a lowercase letter and use a-z, 0-9, - or _ (max 32)')
  const host = assertString(source.host, 'host', HOST_PATTERN, 'use a hostname, IP address, or ssh config alias')
  const port = source.port === undefined || source.port === null ? undefined : source.port
  if (port !== undefined && (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535)) throw new Error('port must be an integer in [1, 65535]')
  const identityFile = optionalString(source.identityFile, 'identityFile', EXECUTABLE_PATTERN, 'use an absolute path without spaces')
  if (identityFile !== undefined && !identityFile.startsWith('/') && !identityFile.startsWith('~/')) throw new Error('identityFile must be an absolute path or start with ~/')
  const dsh = source.dsh === undefined || source.dsh === null || source.dsh === '' ? 'dsh' : assertString(source.dsh, 'dsh', EXECUTABLE_PATTERN, 'use a bare name or an absolute path')
  if (dsh.startsWith('-')) throw new Error('dsh must not start with -')
  const shell = source.shell === undefined || source.shell === null ? 'bash' : String(source.shell).trim()
  if (shell !== '' && !EXECUTABLE_PATTERN.test(shell)) throw new Error('shell must be a shell name such as bash, or an empty string to disable the wrapper')
  if (shell.startsWith('-')) throw new Error('shell must not start with -')
  const profile = source.profile === undefined || source.profile === null || source.profile === '' ? 'headless' : assertString(source.profile, 'profile', PROFILE_PATTERN, 'use a lowercase dsh profile name such as headless or sdk')
  const proxyJump = optionalString(source.proxyJump, 'proxyJump', JUMP_PATTERN, 'use [user@]host[:port]')
  const cwd = optionalString(source.cwd, 'cwd', ABSOLUTE_REMOTE, 'use an absolute path or a ~/ path')
  let note: string | undefined
  if (source.note !== undefined && source.note !== null && source.note !== '') {
    if (typeof source.note !== 'string' || source.note.length > MAX_NOTE || PLAIN_TEXT.test(source.note)) throw new Error('note must be a short string without control characters')
    note = source.note.trim()
  }
  const instance: RemoteInstance = {
    name,
    host,
    ...(source.user === undefined || source.user === null || source.user === '' ? {} : { user: assertString(source.user, 'user', USER_PATTERN, 'use a login name such as alice') }),
    ...(port === undefined ? {} : { port: port as number }),
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(proxyJump === undefined ? {} : { proxyJump }),
    profile,
    dsh,
    shell,
    ...(cwd === undefined ? {} : { cwd }),
    ...(note === undefined ? {} : { note }),
    createdAt: options.existing?.createdAt ?? now,
    updatedAt: now,
    ...(options.existing?.lastProbe === undefined ? {} : { lastProbe: options.existing.lastProbe }),
  }
  return instance
}

/** 把记录投影成摘要。 / Project one record into a summary. */
export function instanceSummary(instance: RemoteInstance): InstanceSummary {
  return {
    name: instance.name,
    target: displayTarget(instance),
    host: instance.host,
    ...(instance.user === undefined ? {} : { user: instance.user }),
    ...(instance.port === undefined ? {} : { port: instance.port }),
    ...(instance.identityFile === undefined ? {} : { identityFile: instance.identityFile }),
    ...(instance.proxyJump === undefined ? {} : { proxyJump: instance.proxyJump }),
    profile: instance.profile,
    dsh: instance.dsh,
    shell: instance.shell,
    ...(instance.cwd === undefined ? {} : { cwd: instance.cwd }),
    ...(instance.note === undefined ? {} : { note: instance.note }),
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    ...(instance.lastProbe === undefined ? {} : { lastProbe: instance.lastProbe }),
  }
}

/** 校验并还原一条已持久化记录：保留创建时间与上次探测，忽略多余字段。 / Restore a stored record, keeping its timestamps and probe. */
export function restoreInstance(input: unknown, options: { readonly now?: number } = {}): RemoteInstance {
  const now = options.now ?? Date.now()
  const instance = validateInstance(input, { now })
  const source = input as Record<string, unknown>
  const createdAt = Number.isSafeInteger(source.createdAt) ? (source.createdAt as number) : now
  const updatedAt = Number.isSafeInteger(source.updatedAt) ? (source.updatedAt as number) : createdAt
  const lastProbe = readProbe(source.lastProbe)
  return {
    ...instance,
    createdAt,
    updatedAt,
    ...(lastProbe === undefined ? {} : { lastProbe }),
  }
}

/** 读取一条探测结论；结构不合法就当没有。 / Read one probe verdict; a malformed one counts as absent. */
function readProbe(value: unknown): ProbeRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (typeof source.ok !== 'boolean' || !Number.isSafeInteger(source.at)) return undefined
  const text = (candidate: unknown): string | undefined => {
    if (typeof candidate !== 'string' || !candidate || PLAIN_TEXT.test(candidate)) return undefined
    return candidate.slice(0, 500)
  }
  return {
    at: source.at as number,
    ok: source.ok,
    ...(text(source.version) === undefined ? {} : { version: text(source.version) }),
    ...(text(source.os) === undefined ? {} : { os: text(source.os) }),
    ...(text(source.message) === undefined ? {} : { message: text(source.message) }),
  }
}

/** 清单快照：内存记录、文件是否存在、被丢弃的条目名。 / Snapshot: records, file existence, dropped entries. */
export interface StoreSnapshot {
  readonly instances: Map<string, RemoteInstance>
  readonly exists: boolean
  readonly skipped: readonly string[]
}

/**
 * 设备清单文件。写入串行化，先写临时文件再 rename，权限收紧到 0600。
 * The device-list file. Writes are serialized, land through a temporary file
 * plus rename, and use 0600 permissions.
 */
export class InstanceStore {
  private readonly file: string
  private readonly now: () => number
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: { readonly file: string; readonly now?: () => number }) {
    this.file = options.file
    this.now = options.now ?? Date.now
  }

  /** 清单文件路径。 / The list file path. */
  get path(): string {
    return this.file
  }

  /** 读取清单；文件缺失视为空清单，损坏则抛错而不是静默清空。 / Read the list; a missing file is empty, a broken one throws. */
  async load(): Promise<StoreSnapshot> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { instances: new Map(), exists: false, skipped: [] }
      throw new Error(`Cannot read the remote instance list: ${(error as Error).message}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('The remote instance list is not valid JSON; fix or delete it before retrying')
    }
    const rows = parsed && typeof parsed === 'object' && Array.isArray((parsed as { instances?: unknown }).instances)
      ? ((parsed as { instances: unknown[] }).instances)
      : undefined
    if (!rows) throw new Error('The remote instance list has no `instances` array')
    const instances = new Map<string, RemoteInstance>()
    const skipped: string[] = []
    for (const row of rows) {
      try {
        const instance = restoreInstance(row, { now: this.now() })
        instances.set(instance.name, instance)
      } catch (error) {
        const name = row && typeof row === 'object' && typeof (row as { name?: unknown }).name === 'string' ? (row as { name: string }).name.slice(0, 64) : 'unknown'
        skipped.push(`${name}: ${(error as Error).message}`)
      }
    }
    return { instances, exists: true, skipped }
  }

  /** 原子写回整份清单。 / Atomically write the whole list back. */
  async save(instances: ReadonlyMap<string, RemoteInstance>): Promise<void> {
    await this.serialize(() => this.writeNow(instances))
  }

  /** 串行执行一次读改写；写入不会再次排队，避免自锁。 / Run one read-modify-write; the write does not requeue. */
  async update(mutate: (instances: Map<string, RemoteInstance>) => void | Promise<void>): Promise<StoreSnapshot & { changed: boolean }> {
    return this.serialize(async () => {
      const snapshot = await this.load()
      const before = JSON.stringify([...snapshot.instances.values()])
      await mutate(snapshot.instances)
      const after = JSON.stringify([...snapshot.instances.values()])
      const changed = before !== after
      if (changed) await this.writeNow(snapshot.instances)
      return { ...snapshot, changed }
    })
  }

  private async writeNow(instances: ReadonlyMap<string, RemoteInstance>): Promise<void> {
    const body = JSON.stringify({ version: 1, instances: [...instances.values()] }, null, 2) + '\n'
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.file)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => undefined)
    return next
  }
}
