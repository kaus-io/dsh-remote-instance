/**
 * 桥接客户端：经 SSH 隧道访问对端插件起的 `/v1/*` 服务。
 * 隧道只绑本机回环；token 与端口由对端的描述文件提供，读一次即缓存。
 *
 * Bridge client: reach the peer plugin's `/v1/*` service through an SSH tunnel.
 * The tunnel binds loopback only; the peer's descriptor file supplies the port
 * and token, read once and cached.
 */
import { createServer } from 'node:net'
import { shellQuote } from './shell.js'

/** 对端描述文件内容。 / The peer descriptor. */
export interface BridgeDescriptor {
  readonly port: number
  readonly token: string
}

/** 一次 ssh 命令的执行结果。 / One ssh command result. */
export interface BridgeResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** 执行一次 ssh（用于读描述文件）。 / Run one ssh command (descriptor read). */
export type BridgeExec = (argv: readonly string[]) => Promise<BridgeResult>

/** 起一个长驻 ssh 隧道。 / Start a long-lived ssh tunnel. */
export type BridgeSpawn = (argv: readonly string[]) => { kill(): void }

/** 客户端选项。 / Client options. */
export interface BridgeClientOptions {
  readonly exec: BridgeExec
  readonly spawn: BridgeSpawn
  /** 读远端文件的 argv。 / argv that reads a remote file. */
  readonly commandArgv: (command: string) => readonly string[]
  /** 建隧道的 argv。 / argv that opens the tunnel. */
  readonly tunnelArgv: (forward: { readonly localPort: number; readonly remotePort: number }) => readonly string[]
  /** 远端描述文件路径。 / Remote descriptor path. */
  readonly descriptorPath?: string
  /** 直接给出一条读描述文件的远端命令（跨平台时用）。 / A ready-made remote command that prints the descriptor. */
  readonly descriptorCommand?: string
  /** 隧道就绪等待上限，默认 10s。 / Tunnel readiness ceiling; 10s by default. */
  readonly openTimeoutMs?: number
  /** 便于测试的 fetch 替身。 / Injectable fetch for tests. */
  readonly fetchImpl?: typeof fetch
}

/** 一个新的本地端口。 / A fresh local port. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (port === 0) throw new Error('could not reserve a local port')
  return port
}

function parseDescriptor(text: string): BridgeDescriptor {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('the peer bridge descriptor is not JSON')
  }
  if (!value || typeof value !== 'object') throw new Error('the peer bridge descriptor is empty')
  const record = value as Record<string, unknown>
  const port = record.port
  const token = record.token
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535) throw new Error('the peer bridge descriptor has no valid port')
  if (typeof token !== 'string' || token.length < 16) throw new Error('the peer bridge descriptor has no valid token')
  return { port: port as number, token }
}

/** 一个对端连接。 / One peer connection. */
export class BridgeClient {
  readonly #options: BridgeClientOptions
  #descriptor: BridgeDescriptor | undefined
  #tunnel: { kill(): void } | undefined
  #localPort = 0

  constructor(options: BridgeClientOptions) {
    this.#options = options
  }

  /** 读对端的端口与 token。 / Read the peer's port and token. */
  async discover(): Promise<BridgeDescriptor> {
    if (this.#descriptor) return this.#descriptor
    const command = this.#options.descriptorCommand
      ?? (this.#options.descriptorPath === undefined ? undefined : `cat ${shellQuote(this.#options.descriptorPath)}`)
    if (command === undefined) throw new Error('bridge descriptor path is not configured')
    const result = await this.#options.exec(this.#options.commandArgv(command))
    if (result.exitCode !== 0) {
      throw new Error(`cannot read the peer bridge descriptor: ${(result.stderr || result.stdout).trim().slice(0, 300) || `exit ${String(result.exitCode)}`}`)
    }
    const descriptor = parseDescriptor(result.stdout)
    this.#descriptor = descriptor
    return descriptor
  }

  /** 建隧道并返回本地端口。 / Open the tunnel and return its local port. */
  async open(): Promise<number> {
    if (this.#localPort > 0) return this.#localPort
    const descriptor = await this.discover()
    const localPort = await freePort()
    const tunnel = this.#options.spawn(this.#options.tunnelArgv({ localPort, remotePort: descriptor.port }))
    this.#tunnel = tunnel
    this.#localPort = localPort
    const deadline = Date.now() + (this.#options.openTimeoutMs ?? 10_000)
    while (Date.now() < deadline) {
      try {
        await this.#request('/v1/info')
        return localPort
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await this.close()
    throw new Error(`the ssh tunnel to the peer bridge did not become ready within ${String(this.#options.openTimeoutMs ?? 10_000)}ms`)
  }

  /** 调用一个桥接端点。 / Call one bridge endpoint. */
  async call<T>(path: string, init?: { readonly method?: 'GET' | 'POST'; readonly body?: unknown }): Promise<T> {
    const localPort = await this.open()
    if (this.#localPort !== localPort) throw new Error('bridge tunnel is not open')
    return (await this.#request(path, init)) as T
  }

  /** 关闭隧道。 / Close the tunnel. */
  async close(): Promise<void> {
    const tunnel = this.#tunnel
    this.#tunnel = undefined
    this.#localPort = 0
    if (tunnel !== undefined) {
      try { tunnel.kill() } catch { /* already gone / 已经退出。 */ }
    }
  }

  async #request(path: string, init?: { readonly method?: 'GET' | 'POST'; readonly body?: unknown }): Promise<unknown> {
    const descriptor = this.#descriptor
    if (!descriptor) throw new Error('bridge is not discovered')
    if (this.#localPort === 0) throw new Error('bridge tunnel is not open')
    const fetchImpl = this.#options.fetchImpl ?? fetch
    const response = await fetchImpl(`http://127.0.0.1:${String(this.#localPort)}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    let value: unknown
    try {
      value = text ? JSON.parse(text) : undefined
    } catch {
      throw new Error(`the peer bridge returned non-JSON (${String(response.status)})`)
    }
    if (!response.ok) {
      const message = value && typeof value === 'object' && typeof (value as Record<string, unknown>).error === 'string'
        ? (value as Record<string, unknown>).error as string
        : `HTTP ${String(response.status)}`
      throw new Error(`peer bridge: ${message}`)
    }
    return value
  }
}
