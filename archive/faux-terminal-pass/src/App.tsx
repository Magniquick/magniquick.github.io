import { FormEvent, useEffect, useRef, useState } from 'react'
import { featuredProjects, projectArchive } from './data/projects'
import { profile } from './data/profile'

type TranscriptEntry = {
  kind: 'system' | 'command' | 'output'
  content: string
}

const bootTranscript: TranscriptEntry[] = [
  { kind: 'system', content: 'booting personal site...' },
  { kind: 'system', content: 'ui mode: client-side faux terminal' },
  { kind: 'system', content: 'type `help` to inspect available commands' },
]

const commandHints = ['help', 'whoami', 'ls projects', 'cat about', 'cat featured', 'open github', 'clear']

function formatFeatured() {
  return featuredProjects
    .map((project, index) => {
      return `${index + 1}. ${project.name} [${project.language}]
   ${project.description}
   ${project.reason}`
    })
    .join('\n\n')
}

function formatProjects() {
  return projectArchive
    .map((project) => {
      const fork = project.isFork ? ' / fork' : ''
      return `${project.name}${fork}  ${project.language}  *${project.stars}  ${project.updatedAt}
${project.description}`
    })
    .join('\n\n')
}

function runCommand(rawInput: string) {
  const input = rawInput.trim()
  const normalized = input.toLowerCase()

  if (!input) {
    return { output: '', clear: false }
  }

  if (normalized === 'help') {
    return {
      output: `available commands

help
whoami
pwd
ls projects
cat about
cat featured
cat stats
open github
clear`,
      clear: false,
    }
  }

  if (normalized === 'whoami') {
    return {
      output: `${profile.handle}
${profile.fullName}
${profile.strapline}`,
      clear: false,
    }
  }

  if (normalized === 'pwd') {
    return {
      output: '/home/magni/Projects/website',
      clear: false,
    }
  }

  if (normalized === 'ls projects') {
    return {
      output: projectArchive.map((project) => project.name).join('\n'),
      clear: false,
    }
  }

  if (normalized === 'cat about') {
    return {
      output: `${profile.intro}

${profile.summary}`,
      clear: false,
    }
  }

  if (normalized === 'cat featured') {
    return {
      output: formatFeatured(),
      clear: false,
    }
  }

  if (normalized === 'cat stats') {
    return {
      output: profile.stats.map((stat) => `${stat.label}: ${stat.value}`).join('\n'),
      clear: false,
    }
  }

  if (normalized === 'open github') {
    window.open(profile.githubUrl, '_blank', 'noopener,noreferrer')
    return {
      output: `opening ${profile.githubUrl}`,
      clear: false,
    }
  }

  if (normalized === 'clear') {
    return { output: '', clear: true }
  }

  if (normalized === 'ls all') {
    return {
      output: formatProjects(),
      clear: false,
    }
  }

  return {
    output: `command not found: ${input}

try: help`,
    clear: false,
  }
}

function App() {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>(bootTranscript)
  const [input, setInput] = useState('')
  const outputRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight })
  }, [transcript])

  function submitCommand(rawInput: string) {
    const trimmed = rawInput.trim()
    const nextEntries = trimmed ? [{ kind: 'command' as const, content: `$ ${trimmed}` }] : []
    const result = runCommand(rawInput)

    if (result.clear) {
      setTranscript(bootTranscript)
      return
    }

    const outputEntries = result.output ? [{ kind: 'output' as const, content: result.output }] : []
    setTranscript((current) => [...current, ...nextEntries, ...outputEntries])
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    submitCommand(input)
    setInput('')
  }

  return (
    <div className="site-shell">
      <div className="page-frame" aria-hidden="true" />

      <header className="masthead">
        <div>
          <p className="eyebrow">magniquick.exe</p>
          <h1>{profile.handle}</h1>
          <p className="subhead">{profile.strapline}</p>
        </div>
        <div className="masthead-meta">
          <span>{profile.fullName}</span>
          <span>dark mode by default</span>
        </div>
      </header>

      <main className="workspace">
        <section className="terminal-window">
          <div className="window-topbar">
            <div className="window-lights" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p>session://portfolio</p>
          </div>

          <div className="terminal-output" ref={outputRef}>
            {transcript.map((entry, index) => (
              <pre
                className={`line line-${entry.kind}`}
                key={`${entry.kind}-${index}-${entry.content.slice(0, 12)}`}
              >
                {entry.content}
              </pre>
            ))}
          </div>

          <form className="terminal-input-row" onSubmit={handleSubmit}>
            <span className="prompt">magniquick@site:~$</span>
            <input
              aria-label="Terminal command"
              autoComplete="off"
              spellCheck={false}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="type a command"
            />
          </form>

          <div className="command-palette" aria-label="Suggested commands">
            {commandHints.map((hint) => (
              <button key={hint} type="button" onClick={() => submitCommand(hint)}>
                {hint}
              </button>
            ))}
          </div>
        </section>

        <aside className="info-column">
          <section className="info-card">
            <p className="section-label">about</p>
            <p>{profile.intro}</p>
          </section>

          <section className="info-card">
            <p className="section-label">featured</p>
            <ul className="project-list">
              {featuredProjects.slice(0, 5).map((project) => (
                <li key={project.name}>
                  <strong>{project.name}</strong>
                  <span>{project.language}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="info-card">
            <p className="section-label">stats</p>
            <dl className="stats-list">
              {profile.stats.map((stat) => (
                <div key={stat.label}>
                  <dt>{stat.label}</dt>
                  <dd>{stat.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </aside>
      </main>
    </div>
  )
}

export default App
