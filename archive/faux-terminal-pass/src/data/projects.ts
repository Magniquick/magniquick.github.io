export type FeaturedProject = {
  name: string
  url: string
  language: string
  status: string
  description: string
  reason: string
  tags: string[]
}

export type RepoEntry = {
  name: string
  url: string
  language: string
  stars: number
  updatedAt: string
  isFork: boolean
  description: string
}

export const featuredProjects: FeaturedProject[] = [
  {
    name: 'tachypipe',
    url: 'https://github.com/Magniquick/tachypipe',
    language: 'Go',
    status: 'Encrypted clipboard sync prototype',
    description:
      'Clipboard sync over public MQTT with OPAQUE pairing, daily key rotation, Android integration, and local daemon tooling.',
    reason:
      'Probably the best example here of me going all the way down the stack instead of stopping at the first version that worked.',
    tags: ['protocols', 'security', 'cross-platform'],
  },
  {
    name: 'codex-serve',
    url: 'https://github.com/Magniquick/codex-serve',
    language: 'Rust',
    status: 'Local OpenAI-compatible bridge for Codex CLI',
    description:
      'A small server that exposes Codex CLI through an OpenAI-style surface, with streaming, models, health checks, and compatibility shims.',
    reason:
      'Very representative project: take two things that almost fit together, build the adapter, and make the setup less annoying.',
    tags: ['ai infra', 'rust', 'developer tools'],
  },
  {
    name: 'zsh-dots',
    url: 'https://github.com/Magniquick/zsh-dots',
    language: 'Shell',
    status: 'Fast shell setup with measurable tradeoffs',
    description:
      'A heavily tuned zsh configuration focused on speed, plugin ergonomics, eval caching, and startup profiling.',
    reason:
      'This is what my desktop work usually looks like: customization with benchmarks, profiling, and very little patience for slow defaults.',
    tags: ['shell', 'performance', 'linux'],
  },
  {
    name: 'font-arena',
    url: 'https://github.com/Magniquick/font-arena',
    language: 'TypeScript',
    status: 'Frontend experiment',
    description:
      'A React/Vite project exploring typography choices and presentation through a dedicated interface rather than a mood board.',
    reason:
      'Less systems-heavy than the rest, but useful because it shows I care about interface quality too, not just plumbing.',
    tags: ['frontend', 'design', 'react'],
  },
  {
    name: 'spotify-lyrics-api',
    url: 'https://github.com/Magniquick/spotify-lyrics-api',
    language: 'Go',
    status: 'Local client for Spotify lyrics endpoints',
    description:
      'A focused Go port for fetching and formatting lyrics from Spotify WebPlayer endpoints using local session credentials.',
    reason:
      'Small and direct. I like projects that know exactly what they are and stop there.',
    tags: ['api', 'go', 'tooling'],
  },
  {
    name: 'waybar-config-schema',
    url: 'https://github.com/Magniquick/waybar-config-schema',
    language: 'Python',
    status: 'Config tooling for desktop customization',
    description:
      'Schema-oriented work around Waybar configuration, aimed at making highly customized setups less brittle.',
    reason:
      'Another desktop-focused tool: configuration is more fun when it stops breaking in unclear ways.',
    tags: ['desktop', 'schema', 'python'],
  },
  {
    name: 'dotbak',
    url: 'https://github.com/Magniquick/dotbak',
    language: 'Python',
    status: 'Backup-first dotfiles manager',
    description:
      'A simpler dotfiles manager with an explicit focus on backups and low-friction recovery rather than overbuilt abstraction.',
    reason:
      'A good example of how I usually think about tooling: simpler model, fewer surprises, easier recovery.',
    tags: ['dotfiles', 'backups', 'cli'],
  },
  {
    name: 'KeyCrawler',
    url: 'https://github.com/Magniquick/KeyCrawler',
    language: 'Python',
    status: 'Most visible public repo',
    description:
      'A scraper and validator for Android attestation keybox files discovered via the GitHub API.',
    reason:
      'This is the repo most people find first. It is not the whole story, but it is a fair example of how far curiosity can escalate.',
    tags: ['reverse engineering', 'scraping', 'android'],
  },
]

