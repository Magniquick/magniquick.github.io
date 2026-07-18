<svelte:options runes={true} />

<script lang="ts">
  // Ported from the standalone shell repo's src/routes/+page.svelte. The line-editing
  // logic (cursor movement, history, reverse-i-search, tab completion) is unchanged;
  // only the outer chrome and theme were adapted to sit inside the site's window overlay.
  // Control bytes are written as \u escapes throughout (raw ESC can't survive the editor).
  import type { FitAddon } from '@xterm/addon-fit'
  import type { SearchAddon } from '@xterm/addon-search'
  import type { Terminal } from '@xterm/xterm'
  import '@catppuccin/palette/css/catppuccin.css'
  import '@xterm/xterm/css/xterm.css'
  import type { RuntimeEvent, RuntimeRequest } from '../../shell/runtimeProtocol'

  const lineBreak = /\r?\n/g

  function normalizeForTerminal(text: string) {
    return text.replace(lineBreak, '\r\n')
  }

  function promptLineCount(prompt: string) {
    return Math.max(1, prompt.split(/\r?\n/).length)
  }

  function stripAnsi(text: string) {
    return text.replace(/\[[0-9;]*m/g, '')
  }

  function readThemeToken(name: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }

  function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max)
  }

  function computeTerminalFontSize(host: HTMLDivElement) {
    const usableWidth = Math.max(host.clientWidth - 32, 320)
    const usableHeight = Math.max(host.clientHeight - 24, 240)
    const widthBound = usableWidth / 92
    const heightBound = usableHeight / 30
    return Math.round(clamp(Math.min(widthBound, heightBound), 11, 16))
  }

  let terminalHost = $state<HTMLDivElement | null>(null)
  let status = $state('booting runtime')
  let searchValue = $state('')
  let searchOpen = $state(false)

  let worker: Worker | null = null
  let terminal: Terminal | null = null
  let fitAddon: FitAddon | null = null
  let searchAddon: SearchAddon | null = null
  let prompt = ''
  let input = ''
  let cursor = 0
  let history: string[] = []
  let historyIndex = 0
  let historyDraft = ''
  let historySearchActive = false
  let historySearchQuery = ''
  let historySearchIndex = -1
  let historySearchOriginalInput = ''
  let busy = false
  let ready = false
  let completionPending = false
  let completionCommitQueued = false
  let renderedInputLines = 1

  function runSearch() {
    if (!searchValue.trim()) return
    searchAddon?.findNext(searchValue)
  }

  function handleSearchInput(event: Event) {
    searchValue = (event.currentTarget as HTMLInputElement).value
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') runSearch()
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      searchOpen = true
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'c') {
      const selection = terminal?.getSelection()
      if (selection) {
        event.preventDefault()
        void navigator.clipboard.writeText(selection).then(() => {
          terminal?.clearSelection()
        })
      }
    }
  }

  $effect(() => {
    if (!terminalHost) return

    let disposed = false
    let resizeObserver: ResizeObserver | null = null
    let onDataDispose: { dispose: () => void } | null = null

    const mountTerminal = async () => {
      const [{ Terminal }, { FitAddon }, { SearchAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-search'),
        import('@xterm/addon-web-links'),
      ])

      if (disposed || !terminalHost) return

      terminal = new Terminal({
        allowTransparency: true,
        convertEol: true,
        cursorBlink: true,
        // Match the site's mono stack; ANSI colors below stay Catppuccin for program output.
        fontFamily: '"IBM Plex Mono", ui-monospace, "Cascadia Code", monospace',
        fontSize: 14,
        lineHeight: 1.4,
        letterSpacing: 0.2,
        theme: {
          // chrome tuned to the site palette; program colors keep the Catppuccin ANSI set
          background: '#191919',
          foreground: '#e4e4e4',
          cursor: '#58e1ff',
          cursorAccent: '#191919',
          selectionBackground: 'rgba(88, 225, 255, 0.22)',
          scrollbarSliderBackground: 'rgba(120,120,120,0.22)',
          scrollbarSliderHoverBackground: 'rgba(120,120,120,0.38)',
          scrollbarSliderActiveBackground: 'rgba(88,225,255,0.5)',
          black: readThemeToken('--ctp-mocha-surface1'),
          red: readThemeToken('--ctp-mocha-red'),
          green: readThemeToken('--ctp-mocha-green'),
          yellow: readThemeToken('--ctp-mocha-yellow'),
          blue: readThemeToken('--ctp-mocha-blue'),
          magenta: readThemeToken('--ctp-mocha-pink'),
          cyan: readThemeToken('--ctp-mocha-teal'),
          white: readThemeToken('--ctp-mocha-subtext0'),
          brightBlack: readThemeToken('--ctp-mocha-overlay0'),
          brightRed: readThemeToken('--ctp-mocha-red'),
          brightGreen: readThemeToken('--ctp-mocha-green'),
          brightYellow: readThemeToken('--ctp-mocha-yellow'),
          brightBlue: readThemeToken('--ctp-mocha-blue'),
          brightMagenta: readThemeToken('--ctp-mocha-pink'),
          brightCyan: readThemeToken('--ctp-mocha-teal'),
          brightWhite: readThemeToken('--ctp-mocha-subtext1'),
        },
        linkHandler: {
          activate(event, uri) {
            event.preventDefault()
            try {
              const url = new URL(uri)
              if (url.protocol !== 'http:' && url.protocol !== 'https:') return
              const trusted = url.hostname === 'xkcd.com' || url.hostname.endsWith('.xkcd.com')
              if (trusted || window.confirm(`Open ${uri}?`)) {
                window.open(uri, '_blank', 'noopener,noreferrer')
              }
            } catch {
              // ignore invalid links
            }
          },
        },
      })

      fitAddon = new FitAddon()
      searchAddon = new SearchAddon()
      const webLinksAddon = new WebLinksAddon((event, uri) => {
        event.preventDefault()
        try {
          const url = new URL(uri)
          if (url.protocol === 'https:' || url.protocol === 'http:') {
            window.open(uri, '_blank', 'noopener,noreferrer')
          }
        } catch {
          // ignore invalid links
        }
      })

      terminal.loadAddon(fitAddon)
      terminal.loadAddon(searchAddon)
      terminal.loadAddon(webLinksAddon)
      terminal.open(terminalHost)

      worker = new Worker(new URL('../../shell/runtimeWorker.ts', import.meta.url), { type: 'module' })

      const write = (text: string) => {
        terminal?.write(normalizeForTerminal(text))
      }

      function syncTerminalMetrics() {
        if (!terminal || !fitAddon || !terminalHost) return
        const nextFontSize = computeTerminalFontSize(terminalHost)
        if (terminal.options.fontSize !== nextFontSize) {
          terminal.options.fontSize = nextFontSize
          terminal.refresh(0, Math.max(terminal.rows - 1, 0))
        }
        fitAddon.fit()
        if (worker) {
          postToWorker({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
        }
      }

      const currentPrompt = () => {
        if (!historySearchActive) return prompt
        return `[38;2;245;194;231m(reverse-i-search)[0m \`${historySearchQuery}\': `
      }

      const redrawInput = () => {
        if (!terminal) return
        const tailOffset = input.length - cursor
        const activePrompt = currentPrompt()
        const promptLines = promptLineCount(stripAnsi(activePrompt))
        const linesToClear = Math.max(renderedInputLines, promptLines)
        terminal.write('[2K\r')
        for (let index = 1; index < linesToClear; index += 1) {
          terminal.write('[1A[2K\r')
        }
        terminal.write(`${activePrompt}${input}`)
        renderedInputLines = promptLines
        if (tailOffset > 0) {
          terminal.write(`[${tailOffset}D`)
        }
      }

      const updateReverseSearch = (direction: -1 | 1 = -1) => {
        const query = historySearchQuery
        if (!query) {
          historySearchIndex = -1
          input = historySearchOriginalInput
          cursor = input.length
          redrawInput()
          return
        }
        const startIndex =
          historySearchIndex >= 0
            ? historySearchIndex + direction
            : direction < 0
              ? history.length - 1
              : 0
        let nextIndex = -1
        if (direction < 0) {
          for (let index = startIndex; index >= 0; index -= 1) {
            if ((history[index] ?? '').includes(query)) {
              nextIndex = index
              break
            }
          }
        } else {
          for (let index = startIndex; index < history.length; index += 1) {
            if ((history[index] ?? '').includes(query)) {
              nextIndex = index
              break
            }
          }
        }
        historySearchIndex = nextIndex
        input = nextIndex >= 0 ? (history[nextIndex] ?? '') : historySearchOriginalInput
        cursor = input.length
        redrawInput()
      }

      const startReverseSearch = () => {
        if (historySearchActive) {
          updateReverseSearch(-1)
          return
        }
        historySearchActive = true
        historySearchQuery = ''
        historySearchIndex = -1
        historySearchOriginalInput = input
        redrawInput()
      }

      const acceptReverseSearch = () => {
        historySearchActive = false
        historySearchQuery = ''
        historySearchOriginalInput = ''
        historySearchIndex = -1
        historyDraft = input
        historyIndex = history.length
        redrawInput()
      }

      const cancelReverseSearch = () => {
        historySearchActive = false
        input = historySearchOriginalInput
        cursor = input.length
        historySearchQuery = ''
        historySearchOriginalInput = ''
        historySearchIndex = -1
        redrawInput()
      }

      const postToWorker = (message: RuntimeRequest) => {
        worker?.postMessage(message)
      }

      syncTerminalMetrics()

      const commitInput = () => {
        const line = input
        terminal?.write('\r\n')
        input = ''
        cursor = 0
        busy = true
        status = 'running'
        postToWorker({ type: 'input', line })
      }

      const interrupt = () => {
        input = ''
        cursor = 0
        terminal?.write('^C\r\n')
        busy = false
        status = 'interrupt'
        postToWorker({ type: 'interrupt' })
      }

      onDataDispose = terminal.onData((data) => {
        if (!ready) return

        if (data === '') {
          interrupt()
          return
        }
        if (data === '') {
          postToWorker({ type: 'clear' })
          return
        }
        if (busy) return

        if (historySearchActive) {
          if (data === '') {
            updateReverseSearch(-1)
            return
          }
          if (data === '' || data === '') {
            cancelReverseSearch()
            return
          }
          if (data === '\r') {
            acceptReverseSearch()
            return
          }
          if (data === '') {
            historySearchQuery = historySearchQuery.slice(0, -1)
            historySearchIndex = -1
            updateReverseSearch(-1)
            return
          }
          if (data >= ' ') {
            historySearchQuery += data
            historySearchIndex = -1
            updateReverseSearch(-1)
            return
          }
          return
        }

        if (data === '\r') {
          if (completionPending) {
            completionCommitQueued = true
            return
          }
          commitInput()
          return
        }
        if (data === '\t') {
          completionPending = true
          postToWorker({ type: 'complete', line: input, cursor })
          return
        }
        if (data === '') {
          startReverseSearch()
          return
        }
        if (data === '') {
          if (cursor > 0) {
            if (cursor === input.length) {
              input = input.slice(0, -1)
              cursor -= 1
              terminal?.write('\b \b')
            } else {
              input = input.slice(0, cursor - 1) + input.slice(cursor)
              cursor -= 1
              redrawInput()
            }
          }
          return
        }
        if (data === '[A') {
          if (history.length === 0) return
          if (historyIndex === history.length) historyDraft = input
          historyIndex = Math.max(0, historyIndex - 1)
          input = history[historyIndex] ?? ''
          cursor = input.length
          redrawInput()
          return
        }
        if (data === '[B') {
          if (history.length === 0) return
          historyIndex = Math.min(history.length, historyIndex + 1)
          input = historyIndex === history.length ? historyDraft : (history[historyIndex] ?? '')
          cursor = input.length
          redrawInput()
          return
        }
        if (data === '[D') {
          if (cursor > 0) {
            cursor -= 1
            terminal?.write('[D')
          }
          return
        }
        if (data === '[C') {
          if (cursor < input.length) {
            cursor += 1
            terminal?.write('[C')
          }
          return
        }
        if (data === '[H' || data === '') {
          cursor = 0
          redrawInput()
          return
        }
        if (data === '[F' || data === '') {
          cursor = input.length
          redrawInput()
          return
        }
        if (data === '[3~') {
          if (cursor < input.length) {
            input = input.slice(0, cursor) + input.slice(cursor + 1)
            redrawInput()
          }
          return
        }
        if (data >= ' ') {
          if (historyIndex === history.length) historyDraft = ''
          if (cursor === input.length) {
            input += data
            cursor += data.length
            terminal?.write(data)
          } else {
            input = input.slice(0, cursor) + data + input.slice(cursor)
            cursor += data.length
            redrawInput()
          }
        }
      })

      resizeObserver = new ResizeObserver(() => {
        syncTerminalMetrics()
      })
      resizeObserver.observe(terminalHost)

      const handleWorkerMessage = (event: MessageEvent<RuntimeEvent>) => {
        const message = event.data
        switch (message.type) {
          case 'ready':
            ready = true
            status = 'ready'
            return
          case 'stdout':
            write(message.data)
            return
          case 'stderr':
            write(`[31m${message.data}[0m`)
            return
          case 'prompt':
            busy = false
            prompt = message.value
            history = message.history
            input = ''
            historyDraft = ''
            historySearchActive = false
            historySearchQuery = ''
            historySearchOriginalInput = ''
            historySearchIndex = -1
            cursor = 0
            historyIndex = history.length
            terminal?.write(message.value)
            renderedInputLines = promptLineCount(stripAnsi(message.value))
            status = 'ready'
            return
          case 'completion':
            completionPending = false
            input = message.line
            cursor = message.cursor
            if (message.suggestions && message.suggestions.length > 1) {
              terminal?.write(`\r\n${message.suggestions.join('  ')}\r\n`)
            }
            redrawInput()
            if (completionCommitQueued) {
              completionCommitQueued = false
              commitInput()
            }
            return
          case 'clear':
            terminal?.clear()
            return
          case 'busy':
            busy = message.value
            status = message.value ? 'running' : 'ready'
            return
          case 'fs-warning':
            write(`[33m${message.message}[0m\r\n`)
            return
          case 'exit':
            status = message.code === 0 ? 'ready' : `exit ${message.code}`
            return
          case 'fatal':
            write(`[31m${message.message}[0m\r\n`)
            status = 'fatal'
            return
        }
      }

      worker.addEventListener('message', handleWorkerMessage)
      worker.postMessage({ type: 'init' } satisfies RuntimeRequest)

      return () => {
        worker?.removeEventListener('message', handleWorkerMessage)
      }
    }

    const cleanupPromise = mountTerminal()

    return () => {
      disposed = true
      void cleanupPromise?.then((cleanup) => cleanup?.())
      resizeObserver?.disconnect()
      worker?.terminate()
      onDataDispose?.dispose()
      terminal?.dispose()
      terminal = null
      fitAddon = null
      searchAddon = null
      worker = null
      ready = false
    }
  })
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="term">
  <div class="term-actions">
    <span class="dot" data-state={status}></span>
    <span class="status">{status}</span>
    <span class="spacer"></span>
    <button type="button" onclick={() => worker?.postMessage({ type: 'clear' } satisfies RuntimeRequest)}>clear</button>
    <button type="button" onclick={() => worker?.postMessage({ type: 'reset-session' } satisfies RuntimeRequest)}>reset</button>
    <button type="button" class:active={searchOpen} onclick={() => (searchOpen = !searchOpen)}>search</button>
  </div>

  <div class="term-host" bind:this={terminalHost}></div>

  {#if searchOpen}
    <div class="term-search">
      <span class="p">/</span>
      <input
        value={searchValue}
        oninput={handleSearchInput}
        onkeydown={handleSearchKeydown}
        placeholder="find in buffer, enter to jump"
      />
      <button type="button" onclick={runSearch}>next ↵</button>
    </div>
  {/if}
</div>

<style>
  .term {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: #191919;
  }
  .term-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--line, #333);
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 12px;
    color: var(--txt-3, #888);
  }
  .term-actions .spacer {
    flex: 1;
  }
  .term-actions .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--txt-3, #888);
  }
  .term-actions .dot[data-state='ready'] {
    background: #58e1ff;
  }
  .term-actions .dot[data-state='running'] {
    background: oklch(84% 0.15 92);
  }
  .term-actions .dot[data-state='fatal'] {
    background: oklch(64% 0.2 25);
  }
  .term-actions .status {
    color: var(--txt-2, #aaa);
  }
  .term-actions button {
    font: inherit;
    color: var(--txt-3, #888);
    background: transparent;
    border: 1px solid var(--line, #333);
    border-radius: 5px;
    padding: 2px 9px;
    cursor: pointer;
  }
  .term-actions button:hover,
  .term-actions button.active {
    color: #58e1ff;
    border-color: #58e1ff;
  }
  .term-host {
    flex: 1;
    min-height: 0;
    padding: 8px 6px 6px 10px;
    overflow: hidden;
  }
  .term-host :global(.xterm) {
    height: 100%;
  }
  .term-search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-top: 1px solid var(--line, #333);
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 12.5px;
  }
  .term-search .p {
    color: #58e1ff;
  }
  .term-search input {
    flex: 1;
    font: inherit;
    color: var(--txt-1, #eee);
    background: transparent;
    border: none;
    outline: none;
  }
  .term-search button {
    font: inherit;
    color: var(--txt-3, #888);
    background: transparent;
    border: 1px solid var(--line, #333);
    border-radius: 5px;
    padding: 2px 9px;
    cursor: pointer;
  }
</style>
