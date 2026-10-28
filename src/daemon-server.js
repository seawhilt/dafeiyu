import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { isLocalRequest, jsonResponse } from './local-http.js'

// The daemon's local HTTP API: loopback only, same-origin only, and every
// route but the settings page requires the per-run token header.

const MAX_BODY_BYTES = 256 * 1024

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, 'request body is too large')
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw new HttpError(400, 'body must be a JSON object')
  }
}

function tokenMatches(expected, received) {
  if (typeof received !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * @param {{
 *   token: string,
 *   routes: Record<string, (body: object | undefined, url: URL) => unknown>,
 *   page: () => { html: string, csp: string },
 *   binary?: Record<string, (url: URL) => { contentType: string, bytes: Buffer }>,
 *   logger?: Console,
 * }} options  Route keys are "METHOD /path"; a key ending in "/*" matches
 *   every path under that prefix. Handlers also receive the parsed URL.
 */
export function createDaemonServer({ token, routes, page, binary = {}, logger = console }) {
  // Exact keys win; "METHOD /prefix/*" matches anything under the prefix.
  const find = (table, method, pathname) => table[`${method} ${pathname}`]
    ?? Object.entries(table).find(([key]) => key.endsWith('/*')
      && key.startsWith(`${method} `) && pathname.startsWith(key.slice(method.length + 1, -1)))?.[1]

  const server = createServer(async (req, res) => {
    try {
      // Same-origin requests from the settings page carry an Origin header;
      // isLocalRequest rejects any other origin.
      if (!isLocalRequest(req)) throw new HttpError(403, 'local access only')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/settings') {
        const { html, csp } = page()
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': csp,
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
        })
        res.end(html)
        return
      }
      if (!tokenMatches(token, req.headers['x-dafeiyu-token'])) throw new HttpError(401, 'bad token')
      const raw = find(binary, req.method, url.pathname)
      if (raw) {
        const { contentType, bytes } = raw(url)
        res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store', 'content-length': bytes.length })
        res.end(bytes)
        return
      }
      const handler = find(routes, req.method, url.pathname)
      if (!handler) throw new HttpError(404, 'not found')
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined
      jsonResponse(res, 200, await handler(body, url))
    } catch (error) {
      const statusCode = Number.isInteger(error?.status) ? error.status : 500
      if (statusCode === 500) logger.error?.('dafeiyu daemon request failed', error)
      jsonResponse(res, statusCode, { error: statusCode === 500 ? 'internal error' : error.message })
    }
  })

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      return server.address().port
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
