import assert from 'node:assert/strict'
import test from 'node:test'
import { claudeCommands, parseUsageReport, queryClaudeUsage, usageMessage, usageSummary } from '../src/claude-usage.js'

const REPORT = `You are currently using your subscription to power your Claude Code usage

Current session: 66% used · resets Oct 27 at 8:19pm (Asia/Shanghai)
Current week (all models): 37% used · resets Nov 2 at 9:59am (Asia/Shanghai)

What's contributing to your limits usage?`

test('parses the session and weekly lines of /usage', () => {
  assert.deepEqual(parseUsageReport(REPORT), {
    session: { percent: 66, resets: 'Oct 27 at 8:19pm (Asia/Shanghai)' },
    weekly: { percent: 37, resets: 'Nov 2 at 9:59am (Asia/Shanghai)' },
  })
  assert.equal(usageSummary(parseUsageReport(REPORT)), 'Claude 额度 会话 66% · 本周 37%')
})

test('reports without usage lines give nothing', () => {
  assert.equal(parseUsageReport('You are using an API key'), undefined)
  assert.equal(parseUsageReport(undefined), undefined)
  assert.deepEqual(parseUsageReport('Current week (all models): 140% used'), { session: undefined, weekly: { percent: 100, resets: undefined } })
})

test('queries claude in print mode without saving a session', async () => {
  const calls = []
  const run = (command, args, options, callback) => {
    calls.push({ command, args, options })
    callback(null, JSON.stringify({ result: REPORT }))
  }
  const usage = await queryClaudeUsage({ commands: ['claude'], run })
  assert.equal(usage.session.percent, 66)
  assert.deepEqual(calls[0].args.slice(0, 5), ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'])
  assert.deepEqual(JSON.parse(calls[0].args[calls[0].args.indexOf('--settings') + 1]), { disableAllHooks: true })
  assert.ok(calls[0].options.timeout > 0)
})

test('falls back to the next command only when one is missing', async () => {
  const tried = []
  const missing = Object.assign(new Error('not found'), { code: 'ENOENT' })
  const run = (command, _args, _options, callback) => {
    tried.push(command)
    if (command === 'claude') callback(missing)
    else callback(null, JSON.stringify({ result: REPORT }))
  }
  assert.equal((await queryClaudeUsage({ commands: ['claude', '/home/x/.local/bin/claude'], run })).weekly.percent, 37)
  assert.deepEqual(tried, ['claude', '/home/x/.local/bin/claude'])

  const failing = (_command, _args, _options, callback) => callback(Object.assign(new Error('boom'), { code: 1 }))
  await assert.rejects(queryClaudeUsage({ commands: ['a', 'b'], run: failing }), /boom/)
  const garbage = (_command, _args, _options, callback) => callback(null, 'not json')
  await assert.rejects(queryClaudeUsage({ commands: ['a'], run: garbage }), /invalid JSON/)
  const empty = (_command, _args, _options, callback) => callback(null, JSON.stringify({ result: 'no usage here' }))
  await assert.rejects(queryClaudeUsage({ commands: ['a'], run: empty }), /no subscription usage/)
})

test('DAFEIYU_CLAUDE overrides the command search', () => {
  assert.deepEqual(claudeCommands({ DAFEIYU_CLAUDE: '/opt/claude' }, '/home/x'), ['/opt/claude'])
  assert.equal(claudeCommands({}, '/home/x')[0], 'claude')
})

test('usage travels in the balance slot so helpers render it unchanged', () => {
  const message = usageMessage({ session: { percent: 5 } }, 123)
  assert.equal(message.kind, 'balance')
  assert.equal(message.source, 'subscription')
  assert.equal(message.summary, 'Claude 额度 会话 5%')
})
