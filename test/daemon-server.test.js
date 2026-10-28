import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { request } from 'node:http'
import test from 'node:test'
import { createDaemonServer } from '../src/daemon-server.js'

const TOKEN = 'test-token'

async function startDaemonServer(t) {
  const server = createDaemonServer({
    token: TOKEN,
    routes: {
      'POST /echo': (body) => ({ ok: true, body }),
      'GET /status': () => ({ ok: true }),
    },
    page: () => ({ html: '<html></html>', csp: "default-src 'none'" }),
    logger: { error() {} },
  })
  const port = await server.listen()
  t.after(() => server.close())
  return { server, port }
}

function post(port, path, body, { token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'x-dafeiyu-token': token,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : undefined })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('an oversized JSON body is drained and answered with 413', async (t) => {
  const { port } = await startDaemonServer(t)
  const result = await post(port, '/echo', JSON.stringify({ data: 'x'.repeat(300 * 1024) }))
  assert.equal(result.status, 413)
  assert.match(result.body.error, /too large/u)
})

test('a malformed body is answered with 400', async (t) => {
  const { port } = await startDaemonServer(t)
  const result = await post(port, '/echo', 'not json')
  assert.equal(result.status, 400)
})

test('an unknown POST route drains the body and answers 404', async (t) => {
  const { port } = await startDaemonServer(t)
  const result = await post(port, '/missing', JSON.stringify({ data: 'x'.repeat(64 * 1024) }))
  assert.equal(result.status, 404)
})

test('close() force-closes a connection stuck mid-request', async (t) => {
  const { server, port } = await startDaemonServer(t)
  const socket = connect(port, '127.0.0.1')
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  // Headers announce a body that never arrives.
  socket.write('POST /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nx-dafeiyu-token: test-token\r\ncontent-length: 100\r\n\r\n')
  const started = Date.now()
  await server.close()
  assert.ok(Date.now() - started < 2500, 'close should not wait for the request timeout')
  socket.destroy()
})

test('a settings page request without a token still works, API calls do not', async (t) => {
  const { port } = await startDaemonServer(t)
  const page = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/settings', method: 'GET' }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(page, 200)
  const result = await post(port, '/echo', '{}', { token: 'wrong' })
  assert.equal(result.status, 401)
})
