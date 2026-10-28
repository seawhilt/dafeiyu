import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetRoot = join(repositoryRoot, 'assets')

// SHA-256 of the unmodified upstream Chromium cursors
// (ui/resources/cursors/hand_grab.cur and hand_grabbing.cur). The MD5 digests
// are recorded in assets/cursors/README.md and checked by the Python suite;
// these pin the same bytes from the packaged side, so editing or swapping a
// cursor fails here even when only `npm test` runs.
const CURSOR_SHA256 = Object.freeze({
  'cursor_grab.cur': '3df4009e28e365e1666c868aede15239c75cbb6cf710cd691997b722c3eea7f0',
  'cursor_grabbing.cur': '22e823e71c106f338d42932c13c16e05a8310b3bdec18a89cc5ca197408cf11a',
})

test('package files whitelist ships the glove cursors and their license notice', async () => {
  const pkg = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
  for (const entry of ['assets/cursor_grab.cur', 'assets/cursor_grabbing.cur', 'assets/cursors/']) {
    assert.ok(pkg.files.includes(entry), `package.json "files" is missing ${entry}`)
  }
})

test('glove cursor files are valid 32x32 CUR icons', async () => {
  for (const name of ['cursor_grab.cur', 'cursor_grabbing.cur']) {
    const bytes = await readFile(join(assetRoot, name))
    assert.deepEqual([...bytes.subarray(0, 4)], [0, 0, 2, 0], `${name} is not a CUR (ICONDIR header)`)
    assert.equal(bytes[6], 32, `${name} width must be 32`)
    assert.equal(bytes[7], 32, `${name} height must be 32`)
  }
})

test('shipped cursors are the unmodified upstream Chromium files', async () => {
  for (const [name, expected] of Object.entries(CURSOR_SHA256)) {
    const bytes = await readFile(join(assetRoot, name))
    const digest = createHash('sha256').update(bytes).digest('hex')
    assert.equal(digest, expected, `${name} differs from the upstream Chromium cursor; update the provenance note`)
  }
})

test('cursor license and provenance notice are bundled', async () => {
  for (const name of ['cursors/LICENSE', 'cursors/README.md']) {
    const info = await stat(join(assetRoot, name))
    assert.ok(info.size > 0, `${name} is empty`)
  }
})
