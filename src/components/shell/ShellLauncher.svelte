<svelte:options runes={true} />

<script lang="ts">
  // The ./shell --wasm tile. Shows a lightweight boot prompt inline; the heavy terminal
  // (xterm + pyodide worker) is only mounted on first click, in a portalled overlay.
  //
  // Cross-origin isolation (for pyodide's SharedArrayBuffer Ctrl-C) is deferred to launch
  // time: we register the coi service worker and reload ONLY when someone actually boots
  // the shell — so visitors who never open the terminal never pay a reload. The reload is
  // one-time; an autoboot flag reopens the terminal after it so it stays a single click.
  import { onMount } from 'svelte'
  import Terminal from './Terminal.svelte'

  const SW_URL = `${import.meta.env.BASE_URL}coi-serviceworker.js`
  // localStorage, NOT sessionStorage: gaining cross-origin isolation (COOP: same-origin)
  // swaps the browsing-context group and hands the reloaded page a fresh sessionStorage,
  // wiping the flag exactly when isolation succeeds. localStorage is per-origin and
  // survives the swap. The timestamp lets us ignore a stale flag on a later visit.
  const AUTOBOOT_KEY = 'shell:autoboot'
  const AUTOBOOT_TTL = 30_000

  let launched = $state(false) // has the terminal ever been booted (kept mounted after)
  let open = $state(false) // is the overlay currently visible
  let isolating = $state(false) // registering SW + about to reload

  function launch() {
    launched = true
    open = true
  }

  async function boot() {
    // Already isolated (returning visitor whose SW controls the page, or dev headers),
    // or isolation isn't achievable here → just open. Without SAB the shell still runs;
    // only Ctrl-C interrupt of a running python is unavailable.
    if (
      window.crossOriginIsolated ||
      !window.isSecureContext ||
      !('serviceWorker' in navigator)
    ) {
      launch()
      return
    }
    // Register the coi SW, then reload once it's active. That reload is served through the
    // SW with COEP/COOP → isolated; the autoboot flag (in localStorage) reopens us after.
    isolating = true
    localStorage.setItem(AUTOBOOT_KEY, String(Date.now()))
    try {
      await navigator.serviceWorker.register(SW_URL)
      await navigator.serviceWorker.ready
      location.reload()
    } catch {
      localStorage.removeItem(AUTOBOOT_KEY)
      isolating = false
      launch() // fall back to a non-isolated (no Ctrl-C) session
    }
  }

  onMount(() => {
    const raw = localStorage.getItem(AUTOBOOT_KEY)
    if (!raw) return
    localStorage.removeItem(AUTOBOOT_KEY)
    if (Date.now() - Number(raw) < AUTOBOOT_TTL) launch() // just came back from the reload
  })

  function close() {
    open = false
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) close()
  }

  // Move the overlay to <body> so position:fixed isn't trapped by the window's
  // transformed .rise ancestor.
  function portal(node: HTMLElement) {
    document.body.appendChild(node)
    return {
      destroy() {
        node.remove()
      },
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<button class="boot" type="button" onclick={boot} disabled={isolating} aria-haspopup="dialog">
  <span class="lede">micropython + wasm terminal</span>
  <span class="cmd"><span class="prompt">$</span> ./shell --wasm<span class="cursor">▸</span></span>
  <span class="hint">{isolating ? 'booting…' : 'click to boot — xterm.js shell w/ python, coreutils & more, all client-side'}</span>
</button>

{#if launched}
  <div class="overlay" class:open use:portal role="dialog" aria-modal="true" aria-label="./shell --wasm terminal">
    <button class="backdrop" type="button" aria-label="Close terminal" onclick={close}></button>
    <div class="modal">
      <div class="modal-bar">
        <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="name">./shell --wasm</span>
        <button class="x" type="button" onclick={close} aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <Terminal />
      </div>
    </div>
  </div>
{/if}

<style>
  .boot {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    text-align: left;
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    background: transparent;
    border: 1px dashed var(--line);
    border-radius: 7px;
    padding: 12px 13px;
    cursor: pointer;
    color: var(--txt-2);
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .boot:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, transparent);
  }
  .boot .lede {
    font-size: 13px;
    color: var(--txt-3);
  }
  .boot .cmd {
    font-size: 15px;
    color: var(--txt-1);
    letter-spacing: -0.01em;
  }
  .boot .prompt {
    color: var(--accent);
    margin-right: 6px;
  }
  .boot .cursor {
    color: var(--accent);
    margin-left: 6px;
    animation: blink 1.1s steps(1) infinite;
  }
  .boot:hover .cursor {
    color: var(--accent);
  }
  .boot .hint {
    font-size: 11.5px;
    color: var(--txt-3);
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .boot .cursor {
      animation: none;
    }
  }

  .overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 4vh 3vw;
  }
  .overlay.open {
    display: flex;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: rgba(0, 0, 0, 0.62);
    backdrop-filter: blur(2px);
    cursor: pointer;
  }
  .modal {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(1100px, 94vw);
    height: min(680px, 88vh);
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 9px;
    overflow: hidden;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
  }
  .modal-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--bg-3) 55%, transparent);
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
  }
  .modal-bar .dots {
    display: inline-flex;
    gap: 6px;
  }
  .modal-bar .dots i {
    width: 11px;
    height: 11px;
    border: 1px solid var(--line);
    border-radius: 50%;
  }
  .modal-bar .name {
    flex: 1;
    font-size: 13px;
    color: var(--txt-2);
  }
  .modal-bar .x {
    font: inherit;
    font-size: 13px;
    color: var(--txt-3);
    background: transparent;
    border: 0;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .modal-bar .x:hover {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .modal-body {
    flex: 1;
    min-height: 0;
  }
</style>
