/**
 * Browser half of dsh-doc-translator, hand-written in the closure-factory form
 * the client module loader expects (see `packages/client/tsdown.client.ts`):
 * no build step, React through the loader's `require`.
 *
 * It registers two things:
 *
 * - The `doc_translate` row of the conversation. While a call runs, the row
 *   opens the call's live view in the right Sidebar once. The live directory is
 *   derived from the call id and the Session working directory with the same
 *   rule as `liveDirName` in `live.js`.
 * - The live view tab (`dsh-resource://doc-translate/live/<directory>`). It polls
 *   the directory's `state.json` through the authenticated `/api/file` route and
 *   shows each page or line as it is finished: a translated page fades in over
 *   its original, a translated line fades in over its source, and the view
 *   follows the first unfinished part unless the user scrolled in the last few
 *   seconds. Images are written once by the Host, so nothing already shown is
 *   reloaded.
 */
window.__ModuleLoader__.load({
  id: 'dsh-doc-translator',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { DisclosureRow, IconGlobeOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const NS = 'doc-translator'
    const TAB_ID = 'dsh-doc-translator/live'
    const TAB_KIND = 'doc-translate-live'
    const ADDRESS_PREFIX = 'dsh-resource://doc-translate/live/'
    const LIVE_PREFIX = '.dsh-translating-'
    /** Poll period of `state.json` while the translation runs. */
    const POLL_MS = 600
    /** Polls without a `state.json` before the view says there is nothing to show. */
    const MAX_MISSES = 50
    /** A user scroll pauses following the translation for this long. */
    const FOLLOW_PAUSE_MS = 4000

    const en = {
      'row.title': 'Translate document',
      'row.preparing': 'Preparing the translation',
      'row.running': 'Translating',
      'row.ok': 'Translated',
      'row.error': 'Translation failed',
      'row.stopped': 'Translation stopped',
      'row.live': 'Show progress',
      'row.open': 'Open translation',
      'row.inspect': 'Inspect',
      'tab.title': 'Live translation',
      'tab.loading': 'Waiting for the translation to start…',
      'tab.missing': 'This translation has no live view any more.',
      'tab.running': 'Translating',
      'tab.done': 'Translated',
      'tab.failed': 'Translation failed',
      'tab.stopped': 'Translation stopped',
      'tab.pages': '{done} of {total} pages',
      'tab.lines': '{done} of {total} lines',
      'tab.open': 'Open translation',
      'tab.page': 'Page {n}',
    }
    const zh = {
      'row.title': '翻译文档',
      'row.preparing': '正在准备翻译',
      'row.running': '正在翻译',
      'row.ok': '已翻译',
      'row.error': '翻译失败',
      'row.stopped': '翻译已停止',
      'row.live': '查看进度',
      'row.open': '打开译文',
      'row.inspect': '查看',
      'tab.title': '实时翻译',
      'tab.loading': '等待翻译开始…',
      'tab.missing': '此翻译已没有实时视图。',
      'tab.running': '正在翻译',
      'tab.done': '已翻译',
      'tab.failed': '翻译失败',
      'tab.stopped': '翻译已停止',
      'tab.pages': '第 {done}/{total} 页',
      'tab.lines': '第 {done}/{total} 行',
      'tab.open': '打开译文',
      'tab.page': '第 {n} 页',
    }
    const vi = {
      'row.title': 'Dịch tài liệu',
      'row.preparing': 'Đang chuẩn bị dịch',
      'row.running': 'Đang dịch',
      'row.ok': 'Đã dịch xong',
      'row.error': 'Dịch thất bại',
      'row.stopped': 'Đã dừng dịch',
      'row.live': 'Xem tiến độ',
      'row.open': 'Mở bản dịch',
      'row.inspect': 'Xem chi tiết',
      'tab.title': 'Dịch trực tiếp',
      'tab.loading': 'Đang chờ bắt đầu dịch…',
      'tab.missing': 'Bản dịch này không còn bản xem trực tiếp.',
      'tab.running': 'Đang dịch',
      'tab.done': 'Đã dịch xong',
      'tab.failed': 'Dịch thất bại',
      'tab.stopped': 'Đã dừng dịch',
      'tab.pages': '{done}/{total} trang',
      'tab.lines': '{done}/{total} dòng',
      'tab.open': 'Mở bản dịch',
      'tab.page': 'Trang {n}',
    }

    const CSS = `
.dshdt-root{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2,#f5f5f5);color:var(--dsw-alias-label-primary,#222);font-family:var(--dsw-font,inherit)}
.dshdt-head{flex:none;padding:10px 14px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));background:var(--dsw-alias-bg-base,#fff)}
.dshdt-line{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px}
.dshdt-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dshdt-status{flex:none;color:var(--dsw-alias-label-secondary,#666)}
.dshdt-status[data-state=failed]{color:var(--dsw-alias-state-error-primary,#d33)}
.dshdt-open{flex:none;padding:2px 8px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.2));border-radius:var(--dsw-radius-sm,4px);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dshdt-open:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dshdt-bar{height:3px;margin-top:8px;border-radius:2px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.08));overflow:hidden}
.dshdt-fill{height:100%;background:var(--dsw-alias-brand-primary,#4d6bfe);transition:width .6s cubic-bezier(.2,.7,.2,1)}
.dshdt-body{flex:1;min-height:0;overflow:auto;padding:14px;overscroll-behavior:contain}
.dshdt-empty{padding:24px 14px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px}
.dshdt-error{margin-top:6px;font-size:12px;color:var(--dsw-alias-state-error-primary,#d33);white-space:pre-wrap}
.dshdt-page{position:relative;margin:0 auto 14px;max-width:100%;background:#fff;border-radius:var(--dsw-radius-sm,4px);box-shadow:0 1px 3px rgba(0,0,0,.12);overflow:hidden}
.dshdt-img{display:block;width:100%;height:auto;user-select:none}
.dshdt-over{position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity .7s ease}
.dshdt-over[data-loaded]{opacity:1}
.dshdt-page[data-working]::after{content:"";position:absolute;left:0;right:0;top:-30%;height:30%;pointer-events:none;background:linear-gradient(180deg,transparent,rgba(77,107,254,.10),transparent);animation:dshdt-sweep 2.4s ease-in-out infinite}
.dshdt-tag{position:absolute;top:8px;right:8px;padding:1px 7px;border-radius:10px;font-size:11px;background:rgba(0,0,0,.55);color:#fff;transition:opacity .5s ease}
.dshdt-page[data-done] .dshdt-tag{opacity:0}
.dshdt-rows{max-width:760px;margin:0 auto;font-size:14px;line-height:1.6}
.dshdt-row{margin:0 0 8px;padding:6px 10px;border-radius:var(--dsw-radius-sm,4px);white-space:pre-wrap;overflow-wrap:anywhere}
.dshdt-row[data-done]{background:var(--dsw-alias-bg-base,#fff);animation:dshdt-fade .5s ease}
.dshdt-row[data-todo]{color:var(--dsw-alias-label-tertiary,#999)}
.dshdt-row[data-working]{background:linear-gradient(90deg,transparent,rgba(77,107,254,.08),transparent);background-size:200% 100%;animation:dshdt-shine 1.8s linear infinite}
@keyframes dshdt-sweep{from{top:-30%}to{top:100%}}
@keyframes dshdt-fade{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
@keyframes dshdt-shine{from{background-position:100% 0}to{background-position:-100% 0}}
@media (prefers-reduced-motion:reduce){.dshdt-page[data-working]::after,.dshdt-row[data-working],.dshdt-row[data-done]{animation:none}.dshdt-over,.dshdt-fill{transition:none}}
`

    /** Live directory of a call; mirrors `liveDirName` in live.js. */
    function liveDirName(callId) {
      return `${LIVE_PREFIX}${String(callId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}`
    }

    function joinPath(dir, name) {
      return `${dir.replace(/[/\\]+$/, '')}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`
    }

    function liveAddress(dir) {
      return `${ADDRESS_PREFIX}${encodeURIComponent(dir)}`
    }

    function dirOf(address) {
      if (typeof address !== 'string' || !address.startsWith(ADDRESS_PREFIX)) return null
      try {
        const dir = decodeURIComponent(address.slice(ADDRESS_PREFIX.length))
        return dir === '' ? null : dir
      } catch {
        return null // A malformed escape names no directory.
      }
    }

    /** Authenticated URL of a Host file; mirrors `fileMediaUrl` in dsh-util-workspace-path. */
    function mediaUrl(path) {
      return new URL(`api/file?path=${encodeURIComponent(path)}`, document.baseURI).href
    }

    /** Address of a Session file; mirrors `sessionFileAddress` in dsh-util-workspace-path. */
    function fileAddress(sessionId, path) {
      const segment = value => encodeURIComponent(value).replace(/%3A/gi, ':')
      const normalized = path.replace(/\\/g, '/')
      return `dsh-resource://file/session/${segment(sessionId)}/${normalized.split('/').map(segment).join('/')}`
    }

    function format(text, values) {
      return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
    }

    /** Parsed call arguments; streaming can expose a truncated prefix, which reads as no arguments. */
    function argsOf(raw) {
      try {
        const value = JSON.parse(raw)
        return value !== null && typeof value === 'object' ? value : {}
      } catch {
        return {}
      }
    }

    function fileName(path) {
      return path.split(/[/\\]/).pop() || path
    }

    /** The translated file and live directory recorded in the result metadata, when well-formed. */
    function metaOf(block) {
      const meta = block.meta
      if (meta === null || typeof meta !== 'object' || typeof meta.file !== 'string') return null
      return { file: meta.file, live: typeof meta.live === 'string' ? meta.live : undefined }
    }

    /** `state.json` fields this view reads, or null when the file does not have them. */
    function parseState(value) {
      if (value === null || typeof value !== 'object' || value.version !== 1) return null
      if (!['running', 'done', 'failed'].includes(value.status)) return null
      if (value.kind === 'pages' && Array.isArray(value.pages)) return value
      if (value.kind === 'segments' && Array.isArray(value.segments)) return value
      return null
    }

    /**
     * Poll `state.json` of `dir` until the translation is no longer running.
     * Re-renders only when the file content changed.
     */
    function useLiveState(dir) {
      const [view, setView] = useState({ phase: 'loading' })
      useEffect(() => {
        if (dir === null) { setView({ phase: 'missing' }); return undefined }
        let stopped = false
        let timer
        let misses = 0
        let lastText
        const poll = async () => {
          let next = true
          try {
            const response = await fetch(mediaUrl(joinPath(dir, 'state.json')), { cache: 'no-store', credentials: 'same-origin' })
            if (response.ok) {
              const text = await response.text()
              misses = 0
              if (text !== lastText) {
                lastText = text
                const state = parseState(JSON.parse(text))
                if (state === null) { if (!stopped) setView({ phase: 'missing' }); return }
                if (!stopped) setView({ phase: 'ready', state })
                if (state.status !== 'running') next = false
              }
            } else if (++misses > MAX_MISSES) {
              if (!stopped) setView({ phase: 'missing' })
              next = false
            }
          } catch {
            // A network error or a state written by another version: try again on the next poll.
          }
          if (next && !stopped) timer = setTimeout(poll, POLL_MS)
        }
        poll()
        return () => { stopped = true; clearTimeout(timer) }
      }, [dir])
      return view
    }

    /**
     * Keep the first unfinished part in view while the user is not scrolling.
     * @returns the props the scroll container spreads.
     */
    function useFollow(bodyRef, frontier, active) {
      const lastUser = useRef(0)
      useEffect(() => {
        if (!active || frontier < 0 || Date.now() - lastUser.current < FOLLOW_PAUSE_MS) return
        const target = bodyRef.current?.querySelector(`[data-index="${frontier}"]`)
        target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }, [frontier, active])
      const mark = () => { lastUser.current = Date.now() }
      return { onWheel: mark, onTouchMove: mark, onKeyDown: mark, onPointerDown: mark }
    }

    function PageView({ dir, page, index, running, t }) {
      const [loaded, setLoaded] = useState(false)
      const done = page.translated !== undefined
      return h('div', { className: 'dshdt-page', 'data-index': index, 'data-done': done || undefined, 'data-working': (running && !done) || undefined },
        h('img', { className: 'dshdt-img', src: mediaUrl(joinPath(dir, page.original)), alt: format(t('tab.page'), { n: index + 1 }), draggable: false }),
        done ? h('img', { className: 'dshdt-img dshdt-over', src: mediaUrl(joinPath(dir, page.translated)), alt: '', draggable: false, 'data-loaded': loaded || undefined, onLoad: () => setLoaded(true) }) : null,
        h('span', { className: 'dshdt-tag' }, format(t('tab.page'), { n: index + 1 })))
    }

    function SegmentRow({ row, index, working }) {
      const done = row.t !== undefined
      return h('p', {
        className: 'dshdt-row', 'data-index': index, title: done ? row.s : undefined,
        'data-done': done || undefined, 'data-todo': done ? undefined : true, 'data-working': working || undefined,
      }, done ? row.t : row.s)
    }

    /** Body of the live view tab. */
    function LiveBody(props) {
      const { useTabInfo, sessionId, t } = props
      const { tab } = useTabInfo()
      const dir = dirOf(tab.navigation?.address ?? tab.contentId)
      const view = useLiveState(dir)
      const bodyRef = useRef(null)
      const state = view.phase === 'ready' ? view.state : null
      const running = state?.status === 'running'
      const parts = state === null ? [] : state.kind === 'pages' ? state.pages : state.segments
      const isDone = part => (state.kind === 'pages' ? part.translated !== undefined : part.t !== undefined)
      const finished = state === null ? 0 : parts.filter(isDone).length
      const frontier = state === null ? -1 : parts.findIndex(part => !isDone(part))
      const follow = useFollow(bodyRef, frontier, running)

      if (view.phase !== 'ready') {
        return h('div', { className: 'dshdt-root' }, h('div', { className: 'dshdt-empty' }, t(view.phase === 'missing' ? 'tab.missing' : 'tab.loading')))
      }
      const statusKey = state.status === 'failed' && state.error === 'stopped' ? 'tab.stopped' : `tab.${state.status}`
      const count = format(t(state.kind === 'pages' ? 'tab.pages' : 'tab.lines'), { done: finished, total: parts.length })
      const percent = parts.length === 0 ? 0 : Math.round((finished / parts.length) * 100)
      return h('div', { className: 'dshdt-root' },
        h('div', { className: 'dshdt-head' },
          h('div', { className: 'dshdt-line' },
            h('span', { className: 'dshdt-name', title: state.source }, state.source),
            h('span', { className: 'dshdt-status', 'data-state': state.status }, `${t(statusKey)} · ${count}`),
            state.status === 'done' && typeof state.output === 'string' && sessionId !== undefined
              ? h('button', { type: 'button', className: 'dshdt-open', onClick: () => tab.actions.openResource(fileAddress(sessionId, state.output)) }, t('tab.open'))
              : null),
          h('div', { className: 'dshdt-bar' }, h('div', { className: 'dshdt-fill', style: { width: `${state.status === 'done' ? 100 : percent}%` } })),
          state.status === 'failed' && state.error && state.error !== 'stopped' ? h('div', { className: 'dshdt-error' }, state.error) : null),
        h('div', { className: 'dshdt-body', ref: bodyRef, tabIndex: -1, ...follow },
          state.kind === 'pages'
            ? state.pages.map((page, index) => h(PageView, { key: index, dir, page, index, running, t }))
            : h('div', { className: 'dshdt-rows' }, state.segments.map((row, index) => h(SegmentRow, {
              // A row remounts when it is translated, so its fade-in plays once.
              key: `${index}:${row.t !== undefined}`, row, index, working: running && index === frontier,
            })))))
    }

    function linkButton(label, onClick) {
      return h('button', {
        type: 'button',
        onClick: (event) => { event.stopPropagation(); onClick() },
        style: { marginLeft: 8, padding: '0 6px', border: '1px solid currentColor', borderRadius: 4, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer', opacity: 0.85 },
      }, label)
    }

    function icon() {
      return h(IconGlobeOutlineRegular, { size: 14 })
    }

    function noop() {}

    function PreparingRow({ t }) {
      return h('div', { 'data-tool': 'doc_translate', 'data-state': 'preparing' },
        h(DisclosureRow, { title: t('row.title'), icon: icon(), open: false, expandable: false, onToggle: noop, running: true,
          collapsedContent: h('span', null, t('row.preparing')) }))
    }

    function StartedRow({ block, callId, cwd, openFile, inspect, t, claimAutoOpen, openLive }) {
      const settled = 'kind' in block
      const args = argsOf((settled ? block.call?.argsRaw : block.argsRaw) ?? '')
      const path = typeof args.path === 'string' ? args.path : ''
      const state = !settled ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
      const meta = settled ? metaOf(block) : null
      const liveDir = meta?.live ?? (typeof cwd === 'string' && cwd !== '' ? joinPath(cwd, liveDirName(callId)) : null)
      const output = settled ? block.content.map(item => (item.type === 'text' ? item.text : JSON.stringify(item))).join('\n') : ''
      const [expanded, setExpanded] = useState(false)

      useEffect(() => {
        if (state === 'running' && liveDir !== null && claimAutoOpen(callId)) openLive(liveDir)
      }, [state, liveDir, callId])

      const actions = []
      if (liveDir !== null && (state === 'running' || meta?.live !== undefined)) actions.push(linkButton(t('row.live'), () => openLive(liveDir)))
      if (state === 'ok' && meta !== null) actions.push(linkButton(t('row.open'), () => openFile(meta.file)))
      const summary = h('span', null,
        h('span', null, t(`row.${state}`)),
        path === '' ? null : h('span', { style: { marginLeft: 6, opacity: 0.8 } }, fileName(path)),
        ...actions)
      return h('div', { 'data-tool': 'doc_translate', 'data-state': state },
        h(DisclosureRow, {
          title: t('row.title'), icon: icon(), running: state === 'running',
          open: expanded && output !== '', expandable: output !== '', expandOnRowClick: true, keepContentWhenOpen: true,
          onToggle: () => setExpanded(value => !value), collapsedContent: summary,
        },
        h('pre', { style: { whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: '12px' } }, output),
        inspect ? linkButton(t('row.inspect'), inspect) : null))
    }

    /** Keyed `tool.call.toolview` row for `doc_translate`. */
    function DocTranslateRow(props) {
      return props.phase === 'preparing' ? h(PreparingRow, props) : h(StartedRow, props)
    }

    /** Services this plugin uses. */
    const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

    /**
     * Register the dictionaries, the stylesheet, the live view tab, and the `doc_translate` row.
     * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
     */
    function apply(ctx) {
      // Calls whose live view this page already opened, so a remounted row does not reopen a tab the user closed.
      const opened = new Set()
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh, vi }), 'doc-translator: dictionaries')
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-doc-translator'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'doc-translator: stylesheet')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        patterns: [`${ADDRESS_PREFIX}**`],
        canOpen: address => dirOf(address) !== null,
        title: () => t('tab.title'),
      }), 'doc-translator: live tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS },
        LiveBody,
      )), 'doc-translator: live tab body')
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'doc_translate',
        locale: NS,
        inject: () => ({
          claimAutoOpen: (callId) => {
            if (opened.has(callId)) return false
            opened.add(callId)
            return true
          },
          openLive: dir => ctx.sidebarRight.openResource(liveAddress(dir)),
        }),
      }, DocTranslateRow))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
