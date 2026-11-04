/**
 * 桥接服务：在插件所在的 Host 进程里起一个只绑 `127.0.0.1` 的 HTTP 服务，让对端插件经 SSH 隧道调用。
 * 会话能力走公共的 `ctx.sessionController`（list / create / prompt / cancel），历史读本机 `$DSH_HOME/sessions` 日志。
 *
 * The bridge: an HTTP service bound to `127.0.0.1` inside the Host process the
 * plugin runs in, called by the peer plugin over an SSH tunnel. Sessions use the
 * public `ctx.sessionController` (list / create / prompt / cancel); history reads
 * this machine's own `$DSH_HOME/sessions` logs.
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { decompressFrames, parseSessionLog } from './history.js'

/** 会话控制器的最小接口（Host 公共服务）。 / The narrow Host session-controller surface. */
export interface SessionControllerLike {
  list(request: { readonly cursor?: string }, signal?: AbortSignal): Promise<{ readonly items: readonly unknown[] }>
  create(request: { readonly cwd?: string; readonly sessionId?: string }): Promise<{ readonly sessionId: string }>
  prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly content: readonly unknown[]
  }): Promise<{ readonly accepted: true }>
  cancel(request: { readonly sessionId: string }): unknown
}

/** 桥接需要的 Host 面。 / The Host face the bridge needs. */
export interface BridgeHost {
  get(name: string): unknown
  readonly logger?: { warn(message: string): void }
}

/** 桥接配置。 / Bridge options. */
export interface BridgeOptions {
  /** 监听端口；0 表示关闭桥接。 / Listen port; 0 disables the bridge. */
  readonly port: number
  /** token 文件路径；不存在时生成。 / Token file; generated when absent. */
  readonly tokenFile: string
  /** 本机 DSH 数据根，用于读会话日志。 / Local DSH home for session logs. */
  readonly dshHome: string
  /** 绑定地址，默认 127.0.0.1。 / Bind address, 127.0.0.1 by default. */
  readonly host?: string
}

/** 启动结果。 / The started handle. */
export interface BridgeHandle {
  readonly port: number
  readonly token: string
  close(): Promise<void>
}

/** 一个会话摘要。 / One session summary. */
interface SessionRow {
  readonly sessionId: string
  readonly cwd?: string
  readonly updatedAt?: number
  readonly running?: boolean
  readonly blank?: boolean
  readonly agentAvailable?: boolean
  readonly title?: string
}

const BODY_LIMIT = 1_048_576
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { ok: false, error: message })
}

function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('request aborted')))
  })
}

/** 读取或生成桥接 token（0600）。 / Read or create the bridge token (0600). */
async function ensureToken(file: string): Promise<string> {
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing) return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const token = randomBytes(32).toString('base64url')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${token}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  return token
}

/** 找会话日志目录并返回按名字排序的日志文件。 / Find the session log directory and its log files. */
async function sessionLogFiles(dshHome: string, sessionId: string): Promise<string[]> {
  const root = join(dshHome, 'sessions')
  let groups: string[]
  try {
    groups = await readdir(root)
  } catch {
    return []
  }
  for (const group of groups) {
    const directory = join(root, group, sessionId)
    try {
      if (!(await stat(directory)).isDirectory()) continue
    } catch {
      continue
    }
    let names: string[] = []
    try {
      names = (await readdir(directory)).filter(name => name.endsWith('.jsonl.zstd')).sort()
    } catch {
      continue
    }
    return names.map(name => join(directory, name))
  }
  return []
}

/** 读一个会话的日志并解析成消息。 / Read one session's logs and parse them into messages. */
async function readHistory(dshHome: string, sessionId: string): Promise<{ messages: readonly unknown[]; cwd?: string; sessionId?: string }> {
  const files = await sessionLogFiles(dshHome, sessionId)
  if (files.length === 0) return { messages: [] }
  let text = ''
  for (const file of files) text += decompressFrames(await readFile(file))
  const parsed = parseSessionLog(text)
  return {
    messages: parsed.messages,
    ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
  }
}

