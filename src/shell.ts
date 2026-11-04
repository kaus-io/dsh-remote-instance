/**
 * SSH 命令行构造：所有值以单引号安全转义后交给远端 POSIX shell，任务正文只经 stdin 传输，绝不拼进命令。
 * SSH command construction: every value is single-quote escaped for the remote
 * POSIX shell, and a task body only ever travels over stdin, never inside the
 * command line.
 */
import type { RemoteInstance } from './instances.js'

const CONTROL = /[\u0000-\u001f\u007f]/

/** `ssh` 需要的连接参数。 / Connection parameters `ssh` needs. */
export interface SshTarget {
  readonly host: string
  readonly user?: string
  readonly port?: number
  readonly identityFile?: string
  readonly proxyJump?: string
}

/** 远程命令需要的实例字段。 / Instance fields a remote command needs. */
export interface RemoteCommandInstance extends SshTarget {
  readonly profile: string
  readonly dsh: string
  readonly shell: string
  readonly cwd?: string
}

/** 远端命令里出现控制字符一律拒绝。 / Reject control characters before they reach a remote command. */
export function assertPlain(value: string, label: string): string {
  if (typeof value !== 'string' || CONTROL.test(value)) throw new Error(`${label} must be a string without control characters`)
  return value
}

/** POSIX 单引号转义；脚本正文允许换行，只拒绝 NUL。 / POSIX single-quote escaping; scripts may span lines, only NUL is rejected. */
export function shellQuote(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('value must be a string without NUL characters')
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 从实例记录取 ssh 目标。 / Project an instance record onto its ssh target. */
export function sshTargetOf(instance: RemoteInstance): SshTarget {
  return {
    host: instance.host,
    ...(instance.user === undefined ? {} : { user: instance.user }),
    ...(instance.port === undefined ? {} : { port: instance.port }),
    ...(instance.identityFile === undefined ? {} : { identityFile: instance.identityFile }),
    ...(instance.proxyJump === undefined ? {} : { proxyJump: instance.proxyJump }),
  }
}

/**
 * 构造 ssh argv：批处理模式禁止任何口令交互，连接超时与保活都有上限；目标之后只追加一条命令。
 * Build the ssh argv: batch mode forbids every password prompt, connect and
 * keepalive are bounded, and exactly one command follows the target.
 */
export function sshArgv(target: SshTarget, remoteCommand: string, options: { readonly connectTimeoutMs: number }): string[] {
  if (typeof remoteCommand !== 'string' || remoteCommand.includes('\0')) throw new Error('remote command must be a string without NUL characters')
  if (!target.host) throw new Error('host is required')
  if (target.host.startsWith('-')) throw new Error('host must not start with -')
  const argv = [
    'ssh',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.max(1, Math.ceil(options.connectTimeoutMs / 1000))}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
  ]
  if (target.port !== undefined) argv.push('-p', String(target.port))
  if (target.identityFile) argv.push('-i', assertPlain(target.identityFile, 'identityFile'))
  if (target.proxyJump) argv.push('-J', assertPlain(target.proxyJump, 'proxyJump'))
  if (target.user) argv.push('-l', assertPlain(target.user, 'user'))
  argv.push('--', target.host, remoteCommand)
  return argv
}

/** 需要时把脚本套进登录 shell，让非交互 ssh 也拿到 nvm 之类的 PATH。 / Wrap a script in the login shell so a non-interactive ssh keeps PATH setup. */
function wrapInShell(instance: RemoteCommandInstance, script: string): string {
  if (instance.shell === '') return script
  return `${shellQuote(instance.shell)} -lc ${shellQuote(script)}`
}

/** 一次远程 DSH 任务的命令：`cd` 到工作目录后以 `--json` 运行指定 profile，任务从 stdin 读入。 / One remote DSH task command. */
export function remoteTaskCommand(instance: RemoteCommandInstance, sessionId?: string): string {
  const steps: string[] = []
  if (instance.cwd) steps.push(`cd -- ${shellQuote(instance.cwd)}`)
  const argv = [instance.dsh, '--profile', instance.profile, '--json']
  if (sessionId !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('sessionId may only contain A-Za-z0-9, _ and -')
    argv.push('--session-id', sessionId)
  }
  steps.push(`exec ${argv.map(value => shellQuote(value)).join(' ')}`)
  return wrapInShell(instance, steps.join(' && '))
}

/** 探测脚本：只读、固定内容，输出 `probe<TAB>key<TAB>value` 行。 / Read-only fixed probe emitting tab-separated facts. */
export function probeScript(instance: RemoteCommandInstance): string {
  const dsh = shellQuote(instance.dsh)
  return [
    'home="${DSH_HOME:-$HOME/.dsh}"',
    `printf 'probe\\tversion\\t%s\\n' "$(${dsh} --version 2>&1 | head -n 1)"`,
    `printf 'probe\\tos\\t%s\\n' "$(uname -srm 2>&1)"`,
    `printf 'probe\\tpath\\t%s\\n' "$(command -v ${dsh} 2>/dev/null || printf missing)"`,
    `printf 'probe\\thome\\t%s\\n' "$home"`,
    `printf 'probe\\tcwd\\t%s\\n' "$(pwd)"`,
    `printf 'probe\\tprofile\\t%s\\n' "$([ -f "$home/profiles/${instance.profile}/package.json" ] && printf present || printf missing)"`,
  ].join('\n')
}

/** 探测命令。 / The probe command. */
export function remoteProbeCommand(instance: RemoteCommandInstance): string {
  return wrapInShell(instance, probeScript(instance))
}

/** 探测结果。 / Parsed probe facts. */
export interface ProbeFacts {
  readonly version?: string
  readonly os?: string
  readonly dshPath?: string
  readonly dshHome?: string
  readonly cwd?: string
  readonly profile?: string
}

/** 解析探测脚本的 `probe<TAB>key<TAB>value` 输出。 / Parse the tab-separated probe output. */
export function parseProbeOutput(stdout: string): ProbeFacts {
  const facts: Record<string, string> = {}
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.startsWith('probe\t')) continue
    const [, key, ...rest] = line.split('\t')
    if (!key || rest.length === 0) continue
    const value = rest.join('\t').trim()
    if (value) facts[key] = value
  }
  return {
    ...(facts.version === undefined ? {} : { version: facts.version }),
    ...(facts.os === undefined ? {} : { os: facts.os }),
    ...(facts.path === undefined ? {} : { dshPath: facts.path }),
    ...(facts.home === undefined ? {} : { dshHome: facts.home }),
    ...(facts.cwd === undefined ? {} : { cwd: facts.cwd }),
    ...(facts.profile === undefined ? {} : { profile: facts.profile }),
  }
}
