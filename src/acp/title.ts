import { spawn } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { getPiCommand, shouldUseShellForPiCommand } from '../pi-rpc/command.js'

/**
 * Thread titles are generated out-of-band: pi has no title service (its
 * `set_session_name` RPC only renames), so the adapter asks a throwaway pi for a
 * one-line summary of the finished turn. Mirrors Claude Code's ACP adapter,
 * which pushes a generated title when a turn ends.
 */

const TITLE_TIMEOUT_MS = 20_000
const TITLE_MAX_CHARS = 60
const EXCERPT_MAX_CHARS = 2_000

const TITLE_SYSTEM_PROMPT = 'You name coding sessions. Reply with the title only.'

const TITLE_INSTRUCTIONS = `Generate a concise title for this coding session.

Rules:
- Use English.
- Maximum 8 words.
- Describe the primary coding task.
- Use imperative or noun-phrase style.
- No quotes, no trailing punctuation.
- Do not use generic words like "Help" or "Question".`

export type SessionTitleRequest = {
  cwd: string
  piCommand?: string
  provider?: string
  modelId?: string
  /** First user message of the session. */
  userPrompt: string
  /** Assistant text produced during the turn that just finished. */
  assistantText: string
  signal?: AbortSignal
}

/** Injected in tests; defaults to {@link generateSessionTitle}. */
export type SessionTitleGenerator = (request: SessionTitleRequest) => Promise<string | null>

export function isTitleGenerationEnabled(): boolean {
  const raw = process.env.PI_ACP_AUTO_TITLE?.trim().toLowerCase()
  if (!raw) return true
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

function excerpt(text: string): string {
  const normalized = text.replace(/\r\n/gu, '\n').trim()
  const chars = Array.from(normalized)
  if (chars.length <= EXCERPT_MAX_CHARS) return normalized
  return chars.slice(0, EXCERPT_MAX_CHARS).join('') + '\n…'
}

export function buildTitlePrompt(request: Pick<SessionTitleRequest, 'userPrompt' | 'assistantText'>): string {
  const parts = [TITLE_INSTRUCTIONS, '', '<first_user_message>', excerpt(request.userPrompt), '</first_user_message>']

  if (request.assistantText.trim()) {
    parts.push('', '<assistant_reply>', excerpt(request.assistantText), '</assistant_reply>')
  }

  parts.push('', 'Title:')
  return parts.join('\n')
}

/**
 * Turn a model answer into a bare title line: first non-empty line, no `Title:`
 * prefix, no wrapping quotes, no trailing punctuation, bounded length.
 */
export function sanitizeGeneratedTitle(raw: string): string | null {
  const line = raw
    .split(/\r?\n/u)
    .map(part => part.trim())
    // Models sometimes wrap the title in a code fence; ignore the fence itself.
    .find(part => part.length > 0 && !/^(?:```|~~~)/u.test(part))
  if (!line) return null

  let title = line
    .replace(/^(?:title|标题)\s*[:：]\s*/iu, '')
    .replace(/^[#>*\s]+/u, '')
    .replace(/^["'`“”‘’「」《》]+|["'`“”‘’「」《》]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/[\s.,;:!?、，。；：！？-]+$/gu, '')
    .trim()

  if (!title) return null

  const chars = Array.from(title)
  if (chars.length > TITLE_MAX_CHARS) {
    const clipped = chars.slice(0, TITLE_MAX_CHARS).join('')
    const lastSpace = clipped.lastIndexOf(' ')
    title = (lastSpace > TITLE_MAX_CHARS / 2 ? clipped.slice(0, lastSpace) : clipped).trim()
  }

  return title || null
}

function titleRequestArgs(request: SessionTitleRequest): string[] {
  const args = [
    '--print',
    '--mode',
    'json',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-mcp',
    '--no-themes',
    '--no-approve',
    '--system-prompt',
    TITLE_SYSTEM_PROMPT
  ]

  if (request.provider && request.modelId) {
    args.push('--provider', request.provider, '--model', request.modelId)
  }

  return args
}

function assistantTextFromRecord(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null

  const entry = record as { type?: unknown; message?: unknown }
  if (entry.type !== 'message_end' && entry.type !== 'turn_end') return null

  const message = entry.message as { role?: unknown; content?: unknown } | undefined
  if (message?.role !== 'assistant') return null

  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  const text = content
    .map(block => {
      const item = block as { type?: unknown; text?: unknown } | null
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
    })
    .join('')

  return text || null
}

/** Last assistant text found in a `pi --mode json` JSONL stream. */
export function assistantTextFromJsonStream(stream: string): string {
  let text = ''

  for (const line of stream.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      // Diagnostics must not leak into the title; ignore non-JSON lines.
      continue
    }

    const chunk = assistantTextFromRecord(record)
    if (chunk) text = chunk
  }

  return text
}

/**
 * Ask pi for a session title. Resolves `null` for any failure (missing binary,
 * provider error, timeout, abort): titling is best-effort and must never affect
 * the turn it follows.
 */
export async function generateSessionTitle(request: SessionTitleRequest): Promise<string | null> {
  if (request.signal?.aborted) return null

  const command = getPiCommand(request.piCommand)
  const start = shouldUseShellForPiCommand(command) ? crossSpawn : spawn

  let child: ReturnType<typeof spawn>
  try {
    child = start(command, titleRequestArgs(request), {
      cwd: request.cwd,
      stdio: 'pipe',
      env: process.env
    })
  } catch {
    return null
  }

  return await new Promise<string | null>(resolve => {
    let settled = false
    let stdout = ''

    const onAbort = () => finish(null)
    const finish = (title: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      if (!child.killed) child.kill()
      resolve(title)
    }

    // Registered before any listener below, so `timer` is always initialized
    // by the time an abort/exit handler can call `finish`.
    const timer = setTimeout(() => finish(null), TITLE_TIMEOUT_MS)
    timer.unref?.()

    request.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      // Bound memory if pi floods the stream before exiting.
      if (stdout.length > 512 * 1024) stdout = stdout.slice(-64 * 1024)
    })
    // stderr carries diagnostics only; drain it so pi never blocks on a full pipe.
    child.stderr?.resume()

    child.on('error', () => finish(null))
    child.on('close', () => finish(sanitizeGeneratedTitle(assistantTextFromJsonStream(stdout))))

    child.stdin?.on('error', () => {
      // pi may exit before reading stdin; the close handler reports the outcome.
    })
    child.stdin?.end(buildTitlePrompt(request))
  })
}
