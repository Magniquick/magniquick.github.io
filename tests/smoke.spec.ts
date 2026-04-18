import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function readTerminalBuffer(page: Page) {
  return await page.evaluate(() => {
    const terminal = window.__labTerminal
    if (!terminal) {
      return ''
    }

    const lines: string[] = []
    for (let index = 0; index < terminal.buffer.active.length; index += 1) {
      const line = terminal.buffer.active.getLine(index)
      if (!line) {
        continue
      }
      lines.push(line.translateToString(true))
    }
    return lines.join('\n')
  })
}

async function readPromptGlyphColor(page: Page) {
  return await page.evaluate(() => {
    const terminal = window.__labTerminal
    if (!terminal) {
      return null
    }

    const buffer = terminal.buffer.active
    const cell = buffer.getNullCell()
    for (let lineIndex = buffer.length - 1; lineIndex >= 0; lineIndex -= 1) {
      const line = buffer.getLine(lineIndex)
      if (!line) {
        continue
      }
      for (let columnIndex = 0; columnIndex < terminal.cols; columnIndex += 1) {
        const current = line.getCell(columnIndex, cell)
        if (!current || current.getChars() !== '❯') {
          continue
        }
        if (current.isFgRGB()) {
          return current.getFgColor().toString(16).padStart(6, '0')
        }
        return String(current.getFgColor())
      }
    }
    return null
  })
}

async function readFirstGlyphColorForText(page: Page, text: string) {
  return await page.evaluate((needle) => {
    const terminal = window.__labTerminal
    if (!terminal) {
      return null
    }

    const buffer = terminal.buffer.active
    const cell = buffer.getNullCell()
    for (let lineIndex = buffer.length - 1; lineIndex >= 0; lineIndex -= 1) {
      const line = buffer.getLine(lineIndex)
      if (!line) {
        continue
      }
      const textLine = line.translateToString(true)
      const columnIndex = textLine.indexOf(needle)
      if (columnIndex === -1) {
        continue
      }
      const current = line.getCell(columnIndex, cell)
      if (!current || current.isFgDefault()) {
        return 'default'
      }
      if (current.isFgRGB()) {
        return current.getFgColor().toString(16).padStart(6, '0')
      }
      return `palette:${current.getFgColor()}`
    }
    return null
  }, text)
}

async function sendCommand(page: Page, command: string) {
  const promptSerialBefore = await page.evaluate(() => window.__labRuntimeState?.promptSerial ?? 0)
  const input = page.locator('.xterm-helper-textarea')
  await input.focus()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => await page.evaluate(() => window.__labRuntimeState?.promptSerial ?? 0))
    .toBeGreaterThan(promptSerialBefore)
}

async function sendCommandAndReadNewOutput(page: Page, command: string) {
  const before = await readTerminalBuffer(page)
  await sendCommand(page, command)
  const after = await readTerminalBuffer(page)
  return after.slice(before.length)
}

