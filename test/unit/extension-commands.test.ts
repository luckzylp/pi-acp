import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  maybeGet(sessionId: string) {
    if (sessionId !== this.session.sessionId) return undefined
    return this.session
  }
}

function makeSession(proc: FakePiRpcProcess, conn: FakeAgentSideConnection): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

function makeAgent(session: PiAcpSession, conn: FakeAgentSideConnection): PiAcpAgent {
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any
  return agent
}

test('PiAcpSession: extension command completes on the RPC response without agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { contextUsage: { tokens: 42, contextWindow: 1000 } }
  const session = makeSession(proc, conn)

  const reason = await session.runExtensionCommand('/fh-system-prompt')

  assert.equal(reason, 'end_turn')
  assert.deepEqual(proc.prompts, [{ message: '/fh-system-prompt', attachments: [] }])
  assert.deepEqual(
    conn.updates.map(item => item.update.sessionUpdate),
    ['session_info_update', 'usage_update', 'session_info_update']
  )
  assert.deepEqual(conn.updates[0]!.update._meta, {
    piAcp: { queueDepth: 0, running: true, extensionCommand: '/fh-system-prompt' }
  })
  assert.deepEqual(conn.updates[2]!.update._meta, { piAcp: { queueDepth: 0, running: false } })
})

test('PiAcpSession: extension command reports error when the RPC prompt fails', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.prompt = async () => {
    throw new Error('extension handler failed')
  }
  const session = makeSession(proc, conn)

  assert.equal(await session.runExtensionCommand('/fh-fusion'), 'error')
  assert.deepEqual(conn.updates.at(-1)!.update._meta, { piAcp: { queueDepth: 0, running: false } })
})

test('PiAcpAgent: dispatches extension slash commands through runExtensionCommand', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.commands = {
    commands: [{ name: 'fh-system-prompt', description: 'Show the harness prompt', source: 'extension' }]
  }
  proc.sessionStats = { contextUsage: { tokens: 42, contextWindow: 1000 } }
  const session = makeSession(proc, conn)
  const agent = makeAgent(session, conn)

  const result = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/fh-system-prompt show' }]
  } as any)

  assert.equal(result.stopReason, 'end_turn')
  assert.deepEqual(proc.prompts, [{ message: '/fh-system-prompt show', attachments: [] }])
  assert.equal(
    conn.updates.some(u => (u.update as any)._meta?.piAcp?.extensionCommand === '/fh-system-prompt'),
    true
  )
})

test('PiAcpAgent: non-extension slash commands keep the normal prompt lifecycle', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.commands = {
    commands: [
      { name: 'fh-system-prompt', description: 'Show the harness prompt', source: 'extension' },
      { name: 'review', description: 'Review changes', source: 'prompt' }
    ]
  }
  const session = makeSession(proc, conn)
  const agent = makeAgent(session, conn)

  const pending = agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/review now' }]
  } as any)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const result = await pending
  assert.equal(result.stopReason, 'end_turn')
  assert.deepEqual(proc.prompts, [{ message: '/review now', attachments: [] }])
  assert.equal(
    conn.updates.some(u => (u.update as any)._meta?.piAcp?.extensionCommand),
    false
  )
})
