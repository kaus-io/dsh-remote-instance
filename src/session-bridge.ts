/**
 * 会话桥：把一台设备的会话操作绑到对端插件的 `/v1/*` 服务上。
 * 只依赖 SSH（隧道 + 读描述文件），不再需要远端 `dsh` 命令。
 *
 * Session bridge: bind one device's session operations to the peer plugin's
 * `/v1/*` service. Only SSH is needed — no remote `dsh` command.
 */
import { BridgeClient } from './bridge-client.js'
import type { BridgeResult } from './bridge-client.js'

/** 桥接依赖的 ssh 能力（便于测试注入）。 / SSH abilities the bridge needs (injectable). */
export interface SessionBridgeDeps {
  readonly exec: (argv: readonly string[]) => Promise<BridgeResult>
  readonly spawn: (argv: readonly string[]) => { kill(): void }
  readonly commandArgv: (command: string) => readonly string[]
  readonly tunnelArgv: (forward: { readonly localPort: number; readonly remotePort: number }) => readonly string[]
  /** 便于测试的 fetch 替身。 / Injectable fetch for tests. */
  readonly fetchImpl?: typeof fetch
}

/** 一个会话摘要。 / One session row. */
export interface BridgeSessionRow {
  readonly sessionId: string
  readonly cwd?: string
  readonly updatedAt?: number
  readonly running?: boolean
  readonly blank?: boolean
}

/** 对端信息。 / Peer facts. */
export interface BridgeInfo {
  readonly hostname: string
  readonly platform: 'posix' | 'windows'
  readonly canPrompt: boolean
  readonly dshHome?: string
}

/** 一条历史消息。 / One history message. */
export interface BridgeMessage {
  readonly role: string
  readonly text: string
  readonly at?: number
  readonly status?: string
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/** 一台设备的会话桥。 / The session bridge for one device. */
export class SessionBridge {
  readonly #client: BridgeClient
  #disposed = false

  constructor(descriptorPath: string | undefined, deps: SessionBridgeDeps, descriptorCommand?: string) {
    this.#client = new BridgeClient({
      exec: deps.exec,
      spawn: deps.spawn,
      commandArgv: deps.commandArgv,
      tunnelArgv: deps.tunnelArgv,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(descriptorPath === undefined ? {} : { descriptorPath }),
      ...(descriptorCommand === undefined ? {} : { descriptorCommand }),
    })
  }

  /** 对端身份与能力。 / Peer identity and capabilities. */
  async info(): Promise<BridgeInfo> {
    const value = await this.#client.call<Record<string, unknown>>('/v1/info')
    return {
      hostname: typeof value.hostname === 'string' ? value.hostname : '',
      platform: value.platform === 'windows' ? 'windows' : 'posix',
      canPrompt: value.canPrompt === true,
      ...(typeof value.dshHome === 'string' ? { dshHome: value.dshHome } : {}),
    }
  }

  /** 对端能看到的会话。 / Sessions the peer can see. */
  async sessions(): Promise<BridgeSessionRow[]> {
    const value = await this.#client.call<{ sessions?: unknown }>('/v1/sessions')
    const rows = Array.isArray(value.sessions) ? value.sessions : []
    const out: BridgeSessionRow[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const source = row as Record<string, unknown>
      if (typeof source.sessionId !== 'string' || !SESSION_ID.test(source.sessionId)) continue
      out.push({
        sessionId: source.sessionId,
        ...(typeof source.cwd === 'string' ? { cwd: source.cwd } : {}),
        ...(typeof source.updatedAt === 'number' ? { updatedAt: source.updatedAt } : {}),
        ...(typeof source.running === 'boolean' ? { running: source.running } : {}),
        ...(typeof source.blank === 'boolean' ? { blank: source.blank } : {}),
      })
    }
    return out
  }

  /** 一个会话的历史。 / One session's history. */
  async history(sessionId: string): Promise<{ readonly messages: BridgeMessage[]; readonly source: 'log' | 'empty' }> {
    if (!SESSION_ID.test(sessionId)) throw new Error('invalid session id')
    const value = await this.#client.call<{ messages?: unknown; source?: unknown }>(`/v1/history?sessionId=${encodeURIComponent(sessionId)}`)
    const rows = Array.isArray(value.messages) ? value.messages : []
    const messages: BridgeMessage[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const source = row as Record<string, unknown>
      if (typeof source.role !== 'string' || typeof source.text !== 'string' || !source.text) continue
      messages.push({
        role: source.role,
        text: source.text,
        ...(typeof source.at === 'number' ? { at: source.at } : {}),
        ...(typeof source.status === 'string' ? { status: source.status } : {}),
      })
    }
    return { messages, source: value.source === 'log' ? 'log' : 'empty' }
  }

  /** 发一条消息。 / Send one message. */
  async send(sessionId: string, text: string): Promise<void> {
    if (!SESSION_ID.test(sessionId)) throw new Error('invalid session id')
    if (!text.trim()) throw new Error('text is required')
    await this.#client.call('/v1/prompt', { method: 'POST', body: { sessionId, text } })
  }

  /** 停止当前回合。 / Stop the running turn. */
  async stop(sessionId: string): Promise<void> {
    if (!SESSION_ID.test(sessionId)) throw new Error('invalid session id')
    await this.#client.call('/v1/cancel', { method: 'POST', body: { sessionId } })
  }

  /** 新建一个会话。 / Create a session. */
  async create(cwd?: string): Promise<string> {
    const value = await this.#client.call<{ sessionId?: unknown }>('/v1/create', {
      method: 'POST',
      body: cwd === undefined ? {} : { cwd },
    })
    if (typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)) throw new Error('the peer bridge returned no session id')
    return value.sessionId
  }

  /** 关闭隧道。 / Close the tunnel. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.#client.close()
  }
}
