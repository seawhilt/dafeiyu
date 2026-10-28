import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { codexManifest, codexPetDir, listCharacters, listCodexPets, prepareCharacterAssets } from '../src/characters.js'

function petsDir() {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-pets-'))
  const add = (id, manifest, sheet = 'webp') => {
    mkdirSync(join(root, id))
    writeFileSync(join(root, id, 'pet.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
    if (sheet) writeFileSync(join(root, id, 'spritesheet.webp'), sheet)
  }
  return { root, add }
}

test('lists installed codex pets after the built-in whale', () => {
  const { root, add } = petsDir()
  try {
    add('mini-sama', { displayName: 'Mini Sama' })
    add('no-sheet', { displayName: 'x' }, null)
    add('broken', '{ nope')
    add('Bad_Id', { displayName: 'x' })
    assert.deepEqual(listCodexPets(root), [{ id: 'codex:mini-sama', name: 'Mini Sama', source: 'codex-pets' }])
    assert.deepEqual(listCharacters(root).map((item) => item.id), ['whale', 'codex:mini-sama'])
    assert.deepEqual(listCodexPets(join(root, 'missing')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('only well-formed codex ids map to a pack directory', () => {
  assert.equal(codexPetDir('codex:mini-sama', '/p'), join('/p', 'mini-sama'))
  assert.equal(codexPetDir('codex:../etc', '/p'), undefined)
  assert.equal(codexPetDir('whale', '/p'), undefined)
})

test('the codex manifest maps every pet state and helper clip onto atlas cells', () => {
  const manifest = codexManifest('Mini')
  for (const clip of [...Object.values(manifest.stateMap), ...Object.values(manifest.workingActivityMap),
    ...manifest.idleMicroClips, 'head_pat', 'poke', 'tail', 'dragging', 'dragging_release']) {
    assert.ok(manifest.clips[clip], clip)
  }
  for (const [primary, variants] of Object.entries(manifest.loopVariants)) {
    assert.equal(variants[0], primary)
    for (const clip of variants) assert.ok(manifest.clips[clip], clip)
  }
  assert.match(manifest.clips.thinking.frames[0], /^cell:0:6:/)
  assert.equal(manifest.clips.attention.loop, true, 'waiting must loop while it lasts')
  assert.equal(manifest.pixelScale, 2)
})

test('preparing a character writes a helper-ready asset root', () => {
  const { root, add } = petsDir()
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-home-'))
  try {
    add('mini-sama', { displayName: 'Mini Sama' }, 'SHEET')
    const target = prepareCharacterAssets('codex:mini-sama', { home, root })
    assert.equal(readFileSync(join(target, 'pet', 'spritesheet.webp'), 'utf8'), 'SHEET')
    assert.equal(JSON.parse(readFileSync(join(target, 'pet-manifest.json'), 'utf8')).characterId, 'Mini Sama')
    assert.equal(prepareCharacterAssets('whale', { home, root }), undefined)
    assert.equal(existsSync(join(home, 'characters', 'whale')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('petdex names and links resolve to a slug, other hosts do not', async () => {
  const { petdexSlug } = await import('../src/characters.js')
  assert.equal(petdexSlug('bulby'), 'bulby')
  assert.equal(petdexSlug(' Bulby '), 'bulby')
  assert.equal(petdexSlug('https://petdex.dev/pets/bulby'), 'bulby')
  assert.equal(petdexSlug('https://assets.petdex.dev/community/bulby/spritesheet.webp'), 'bulby')
  assert.equal(petdexSlug('https://evil.example/pets/bulby'), undefined)
  assert.equal(petdexSlug('../etc'), undefined)
  assert.equal(petdexSlug(''), undefined)
})

test('installing from petdex downloads only from its asset host and checks the files', async () => {
  const { installPetdexPet, listCodexPets } = await import('../src/characters.js')
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-petdex-'))
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])
  const requested = []
  const fakeFetch = (files) => async (url) => {
    requested.push(url)
    const name = url.split('/').at(-1)
    const body = files[name]
    return body === undefined
      ? { ok: false, status: 404 }
      : { ok: true, status: 200, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(body)) }
  }
  try {
    const id = await installPetdexPet('https://petdex.dev/pets/bulby',
      { root, fetchImpl: fakeFetch({ 'pet.json': JSON.stringify({ displayName: 'Bulby' }), 'spritesheet.webp': webp }) })
    assert.equal(id, 'codex:bulby')
    assert.ok(requested.every((url) => url.startsWith('https://assets.petdex.dev/community/bulby/')))
    assert.deepEqual(listCodexPets(root).map((pet) => pet.name), ['Bulby'])

    await assert.rejects(installPetdexPet('missing', { root, fetchImpl: fakeFetch({}) }), (error) => error.code === 'NOT_FOUND')
    await assert.rejects(installPetdexPet('fake', { root, fetchImpl: fakeFetch({ 'pet.json': '{}', 'spritesheet.webp': 'not webp' }) }), /不是 WebP/)
    await assert.rejects(installPetdexPet('bad', { root, fetchImpl: fakeFetch({ 'pet.json': '[]' }) }), /pet\.json/)
    await assert.rejects(installPetdexPet('https://evil.example/x', { root, fetchImpl: fakeFetch({}) }), (error) => error.code === 'BAD_NAME')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
