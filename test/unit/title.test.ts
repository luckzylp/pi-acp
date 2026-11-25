import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assistantTextFromJsonStream,
  buildTitlePrompt,
  isTitleGenerationEnabled,
  sanitizeGeneratedTitle
} from '../../src/acp/title.js'

test('buildTitlePrompt: carries the session rules plus the turn excerpt', () => {
  const prompt = buildTitlePrompt({ userPrompt: 'fix the flaky test', assistantText: 'Patched the retry loop.' })

  assert.match(prompt, /Maximum 8 words/u)
  assert.match(prompt, /<first_user_message>\nfix the flaky test\n<\/first_user_message>/u)
  assert.match(prompt, /<assistant_reply>\nPatched the retry loop\.\n<\/assistant_reply>/u)
  assert.match(prompt, /Title:$/u)
})

test('buildTitlePrompt: omits an empty assistant reply and bounds long excerpts', () => {
  const withEmptyReply = buildTitlePrompt({ userPrompt: 'hello', assistantText: '   ' })
  assert.doesNotMatch(withEmptyReply, /<assistant_reply>/u)

  const long = buildTitlePrompt({ userPrompt: 'x'.repeat(5000), assistantText: '' })
  assert.ok(long.length < 2500)
  assert.match(long, /…/u)
})

test('sanitizeGeneratedTitle: reduces a model answer to a bare title', () => {
  assert.equal(sanitizeGeneratedTitle('Fix JWT verification'), 'Fix JWT verification')
  assert.equal(sanitizeGeneratedTitle('Title: "Fix JWT verification."'), 'Fix JWT verification')
  assert.equal(sanitizeGeneratedTitle('标题：修复 JWT 校验。'), '修复 JWT 校验')
  assert.equal(sanitizeGeneratedTitle('# Add Redis caching layer\n\nExtra explanation'), 'Add Redis caching layer')
  assert.equal(sanitizeGeneratedTitle('  Multiple   spaces\there  '), 'Multiple spaces here')
  assert.equal(sanitizeGeneratedTitle('```\nAdd redis cache\n```'), 'Add redis cache')
})

test('sanitizeGeneratedTitle: rejects blank answers and bounds length at a word boundary', () => {
  assert.equal(sanitizeGeneratedTitle(''), null)
  assert.equal(sanitizeGeneratedTitle('   \n  '), null)
  assert.equal(sanitizeGeneratedTitle('...'), null)

  const long = sanitizeGeneratedTitle(
    'Refactor the session title generation pipeline to use the configured provider model'
  )
  assert.ok(long)
  assert.ok(Array.from(long).length <= 60)
  assert.doesNotMatch(long, / $/u)
  assert.ok(!long.endsWith('t'), 'the title is cut at a word boundary')
})

test('assistantTextFromJsonStream: keeps the last assistant message text', () => {
  const stream = [
    'not json at all',
    JSON.stringify({ type: 'message_end', message: { role: 'user', content: 'question' } }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'First ' },
          { type: 'text', text: 'answer' }
        ]
      }
    }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Final' }] } })
  ].join('\n')

  assert.equal(assistantTextFromJsonStream(stream), 'Final')
})

test('assistantTextFromJsonStream: returns empty when no assistant text was produced', () => {
  const stream = [JSON.stringify({ type: 'agent_settled' }), JSON.stringify({ type: 'message_end' })].join('\n')
  assert.equal(assistantTextFromJsonStream(stream), '')
})

test('isTitleGenerationEnabled: defaults to on and honors the opt-out values', () => {
  const previous = process.env.PI_ACP_AUTO_TITLE
  try {
    delete process.env.PI_ACP_AUTO_TITLE
    assert.equal(isTitleGenerationEnabled(), true)

    for (const value of ['0', 'false', 'off', 'NO']) {
      process.env.PI_ACP_AUTO_TITLE = value
      assert.equal(isTitleGenerationEnabled(), false, value)
    }

    process.env.PI_ACP_AUTO_TITLE = '1'
    assert.equal(isTitleGenerationEnabled(), true)
  } finally {
    if (previous === undefined) delete process.env.PI_ACP_AUTO_TITLE
    else process.env.PI_ACP_AUTO_TITLE = previous
  }
})