export const projectArchive: RepoEntry[] = [
  {
    name: 'KeyCrawler',
    url: 'https://github.com/Magniquick/KeyCrawler',
    language: 'Python',
    stars: 106,
    updatedAt: '2026-03-19',
    isFork: false,
    description: 'Crawls android keybox files from literally all of GitHub.',
  },
  {
    name: 'atuin-win',
    url: 'https://github.com/Magniquick/atuin-win',
    language: 'Packaging',
    stars: 12,
    updatedAt: '2025-11-01',
    isFork: false,
    description: 'Windows builds for atuin.',
  },
  {
    name: 'zsh-dots',
    url: 'https://github.com/Magniquick/zsh-dots',
    language: 'Shell',
    stars: 5,
    updatedAt: '2026-02-09',
    isFork: false,
    description: 'Just my zsh dots. Built for speed and practical ergonomics.',
  },
  {
    name: 'waybar-config-schema',
    url: 'https://github.com/Magniquick/waybar-config-schema',
    language: 'Python',
    stars: 3,
    updatedAt: '2026-03-11',
    isFork: false,
    description: 'Schema-oriented tooling for Waybar configuration.',
  },
  {
    name: 'codex-serve',
    url: 'https://github.com/Magniquick/codex-serve',
    language: 'Rust',
    stars: 1,
    updatedAt: '2025-12-04',
    isFork: false,
    description: 'OpenAI-compatible bridge for local Codex CLI sessions.',
  },
  {
    name: 'dotbak',
    url: 'https://github.com/Magniquick/dotbak',
    language: 'Python',
    stars: 1,
    updatedAt: '2025-11-24',
    isFork: false,
    description: 'A dotfiles manager with a focus on backups and simplicity.',
  },
  {
    name: 'tachypipe',
    url: 'https://github.com/Magniquick/tachypipe',
    language: 'Go',
    stars: 0,
    updatedAt: '2026-02-25',
    isFork: false,
    description: 'Encrypted clipboard sync prototype over public MQTT.',
  },
  {
    name: 'dotfiles',
    url: 'https://github.com/Magniquick/dotfiles',
    language: 'QML',
    stars: 0,
    updatedAt: '2026-03-12',
    isFork: false,
    description: 'Current dotfiles with a strong desktop customization bias.',
  },
  {
    name: 'spotify-lyrics-api',
    url: 'https://github.com/Magniquick/spotify-lyrics-api',
    language: 'Go',
    stars: 0,
    updatedAt: '2026-02-11',
    isFork: false,
    description: 'Local client/library for fetching lyrics from Spotify endpoints.',
  },
  {
    name: 'font-arena',
    url: 'https://github.com/Magniquick/font-arena',
    language: 'TypeScript',
    stars: 0,
    updatedAt: '2025-12-24',
    isFork: false,
    description: 'Frontend typography experiment built with React and Vite.',
  },
  {
    name: 'MIST',
    url: 'https://github.com/Magniquick/MIST',
    language: 'Python',
    stars: 0,
    updatedAt: '2025-06-26',
    isFork: false,
    description: 'An older Python project with an apocalyptic sense of naming.',
  },
  {
    name: 'firefox-dots',
    url: 'https://github.com/Magniquick/firefox-dots',
    language: 'JavaScript',
    stars: 0,
    updatedAt: '2024-11-16',
    isFork: false,
    description: 'Firefox customization with the same monorepos-bad energy as the shell setup.',
  },
  {
    name: 'CLIProxyAPI',
    url: 'https://github.com/Magniquick/CLIProxyAPI',
    language: 'Go',
    stars: 0,
    updatedAt: '2026-01-24',
    isFork: true,
    description: 'Fork of a multi-provider CLI proxy API project.',
  },
  {
    name: 'ChatMock',
    url: 'https://github.com/Magniquick/ChatMock',
    language: 'Python',
    stars: 1,
    updatedAt: '2026-02-08',
    isFork: true,
    description: 'Fork exposing OpenAI models through a ChatGPT subscription.',
  },
]
