import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { SessionTitleRequest } from '../../src/acp/title.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

type Harness = {
  conn: FakeAgentSideConnection
  proc: FakePiRpcProcess
  session: PiAcpSession
  requests: SessionTitleRequest[]
  assignedNames: string[]
  generatorCalls: () => number
}

function createHarness(
  options: {
    generate?: (request: SessionTitleRequest) => Promise<string | null>
    autoTitle?: boolean
    generateTitle?: boolean
  } = {}
): Harness {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const assignedNames: string[] = []
  const requests: SessionTitleRequest[] = []

  proc.getState = async () => ({})
  proc.setSessionName = async (name: string) => {
    assignedNames.push(name)
  }

  const session: PiAcpSession = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    autoTitle: options.autoTitle ?? true,
    generateTitle: options.generateTitle ?? true,
    piCommand: 'pi-test',
    titleGenerator: async request => {
      requests.push(request)
      return options.generate ? await options.generate(request) : 'Generated title'
    }
  })

  return { conn, proc, session, requests, assignedNames, generatorCalls: () => requests.length }
}

async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

async function runTurn(harness: Harness, message: string, assistantText = 'Done.'): Promise<string> {
  const prompt = harness.session.prompt(message, [], message)
  await new Promise(resolve => setImmediate(resolve))

  harness.proc.emit({ type: 'agent_start' })
  harness.proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: assistantText }
  })
  harness.proc.emit({ type: 'agent_end' })
  harness.proc.emit({ type: 'agent_settled' })

  const reason = await prompt
  await flush()
  return reason
}

function titles(conn: FakeAgentSideConnection): Array<string | null> {
  return conn.updates.flatMap(({ update }) => ('title' in update ? [update.title ?? null] : []))
}

test('PiAcpSession: generates a thread title when the first turn ends', async () => {
  const harness = createHarness({ generate: async () => 'Fix JWT verification' })

  assert.equal(await runTurn(harness, 'the jwt check is broken, please fix it'), 'end_turn')

  const request = harness.requests[0]!
  assert.equal(request.cwd, process.cwd())
  assert.equal(request.piCommand, 'pi-test')
  assert.equal(request.userPrompt, 'the jwt check is broken, please fix it')
  assert.equal(request.assistantText, 'Done.')
  assert.ok(request.signal)

  // The first-prompt placeholder is replaced by the generated title.
  assert.deepEqual(harness.assignedNames, ['the jwt check is broken, please fix it', 'Fix JWT verification'])
  assert.deepEqual(titles(harness.conn), ['the jwt check is broken, please fix it', 'Fix JWT verification'])
})

test('PiAcpSession: generates the title after the stop reason is delivered', async () => {
  const harness = createHarness({ generate: async () => 'Generated title' })

  const prompt = harness.session.prompt('first message', [], 'first message')
  await new Promise(resolve => setImmediate(resolve))
  harness.proc.emit({ type: 'agent_settled' })

  assert.equal(await prompt, 'end_turn')
  assert.equal(harness.requests.length, 0, 'title request starts only after the turn is settled')

  await flush()
  assert.equal(harness.requests.length, 1)
})

test('PiAcpSession: keeps a generated title instead of regenerating it', async () => {
  const harness = createHarness({ generate: async () => 'Refactor session titles' })

  await runTurn(harness, 'refactor the title handling')
  await runTurn(harness, 'now also update the docs')
  await runTurn(harness, 'and the changelog')

  assert.equal(harness.generatorCalls(), 1)
  assert.deepEqual(harness.assignedNames, ['refactor the title handling', 'Refactor session titles'])
})

test('PiAcpSession: never overwrites an explicit rename', async () => {
  const harness = createHarness({ generate: async () => 'Generated title' })

  const prompt = harness.session.prompt('first message', [], 'first message')
  await new Promise(resolve => setImmediate(resolve))
  await harness.session.setSessionName('Manual title')

  harness.proc.emit({ type: 'agent_settled' })
  await prompt
  await flush()

  assert.equal(harness.generatorCalls(), 0)
  assert.deepEqual(harness.assignedNames, ['first message', 'Manual title'])
  assert.equal(titles(harness.conn).at(-1), 'Manual title')
})

test('PiAcpSession: treats a rename from pi as final', async () => {
  const harness = createHarness({ generate: async () => 'Generated title' })

  const prompt = harness.session.prompt('first message', [], 'first message')
  await new Promise(resolve => setImmediate(resolve))
  harness.proc.emit({ type: 'session_info_changed', name: 'Renamed by extension' })

  harness.proc.emit({ type: 'agent_settled' })
  await prompt
  await flush()

  assert.equal(harness.generatorCalls(), 0)
  assert.equal(titles(harness.conn).at(-1), 'Renamed by extension')
})

test('PiAcpSession: skips title generation for cancelled turns', async () => {
  const harness = createHarness({ generate: async () => 'Generated title' })

  const prompt = harness.session.prompt('first message', [], 'first message')
  await new Promise(resolve => setImmediate(resolve))
  await harness.session.cancel()
  harness.proc.emit({ type: 'agent_settled' })

  assert.equal(await prompt, 'cancelled')
  await flush()

  assert.equal(harness.generatorCalls(), 0)
})

test('PiAcpSession: keeps the placeholder when generation fails and retries a bounded number of times', async () => {
  const harness = createHarness({
    generate: async () => {
      throw new Error('pi title request failed')
    }
  })

  for (let i = 0; i < 5; i += 1) await runTurn(harness, `turn ${i + 1}`)

  assert.equal(harness.generatorCalls(), 3)
  assert.deepEqual(harness.assignedNames, ['turn 1'])
  assert.deepEqual(titles(harness.conn), ['turn 1'])
})

test('PiAcpSession: ignores an empty generated title', async () => {
  const harness = createHarness({ generate: async () => '   ' })

  await runTurn(harness, 'first message')
  assert.deepEqual(harness.assignedNames, ['first message'])

  await runTurn(harness, 'second message')
  assert.equal(harness.generatorCalls(), 2, 'a blank answer does not count as a title')
  assert.deepEqual(harness.assignedNames, ['first message'])
})

test('PiAcpSession: does not generate titles when disabled', async () => {
  const harness = createHarness({ generate: async () => 'Generated title', generateTitle: false })

  await runTurn(harness, 'first message')

  assert.equal(harness.generatorCalls(), 0)
  assert.deepEqual(harness.assignedNames, ['first message'])
})
