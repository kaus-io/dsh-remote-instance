/**
 * SSH 命令行与转义：任务正文只经 stdin 传输，值一律 POSIX 单引号转义后交给远端 shell。
 * 密码认证走 `SSH_ASKPASS`（密码只出现在子进程环境里，绝不进 argv、日志或作业输出）。
 *
 * SSH argv and quoting: a task body only travels over stdin, and every value is
 * POSIX single-quote escaped for the remote shell. Password authentication uses
 * `SSH_ASKPASS`, so the password lives only in the child environment and never
 * in argv, a log, or job output.
 */
import type { RemoteInstance } from './instances.js'

const CONTROL = /[\u0000-\u001f\u007f]/

/** 一次 ssh 调用需要的连接参数。 / Connection parameters one ssh call needs. */
export interface SshTarget {
  readonly host: string
  readonly user?: string
  readonly port?: number
  readonly identityFile?: string
  readonly proxyJump?: string
}

/** 认证方式。 / Authentication mode. */
export type AuthMode = 'password' | 'key'

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
 * 构造 ssh argv。密钥模式保持批处理、绝不提示；密码模式允许一次交互，由 askpass 回答，
 * 两种模式都只接受首次出现的主机指纹（`accept-new`），指纹变化仍然失败。
 *
 * Build the ssh argv. Key mode stays non-interactive; password mode permits one
 * prompt answered by askpass. Both accept only a first-seen host key
 * (`accept-new`); a changed key still fails.
 */
export function sshArgv(target: SshTarget, remoteCommand: string, options: { readonly connectTimeoutMs: number; readonly auth?: AuthMode }): string[] {
  if (typeof remoteCommand !== 'string' || remoteCommand.includes('\0')) throw new Error('remote command must be a string without NUL characters')
  if (!target.host) throw new Error('host is required')
  if (target.host.startsWith('-')) throw new Error('host must not start with -')
  const argv = sshBaseArgv(target, options)
  argv.push('--', target.host, remoteCommand)
  return argv
}

/** 建隧道用的 ssh argv：只转发端口，不执行远端命令。 / ssh argv for a port-forward-only tunnel. */
export function sshForwardArgv(
  target: SshTarget,
  options: { readonly localPort: number; readonly remotePort: number; readonly connectTimeoutMs: number; readonly auth?: AuthMode },
): string[] {
  if (!target.host) throw new Error('host is required')
  if (!Number.isSafeInteger(options.localPort) || options.localPort < 1 || options.localPort > 65_535) throw new Error('local port must be 1-65535')
  if (!Number.isSafeInteger(options.remotePort) || options.remotePort < 1 || options.remotePort > 65_535) throw new Error('remote port must be 1-65535')
  const argv = sshBaseArgv(target, options)
  argv.push('-N', '-L', `127.0.0.1:${options.localPort}:127.0.0.1:${options.remotePort}`)
  argv.push('--', target.host)
  return argv
}

/** 两种 ssh 调用共用的选项。 / Options shared by both ssh invocations. */
function sshBaseArgv(target: SshTarget, options: { readonly connectTimeoutMs: number; readonly auth?: AuthMode }): string[] {
  const auth: AuthMode = options.auth ?? 'key'
  const argv = [
    'ssh',
    '-T',
    '-o', 'LogLevel=ERROR',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.max(1, Math.ceil(options.connectTimeoutMs / 1000))}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
  ]
  if (auth === 'password') {
    argv.push('-o', 'BatchMode=no', '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1')
  } else {
    argv.push('-o', 'BatchMode=yes')
  }
  if (target.port !== undefined) argv.push('-p', String(target.port))
  if (target.identityFile) argv.push('-i', assertPlain(target.identityFile, 'identityFile'))
  if (target.proxyJump) argv.push('-J', assertPlain(target.proxyJump, 'proxyJump'))
  if (target.user) argv.push('-l', assertPlain(target.user, 'user'))
  return argv
}

/** 探测结果。 / Parsed probe facts. */
export interface ProbeFacts {
  readonly version?: string
  readonly os?: string
  readonly dshPath?: string
  readonly dshHome?: string
  readonly cwd?: string
  readonly profile?: string
  readonly platform?: 'posix' | 'windows'
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
  const platform = facts.platform === 'windows' ? 'windows' : facts.platform === 'posix' ? 'posix' : undefined
  return {
    ...(facts.version === undefined ? {} : { version: facts.version }),
    ...(facts.os === undefined ? {} : { os: facts.os }),
    ...(facts.path === undefined ? {} : { dshPath: facts.path }),
    ...(facts.home === undefined ? {} : { dshHome: facts.home }),
    ...(facts.cwd === undefined ? {} : { cwd: facts.cwd }),
    ...(facts.profile === undefined ? {} : { profile: facts.profile }),
    ...(platform === undefined ? {} : { platform }),
  }
}

/** askpass 助手脚本内容：只打印环境里的密码。 / askpass helper body: print the password from the environment only. */
export const ASKPASS_SCRIPT = '#!/bin/sh\nprintf \'%s\\n\' "${DSH_REMOTE_PASSWORD-}"\n'

/** askpass 环境；密码本身由调用方另行注入 `DSH_REMOTE_PASSWORD`。 / askpass environment; the caller injects the password separately. */
export function askpassEnv(helperPath: string): Record<string, string> {
  return {
    SSH_ASKPASS: helperPath,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: ':0',
  }
}
