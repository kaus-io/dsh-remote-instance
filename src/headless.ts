/**
 * 解析远端 `dsh --profile headless --json` 的按行 JSON 事件流：把提交后的文本、工具调用和错误折叠成作业输出，并在结束时给出最终回答。
 * Parse the remote `dsh --profile headless --json` line-delimited event
 * stream: committed text, tool calls, and errors become job output, and the
 * terminal `final` becomes the answer.
 */

/** 一次事件产生的作业效果。 / The job effect one event produces. */
export type TaskUpdate =
  | { readonly kind: 'progress'; readonly text: string }
  | { readonly kind: 'log'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }

/** 一次远程任务的解析结果。 / The parsed result of one remote task. */
export interface TaskParseResult {
  readonly status: 'completed' | 'failed' | 'killed'
  readonly answer: string
  readonly sessionId?: string
  readonly toolCalls: number
  readonly error?: string
}

/** 增量喂入远端输出。 / Feed remote output incrementally. */
export interface TaskParser {
  push(chunk: string): readonly TaskUpdate[]
  finish(options: { readonly exitCode: number | null; readonly aborted: boolean; readonly stderr?: string }): TaskParseResult
}

/** 默认回答上限，保护作业结果不吞掉上下文。 / Default answer cap protecting the model surface. */
const MAX_ANSWER = 200_000
/** 非 JSON 回退输出的保留上限。 / Retention bound for the non-JSON fallback. */
const MAX_RAW = 1_000_000

function brief(value: unknown, limit = 160): string {
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
 * 创建一个解析器。旧版 dsh 不支持 `--json` 时输出按纯文本处理，回答仍是完整 stdout。
 * Create a parser. A remote dsh without `--json` yields plain stdout, which is
 * still reported as the complete answer.
 */
export function createTaskParser(): TaskParser {
  let buffer = ''
  let sawJson = false
  let raw = ''
  let finalText: string | undefined
  let sessionId: string | undefined
  let toolCalls = 0
  let errorText: string | undefined
  const texts: string[] = []

  const handleEvent = (event: Record<string, unknown>): TaskUpdate[] => {
    switch (event.type) {
      case 'session': {
        if (typeof event.sessionId === 'string' && event.sessionId) sessionId = event.sessionId
        return sessionId ? [{ kind: 'progress', text: `session ${sessionId}` }] : []
      }
      case 'status': {
        const phase = event.phase
        if (phase === 'turn_start') return [{ kind: 'progress', text: `turn ${String(event.turn ?? '?')}` }]
        if (phase === 'turn_end') return [{ kind: 'progress', text: `turn ${String(event.turn ?? '?')} ended (${String(event.reason ?? 'done')})` }]
        return []
      }
      case 'text': {
        if (typeof event.text !== 'string' || !event.text) return []
        texts.push(event.text)
        return [{ kind: 'log', text: event.text }]
      }
      case 'tool_call': {
        toolCalls += 1
        const tool = typeof event.tool === 'string' ? event.tool : 'tool'
        const input = brief(event.input)
        return [{ kind: 'log', text: `\n▸ ${tool}${input && input !== '{}' ? ` ${input}` : ''}\n` }]
      }
      case 'tool_result': {
        if (event.status !== 'error') return []
        return [{ kind: 'error', text: `\n✗ ${brief(event.result, 400)}\n` }]
      }
      case 'final': {
        if (typeof event.text === 'string') finalText = event.text
        return []
      }
      case 'error': {
        errorText = typeof event.message === 'string' ? event.message : 'remote dsh reported an error'
        return [{ kind: 'error', text: `\n${errorText}\n` }]
      }
      default:
        return []
    }
  }

  const consumeLine = (line: string): TaskUpdate[] => {
    if (!line) return []
    if (line.charCodeAt(0) === 0x7b) {
      try {
        const parsed: unknown = JSON.parse(line)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { type?: unknown }).type === 'string') {
          sawJson = true
          return handleEvent(parsed as Record<string, unknown>)
        }
      } catch {
        /* 不是 JSON 行，按纯文本回退处理。 / Not a JSON line: fall back to plain text. */
      }
    }
    raw = (raw + line + '\n').slice(-MAX_RAW)
    return []
  }

  return {
    push(chunk: string): readonly TaskUpdate[] {
      buffer += chunk
      const updates: TaskUpdate[] = []
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        for (const update of consumeLine(line)) updates.push(update)
        index = buffer.indexOf('\n')
      }
      // 单行超长时也不能无限缓存。 / Bound a partial line that never terminates.
      if (buffer.length > MAX_RAW) {
        raw = (raw + buffer).slice(-MAX_RAW)
        buffer = ''
      }
      return updates
    },
    finish({ exitCode, aborted, stderr }): TaskParseResult {
      if (buffer) for (const update of consumeLine(buffer.replace(/\r$/, ''))) void update
      buffer = ''
      const answer = (finalText ?? (sawJson ? texts.join('') : raw.trim())).slice(0, MAX_ANSWER)
      const diagnostics = (errorText ?? (stderr ?? '').trim()).slice(-8000)
      const status: TaskParseResult['status'] = aborted ? 'killed' : errorText !== undefined || exitCode !== 0 ? 'failed' : 'completed'
      return {
        status,
        answer,
        ...(sessionId === undefined ? {} : { sessionId }),
        toolCalls,
        ...(status === 'completed' ? {} : { error: diagnostics || `remote dsh exited with code ${String(exitCode)}` }),
      }
    },
  }
}
