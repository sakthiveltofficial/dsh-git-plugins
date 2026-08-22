/**
 * @dsh-git/tool-git-memory — the model-facing `git_memory` tool.
 *
 * Lets the model actively build memory: record user-stated preferences and
 * project facts (source 'stated'), recall known errors/conventions before a
 * git operation, and forget superseded entries. Memory informs defaults; an
 * explicit instruction always wins.
 */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { GitMemoryEntry, GitMemoryKind } from '@dsh-git/memory'

export const name = 'tool-git-memory'
export const inject = ['tools', 'gitMemory']

interface MemoryArgs {
  action: 'record' | 'recall' | 'forget'
  kind?: GitMemoryKind
  text?: string
  project?: string
  fix?: string
  source?: 'stated' | 'observed' | 'inferred'
  key?: string
  text_query?: string
  limit?: number
}

function formatEntry(entry: GitMemoryEntry): string {
  const scope = entry.scope.project ? ` [${entry.scope.project}]` : ''
  const status = entry.kind === 'error' ? (entry.status === 'open' ? ' (open)' : ' (fixed)') : ''
  const fix = entry.fix ? ` → fix: ${entry.fix}` : ''
  return `${entry.kind}${scope}${status}: ${entry.text}${fix} (${entry.source}, seen ${entry.hits}x, key ${entry.key})`
}

export function apply(ctx: Context, _config?: unknown): void {
  ctx.tools.register(defineTool({
    name: 'git_memory',
    description: 'Self-evolving git memory. record: persist a fact, project convention, preference, or error+fix (secrets are scrubbed automatically). recall: retrieve known errors/conventions before a git operation. forget: remove a superseded entry. Memory informs defaults — it never overrides an explicit instruction.',
    parameters: {
      action: { type: 'string', enum: ['record', 'recall', 'forget'], required: true, description: 'What to do with memory.' },
      kind: { type: 'string', enum: ['fact', 'project', 'error', 'preference'], description: 'record: entry kind.' },
      text: { type: 'string', description: 'record: the fact/preference/error message to remember.' },
      project: { type: 'string', description: 'record/recall: project scope; defaults to the current workspace.' },
      fix: { type: 'string', description: 'record: for kind=error, the working resolution.' },
      source: { type: 'string', enum: ['stated', 'observed', 'inferred'], description: 'record: how this entry was established (default stated).' },
      key: { type: 'string', description: 'forget: the entry key to remove.' },
      text_query: { type: 'string', description: 'recall: substring to search for.' },
      limit: { type: 'integer', description: 'recall: maximum results (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    async execute(args, exec) {
      const a = args as MemoryArgs
      const memory = ctx.gitMemory

      switch (a.action) {
        case 'record': {
          if (!a.kind || !a.text) throw new Error('git_memory record requires `kind` and `text`')
          const project = a.project ?? sessionCwd(exec)
          const entry = await memory.record({
            kind: a.kind,
            text: a.text,
            project,
            source: a.source ?? 'stated',
            fix: a.fix,
          })
          return { action: 'record', ok: true, text: `recorded ${entry.kind} memory (${entry.key})` }
        }
        case 'recall': {
          const entries = await memory.recall({
            kind: a.kind,
            project: a.project,
            text: a.text_query,
            limit: a.limit,
          })
          return {
            action: 'recall', ok: true,
            text: entries.length > 0 ? entries.map(formatEntry).join('\n\n') : '(no matching memory)',
          }
        }
        case 'forget': {
          if (!a.key) throw new Error('git_memory forget requires `key`')
          const removed = await memory.forget(a.key)
          return { action: 'forget', ok: true, text: removed ? `forgot ${a.key}` : `no entry with key ${a.key}` }
        }
        default:
          throw new Error(`unknown git_memory action: ${String((a as { action?: unknown }).action)}`)
      }
    },
  }))
}

function sessionCwd(exec: ToolRunContext): string | undefined {
  return exec.agent?.session.header.cwd
}
