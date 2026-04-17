type StreamWriter = (text: string) => void
type StopChecker = () => boolean

const CLEAR_SCREEN = '\u001b[2J\u001b[H'
const SANTA_LINK = '\u001b]8;;https://xkcd.com/838/\u0007Santa\u001b]8;;\u0007'

type RuntimeCommandResult = {
  stdout: string
  stderr: string
  status: number
  clear?: boolean
}

type ParsedFrame = {
  delayMs: number
  body: string
}

const PACMAN_FRAMES: ParsedFrame[] = [
  {
    delayMs: 120,
    body: `            .--.
           / _.-'
          \\  '-.
           '--'

           ccccc
         ccc
       ccc
     ccc
   ccc

    waka waka waka`,
  },
  {
    delayMs: 120,
    body: `            .--.
           / _.-'
          \\  '-.
           '--'

         ccccc
             ccc
               ccc
                 ccc
                   ccc

    waka waka waka`,
  },
  {
    delayMs: 120,
    body: `            .--.
           / _.-'
          \\  '-.
           '--'

       ccccc
           ccc
             ccc
               ccc
                 ccc

    waka waka waka`,
  },
  {
    delayMs: 120,
    body: `            .--.
           / _.-'
          \\  '-.
           '--'

     ccccc
         ccc
           ccc
             ccc
               ccc

    waka waka waka`,
  },
  {
    delayMs: 120,
    body: `            .--.
           / _.-'
          \\  '-.
           '--'

   ccccc
       ccc
         ccc
           ccc
             ccc

    waka waka waka`,
  },
]

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function playFrames(frames: ParsedFrame[], writeStdout: StreamWriter, shouldStop: StopChecker) {
  for (const frame of frames) {
    if (shouldStop()) {
      return { stdout: '', stderr: '', status: 130 } satisfies RuntimeCommandResult
    }
    writeStdout(`${CLEAR_SCREEN}${frame.body}\n`)
    await delay(frame.delayMs)
  }

  return { stdout: '', stderr: '', status: 0 } satisfies RuntimeCommandResult
}

function fitStarwarsFrame(body: string, cols: number, rows: number) {
  const sourceLines = body.split('\n')
  const sourceHeight = sourceLines.length
  const sourceWidth = Math.max(...sourceLines.map((line) => line.length), 0)
  const targetWidth = Math.max(20, cols)
  const targetHeight = Math.max(6, rows - 1)

  if (sourceWidth <= targetWidth && sourceHeight <= targetHeight) {
    const horizontalPad = Math.max(0, Math.floor((targetWidth - sourceWidth) / 2))
    const verticalPad = Math.max(0, Math.floor((targetHeight - sourceHeight) / 2))
    const centered = sourceLines.map((line) => `${' '.repeat(horizontalPad)}${line}`)
    return `${'\n'.repeat(verticalPad)}${centered.join('\n')}`
  }

  const widthScale = sourceWidth / targetWidth
  const heightScale = sourceHeight / targetHeight
  const scale = Math.max(widthScale, heightScale, 1)
  const scaledWidth = Math.max(1, Math.floor(sourceWidth / scale))
  const scaledHeight = Math.max(1, Math.floor(sourceHeight / scale))

  const scaledLines = Array.from({ length: scaledHeight }, (_, rowIndex) => {
    const sourceRow = Math.min(sourceHeight - 1, Math.floor((rowIndex / scaledHeight) * sourceHeight))
    const row = sourceLines[sourceRow] ?? ''
    return Array.from({ length: scaledWidth }, (_, colIndex) => {
      const sourceCol = Math.min(sourceWidth - 1, Math.floor((colIndex / scaledWidth) * sourceWidth))
      return row[sourceCol] ?? ' '
    }).join('')
  })

  const actualWidth = Math.max(...scaledLines.map((line) => line.length), 0)
  const horizontalPad = Math.max(0, Math.floor((targetWidth - actualWidth) / 2))
  const verticalPad = Math.max(0, Math.floor((targetHeight - scaledLines.length) / 2))
  const centered = scaledLines.map((line) => `${' '.repeat(horizontalPad)}${line}`)
  return `${'\n'.repeat(verticalPad)}${centered.join('\n')}`
}

async function playStarwars(writeStdout: StreamWriter, cols: number, rows: number, shouldStop: StopChecker) {
  const response = await fetch(new URL('./jokes/generated/starwars-frames.json', import.meta.url))
  if (!response.ok) {
    return {
      stdout: '',
      stderr: `starwars: failed to load local crawl data\n`,
      status: 1,
    } satisfies RuntimeCommandResult
  }

  const frames = (await response.json()) as ParsedFrame[]
  return await playFrames(
    frames.map((frame) => ({
      ...frame,
      body: fitStarwarsFrame(frame.body, cols, rows),
    })),
    writeStdout,
    shouldStop,
  )
}

export async function runJokeCommand(
  command: string,
  writeStdout: StreamWriter,
  cols = 120,
  rows = 36,
  shouldStop: StopChecker = () => false,
): Promise<RuntimeCommandResult | null> {
  switch (command) {
    case 'nix':
      return { stdout: 'Hope your therapy sessions are going well\n', stderr: '', status: 0 }
    case 'apt':
      return { stdout: 'SLEEP TOMMOROW BUT TONIGHT GO CRAZY !!!\n', stderr: '', status: 0 }
    case 'brew':
      return { stdout: 'You are drunk enough dwag.\n', stderr: '', status: 0 }
    case 'yum':
      return { stdout: 'Nom nom.\n', stderr: '', status: 0 }
    case 'miku':
      return { stdout: 'MIKU MIKU BEAMMMMMMMM\n', stderr: '', status: 0 }
    case 'sudo':
    case 'su':
      return {
        stdout: `This incident will be reported to ${SANTA_LINK}\n`,
        stderr: '',
        status: 1,
      }
    case 'pacman':
      return await playFrames(PACMAN_FRAMES, writeStdout, shouldStop)
    case 'starwars':
      return await playStarwars(writeStdout, cols, rows, shouldStop)
    default:
      return null
  }
}