test('runtime lab boots and executes shared shell/python commands', async ({ page }) => {
  const unique = Date.now().toString(36)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })

  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { name: /Magniquick/ })).toBeVisible()
  await expect(page.locator('.terminal-host')).toBeVisible()

  await expect
    .poll(async () => await readTerminalBuffer(page), {
      timeout: 60_000,
    })
    .toContain('Magniquick runtime lab')

  await expect
    .poll(async () => await readTerminalBuffer(page), {
      timeout: 60_000,
    })
    .toContain('magniquick@lab:~')

  await expect
    .poll(async () => await readTerminalBuffer(page), {
      timeout: 60_000,
    })
    .toContain('❯')

  await sendCommand(page, 'echo $SHELL')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('/bin/jsh-lite')

  await sendCommand(page, 'env FOO=bar printenv FOO')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('bar')

  await sendCommand(page, 'env -u HOME printenv HOME')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('magniquick@lab:~')

  await sendCommand(page, 'ls -lah /home/magni')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('README.txt')

  await sendCommand(page, 'ls')
  const bareLsOutput = await readTerminalBuffer(page)
  expect(bareLsOutput).toContain('README.txt')
  expect(bareLsOutput).toContain('welcome.py')
  expect(bareLsOutput).not.toContain('bin  home  tmp')
  await expect.poll(async () => await readFirstGlyphColorForText(page, 'README.txt')).not.toBe('default')

  await sendCommand(page, 'ls /bin')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('ls')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('python')

  await sendCommand(page, 'tree /home/magni')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('README.txt')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('welcome.py')

  const input = page.locator('.xterm-helper-textarea')
  await input.focus()
  const promptSerialBeforeTab = await page.evaluate(() => window.__labRuntimeState?.promptSerial ?? 0)
  await page.keyboard.type('cat wel')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => await page.evaluate(() => window.__labRuntimeState?.promptSerial ?? 0))
    .toBeGreaterThan(promptSerialBeforeTab)
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('Magniquick lab')

  await input.focus()
  const promptSerialBeforeListTab = await page.evaluate(() => window.__labRuntimeState?.promptSerial ?? 0)
  await page.keyboard.type('ls ./')
  await page.keyboard.press('Tab')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('README.txt')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => await page.evaluate(() => window.__labRuntimeState?.promptSerial ?? 0))
    .toBeGreaterThan(promptSerialBeforeListTab)

  await sendCommand(page, 'echo -e "alpha\\nbeta" > /home/magni/grep.txt')
  await sendCommand(page, 'grep -n beta /home/magni/grep.txt')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('2:beta')

  await sendCommand(page, 'cat -n /home/magni/grep.txt')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('     1  alpha')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('     2  beta')

  await sendCommand(page, 'pwd')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('/home/magni')
  await sendCommand(page, 'cat /home/magni/.jsh_history')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('pwd')
  await sendCommand(page, 'cd /tmp')
  await sendCommand(page, 'cd -')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('/home/magni')

  await sendCommand(page, 'cd /tmp')
  await sendCommand(page, 'echo cwd-hi > rel.txt && cat rel.txt')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('cwd-hi')
  await sendCommand(page, 'mkdir wasi-scratch && touch wasi-scratch/a && ls wasi-scratch')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('a')
  await sendCommand(page, 'ls -l wasi-scratch')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('a')
  await sendCommand(page, 'cp -R wasi-scratch wasi-copy && ls wasi-copy')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('a')
  await sendCommand(page, 'echo numeric > 1 && cat -n 1')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('numeric')
  await sendCommand(page, `echo -e "zeta\\nalpha" > sortin-${unique} && sort -o sorted-rel-${unique} sortin-${unique}`)
  expect(await sendCommandAndReadNewOutput(page, `cat sorted-rel-${unique}`)).toContain('alpha\nzeta')
  expect(await sendCommandAndReadNewOutput(page, `cat /sorted-rel-${unique}`)).toContain(`/sorted-rel-${unique}: No such file`)
  await sendCommand(page, `touch refdate-${unique}`)
  expect(await sendCommandAndReadNewOutput(page, `date -r refdate-${unique} +DATE_REL_OK`)).toContain('DATE_REL_OK')
  expect(await sendCommandAndReadNewOutput(page, `date -rrefdate-${unique} +DATE_REL_ATTACHED_OK`)).toContain(
    'DATE_REL_ATTACHED_OK',
  )
  await sendCommand(page, `echo 2026-04-18 > dates-${unique}`)
  expect(await sendCommandAndReadNewOutput(page, `date -f dates-${unique} +%Y`)).toContain('2026')
  expect(await sendCommandAndReadNewOutput(page, `date --file=dates-${unique} +%Y`)).toContain('2026')
  await sendCommand(page, `echo -e "one\\ntwo" > cinput-${unique} && csplit -f piece-rel-${unique} cinput-${unique} /two/`)
  expect(await sendCommandAndReadNewOutput(page, `ls piece-rel-${unique}00`)).toContain(`piece-rel-${unique}00`)
  expect(await sendCommandAndReadNewOutput(page, `ls /piece-rel-${unique}00`)).toContain(`'/piece-rel-${unique}00': No such file`)
  await sendCommand(page, `sort -osorted-attached-${unique} sortin-${unique}`)
  expect(await sendCommandAndReadNewOutput(page, `cat sorted-attached-${unique}`)).toContain('alpha\nzeta')
  expect(await sendCommandAndReadNewOutput(page, `cat /sorted-attached-${unique}`)).toContain(
    `/sorted-attached-${unique}: No such file`,
  )
  expect(await sendCommandAndReadNewOutput(page, 'cat definitely-missing')).toContain(
    'cat: definitely-missing: No such file',
  )
  await sendCommand(page, 'touch .__jsh_cwd__ && ls -a')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('.__jsh_cwd__')
  await sendCommand(page, 'cat /home/magni/README.txt')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('Magniquick')
  await sendCommand(page, 'cd /home/magni')

  await sendCommand(page, 'false')
  await expect.poll(async () => await readPromptGlyphColor(page)).toBe('f38ba8')

  expect(await sendCommandAndReadNewOutput(page, 'head -n 1 /home/magni/grep.txt')).toContain('alpha')

  expect(await sendCommandAndReadNewOutput(page, 'tail -n 1 /home/magni/grep.txt')).toContain('beta')

  await sendCommand(page, 'sort -r /home/magni/grep.txt')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('beta\nalpha')

  await sendCommand(page, 'which jq curl ls')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('/bin/jq')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('/bin/curl')

  await sendCommand(page, 'echo \'{"name":"magni"}\' | jq -r .name')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('magni')

  await sendCommand(page, 'echo hi | xxd')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('00000000:')

  await sendCommand(page, 'hostname')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('lab')

  await sendCommand(page, 'neofetch')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('Magniquick Runtime Lab')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('/bin/jsh-lite')

  await sendCommand(page, 'less /home/magni/README.txt')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('-- end --')
  await sendCommand(page, 'q')
  await sendCommand(page, 'true')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('magniquick@lab:~')
  await expect.poll(async () => await readPromptGlyphColor(page)).toBe('a6e3a1')

  await sendCommand(page, `mkdir /tmp/firstgone-${unique} && cd /tmp/firstgone-${unique} && rm -r /tmp/firstgone-${unique}`)
  await sendCommand(page, 'python -c "print(1)"')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain(`/tmp/firstgone-${unique}: no such directory`)
  await sendCommand(page, 'cd /home/magni')
  await sendCommand(page, `echo "print(42)" > bootfail-${unique}.py`)
  expect(await sendCommandAndReadNewOutput(page, `python bootfail-${unique}.py`)).toContain('42')
  await sendCommand(page, 'python')
  expect(await sendCommandAndReadNewOutput(page, 'print(99)')).toContain('99')
  await sendCommand(page, 'exit()')
  await sendCommand(page, 'cd /tmp')
  await sendCommand(
    page,
    `echo files0 > file0-${unique} && python -c "open('list0-${unique}','wb').write(b'file0-${unique}\\0')"`,
  )
  expect(await sendCommandAndReadNewOutput(page, `wc --files0-from=list0-${unique}`)).toContain(`file0-${unique}`)
  expect(await sendCommandAndReadNewOutput(page, `sort --files0-from=list0-${unique}`)).toContain('files0')
  await sendCommand(page, `echo -e "a\\na\\nb" > uniqin-${unique}`)
  expect(await sendCommandAndReadNewOutput(page, `uniq uniqin-${unique}`)).toContain('a\nb')
  await sendCommand(page, `printf A > odin-${unique}`)
  expect(await sendCommandAndReadNewOutput(page, `od -An -tx1 odin-${unique}`)).toContain('41')
  await sendCommand(page, `printf "c\\nd\\n" | split -l 1 - pipepart-${unique}-`)
  expect(await sendCommandAndReadNewOutput(page, `ls pipepart-${unique}-aa`)).toContain(`pipepart-${unique}-aa`)
  expect(await sendCommandAndReadNewOutput(page, `ls /pipepart-${unique}-aa`)).toContain(
    `/pipepart-${unique}-aa': No such file`,
  )
  await sendCommand(page, 'cd /home/magni')

  await sendCommand(page, 'python -c "print(7 * 6)"')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('42')

  await sendCommand(page, 'echo "print(42)" | python > /home/magni/foobar')
  await sendCommand(page, 'echo "print(42)" | python >> /home/magni/foobar')
  await sendCommand(page, 'cat /home/magni/foobar')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('42\n42')

  await sendCommand(page, 'echo "from shell" > /home/magni/shared.txt')
  await sendCommand(page, "python -c \"print(open('/home/magni/shared.txt').read())\"")
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('from shell')

  await sendCommand(page, "python -c \"open('/home/magni/py.txt','w').write('from python')\"")
  await sendCommand(page, 'cat /home/magni/py.txt')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('from python')

  await sendCommand(page, 'cd /tmp')
  await sendCommand(page, 'python -c "import os; print(os.getcwd())"')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('/tmp')
  await sendCommand(page, 'python -c "open(\'py-rel.txt\',\'w\').write(\'ok\')"')
  await sendCommand(page, 'cat /tmp/py-rel.txt')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('ok')
  await sendCommand(page, 'cd /home/magni')

  await sendCommand(page, 'python')
  await sendCommand(page, 'import os')
  await sendCommand(page, "os.chdir('/tmp')")
  await sendCommand(page, 'print(os.getcwd())')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('/tmp')
  await sendCommand(page, 'exit()')

  await sendCommand(page, 'mkdir /tmp/gone && cd /tmp/gone && rm -r /tmp/gone')
  await sendCommand(page, 'python -c "open(\'x\',\'w\').write(\'z\')"')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('/tmp/gone: no such directory')
  expect(await sendCommandAndReadNewOutput(page, 'python -c "print(1)"; echo after-deleted-cwd')).toContain('after-deleted-cwd')
  await sendCommand(page, 'cd /home/magni')

  await sendCommand(page, 'tail --help')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('Print the last')

  await sendCommand(page, 'echo hi > /tmp/x && cat /tmp/x')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('hi')

  await sendCommand(page, 'mkdir /home/magni/scratch && ls /home/magni')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('scratch')

  await sendCommand(page, 'echo hi | wc -l')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('1')

  await sendCommand(page, 'seq 3')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('1\n2\n3')

  await sendCommand(page, "echo 'unterminated")
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('unexpected EOF while parsing shell input')

  await sendCommand(page, 'echo draft-value')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('draft-value')

  await input.focus()
  await page.keyboard.press('Control+r')
  await page.keyboard.type('printenv FOO')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain("(reverse-i-search)")
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('env FOO=bar printenv FOO')
  await page.keyboard.press('Enter')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('bar')

  await sendCommand(page, 'echo -e "alpha\\nbeta\\ngamma\\nbeta again" > /home/magni/search.txt')
  await sendCommand(page, 'less /home/magni/search.txt')
  await sendCommand(page, '/beta')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('beta')
  await sendCommand(page, 'n')
  await expect.poll(async () => await readTerminalBuffer(page)).toContain('beta again')
  await sendCommand(page, 'q')

  await sendCommand(page, 'ls /home/magni')
  const lsOutput = await readTerminalBuffer(page)
  expect(lsOutput).toContain('README.txt')
  expect(lsOutput).toContain('welcome.py')
  expect(lsOutput).toMatch(/README\.txt\s+welcome\.py|welcome\.py\s+README\.txt/)

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
