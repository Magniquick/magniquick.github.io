import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
// Source extracted from the original Asciimation applet archive:
// https://www.asciimation.co.nz/asciimation/SwPlay.jar -> data/sw1.txt
const sourcePath = path.join(projectRoot, 'src', 'jokes', 'original', 'sw1.txt')
const outputDir = path.join(projectRoot, 'src', 'jokes', 'generated')
const outputPath = path.join(outputDir, 'starwars-frames.json')

function buildFrames(source) {
  const lines = source.split(/\r?\n/)
  const frames = []

  for (let index = 0; index < lines.length; index += 14) {
    const chunk = lines.slice(index, index + 14)
    if (chunk.length < 14) {
      break
    }

    const frameDelay = Number.parseInt(chunk[0], 10)
    if (!Number.isFinite(frameDelay)) {
      continue
    }

    frames.push({
      delayMs: Math.max(1, frameDelay) * 67,
      body: chunk.slice(1).join('\n'),
    })
  }

  return frames
}

const source = await readFile(sourcePath, 'utf8')
const frames = buildFrames(source)

await mkdir(outputDir, { recursive: true })
await writeFile(outputPath, `${JSON.stringify(frames, null, 2)}\n`)
