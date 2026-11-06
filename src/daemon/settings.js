// Settings page script. settingsPage() inlines it into settings.html under
// the page's CSP nonce, so the page stays a single response.
'use strict'
const token = location.hash.slice(1)
const SECTIONS = ['sources', 'character', 'texts', 'display', 'about']
const requestedSection = /(?:^|[?&])section=([a-z]+)/u.exec(location.search || '')?.[1]
let section = SECTIONS.includes(requestedSection) ? requestedSection : 'sources'
// Drop the token from the address bar and history; keep the open section.
history.replaceState(null, '', `${location.pathname}?section=${section}`)

const $ = (id) => document.getElementById(id)
let state

// Everything the page creates besides DOM nodes and must take back down.
// `render()` runs every 5 seconds and `renderCharacters()` on every refresh,
// so anything left running here would accumulate silently.
const segmentedState = new WeakMap()
const sheetStops = new Set()
const blobUrls = new Set()
let previewEpoch = 0
let refreshTimer

function toast(text) {
  const el = $('toast')
  el.textContent = text
  el.classList.add('show')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => el.classList.remove('show'), 2200)
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-dafeiyu-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`)
  return value
}

function ago(ms) {
  if (!ms) return ''
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  return `${Math.round(seconds / 3600)} 小时前`
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function selectSection(next) {
  section = SECTIONS.includes(next) ? next : 'sources'
  for (const item of document.querySelectorAll('[data-section]')) {
    if (item.dataset.section === section) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  }
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== section
  history.replaceState(null, '', `${location.pathname}?section=${section}`)
}

for (const item of document.querySelectorAll('[data-section]')) {
  item.addEventListener('click', () => selectSection(item.dataset.section))
}
selectSection(section)

// ---- Products ----------------------------------------------------------

// Product colours for the letter badges; brand logos are not bundled.
const BADGE_COLORS = { claude: '#d97757', codex: '#10a37f', cursor: '#5b6170', deepseek: '#4d6bfe', other: '#8a8f98' }
const DRAG_THRESHOLD_PX = 6

/** @returns {[text: string, tone: 'ok' | 'warn' | '']} */
function sourceStatus(row) {
  if (!row.enabled) return ['已关闭，不会显示在桌宠上', '']
  const seen = row.lastEventAt ? ` · ${ago(row.lastEventAt)}收到事件` : ''
  if (row.kind === 'dsh') {
    return row.configured ? [`已连接 DSH 插件${seen}`, 'ok'] : ['还没连接过 DSH 插件', 'warn']
  }
  if (row.kind === 'manual') {
    return row.configured ? [`收到过事件${seen}`, 'ok'] : ['还没收到事件，展开查看接入命令', '']
  }
  const integration = row.integration
  if (!integration.readable) return ['读取设置失败', 'warn']
  if (integration.installed) return [`已接入${seen || '，新开的会话生效'}`, 'ok']
  return row.configured ? [`收到过事件，但 hooks 未写入${seen}`, 'warn'] : ['未接入', 'warn']
}

function usageText(usage) {
  if (!usage) return ''
  const reset = usage.session?.resets ? `，${usage.session.resets} 重置` : ''
  return `会话 ${Math.round(usage.session?.percent ?? 0)}% · 本周 ${Math.round(usage.weekly?.percent ?? 0)}%${reset}`
}

function detailList(entries) {
  const list = el('dl')
  for (const [term, value] of entries) {
    if (!value) continue
    list.append(el('dt', '', term))
    const dd = el('dd')
    dd.append(value)
    list.append(dd)
  }
  return list
}

function hooksDetail(row) {
  const integration = row.integration
  const path = el('span', 'path', integration.settingsPath)
  const fragment = document.createDocumentFragment()
  fragment.append(detailList([
    ['配置文件', path],
    ['读取', integration.readable ? '' : `失败：${integration.error}`],
    ['最近事件', row.lastEventAt ? ago(row.lastEventAt) : '这次运行还没收到'],
    ['额度', usageText(row.usage)],
  ]))
  const actions = el('div', 'actions')
  const install = el('button', 'primary', integration.installed ? '重新接入' : '一键接入')
  install.type = 'button'
  install.addEventListener('click', () => run(() => api(`/sources/${row.id}/install`, {}), `已接入 ${row.label}，新开的会话生效`))
  actions.append(install)
  if (integration.installed) {
    const remove = el('button', 'danger', '移除接入')
    remove.type = 'button'
    remove.addEventListener('click', () => {
      if (confirm(`移除 ${row.label} 接入？会删除大肥鱼写入的 hooks。`)) {
        run(() => api(`/sources/${row.id}/uninstall`, {}), `已移除 ${row.label} 接入`)
      }
    })
    actions.append(remove)
  }
  fragment.append(actions, el('p', 'hint', '接入会在配置文件里写入 hooks，原文件备份为 .dafeiyu.bak，新开的会话生效。'))
  if (row.setupNote) fragment.append(el('p', 'hint', row.setupNote))
  return fragment
}

function manualDetail(row) {
  const fragment = document.createDocumentFragment()
  fragment.append(detailList([
    ['命令', el('span', 'path', row.command)],
    ['最近事件', row.lastEventAt ? ago(row.lastEventAt) : '这次运行还没收到'],
  ]))
  fragment.append(el('p', 'hint', row.setupNote))
  return fragment
}

function dshDetail(row) {
  const fragment = document.createDocumentFragment()
  fragment.append(detailList([['最近消息', row.lastEventAt ? ago(row.lastEventAt) : '这次运行还没收到']]))
  const help = $('dsh-help').content.cloneNode(true)
  help.querySelector('[data-release]').href = state.dsh.releaseUrl
  fragment.append(help)
  return fragment
}

const GRIP_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="4.5" cy="3" r="1.2"/><circle cx="9.5" cy="3" r="1.2"/><circle cx="4.5" cy="7" r="1.2"/><circle cx="9.5" cy="7" r="1.2"/><circle cx="4.5" cy="11" r="1.2"/><circle cx="9.5" cy="11" r="1.2"/></svg>'
const CHEVRON_SVG = '<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'

function sourceRow(row) {
  const open = openDetails.has(row.id)
  const item = el('li', `source${row.enabled ? '' : ' off'}${open ? ' open' : ''}`)
  item.dataset.id = row.id

  const line = el('div', 'source-row')
  const grip = el('button', 'grip')
  grip.type = 'button'
  grip.innerHTML = GRIP_SVG
  grip.setAttribute('aria-label', `调整 ${row.label} 的顺序（↑ ↓）`)

  const main = el('button', 'source-main')
  main.type = 'button'
  main.setAttribute('aria-expanded', String(open))
  main.setAttribute('aria-controls', `source-detail-${row.id}`)
  const badge = el('span', 'badge', row.label.slice(0, 1))
  badge.setAttribute('aria-hidden', 'true')
  if (BADGE_COLORS[row.id]) badge.style.setProperty('--badge', BADGE_COLORS[row.id])
  const textBox = el('span', 'source-text')
  const name = el('span', 'source-name', row.label)
  if (row.displayed) name.append(el('span', 'tag', '正在显示'))
  const [statusText, tone] = sourceStatus(row)
  const status = el('span', 'source-status')
  status.append(el('span', `dot ${tone}`), statusText)
  textBox.append(name, status)
  const chevron = el('span', 'chevron-box')
  chevron.innerHTML = CHEVRON_SVG
  main.append(badge, textBox, chevron)
  main.addEventListener('click', () => {
    if (suppressClick) return
    if (openDetails.has(row.id)) openDetails.delete(row.id)
    else openDetails.add(row.id)
    sourcesSignature = undefined
    renderSources()
  })

  const toggle = el('label', 'switch')
  const input = el('input')
  input.type = 'checkbox'
  input.checked = row.enabled
  input.setAttribute('aria-label', `在桌宠上显示 ${row.label}`)
  input.addEventListener('change', () => run(
    () => api(`/sources/${row.id}/${input.checked ? 'enable' : 'disable'}`, {}),
    input.checked ? `已开启 ${row.label}` : `已关闭 ${row.label}`,
  ))
  toggle.append(input, el('span'))
  line.append(grip, main, toggle)
  item.append(line)

  if (open) {
    const detail = el('div', 'source-detail')
    detail.id = `source-detail-${row.id}`
    const details = { hooks: hooksDetail, manual: manualDetail, dsh: dshDetail }
    detail.append(details[row.kind](row))
    item.append(detail)
  }
  return item
}

const openDetails = new Set()
let sourcesSignature
let drag
let suppressClick = false

// Rebuild only when something shown changed; the 5 s refresh would
// otherwise drop focus from a toggle or handle the user is on.
function renderSources() {
  if (drag) return
  const rows = state.sources
  const enabled = rows.filter((row) => row.enabled).length
  $('sources-count').textContent = `已启用 ${enabled} / ${rows.length}`
  renderSegmented($('sources-bulk'), [['on', '全部开启'], ['off', '全部关闭']],
    enabled === rows.length ? 'on' : enabled === 0 ? 'off' : null, setAllEnabled)

  const signature = JSON.stringify([rows.map((row) => ({ ...row, seen: ago(row.lastEventAt) })), [...openDetails]])
  if (signature === sourcesSignature) return
  sourcesSignature = signature
  const active = document.activeElement
  const focusedId = active?.closest?.('.source')?.dataset.id
  const focusedPart = ['grip', 'source-main'].find((name) => active?.classList?.contains(name)) ?? 'switch input'
  $('sources').replaceChildren(...rows.map(sourceRow))
  if (focusedId) $('sources').querySelector(`.source[data-id="${focusedId}"] .${focusedPart}`)?.focus()
}

function setAllEnabled(value) {
  const wanted = value === 'on'
  const changes = state.sources.filter((row) => row.enabled !== wanted)
  if (changes.length === 0) return
  run(async () => {
    for (const row of changes) await api(`/sources/${row.id}/${wanted ? 'enable' : 'disable'}`, {})
  }, wanted ? '已全部开启' : '已全部关闭')
}

function saveOrder(order) {
  return run(() => api('/sources/order', { order }), '已调整顺序')
}

function moved(order, id, target, after) {
  const rest = order.filter((item) => item !== id)
  const index = rest.indexOf(target) + (after ? 1 : 0)
  return [...rest.slice(0, index), id, ...rest.slice(index)]
}

function clearDropMarks() {
  for (const node of document.querySelectorAll('.drop-before, .drop-after')) node.classList.remove('drop-before', 'drop-after')
}

// Pointer events rather than HTML5 drag and drop: a page hosted in an
// embedded webview (WebView2, Qt WebEngine) may never fire `dragstart`.
$('sources').addEventListener('pointerdown', (event) => {
  const line = event.target.closest('.source-row')
  if (!line || event.button !== 0 || event.target.closest('.switch')) return
  drag = { id: line.parentElement.dataset.id, startY: event.clientY, active: false, target: null, after: false, pointerId: event.pointerId }
})
window.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return
  if (!drag.active) {
    if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
    drag.active = true
    $('sources').querySelector(`.source[data-id="${drag.id}"]`)?.classList.add('dragging')
  }
  const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('.source')
  clearDropMarks()
  if (!over || over.dataset.id === drag.id) {
    drag.target = null
    return
  }
  const box = over.getBoundingClientRect()
  drag.after = event.clientY > box.top + box.height / 2
  drag.target = over.dataset.id
  over.classList.add(drag.after ? 'drop-after' : 'drop-before')
})
function endDrag(commit) {
  if (!drag) return
  const { active, id, target, after } = drag
  drag = undefined
  clearDropMarks()
  for (const node of document.querySelectorAll('.dragging')) node.classList.remove('dragging')
  if (!active) return
  // The pointerup that ends a drag must not also expand the row.
  suppressClick = true
  setTimeout(() => { suppressClick = false }, 0)
  if (commit && target) saveOrder(moved(state.sources.map((row) => row.id), id, target, after))
  else {
    sourcesSignature = undefined
    renderSources()
  }
}
window.addEventListener('pointerup', () => endDrag(true))
window.addEventListener('pointercancel', () => endDrag(false))

$('sources').addEventListener('keydown', (event) => {
  if (!event.target.classList.contains('grip') || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const order = state.sources.map((row) => row.id)
  const id = event.target.closest('.source').dataset.id
  const index = order.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1)
  if (index < 0 || index >= order.length) return
  const next = order.filter((item) => item !== id)
  saveOrder([...next.slice(0, index), id, ...next.slice(index)])
})

// ---- Shared controls ---------------------------------------------------

// Rebuild the buttons only when the option list itself changes. The page
// refreshes every 5 seconds; replacing the nodes on each tick would drop
// keyboard focus from a button the user is tabbing through.
function renderSegmented(node, options, value, onPick) {
  const signature = JSON.stringify(options)
  let cached = segmentedState.get(node)
  if (!cached || cached.signature !== signature) {
    const buttons = options.map(([id, label]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.setAttribute('aria-pressed', 'false')
      button.addEventListener('click', () => cached.onPick(id))
      return button
    })
    cached = { signature, onPick, buttons }
    segmentedState.set(node, cached)
    node.replaceChildren(...buttons)
  }
  cached.onPick = onPick
  options.forEach(([id], index) => {
    cached.buttons[index].setAttribute('aria-pressed', String(id === value))
  })
}

function render() {
  const { settings } = state
  $('version').textContent = `v${state.version}`
  renderSources()

  renderPetSettings(settings)
  $('home-path').textContent = state.paths.home
  $('log-path').textContent = state.paths.log
}

async function refresh() {
  try {
    const next = await api('/config')
    state = next
    document.body.classList.remove('offline')
    render()
  } catch {
    document.body.classList.add('offline')
  }
}

async function run(action, done) {
  try {
    const result = await action()
    if (result && result.settings) state = result
    await refresh()
    if (done) toast(done)
  } catch (error) {
    toast(error.message)
  }
}

const save = (patch) => run(() => api('/config', { patch }), '已保存')

// ---- Display and motion --------------------------------------------------

// One table drives both tabs: each row names its setting, how it is edited
// and what it does. Ranges and choices match dsh-pet-indesktop.
const percent = (value) => `${Math.round(value)}%`
const PET_TABS = [
  {
    id: 'display',
    groups: [
      ['显示', [
        { key: 'scale', label: '桌宠大小', hint: '调整桌宠在桌面上的显示尺寸。', type: 'select', options: () => state.options.scales },
        { key: 'bubbleScale', label: '气泡文字大小', hint: '气泡和文字一起等比放大，100% 为默认。', type: 'range', min: 50, max: 300, step: 10, factor: 100, format: percent },
        { key: 'petOpacity', label: '不透明度', hint: '桌宠的整体透明度；100% 为完全不透明。', type: 'range', min: 10, max: 100, step: 5, format: percent },
      ]],
      ['气泡与提示', [
        { key: 'bubbleMode', label: '气泡显示', type: 'segmented', options: () => [['auto', '自动'], ['always', '常驻'], ['custom', '仅提醒'], ['hidden', '隐藏']] },
        { key: 'whisperLevel', label: '碎碎念', type: 'segmented', options: () => [['off', '关闭'], ['low', '偶尔'], ['high', '话多']] },
        { key: 'soundEnabled', label: '完成／出错提示音', type: 'switch' },
      ]],
    ],
  },
  {
    id: 'motion',
    groups: [
      ['动画与移动', [
        { key: 'playbackSpeed', label: '播放速率', hint: '控制桌宠动画的播放速度。', type: 'select', options: () => state.options.playbackSpeeds.map((speed) => [speed, `${speed}x`]) },
        { key: 'animationGap', label: '动作等待间隔', hint: '待机动作之间再多休息几秒；0 秒表示不额外等待。', type: 'number', min: 0, max: 3600, step: 0.5, suffix: '秒' },
        { key: 'activityLevel', label: '待机动作', hint: '待机动作的频率。', type: 'segmented', options: () => [['quiet', '安静'], ['normal', '标准'], ['lively', '活泼']] },
        { key: 'powerSaving', label: '省电模式', hint: '30 秒没有操作桌宠时，动画按一半帧率播放；任何操作立即恢复。', type: 'switch' },
        { key: 'noMove', label: '不移动', hint: '桌宠不再在桌面上自己走动。', type: 'switch' },
        { key: 'reducedMotion', label: '减少动态', hint: '关掉走动、甩出、点击回弹和待机动作。', type: 'switch' },
      ]],
      ['拖拽与弹射', [
        { key: 'dragPhysics', label: '拖动物理', hint: '松手时还在快速移动就会被甩出去，受重力落下、碰到屏幕边会弹回。', type: 'switch' },
        { key: 'dropGravity', label: '静止放手下落', hint: '松手时几乎没在动，桌宠也会自然落到屏幕底部，而不是停在半空。', type: 'switch' },
        { key: 'throwStrength', label: '甩出力度', hint: '甩出或弹射时的最大速度。', type: 'segmented', options: () => [['gentle', '轻柔'], ['standard', '标准'], ['strong', '强力'], ['crazy', '疯狂']] },
        { key: 'slingshot', label: '弹弓弹射', hint: '拖着桌宠时按一下右键开始蓄力瞄准，往反方向拉，松开左键弹射出去；Esc 或再按右键取消。', type: 'switch' },
        { key: 'lockPosition', label: '锁定位置', hint: '桌宠固定不动，不能拖动；点击互动照常。', type: 'switch' },
        { key: 'shiftDrag', label: 'SHIFT+左键拖动', hint: '必须按住 SHIFT 再拖动桌宠。', type: 'switch' },
      ]],
      ['边缘探头', [
        { key: 'edgeProbe', label: '边缘探头', hint: '拖到屏幕左右边缘，桌宠会斜着探出头偷看；点它会出来待 5 秒再缩回去。', type: 'switch' },
      ]],
    ],
  },
]
const petControls = new Map()
let petTab = 'display'

function selectPetTab(next) {
  petTab = next
  for (const tab of document.querySelectorAll('[data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === petTab))
  for (const panel of document.querySelectorAll('[data-tabpanel]')) panel.hidden = panel.dataset.tabpanel !== petTab
}
for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => selectPetTab(tab.dataset.tab))
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const next = PET_TABS[(PET_TABS.findIndex((item) => item.id === petTab) + 1) % PET_TABS.length].id
    selectPetTab(next)
    $(`tab-${next}`).focus?.()
  })
}
selectPetTab(petTab)

/** Build one control; returns how to show a new value. */
function petControl(row) {
  const commit = (value) => save({ [row.key]: value })
  if (row.type === 'switch') {
    const input = el('input')
    input.type = 'checkbox'
    input.id = `setting-${row.key}`
    input.addEventListener('change', () => commit(input.checked))
    return { node: input, show: (value) => { input.checked = Boolean(value) } }
  }
  if (row.type === 'segmented') {
    const node = el('span', 'segmented')
    return { node, show: (value) => renderSegmented(node, row.options(), value, commit) }
  }
  if (row.type === 'select') {
    const select = el('select')
    select.id = `setting-${row.key}`
    select.addEventListener('change', () => commit(Number(select.value)))
    return {
      node: select,
      show(value) {
        const options = row.options()
        // A saved value outside the list still shows, as in dsh-pet-indesktop.
        const listed = options.some(([option]) => Number(option) === Number(value)) ? options : [...options, [value, String(value)]]
        select.replaceChildren(...listed.map(([option, label]) => {
          const item = el('option', '', label)
          item.value = String(option)
          return item
        }))
        select.value = String(value)
      },
    }
  }
  if (row.type === 'range') {
    const box = el('span', 'control')
    const input = el('input')
    input.type = 'range'
    input.id = `setting-${row.key}`
    Object.assign(input, { min: row.min, max: row.max, step: row.step })
    const label = el('span')
    const factor = row.factor ?? 1
    input.addEventListener('input', () => { label.textContent = row.format(Number(input.value)) })
    input.addEventListener('change', () => commit(Number(input.value) / factor))
    box.append(input, label)
    return {
      node: box,
      show(value) {
        if (document.activeElement !== input) input.value = String(Math.round(value * factor))
        label.textContent = row.format(value * factor)
      },
    }
  }
  const box = el('span', 'control')
  const input = el('input')
  input.type = 'number'
  input.id = `setting-${row.key}`
  Object.assign(input, { min: row.min, max: row.max, step: row.step })
  input.addEventListener('change', () => commit(Number(input.value)))
  box.append(input, el('span', '', row.suffix))
  return { node: box, show: (value) => { if (document.activeElement !== input) input.value = String(value) } }
}

function buildPetSettings() {
  for (const tab of PET_TABS) {
    $(`tabpanel-${tab.id}`).replaceChildren(...tab.groups.map(([title, rows]) => {
      const card = el('div', 'card')
      card.append(el('p', 'card-title', title))
      for (const row of rows) {
        const line = el('div', 'row')
        const text = el('div', 'row-text')
        const label = el('label', 'row-label', row.label)
        label.htmlFor = `setting-${row.key}`
        text.append(label)
        if (row.hint) text.append(el('span', 'row-hint', row.hint))
        const control = petControl(row)
        const box = el('div', 'control')
        box.append(control.node)
        line.append(text, box)
        card.append(line)
        petControls.set(row.key, control)
      }
      return card
    }))
  }
}

function renderPetSettings(settings) {
  if (petControls.size === 0) buildPetSettings()
  for (const [key, control] of petControls) control.show(settings[key])
}

// ---- Characters and bubble lines ---------------------------------------

async function blobUrl(path) {
  const epoch = previewEpoch
  const response = await fetch(path, { headers: { 'x-dafeiyu-token': token } })
  if (!response.ok) throw new Error('preview unavailable')
  const url = URL.createObjectURL(await response.blob())
  if (epoch !== previewEpoch) {
    // The character list was rebuilt while this preview was still loading.
    URL.revokeObjectURL(url)
    return null
  }
  blobUrls.add(url)
  return url
}

// Stop every animation and release every preview URL created for the cards
// currently on screen. Called before the list is rebuilt and on page unload.
function releasePreviews() {
  previewEpoch += 1
  for (const stop of sheetStops) stop()
  sheetStops.clear()
  for (const url of blobUrls) URL.revokeObjectURL(url)
  blobUrls.clear()
}

// Codex sheets animate their idle row on a canvas; CSP allows no inline styles.
// The returned stop function is also tracked here: the interval must die with
// the card, otherwise every refresh leaks a timer painting into a detached
// canvas. Callers may still stop early (e.g. on a failed rebuild).
function animateSheet(canvas, url, preview) {
  const image = new Image()
  let timer
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    sheetStops.delete(stop)
  }
  sheetStops.add(stop)
  image.onload = () => {
    if (stopped) return
    const context = canvas.getContext('2d')
    let frame = 0
    const draw = () => {
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, frame * preview.cell.width, preview.row * preview.cell.height,
        preview.cell.width, preview.cell.height, 0, 0, canvas.width, canvas.height)
      frame = (frame + 1) % preview.columns
    }
    draw()
    timer = setInterval(draw, preview.frameMs)
  }
  image.src = url
  return stop
}

async function renderCharacters() {
  const data = await api('/characters')
  const list = $('characters')
  // Stop the previous round before its cards leave the DOM. Keeping the old
  // cards alive when /characters fails leaves their timers valid too.
  releasePreviews()
  list.replaceChildren(...data.list.map((item) => {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'character'
    card.setAttribute('aria-pressed', String(item.id === data.current))
    const name = document.createElement('span')
    name.textContent = item.name
    const source = document.createElement('small')
    source.textContent = item.id === data.current ? '当前' : item.source === 'builtin' ? '内置' : item.source === 'skin' ? '皮肤' : 'codex-pets'
    let art
    if (item.source === 'builtin' || item.source === 'skin') {
      art = document.createElement('img')
      art.alt = item.name
      blobUrl(`/characters/preview?id=${encodeURIComponent(item.id)}`).then((url) => { if (url) art.src = url }).catch(() => {})
    } else {
      art = document.createElement('canvas')
      art.width = data.preview.cell.width
      art.height = data.preview.cell.height
      blobUrl(`/characters/preview?id=${encodeURIComponent(item.id)}`).then((url) => {
        if (url) animateSheet(art, url, data.preview)
      }).catch(() => {})
    }
    card.append(art, name, source)
    card.addEventListener('click', () => {
      if (item.id === data.current) return
      run(async () => { await api('/character', { id: item.id }); await renderCharacters() }, `已换成 ${item.name}`)
    })
    return card
  }))
}

async function renderTexts() {
  const groups = await api('/bubble-text')
  $('texts').replaceChildren(...groups.map((group) => {
    const box = document.createElement('div')
    const label = document.createElement('label')
    label.textContent = group.custom ? `${group.label}（已自定义）` : group.label
    label.htmlFor = `text-${group.key}`
    const area = document.createElement('textarea')
    area.id = `text-${group.key}`
    area.dataset.key = group.key
    area.value = group.lines.join('\n')
    box.append(label, area)
    return box
  }))
}

$('characters-refresh').addEventListener('click', () => renderCharacters().catch((error) => toast(error.message)))
$('petdex-install').addEventListener('click', () => {
  const name = $('petdex-name').value.trim()
  if (!name) return toast('先填宠物名或链接')
  $('petdex-install').disabled = true
  toast('正在从 petdex 下载…')
  run(async () => {
    const result = await api('/characters/install', { name })
    $('petdex-name').value = ''
    await renderCharacters()
    const pet = result.list.find((item) => item.id === result.installed)
    toast(`已安装 ${pet ? pet.name : name}，点它的卡片就能换上`)
  }).finally(() => { $('petdex-install').disabled = false })
})
$('texts-save').addEventListener('click', () => {
  const groups = {}
  for (const area of document.querySelectorAll('#texts textarea')) groups[area.dataset.key] = area.value.split('\n')
  run(async () => { await api('/bubble-text', { groups }); await renderTexts() }, '文案已保存')
})
$('texts-reset').addEventListener('click', () => {
  if (confirm('把所有气泡文案恢复成内置文案？')) {
    run(async () => { await api('/bubble-text', { groups: {} }); await renderTexts() }, '已恢复默认文案')
  }
})

// Closing, reloading or freezing the page into the back/forward cache all end
// up here: stop the refresh poll and tear down every per-card timer and URL.
window.addEventListener('pagehide', () => {
  clearInterval(refreshTimer)
  refreshTimer = undefined
  releasePreviews()
})

if (!token) document.body.classList.add('offline')
else {
  refresh()
  renderCharacters().catch(() => {})
  renderTexts().catch(() => {})
  refreshTimer = setInterval(refresh, 5000)
}