/** 归一化一条会话摘要。 / Normalize one session summary. */
function sessionRow(value: unknown): SessionRow | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  if (typeof source.sessionId !== 'string' || !source.sessionId) return undefined
  return {
    sessionId: source.sessionId,
    ...(typeof source.cwd === 'string' ? { cwd: source.cwd } : {}),
    ...(typeof source.updatedAt === 'number' ? { updatedAt: source.updatedAt } : {}),
    ...(typeof source.running === 'boolean' ? { running: source.running } : {}),
    ...(typeof source.blank === 'boolean' ? { blank: source.blank } : {}),
    ...(typeof source.agentAvailable === 'boolean' ? { agentAvailable: source.agentAvailable } : {}),
  }
}

/**
 * 启动桥接服务。port 为 0 时不监听，返回一个不可用的句柄。
 * Start the bridge. A port of 0 starts nothing and returns an inert handle.
 */
export async function startBridge(ctx: BridgeHost, options: BridgeOptions): Promise<BridgeHandle> {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error('bridge port must be 0-65535')
  if (options.port === 0) return { port: 0, token: '', close: async () => undefined }
  const token = await ensureToken(options.tokenFile)
  const host = options.host ?? '127.0.0.1'
  const controller = (): SessionControllerLike | undefined => {
    const candidate = ctx.get('sessionController')
    return candidate && typeof candidate === 'object' ? (candidate as SessionControllerLike) : undefined
  }

  const server: Server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) return sendError(res, 401, 'missing or wrong bridge token')
      const url = new URL(req.url ?? '/', `http://${host}`)
      const route = `${req.method ?? 'GET'} ${url.pathname}`

      if (route === 'GET /v1/info') {
        return sendJson(res, 200, {
          ok: true,
          hostname: hostname(),
          platform: process.platform === 'win32' ? 'windows' : 'posix',
          dshHome: options.dshHome,
          canPrompt: controller() !== undefined,
          node: process.version,
        })
      }

      if (route === 'GET /v1/sessions') {
        const sessions = controller()
        if (!sessions) return sendError(res, 503, 'this host has no session controller')
        const listed = await sessions.list({})
        const rows = listed.items.map(sessionRow).filter((row): row is SessionRow => row !== undefined)
        return sendJson(res, 200, { ok: true, sessions: rows })
      }

      if (route === 'GET /v1/history') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (!SESSION_ID.test(sessionId)) return sendError(res, 400, 'invalid session id')
        const history = await readHistory(options.dshHome, sessionId)
        return sendJson(res, 200, { ok: true, source: history.messages.length > 0 ? 'log' : 'empty', ...history })
      }

      if (route === 'POST /v1/create') {
        const sessions = controller()
        if (!sessions) return sendError(res, 503, 'this host has no session controller')
        const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>
        const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined
        const created = await sessions.create(cwd === undefined ? {} : { cwd })
        return sendJson(res, 200, { ok: true, sessionId: created.sessionId })
      }

      if (route === 'POST /v1/prompt') {
        const sessions = controller()
        if (!sessions) return sendError(res, 503, 'this host has no session controller')
        const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const text = typeof body.text === 'string' ? body.text : ''
        if (!SESSION_ID.test(sessionId)) return sendError(res, 400, 'invalid session id')
        if (!text.trim()) return sendError(res, 400, 'text is required')
        if (text.length > 200_000) return sendError(res, 400, 'text is too large')
        await sessions.prompt({
          requestId: randomBytes(16).toString('hex'),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        })
        return sendJson(res, 200, { ok: true, accepted: true })
      }

      if (route === 'POST /v1/cancel') {
        const sessions = controller()
        if (!sessions) return sendError(res, 503, 'this host has no session controller')
        const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (!SESSION_ID.test(sessionId)) return sendError(res, 400, 'invalid session id')
        await sessions.cancel({ sessionId })
        return sendJson(res, 200, { ok: true })
      }

      return sendError(res, 404, `unknown bridge route: ${route}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn(`remote-instance bridge: ${message}`)
      if (!res.writableEnded) sendError(res, 500, message.slice(0, 2_000))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port
  // 端口是动态的，写一份描述文件让对端经 SSH 读到。 / The port is dynamic; publish it for the peer to read over SSH.
  const descriptor = join(options.dshHome, 'remote-instance-bridge.json')
  await mkdir(dirname(descriptor), { recursive: true })
  await writeFile(descriptor, `${JSON.stringify({ port, token, pid: process.pid, startedAt: Date.now() }, null, 2)}\n`, { mode: 0o600 })
  await chmod(descriptor, 0o600)
  return {
    port,
    token,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  }
}
