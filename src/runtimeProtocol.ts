export type RuntimeRequest =
  | { type: 'init' }
  | { type: 'input'; line: string }
  | { type: 'complete'; line: string; cursor: number }
  | { type: 'interrupt' }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'clear' }
  | { type: 'reset-session' }
  | { type: 'search'; query: string }

export type RuntimeEvent =
  | { type: 'ready' }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'completion'; line: string; cursor: number; suggestions?: string[] }
  | { type: 'prompt'; value: string; history: string[] }
  | { type: 'clear' }
  | { type: 'busy'; value: boolean }
  | { type: 'fs-warning'; message: string }
  | { type: 'exit'; code: number }
  | { type: 'fatal'; message: string }

export type ShellMode = 'shell' | 'python' | 'less'
