export type Profile = {
  handle: string
  fullName: string
  strapline: string
  intro: string
  summary: string
  githubUrl: string
  quickFacts: string[]
  stats: Array<{
    label: string
    value: string
  }>
}

export const profile: Profile = {
  handle: 'Magniquick',
  fullName: 'Navon John Lukose',
  strapline: 'I build small sharp tools for Linux, AI workflows, and whatever else refuses to behave.',
  intro:
    'Most of my work sits close to the machine: terminal tooling, desktop customization, protocol-heavy experiments, automation, and practical one-off utilities that turned out to be worth keeping.',
  summary:
    'Python, Go, Rust, TypeScript, shell. Some projects are clean and reusable. Some are weird and extremely specific. All of them started with a problem that annoyed me enough to fix it.',
  githubUrl: 'https://github.com/Magniquick',
  quickFacts: [
    'Linux and shell-heavy by default.',
    'I like useful adapters more than big platforms.',
    'GitHub is the full archive. This page is the shortlist.',
  ],
  stats: [
    { label: 'Public repos', value: '44' },
    { label: 'Followers', value: '23' },
    { label: 'Breakout repo stars', value: '106' },
    { label: 'Primary lanes', value: 'Python / Go / Rust / TS' },
  ],
}
