/**
 * @dsh-git/local — the local git provider.
 *
 * Implements `gitLocal` by shelling to the real git binary through `ctx.shell`
 * (the `ShellExecutor` seam). Delegating to git itself keeps edge cases correct:
 * submodules, LFS, hooks, and the index all behave exactly as the user's own
 * `git` does. Every command runs `--no-pager` with `GIT_TERMINAL_PROMPT=0` so a
 * missing credential fails fast instead of hanging on an interactive prompt.
 */
import z from '@deepseek-ai/schemastery'
import { resolve as pathResolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecRequest, ShellRunResult } from '@deepseek-ai/dsh-shell'
import {
  GitLocalService,
  GitError,
  type GitErrorCode,
  type AddRequest,
  type AddResult,
  type BlameRequest,
  type BlameResult,
  type BranchRequest,
  type BranchResult,
  type CheckoutRequest,
  type CheckoutResult,
  type CloneRequest,
  type CloneResult,
  type CodeSearchRequest,
  type CodeSearchResult,
  type CommitRequest,
  type CommitResult,
  type DiffRequest,
  type DiffResult,
  type FileSearchRequest,
  type InitRequest,
  type InitResult,
  type LogRequest,
  type LogResult,
  type MergeRequest,
  type MergeResult,
  type PullRequest,
  type PullResult,
  type PushRequest,
  type PushResult,
  type RebaseRequest,
  type RebaseResult,
  type RemoteAddRequest,
  type RemoteAddResult,
  type RemoteRequest,
  type RemoteResult,
  type StatusEntry,
  type StatusRequest,
  type StatusResult,
  type StashEntry,
  type StashRequest,
  type StashResult,
  type TagRequest,
  type TagResult,
} from '@dsh-git/core'

export interface Config {
  /** Fallback working directory when a request omits one. */
  cwd?: string
  /** Foreground command timeout, in milliseconds. */
  timeoutMs?: number
  /** Foreground stdout capture budget, in bytes. */
  stdoutMaxBytes?: number
}

type ResolvedConfig = {
  cwd: string
  timeoutMs: number
  stdoutMaxBytes: number
}

/** Single-quote an argument for POSIX shell; embedded quotes are escaped. */
function shq(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

function classifyGitError(detail: string): GitErrorCode {
  if (/not a git repository/i.test(detail)) return 'GIT_NOT_A_REPO'
  if (/authentication failed|could not read username|permission denied \(publickey\)|invalid username or password/i.test(detail)) return 'GIT_AUTH_FAILED'
  if (/conflict/i.test(detail)) return 'GIT_CONFLICT'
  if (/please commit your changes or stash them|local changes would be overwritten|overwritten by merge/i.test(detail)) return 'GIT_DIRTY'
  if (/rate limit|too many requests/i.test(detail)) return 'GIT_RATE_LIMITED'
  if (/could not resolve host|connection (timed out|refused)|unable to access/i.test(detail)) return 'GIT_NETWORK'
  return 'GIT_FAILED'
}

function hostOf(url: string): string | null {
  if (!url) return null
  const match = url.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)/i)
  return match ? match[1] : null
}

function parseStashList(text: string): StashEntry[] {
  return text.split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf(': ')
    return {
      ref: line.slice(0, i).trim(),
      subject: i >= 0 ? line.slice(i + 2).trim() : '',
    }
  })
}

const GIT_BASE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
} as const

export class LocalGitService extends GitLocalService {
  static inject = ['shell']
  static Config = z.object({
    cwd: z.string().default(process.cwd()),
    timeoutMs: z.number().default(120000),
    stdoutMaxBytes: z.number().default(1024 * 1024),
  })

  readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = {
      cwd: config.cwd ?? process.cwd(),
      timeoutMs: config.timeoutMs ?? 120000,
      stdoutMaxBytes: config.stdoutMaxBytes ?? 1024 * 1024,
    }
  }

  // ── shell plumbing ─────────────────────────────────────────────────────────

  private git(workdir: string, argv: string[], opts: {
    stdin?: string
    signal?: AbortSignal
    timeoutMs?: number
    stdoutMaxBytes?: number
    sandboxPolicy?: SandboxExecutionPolicy
  } = {}): Promise<ShellRunResult> {
    const command = ['git', '--no-pager', ...argv].map(shq).join(' ')
    const request: ShellExecRequest = {
      command,
      workdir,
      timeoutMs: opts.timeoutMs ?? this.config.timeoutMs,
      stdoutMaxBytes: opts.stdoutMaxBytes ?? this.config.stdoutMaxBytes,
      signal: opts.signal,
      stdin: opts.stdin,
      env: { ...GIT_BASE_ENV },
      sandboxPolicy: opts.sandboxPolicy,
    }
    return this.ctx.shell.run(this.ctx.shell.resolve(request))
  }

  private fatal(result: ShellRunResult, subcmd: string): never {
    if (result.aborted) throw new GitError('git command was aborted', 'GIT_ABORTED')
    if (result.timedOut) throw new GitError(`git ${subcmd} timed out after ${result.timeoutMs}ms`, 'GIT_TIMEOUT')
    const detail = (result.stderr.text || result.stdout.text || '').trim() || 'unknown error'
    throw new GitError(`git ${subcmd} failed (exit ${result.exitCode}): ${detail}`, classifyGitError(detail))
  }

  /** Run a command that must exit 0; returns captured output. */
  private async run(workdir: string, argv: string[], opts: Parameters<LocalGitService['git']>[2] = {}): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
    const result = await this.git(workdir, argv, opts)
    if (result.exitCode !== 0) this.fatal(result, argv[0])
    return {
      stdout: result.stdout.text ?? '',
      stderr: result.stderr.text ?? '',
      truncated: result.stdout.truncated,
    }
  }

  private async currentBranch(workdir: string, signal?: AbortSignal): Promise<string> {
    const { stdout } = await this.run(workdir, ['rev-parse', '--abbrev-ref', 'HEAD'], { signal })
    return stdout.trim()
  }

  private async revParseHead(workdir: string, signal?: AbortSignal): Promise<string> {
    const { stdout } = await this.run(workdir, ['rev-parse', 'HEAD'], { signal })
    return stdout.trim()
  }

  private async remoteUrl(workdir: string, signal?: AbortSignal): Promise<string> {
    try {
      const { stdout } = await this.run(workdir, ['remote', 'get-url', 'origin'], { signal })
      return stdout.trim().split('\n')[0] ?? ''
    } catch {
      return ''
    }
  }

  /** Branch from HEAD without requiring a commit (unborn HEAD, fresh clones). */
  private async resolveHeadBranch(workdir: string, signal?: AbortSignal): Promise<string> {
    try {
      const { stdout } = await this.run(workdir, ['symbolic-ref', '--short', 'HEAD'], { signal })
      return stdout.trim()
    } catch {
      return ''
    }
  }

  // ── gitLocal implementation ────────────────────────────────────────────────

  async remote(req: RemoteRequest): Promise<RemoteResult> {
    const url = await this.remoteUrl(req.workdir, req.signal)
    return { name: 'origin', url, host: hostOf(url) }
  }

  async init(req: InitRequest): Promise<InitResult> {
    const argv = ['init']
    if (req.defaultBranch) argv.push('-b', req.defaultBranch)
    await this.run(req.workdir, argv, { signal: req.signal })
    const { stdout } = await this.run(req.workdir, ['symbolic-ref', '--short', 'HEAD'], { signal: req.signal })
    return { workdir: req.workdir, branch: await this.resolveHeadBranch(req.workdir, req.signal) }
  }

  async add(req: AddRequest): Promise<AddResult> {
    const argv = ['add']
    if (req.all || !req.paths?.length) argv.push('--all')
    else argv.push('--', ...req.paths)
    await this.run(req.workdir, argv, { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    const { stdout } = await this.run(req.workdir, ['diff', '--cached', '--name-only'], { signal: req.signal })
    return { staged: stdout.split('\n').filter(Boolean) }
  }

  async status(req: StatusRequest): Promise<StatusResult> {
    const { stdout } = await this.run(req.workdir, ['status', '--porcelain=v1', '-b'], { signal: req.signal })
    const entries: StatusEntry[] = []
    let branch = ''
    for (const line of stdout.split('\n').filter(Boolean)) {
      if (line.startsWith('## ')) {
        branch = line.slice(3).split('...')[0] ?? ''
        continue
      }
      if (line.length < 4) continue
      const state = line.slice(0, 2)
      entries.push({ path: line.slice(3), state, staged: state[0] !== ' ' && state[0] !== '?' })
    }
    return { branch, clean: entries.length === 0, entries }
  }

  async remoteAdd(req: RemoteAddRequest): Promise<RemoteAddResult> {
    const name = req.name ?? 'origin'
    await this.run(req.workdir, ['remote', 'add', name, req.url], { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    return { name, url: req.url }
  }

  async clone(req: CloneRequest): Promise<CloneResult> {
    if (!req.url) throw new GitError('clone requires a url', 'GIT_INVALID_ARGS')
    if (!req.destination) throw new GitError('clone requires a destination', 'GIT_INVALID_ARGS')
    const argv = ['clone']
    if (req.depth !== undefined) argv.push('--depth', String(req.depth))
    if (req.branch) argv.push('--branch', req.branch)
    argv.push('--', req.url, req.destination)
    const parent = req.workdir ?? this.config.cwd
    await this.run(parent, argv, { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    const destination = pathResolve(parent, req.destination)
    return {
      destination,
      branch: await this.resolveHeadBranch(destination, req.signal),
      remoteUrl: await this.remoteUrl(destination, req.signal),
    }
  }

  async branch(req: BranchRequest): Promise<BranchResult> {
    const argv = ['branch']
    if (req.delete && req.name) argv.push('-d', req.name)
    else if (req.name) argv.push(req.name)
    if (req.remote) argv.push('-r')
    const { stdout } = await this.run(req.workdir, argv, { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    const branches = stdout.split('\n')
      .map((line) => line.replace(/^[* ]\s*/, '').trim())
      .filter(Boolean)
    return { current: await this.currentBranch(req.workdir, req.signal), branches }
  }

  async checkout(req: CheckoutRequest): Promise<CheckoutResult> {
    if (!req.ref) throw new GitError('checkout requires a ref', 'GIT_INVALID_ARGS')
    const argv = ['checkout']
    if (req.force) argv.push('-f')
    if (req.create) argv.push('-b')
    argv.push(req.ref)
    await this.run(req.workdir, argv, { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    return { ref: req.ref, current: await this.currentBranch(req.workdir, req.signal) }
  }

  async commit(req: CommitRequest): Promise<CommitResult> {
    if (!req.message) throw new GitError('commit requires a message', 'GIT_INVALID_ARGS')
    const argv = ['commit', '-m', req.message]
    if (req.all) argv.push('-a')
    if (req.amend) argv.push('--amend', '--no-edit')
    const { stdout } = await this.run(req.workdir, argv, { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    return { hash: await this.revParseHead(req.workdir, req.signal), summary: stdout.trim() }
  }

  async push(req: PushRequest): Promise<PushResult> {
    const argv = ['push']
    if (req.force) argv.push('--force-with-lease')
    if (req.setUpstream) argv.push('-u')
    const remote = req.remote ?? 'origin'
    argv.push(remote)
    if (req.branch) argv.push(req.branch)
    const { stdout } = await this.run(req.workdir, argv, { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    return {
      ok: true,
      remote: req.remote ?? 'origin',
      branch: req.branch ?? await this.currentBranch(req.workdir, req.signal),
      summary: stdout.trim(),
    }
  }

  async pull(req: PullRequest): Promise<PullResult> {
    const argv = ['pull']
    if (req.rebase) argv.push('--rebase')
    if (req.branch) argv.push(req.remote ?? 'origin')
    if (req.branch) argv.push(req.branch)
    const { stdout } = await this.run(req.workdir, argv, { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    return { ok: true, summary: stdout.trim() }
  }

  async diff(req: DiffRequest): Promise<DiffResult> {
    const argv = ['diff']
    if (req.staged) argv.push('--staged')
    if (req.context !== undefined) argv.push(`--unified=${req.context}`)
    if (req.pathspec?.length) argv.push('--', ...req.pathspec)
    const { stdout, truncated } = await this.run(req.workdir, argv, { signal: req.signal })
    return { patch: stdout, truncated }
  }

  async blame(req: BlameRequest): Promise<BlameResult> {
    if (!req.file) throw new GitError('blame requires a file', 'GIT_INVALID_ARGS')
    const { stdout } = await this.run(req.workdir, ['blame', '--', req.file], { signal: req.signal })
    return { file: req.file, text: stdout }
  }

  async log(req: LogRequest): Promise<LogResult> {
    const argv = ['log', '--pretty=format:%H%x1f%an%x1f%ad%x1f%s', '--date=short']
    if (req.maxCount !== undefined) argv.push(`-n${req.maxCount}`)
    if (req.pathspec?.length) argv.push('--', ...req.pathspec)
    const { stdout } = await this.run(req.workdir, argv, { signal: req.signal })
    const entries = stdout.split('\n').filter(Boolean).map((line) => {
      const [hash, author, date, subject] = line.split('\x1f')
      return { hash: hash ?? '', author: author ?? '', date: date ?? '', subject: subject ?? '' }
    })
    return { entries }
  }

  async tag(req: TagRequest): Promise<TagResult> {
    if (req.action === 'list') {
      const { stdout } = await this.run(req.workdir, ['tag', '--list'], { signal: req.signal })
      return { tags: stdout.split('\n').filter(Boolean) }
    }
    if (!req.name) throw new GitError(`tag ${req.action} requires a name`, 'GIT_INVALID_ARGS')
    if (req.action === 'create') {
      const argv = ['tag']
      if (req.message) argv.push('-a', req.name, '-m', req.message)
      else argv.push(req.name)
      if (req.ref) argv.push(req.ref)
      await this.run(req.workdir, argv, { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
      return { tags: [], summary: `created tag ${req.name}` }
    }
    await this.run(req.workdir, ['tag', '-d', req.name], { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    return { tags: [], summary: `deleted tag ${req.name}` }
  }

  async stash(req: StashRequest): Promise<StashResult> {
    if (req.action === 'list') {
      const { stdout } = await this.run(req.workdir, ['stash', 'list'], { signal: req.signal })
      return { entries: parseStashList(stdout) }
    }
    const argv = ['stash', req.action]
    if (req.action === 'push' && req.message) argv.push('-m', req.message)
    if (req.action !== 'push' && req.ref) argv.push(req.ref)
    const { stdout } = await this.run(req.workdir, argv, { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    return { entries: [], summary: stdout.trim() || `stash ${req.action}` }
  }

  async merge(req: MergeRequest): Promise<MergeResult> {
    if (req.abort) {
      const { stdout } = await this.run(req.workdir, ['merge', '--abort'], { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
      return { ok: true, conflicted: false, summary: stdout.trim() || 'merge aborted' }
    }
    if (!req.branch) throw new GitError('merge requires a branch', 'GIT_INVALID_ARGS')
    const argv = ['merge']
    if (req.noCommit) argv.push('--no-commit')
    argv.push('--no-edit', req.branch)
    const result = await this.git(req.workdir, argv, { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    const text = `${result.stdout.text ?? ''}\n${result.stderr.text ?? ''}`.trim()
    if (/CONFLICT|Automatic merge failed|not something we can merge/i.test(text)) {
      return { ok: false, conflicted: true, summary: text }
    }
    if (result.exitCode !== 0) this.fatal(result, 'merge')
    return { ok: true, conflicted: false, summary: text }
  }

  async rebase(req: RebaseRequest): Promise<RebaseResult> {
    if (req.abort) {
      const { stdout } = await this.run(req.workdir, ['rebase', '--abort'], { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
      return { ok: true, summary: stdout.trim() || 'rebase aborted' }
    }
    if (req.cont) {
      const { stdout } = await this.run(req.workdir, ['rebase', '--continue'], { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
      return { ok: true, summary: stdout.trim() || 'rebase continued' }
    }
    const argv = ['rebase']
    if (req.onto) argv.push('--onto', req.onto)
    const result = await this.git(req.workdir, argv, { signal: req.signal, sandboxPolicy: req.sandboxPolicy })
    const text = `${result.stdout.text ?? ''}\n${result.stderr.text ?? ''}`.trim()
    if (/CONFLICT|could not apply|Resolve all conflicts/i.test(text)) {
      return { ok: false, summary: text }
    }
    if (result.exitCode !== 0) this.fatal(result, 'rebase')
    return { ok: true, summary: text }
  }

  async searchCode(req: CodeSearchRequest): Promise<CodeSearchResult[]> {
    if (!req.query) throw new GitError('searchCode requires a query', 'GIT_INVALID_ARGS')
    const argv = ['grep', '-n', '-I', '--', req.query]
    if (req.pathspec?.length) argv.push(...req.pathspec)
    const result = await this.git(req.workdir, argv, { signal: req.signal })
    if (result.exitCode === 1) return [] // git grep exits 1 on "no matches"
    if (result.exitCode !== 0) this.fatal(result, 'grep')
    return (result.stdout.text ?? '').split('\n').filter(Boolean).map((line) => {
      const i = line.indexOf(':')
      if (i < 0) return null
      const path = line.slice(0, i)
      const rest = line.slice(i + 1)
      const j = rest.indexOf(':')
      if (j < 0) return null
      return { path, line: Number(rest.slice(0, j)), text: rest.slice(j + 1) }
    }).filter((x): x is CodeSearchResult => x !== null)
  }

  async searchFiles(req: FileSearchRequest): Promise<string[]> {
    if (!req.pattern) throw new GitError('searchFiles requires a pattern', 'GIT_INVALID_ARGS')
    const { stdout } = await this.run(
      req.workdir,
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { signal: req.signal },
    )
    const matcher = globToRegExp(req.pattern)
    return stdout.split('\n').filter((path) => path.length > 0 && matcher.test(path))
  }
}

export default LocalGitService
