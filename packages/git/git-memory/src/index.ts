/**
 * @dsh-git/memory — self-evolving git memory.
 *
 * A durable, cross-session store of environment facts, per-project
 * conventions, error signatures + resolutions, and user-stated preferences.
 *
 * Design:
 * - Storage is a zod-validated KV table in a `git.memory` storage domain
 *   (host `storageDomain`), keyed by content hash so repeated events dedupe
 *   and accumulate a `hits` count (recurring patterns surface automatically).
 * - Auto-capture listens to `tools/result` for git tools: every failure is
 *   recorded with its `tool:action:code` signature; a later success of the
 *   same signature marks the open error resolved.
 * - Secrets are scrubbed before persisting (tokens, keys, private-key blocks,
 *   absolute paths containing a username).
 * - A bounded digest of high-value entries is injected into the system prompt
 *   as a section, so the model pre-empts known errors and follows established
 *   conventions — memory informs defaults, it never overrides an explicit
 *   instruction.
 */
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

// ── storage domain ───────────────────────────────────────────────────────────

const entrySchema = zod.object({
  key: zod.string(),
  kind: zod.enum(['fact', 'project', 'error', 'preference']),
  scope: zod.object({
    /** Session workspace path (or owner/repo for platform ops) this entry came from. */
    project: zod.string().optional(),
    /** Environment string (e.g. `linux/x64`). */
    environment: zod.string().optional(),
  }),
  /** Scrubbed content. */
  text: zod.string(),
  source: zod.enum(['observed', 'stated', 'inferred']),
  /** Errors are 'open' until a later success resolves them; other kinds stay 'resolved'. */
  status: zod.enum(['open', 'resolved']).default('open'),
  hits: zod.number().int().default(1),
  /** Working resolution for error entries. */
  fix: zod.string().optional(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
  resolvedAt: zod.number().optional(),
})

export type GitMemoryEntry = zod.infer<typeof entrySchema>
export type GitMemoryKind = GitMemoryEntry['kind']
export type GitMemorySource = GitMemoryEntry['source']

const gitMemoryDomainSpec = defineDomain({
  name: 'git_memory',
  version: 1,
  tables: { entries: domainTable(entrySchema) },
})

export class GitMemoryError extends Error {
  readonly code: string
  constructor(message: string, code = 'GIT_MEMORY_FAILED') {
    super(message)
    this.name = 'GitMemoryError'
    this.code = code
  }
}

export interface GitMemoryConfig {
  enabled?: boolean
  maxEntries?: number
  digestLimit?: number
}

type ResolvedGitMemoryConfig = { enabled: boolean; maxEntries: number; digestLimit: number }

const GIT_TOOLS = new Set(['git_repo', 'git_inspect', 'git_pr', 'git_issues', 'git_release', 'git_security', 'git_ci'])

// ── helpers ──────────────────────────────────────────────────────────────────

/** FNV-1a content hash → short stable key for dedupe. */
function stableKey(kind: GitMemoryKind, project: string, text: string): string {
  const source = `${kind}|${project}|${text}`
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${kind}:${(hash >>> 0).toString(36)}`
}

/** Best-effort secret scrub: tokens, keys, private-key blocks, username paths. */
export function scrub(text: string): string {
  let out = text
  out = out.replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, '<redacted-token>')
  out = out.replace(/glpat-[A-Za-z0-9_-]{10,}/g, '<redacted-token>')
  out = out.replace(/ggt_[A-Za-z0-9]{10,}/g, '<redacted-token>')
  out = out.replace(/\b([A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|APP_PASSWORD|PAT))\b\s*[=:]\s*[^\s,;]+/gi, '$1=<redacted>')
  out = out.replace(/\b(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256)\s+[A-Za-z0-9+/=]+/g, '$& <redacted>')
  out = out.replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[^\n]*/g, '$& <redacted>')
  out = out.replace(/\/(?:home|Users)\/[^/\s]+\//g, '~/')
  return out
}

// ── service ──────────────────────────────────────────────────────────────────

export class GitMemoryService extends Service {
  static inject = ['storageDomain', 'systemPrompt']
  static Config = z.object({
    enabled: z.boolean().default(true),
    maxEntries: z.number().default(500),
    digestLimit: z.number().default(16),
  })

  readonly config: ResolvedGitMemoryConfig
  private ready: Promise<Domain<typeof gitMemoryDomainSpec>>
  private domain: Domain<typeof gitMemoryDomainSpec> | null = null
  private table: KvTable<string, GitMemoryEntry> | null = null
  private digestCache = ''

  constructor(ctx: Context, config: GitMemoryConfig) {
    super(ctx, 'gitMemory')
    this.config = {
      enabled: config.enabled ?? true,
      maxEntries: config.maxEntries ?? 500,
      digestLimit: config.digestLimit ?? 16,
    }
    this.ready = this.open()
    this.ready.catch(() => {}) // storage failure must never break the session
    ctx.effect(() => () => {
      const domain = this.domain
      if (domain) void domain.close()
    })
    ctx.on('tools/result', (exec, result) => {
      void this.observe(exec, result).catch(() => {})
    })
    ctx.systemPrompt.section({
      name: 'git_memory',
      order: 250,
      text: () => this.digestCache || '',
    })
  }

  private async open(): Promise<Domain<typeof gitMemoryDomainSpec>> {
    const storage = this.ctx.get('storageDomain')
    if (!storage) throw new GitMemoryError('storageDomain is not mounted; git memory is unavailable', 'GIT_MEMORY_NO_STORAGE')
    const domain = await storage.open(gitMemoryDomainSpec)
    this.domain = domain
    return domain
  }

  private async ensureTable(): Promise<KvTable<string, GitMemoryEntry>> {
    if (!this.table) {
      const domain = await this.ready
      this.table = domain.table('entries')
    }
    return this.table
  }

  private environment(): string {
    return `${process.platform}/${process.arch}`
  }

  private async refreshDigest(): Promise<void> {
    if (!this.config.enabled) return
    const table = await this.ensureTable()
    const all: GitMemoryEntry[] = []
    for (const [, entry] of table.entries()) all.push(entry)
    all.sort((a, b) => (b.hits - a.hits) || (b.updatedAt - a.updatedAt))
    const top = all.slice(0, this.config.digestLimit)
    if (top.length === 0) {
      this.digestCache = ''
      return
    }
    const lines = top.map((e) => {
      const scope = e.scope.project ? ` [${e.scope.project}]` : ''
      const status = e.kind === 'error' ? (e.status === 'open' ? ' (open)' : ' (fixed)') : ''
      const fix = e.fix ? ` → fix: ${e.fix}` : ''
      return `- ${e.kind}${scope}${status}: ${e.text}${fix} (seen ${e.hits}x)`
    })
    this.digestCache = `Known git memory — apply only entries matching the current project; an explicit instruction always wins over memory:\n${lines.join('\n')}`
  }

  /** Record one entry; same key bumps `hits` instead of duplicating. */
  async record(input: {
    kind: GitMemoryKind
    text: string
    project?: string
    source?: GitMemorySource
    key?: string
    fix?: string
    status?: 'open' | 'resolved'
  }): Promise<GitMemoryEntry> {
    if (!this.config.enabled) throw new GitMemoryError('git memory recording is disabled', 'GIT_MEMORY_DISABLED')
    const table = await this.ensureTable()
    const text = scrub(input.text)
    const key = input.key ?? stableKey(input.kind, input.project ?? '', text)
    const now = Date.now()
    const existing = table.get(key)
    let entry: GitMemoryEntry
    if (existing) {
      entry = {
        ...existing,
        text,
        fix: input.fix ?? existing.fix,
        source: input.source ?? existing.source,
        status: input.status ?? existing.status,
        hits: existing.hits + 1,
        updatedAt: now,
        resolvedAt: input.status === 'resolved' ? now : existing.resolvedAt,
      }
    } else {
      entry = {
        key,
        kind: input.kind,
        scope: { project: input.project, environment: this.environment() },
        text,
        source: input.source ?? 'inferred',
        status: input.status ?? (input.kind === 'error' ? 'open' : 'resolved'),
        hits: 1,
        fix: input.fix,
        createdAt: now,
        updatedAt: now,
        ...(input.status === 'resolved' ? { resolvedAt: now } : {}),
      }
    }
    await table.put(key, entry)
    await this.enforceCap(table)
    void this.refreshDigest().catch(() => {})
    return entry
  }

  /** Query entries; sorted by hits then recency. */
  async recall(query: { kind?: GitMemoryKind; project?: string; text?: string; status?: 'open' | 'resolved'; limit?: number } = {}): Promise<GitMemoryEntry[]> {
    if (!this.config.enabled) return []
    const table = await this.ensureTable()
    const needle = query.text?.toLowerCase()
    const results: GitMemoryEntry[] = []
    for (const [, entry] of table.entries()) {
      if (query.kind && entry.kind !== query.kind) continue
      if (query.status && entry.status !== query.status) continue
      if (query.project && entry.scope.project !== query.project) continue
      if (needle && !entry.text.toLowerCase().includes(needle)) continue
      results.push(entry)
    }
    results.sort((a, b) => (b.hits - a.hits) || (b.updatedAt - a.updatedAt))
    return results.slice(0, query.limit ?? 50)
  }

  /** Delete one entry (superseding stale memory). */
  async forget(key: string): Promise<boolean> {
    const table = await this.ensureTable()
    const removed = await table.delete(key)
    void this.refreshDigest().catch(() => {})
    return removed
  }

  /** Auto-capture hook driven by `tools/result`: record failures, resolve on success. */
  async observe(exec: ToolExecution, result: ToolExecutionResult): Promise<void> {
    if (!this.config.enabled || !GIT_TOOLS.has(exec.name)) return
    const project = exec.agent?.session?.header?.cwd ?? 'global'
    const action = (exec.arguments as { action?: string } | undefined)?.action
    const signature = `${exec.name}${action ? `:${action}` : ''}`
    try {
      if (result.isError) {
        const code = result.error?.info?.code ?? 'FAILED'
        const message = result.error?.message ?? 'unknown failure'
        await this.record({
          kind: 'error',
          key: `error:${signature}:${code}`,
          project,
          source: 'observed',
          text: `${signature}:${code}: ${message}`,
          status: 'open',
        })
      } else {
        // success of `signature` resolves any open error with the same prefix
        const table = await this.ensureTable()
        const now = Date.now()
        for (const [key, entry] of table.entries()) {
          if (entry.kind === 'error' && entry.status === 'open' && entry.scope.project === project && key.startsWith(`error:${signature}:`)) {
            await table.put(key, { ...entry, status: 'resolved', fix: 'resolved on retry', updatedAt: now, resolvedAt: now })
          }
        }
        void this.refreshDigest().catch(() => {})
      }
    } catch {
      // memory must never break tool execution
    }
  }

  /** Bound the table: evict lowest-hit / oldest entries beyond maxEntries. */
  private async enforceCap(table: KvTable<string, GitMemoryEntry>): Promise<void> {
    const entries: GitMemoryEntry[] = []
    for (const [, entry] of table.entries()) entries.push(entry)
    if (entries.length <= this.config.maxEntries) return
    entries.sort((a, b) => (a.hits - b.hits) || (a.updatedAt - b.updatedAt))
    const excess = entries.slice(0, entries.length - this.config.maxEntries)
    for (const entry of excess) void table.delete(entry.key)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gitMemory: GitMemoryService
  }
}

export default GitMemoryService
