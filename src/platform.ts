/**
 * 远端平台相关的命令构造：POSIX（Linux/macOS/Git Bash）与 Windows（PowerShell，base64 编码避免任何引号歧义）。
 * Remote-platform command building: POSIX (Linux/macOS/Git Bash) and Windows
 * (PowerShell, base64 encoded so no quoting ambiguity exists).
 */
import { shellQuote } from './shell.js'

/** 已探知的远端平台。 / Detected remote platform. */
export type Platform = 'posix' | 'windows'

/** 构造远端命令所需的实例字段。 / Instance fields a remote command needs. */
export interface CommandInstance {
  readonly profile: string
  readonly dsh: string
  readonly shell: string
  readonly cwd?: string
}

/** PowerShell 单引号字符串；内部单引号翻倍。 / PowerShell single-quoted literal; inner quotes double. */
export function psQuote(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('value must be a string without NUL characters')
  return `'${value.replace(/'/g, "''")}'`
}

/** 把 PowerShell 脚本编码成 `-EncodedCommand` 需要的 UTF-16LE base64。 / Encode a PowerShell script for `-EncodedCommand`. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** 完整的 PowerShell 调用命令；只含 ASCII，安全穿过 cmd 与 POSIX 登录 shell。 / The whole PowerShell invocation; ASCII only. */
export function powershellCommand(script: string): string {
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(script)}`
}

/** 会话 id 只允许安全字符；无效时在拼命令前失败。 / Session ids are restricted before any command exists. */
function requireSessionId(sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('sessionId may only contain A-Za-z0-9, _ and -')
  return sessionId
}

/** POSIX 内层脚本：进入工作目录后 exec 远端 dsh。 / POSIX inner script: enter the working directory, then exec dsh. */
export function posixTaskScript(instance: CommandInstance, sessionId?: string): string {
  const steps: string[] = []
  if (instance.cwd) steps.push(`cd -- ${shellQuote(instance.cwd)}`)
  const argv = [instance.dsh, '--profile', instance.profile, '--json']
  const id = requireSessionId(sessionId)
  if (id !== undefined) argv.push('--session-id', id)
  steps.push(`exec ${argv.map(value => shellQuote(value)).join(' ')}`)
  return steps.join(' && ')
}

/** POSIX 任务命令：按需套登录 shell。 / POSIX task command, optionally wrapped in the login shell. */
export function posixTaskCommand(instance: CommandInstance, sessionId?: string): string {
  const script = posixTaskScript(instance, sessionId)
  if (!instance.shell) return script
  return `${shellQuote(instance.shell)} -lc ${shellQuote(script)}`
}

/** POSIX 探测脚本：只读、固定内容。 / Read-only fixed POSIX probe. */
export function posixProbeScript(instance: CommandInstance): string {
  const dsh = shellQuote(instance.dsh)
  return [
    'home="${DSH_HOME:-$HOME/.dsh}"',
    `printf 'probe\\tversion\\t%s\\n' "$(${dsh} --version 2>&1 | head -n 1)"`,
    `printf 'probe\\tos\\t%s\\n' "$(uname -srm 2>&1)"`,
    `printf 'probe\\tpath\\t%s\\n' "$(command -v ${dsh} 2>/dev/null || printf missing)"`,
    `printf 'probe\\thome\\t%s\\n' "$home"`,
    `printf 'probe\\tcwd\\t%s\\n' "$(pwd)"`,
    `printf 'probe\\tprofile\\t%s\\n' "$([ -f "$home/profiles/${instance.profile}/package.json" ] && printf present || printf missing)"`,
    'printf \'probe\\tplatform\\tposix\\n\'',
  ].join('\n')
}

/** POSIX 探测命令。 / POSIX probe command. */
export function posixProbeCommand(instance: CommandInstance): string {
  const script = posixProbeScript(instance)
  if (!instance.shell) return script
  return `${shellQuote(instance.shell)} -lc ${shellQuote(script)}`
}

/** Windows 探测脚本；输出与 POSIX 相同的 `probe<TAB>key<TAB>value` 行。 / Windows probe emitting the same lines. */
export function windowsProbeScript(instance: CommandInstance): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$t = [char]9',
    `$dsh = ${psQuote(instance.dsh)}`,
    "if ($env:DSH_HOME) { $home = $env:DSH_HOME } else { $home = Join-Path $env:USERPROFILE '.dsh' }",
    '$cmd = Get-Command $dsh | Select-Object -First 1',
    `"probe\${t}version\${t}$(& $dsh --version 2>&1 | Select-Object -First 1)"`,
    `"probe\${t}os\${t}$([Environment]::OSVersion.VersionString)"`,
    `"probe\${t}path\${t}$(if ($cmd) { $cmd.Source } else { 'missing' })"`,
    `"probe\${t}home\${t}$home"`,
    `"probe\${t}cwd\${t}$((Get-Location).Path)"`,
    `"probe\${t}profile\${t}$(if (Test-Path (Join-Path $home 'profiles/${instance.profile}/package.json')) { 'present' } else { 'missing' })"`,
    `"probe\${t}platform\${t}windows"`,
  ].join('\n')
}

/** Windows 探测命令。 / Windows probe command. */
export function windowsProbeCommand(instance: CommandInstance): string {
  return powershellCommand(windowsProbeScript(instance))
}

/** Windows 任务脚本：切目录后调用 dsh，并把退出码透传出去。 / Windows task script, forwarding dsh's exit code. */
export function windowsTaskScript(instance: CommandInstance, sessionId?: string): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  ]
  if (instance.cwd) lines.push(`Set-Location -LiteralPath ${psQuote(instance.cwd)}`)
  const args = [instance.dsh, '--profile', instance.profile, '--json']
  const id = requireSessionId(sessionId)
  if (id !== undefined) args.push('--session-id', id)
  lines.push(`& ${args.map(psQuote).join(' ')}`)
  lines.push('if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }')
  return lines.join('\n')
}

/** Windows 任务命令。 / Windows task command. */
export function windowsTaskCommand(instance: CommandInstance, sessionId?: string): string {
  return powershellCommand(windowsTaskScript(instance, sessionId))
}

/** POSIX 上的 ACP 服务命令：常驻 stdio。 / The ACP stdio server command on POSIX. */
export function posixAcpCommand(instance: CommandInstance): string {
  const steps: string[] = []
  if (instance.cwd) steps.push(`cd -- ${shellQuote(instance.cwd)}`)
  steps.push(`exec ${shellQuote(instance.dsh)} ${shellQuote('--profile')} ${shellQuote('acp')}`)
  const script = steps.join(' && ')
  return instance.shell === '' ? script : `${shellQuote(instance.shell)} -lc ${shellQuote(script)}`
}

/** Windows 上的 ACP 服务命令。 / The ACP stdio server command on Windows. */
export function windowsAcpCommand(instance: CommandInstance): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  ]
  if (instance.cwd) lines.push(`Set-Location -LiteralPath ${psQuote(instance.cwd)}`)
  lines.push(`& ${[instance.dsh, '--profile', 'acp'].map(psQuote).join(' ')}`)
  lines.push('exit $LASTEXITCODE')
  return powershellCommand(lines.join('\n'))
}

/** 按平台构造 ACP 启动命令。 / Build the ACP launch command for one platform. */
export function acpCommand(instance: CommandInstance, platform: Platform): string {
  return platform === 'windows' ? windowsAcpCommand(instance) : posixAcpCommand(instance)
}

/** 按平台构造任务命令。 / Build the task command for one platform. */
export function taskCommand(instance: CommandInstance, platform: Platform, sessionId?: string): string {
  return platform === 'windows' ? windowsTaskCommand(instance, sessionId) : posixTaskCommand(instance, sessionId)
}

/** 按平台构造探测命令。 / Build the probe command for one platform. */
export function probeCommand(instance: CommandInstance, platform: Platform): string {
  return platform === 'windows' ? windowsProbeCommand(instance) : posixProbeCommand(instance)
}
