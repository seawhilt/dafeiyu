import assert from 'node:assert/strict'
import test from 'node:test'
import { applyBubbleText, BUBBLE_GROUPS, bubbleTextView, sanitizeBubbleText } from '../src/bubble-text.js'
import { createMessage } from '../src/protocol.js'

test('sanitising trims, drops blanks and unknown groups, and ignores unchanged defaults', () => {
  assert.deepEqual(sanitizeBubbleText({ thinking: ['  想想 ', '', 3], nope: ['x'] }), { thinking: ['想想'] })
  assert.deepEqual(sanitizeBubbleText({ done: [...BUBBLE_GROUPS.done.defaults] }), {})
  assert.equal(sanitizeBubbleText({ chatter: ['x'.repeat(200)] }).chatter[0].length, 60)
})

test('the view marks which groups the user customised', () => {
  const view = bubbleTextView({ working: ['正在处理 {task}'] })
  assert.equal(view.find((group) => group.key === 'working').custom, true)
  assert.equal(view.find((group) => group.key === 'done').custom, false)
})

test('custom lines replace status messages and fill in the task', () => {
  const custom = { working: ['在弄 {task}'], done: ['好了！'] }
  const working = applyBubbleText(createMessage('state', { state: 'WORKING', message: 'x', task: '改按钮' }), custom)
  assert.equal(working.message, '在弄 改按钮')
  assert.equal(applyBubbleText(createMessage('pulse', { state: 'SUCCESS', message: 'x' }), custom).message, '好了！')
  const thinking = createMessage('state', { state: 'THINKING', message: '原文' })
  assert.equal(applyBubbleText(thinking, custom), thinking, 'groups without custom lines keep the original')
  const config = createMessage('config', {})
  assert.equal(applyBubbleText(config, custom), config)
})
