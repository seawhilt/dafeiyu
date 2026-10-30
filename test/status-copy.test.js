import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activityCopy,
  activityStage,
  apiErrorCopy,
  statusCopy,
  statusCopyLibrary,
  taskCopy,
} from '../src/status-copy.js'

test('status copy stays varied, friendly, and deterministic', () => {
  assert.ok(Object.values(statusCopyLibrary).every((variants) => variants.length >= 2))
  assert.equal(statusCopy('success', 1), statusCopy('success', 1))
  assert.notEqual(statusCopy('success', 1), statusCopy('success', 2))
  assert.match(statusCopy('waiting', 0), /你|确认/u)
})

test('activity copy hides technical tool names behind human stages', () => {
  assert.equal(activityStage('testing'), '验证阶段')
  assert.match(activityCopy('searching', 0), /找|查看/u)
  assert.doesNotMatch(activityCopy('commanding', 1), /shell_command/u)
})

test('task copy adds restrained conversational particles', () => {
  assert.equal(taskCopy('修改登录模块'), '正在修改登录模块呢')
  assert.equal(taskCopy('正在运行测试'), '正在运行测试呢')
  assert.equal(taskCopy('Ship the release'), '正在处理「Ship the release」呢')
})

test('API error copy names the kind of failure instead of a generic problem', () => {
  assert.match(apiErrorCopy('rate_limit', 0), /限流|频繁/u)
  assert.match(apiErrorCopy('overloaded', 0), /忙|服务/u)
  assert.match(apiErrorCopy('authentication_failed', 0), /登录|凭证/u)
  assert.match(apiErrorCopy('billing_error', 0), /账户|额度/u)
  assert.match(apiErrorCopy('invalid_request', 0), /配置|请求/u)
  assert.equal(apiErrorCopy('max_output_tokens', 0), statusCopy('limit', 0))
  assert.equal(apiErrorCopy('something_new', 0), statusCopy('error', 0))
  assert.equal(apiErrorCopy(undefined, 0), statusCopy('error', 0))
})
