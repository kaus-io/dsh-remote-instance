/**
 * 会话历史：受限读取远端 `$DSH_HOME/sessions/<cwd>/<sessionId>/*.jsonl.zstd`，本地按帧解压后解析成消息。
 * 远端只能执行固定命令（会话 id 已白名单），压缩数据有字节上限；解压需要宿主 Node 支持 zstd。
 *
 * Session history: a bounded, fixed-command read of
 * `$DSH_HOME/sessions/<cwd>/<sessionId>/*.jsonl.zstd` on the remote, decompressed
 * frame by frame here and parsed into messages. The remote command is fixed
 * (the session id is whitelisted), the compressed payload is capped, and local
 * decompression needs a Node runtime with zstd support.
 */
import { zstdDecompressSync } from 'node:zlib'
import { psQuote } from './platform.js'
import type { Platform } from './platform.js'
import { shellQuote } from './shell.js'

/** 压缩数据上限。 / Cap on the compressed payload. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024
/** 保留的消息条数上限。 / Cap on retained messages. */
const MAX_MESSAGES = 240
/** 单条消息的字符上限。 / Cap on one message. */
const MAX_TEXT = 20_000

/** 一条从日志还原出来的消息。 / One message recovered from the log. */
export interface HistoryMessage {
  readonly role: 'user' | 'assistant' | 'thought' | 'tool' | 'notice'
  readonly text: string
  readonly at?: number
  readonly id?: string
  readonly status?: string
}

/** 解析结果。 / Parse result. */
export interface HistoryParse {
  readonly sessionId?: string
  readonly cwd?: string
  readonly createdAt?: number
  readonly messages: readonly HistoryMessage[]
  readonly events: number
}

/** zstd 帧的魔数。 / The zstd frame magic. */
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * 解压多帧拼接的 zstd 数据（会话日志每次追加一帧）。损坏的尾部帧会被丢弃。
 * Decompress concatenated zstd frames (one per append); a damaged tail frame is dropped.
 */
export function decompressFrames(buffer: Buffer): string {
  if (buffer.length === 0) return ''
  const starts: number[] = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1] && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) starts.push(index)
  }
  if (starts.length === 0) throw new Error('the session log has no zstd frame')
  let text = ''
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    const to = starts[index + 1] ?? buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(from, to)).toString('utf8')
    } catch {
      // 截断或损坏的帧跳过；其余帧仍然可用。 / Skip a truncated or damaged frame; the rest still decode.
    }
  }
  return text
}

function textOfBlocks(blocks: unknown, kinds: readonly string[]): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const source = block as Record<string, unknown>
    if (typeof source.type !== 'string' || !kinds.includes(source.type)) continue
    if (typeof source.text === 'string' && source.text) parts.push(source.text)
  }
  return parts.join('')
}

function brief(value: unknown, limit = 200): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  text = (text ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * 把 v4 的 JSONL 事件解析成消息；未知事件忽略，连续同类消息合并。
 * Parse the v4 JSONL events into messages; unknown events are ignored and
 * consecutive same-role messages merge.
 */
export function parseSessionLog(text: string): HistoryParse {
  const messages: HistoryMessage[] = []
  let sessionId: string | undefined
  let cwd: string | undefined
  let createdAt: number | undefined
  let events = 0
  const push = (message: HistoryMessage): void => {
    if (!message.text) return
    const last = messages[messages.length - 1]
    if (last && last.role === message.role && last.id === undefined && message.id === undefined && message.role !== 'tool') {
      messages[messages.length - 1] = { ...last, text: (last.text + message.text).slice(-MAX_TEXT) }
      return
    }
    messages.push({ ...message, text: message.text.slice(0, MAX_TEXT) })
    if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES)
  }
  for (const line of text.split('\n')) {
    const raw = line.trim()
    if (!raw) continue
    let event: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') continue
      event = parsed as Record<string, unknown>
    } catch {
      continue
    }
    events += 1
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'session') {
      if (typeof event.id === 'string') sessionId = event.id
      if (typeof event.cwd === 'string') cwd = event.cwd
      if (typeof event.createdAt === 'number') createdAt = event.createdAt
      continue
    }
    const at = typeof event.time === 'number' ? event.time : undefined
    switch (event.type) {
      case 'user/message': {
        const body = textOfBlocks(data.content, ['text'])
        push({ role: 'user', text: body, ...(at === undefined ? {} : { at }) })
        break
      }
      case 'assistant/message': {
        const message = (data.message ?? {}) as Record<string, unknown>
        const body = textOfBlocks(message.content, ['text'])
        const thought = textOfBlocks(message.content, ['reasoning'])
        if (thought) push({ role: 'thought', text: thought, ...(at === undefined ? {} : { at }) })
        if (body) push({ role: 'assistant', text: body, ...(at === undefined ? {} : { at }) })
        break
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : 'tool'
        const args = brief(data.arguments)
        push({
          role: 'tool',
          text: `${name}${args && args !== '{}' ? ` ${args}` : ''}`,
          at: at ?? Date.now(),
          ...(typeof data.callId === 'string' ? { id: data.callId } : {}),
          status: 'called',
        })
        break
      }
      case 'tool/result': {
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : undefined
        if (id === undefined) break
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (!message || message.id !== id) continue
          messages[index] = { ...message, status: 'done' }
          break
        }
        break
      }
      default:
        break
    }
  }
  return { messages, events, ...(sessionId === undefined ? {} : { sessionId }), ...(cwd === undefined ? {} : { cwd }), ...(createdAt === undefined ? {} : { createdAt }) }
}

/**
 * 远端读取命令：只读、固定片段，输出 JSONL 压缩数据的 base64。
 * The remote read: read-only and fixed, printing the compressed JSONL as base64.
 */
export function historyCommand(platform: Platform, home: string | undefined, sessionId: string, limit = MAX_LOG_BYTES): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('sessionId may only contain A-Za-z0-9, _ and -')
  const base = home && home.trim() ? home.trim() : '${DSH_HOME:-$HOME/.dsh}'
  if (platform === 'windows') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$ProgressPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      `$home = ${home && home.trim() ? psQuote(home.trim()) : `if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }`}`,
      `$sid = ${psQuote(sessionId)}`,
      `$dir = Get-ChildItem (Join-Path $home 'sessions') -Directory | ForEach-Object { Get-ChildItem $_.FullName -Directory } | Where-Object { $_.Name -eq $sid } | Select-Object -First 1`,
      'if ($dir) { $chunks = @(); $size = 0; Get-ChildItem $dir.FullName -Filter *.jsonl.zstd | Sort-Object Name | ForEach-Object { if ($size -lt ' + String(limit) + ') { $bytes = [IO.File]::ReadAllBytes($_.FullName); $size += $bytes.Length; $chunks += $bytes } }; if ($chunks.Count -gt 0) { [Convert]::ToBase64String([byte[]]$chunks) } }',
    ].join('\n')
    return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
  }
  const homeExpr = home && home.trim() ? shellQuote(home.trim()) : '"${DSH_HOME:-$HOME/.dsh}"'
  const script = [
    `home=${homeExpr}`,
    `dir=$(find "$home/sessions" -mindepth 2 -maxdepth 2 -type d -name ${shellQuote(sessionId)} 2>/dev/null | head -n 1)`,
    '[ -n "$dir" ] || exit 0',
    `cat "$dir"/*.jsonl.zstd 2>/dev/null | head -c ${limit} | base64 | tr -d '\\n'`,
  ].join('\n')
  return script
}
