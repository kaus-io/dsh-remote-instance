/**
 * 插件配置与 Host 数据目录：插件配置只调参和提供首轮种子，设备清单本身存在 `$DSH_HOME` 下的 JSON 文件里。
 * Plugin configuration and the Host data directory: config only tunes bounds and
 * seeds a fresh device list, while the list itself lives in a JSON file under
 * `$DSH_HOME`.
 */
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { validateInstance } from './instances.js'

/** 插件全部可调值，`apply` 时解析一次。 / Every tunable the plugin resolves once in `apply`. */
export interface ServiceSettings {
  /** 设备清单文件；默认 `$DSH_HOME/remote-instances.json`。 / Device list file; defaults to `$DSH_HOME/remote-instances.json`. */
  readonly storeFile: string
  /** SSH 建连超时；默认 10s。 / SSH connect timeout; 10s by default. */
  readonly connectTimeoutMs: number
  /** 探测总超时；默认 30s。 / Whole-probe timeout; 30s by default. */
  readonly probeTimeoutMs: number
  /** 单个远程任务上限；默认 1h。 / Per-task ceiling; 1h by default. */
  readonly taskTimeoutMs: number
  /** 作业输出保留上限；默认 256 KiB。 / Job output retention; 256 KiB by default. */
  readonly maxOutputBytes: number
  /** 清单文件不存在时写入的首轮设备；默认空。 / Devices seeded when the list file is absent; empty by default. */
  readonly seed: readonly unknown[]
}

const LIMITS = {
  connectTimeoutMs: [1_000, 120_000, 10_000],
  probeTimeoutMs: [1_000, 300_000, 30_000],
  taskTimeoutMs: [10_000, 86_400_000, 3_600_000],
  maxOutputBytes: [4_096, 4_194_304, 262_144],
} as const satisfies Record<string, readonly [number, number, number]>

const KNOWN_KEYS = new Set<string>(['storeFile', ...Object.keys(LIMITS), 'instances'])

/** 展开只针对当前用户 home 的 `~` 前缀；其它形式原样返回。 / Expand a bare or current-user `~`; everything else passes through. */
export function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith(`~${sep}`) || value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** 解析 DSH 数据根：显式 `$DSH_HOME` 优先，否则 `~/.dsh`。 / Resolve the DSH data root: `$DSH_HOME`, else `~/.dsh`. */
export function resolveDshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return normalize(configured ? expandHome(configured) : join(homedir(), '.dsh'))
}

/** 面向界面的路径：home 显示为 `~`，显式配置的数据根显示为 `$DSH_HOME`。 / Symbolic path for display. */
export function displayPath(value: string): string {
  const home = homedir()
  if (value.startsWith(home + sep)) return `~${value.slice(home.length)}`
  const configured = process.env.DSH_HOME?.trim()
  if (configured) {
    const root = normalize(expandHome(configured))
    if (value.startsWith(root + sep)) return `$DSH_HOME${value.slice(root.length)}`
  }
  return value
}

function readInteger(source: Record<string, unknown>, key: keyof typeof LIMITS): number {
  const value = source[key]
  if (value === undefined) return LIMITS[key][2]
  const [minimum, maximum] = LIMITS[key]
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`remote-instance config: ${key} must be an integer in [${minimum}, ${maximum}]`)
  }
  return value as number
}

function readStoreFile(source: Record<string, unknown>): string {
  const value = source.storeFile
  if (value === undefined) return join(resolveDshHome(), 'remote-instances.json')
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('remote-instance config: storeFile must be a non-empty path without control characters')
  }
  const expanded = expandHome(value.trim())
  if (!isAbsolute(expanded)) throw new Error('remote-instance config: storeFile must be absolute or start with ~')
  return normalize(expanded)
}

/**
 * 校验并解析插件配置。未知字段直接拒绝，避免把拼写错误静默当成默认值。
 * Validate and resolve the plugin config. Unknown fields are rejected so a typo
 * never silently becomes a default.
 */
export function resolveSettings(config: unknown): ServiceSettings {
  if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new Error('remote-instance config must be an object')
  }
  const source = (config ?? {}) as Record<string, unknown>
  for (const key of Object.keys(source)) if (!KNOWN_KEYS.has(key)) throw new Error(`remote-instance config: unknown field ${key}`)
  const seed = source.instances
  if (seed !== undefined) {
    if (!Array.isArray(seed)) throw new Error('remote-instance config: instances must be a list')
    if (seed.length > 64) throw new Error('remote-instance config: instances accepts at most 64 entries')
    for (const entry of seed) validateInstance(entry, { now: 0 })
  }
  return {
    storeFile: readStoreFile(source),
    connectTimeoutMs: readInteger(source, 'connectTimeoutMs'),
    probeTimeoutMs: readInteger(source, 'probeTimeoutMs'),
    taskTimeoutMs: readInteger(source, 'taskTimeoutMs'),
    maxOutputBytes: readInteger(source, 'maxOutputBytes'),
    seed: seed === undefined ? [] : (seed as readonly unknown[]),
  }
}
