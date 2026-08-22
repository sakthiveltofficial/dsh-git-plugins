// End-to-end smoke test for @dsh-git/local: drives the real git binary through
// a minimal ctx.shell double and checks command-building, quoting, and output
// parsing against a scratch repo. Run with: node scripts/smoke-local.mjs
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitError } from '../packages/git/core/lib/index.js'
import LocalGitService, { LocalGitService as Named } from '../packages/git/git-local/lib/index.js'

if (typeof LocalGitService !== 'function') throw new Error('default export is not a class')
if (Named !== LocalGitService) throw new Error('named/default export mismatch')
if (!Array.isArray(LocalGitService.inject) || !LocalGitService.inject.includes('shell')) throw new Error('missing inject')
if (GitError.prototype.name !== 'Error') throw new Error('GitError should extend Error')

const fakeShell = {
  resolve(request) {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024 * 1024,
      signal: request.signal,
      stdin: request.stdin,
      env: request.env,
    }
  },
  async run(spec) {
    try {
      const stdout = execSync(spec.command, {
        cwd: spec.workdir,
        shell: '/bin/bash',
        encoding: 'utf8',
        env: { ...process.env, ...spec.env },
        maxBuffer: 64 * 1024 * 1024,
      })
      return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs, stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false } }
    } catch (error) {
      return {
        exitCode: error.status ?? 1, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: error.stdout?.toString() ?? '', truncated: false },
        stderr: { text: error.stderr?.toString() ?? '', truncated: false },
      }
    }
  },
}

const ctx = { reflect: { provide() {} }, shell: fakeShell }
const git = new LocalGitService(ctx, {})

const root = mkdtempSync(join(tmpdir(), 'dsh-git-smoke-'))
const notRepo = mkdtempSync(join(tmpdir(), 'dsh-git-not-repo-'))
try {
  execSync('git init -q', { cwd: root })
  execSync('git config user.email smoke@example.com && git config user.name smoke', { cwd: root })
  writeFileSync(join(root, 'a.txt'), 'hello\nworld\n')
  execSync('git add -A && git commit -q -m init', { cwd: root })

  const branch = await git.branch({ workdir: root })
  console.log('branch:', branch.current, JSON.stringify(branch.branches))

  const log = await git.log({ workdir: root })
  console.log('log:', log.entries.length, '|', log.entries[0]?.subject)

  console.log('searchFiles *.txt:', JSON.stringify(await git.searchFiles({ workdir: root, pattern: '*.txt' })))
  const code = await git.searchCode({ workdir: root, query: 'hello' })
  console.log('searchCode hello:', JSON.stringify(code.map((c) => `${c.path}:${c.line}`)))

  console.log('diff(clean) length:', (await git.diff({ workdir: root })).patch.length)

  writeFileSync(join(root, 'a.txt'), 'hello\nworld\nmore\n')
  console.log('diff(dirty) lines:', (await git.diff({ workdir: root })).patch.split('\n').length)

  const commit = await git.commit({ workdir: root, message: 'second', all: true })
  console.log('commit:', commit.hash.slice(0, 8))

  await git.tag({ workdir: root, action: 'create', name: 'v1.0.0' })
  console.log('tags:', JSON.stringify((await git.tag({ workdir: root, action: 'list' })).tags))

  console.log('blame line1:', (await git.blame({ workdir: root, file: 'a.txt' })).text.split('\n')[0])

  // bootstrap verbs: init → status → add → status → commit → remoteAdd → remote
  const fresh = mkdtempSync(join(tmpdir(), 'dsh-git-boot-'))
  const init = await git.init({ workdir: fresh, defaultBranch: 'main' })
  console.log('init:', init.workdir === fresh && init.branch === 'main' ? 'ok' : JSON.stringify(init))
  const clean = await git.status({ workdir: fresh })
  console.log('status(clean):', clean.branch === 'main' && clean.clean ? 'ok' : JSON.stringify(clean))
  writeFileSync(join(fresh, 'b.txt'), 'content\n')
  const dirty = await git.status({ workdir: fresh })
  console.log('status(untracked):', dirty.entries.some((e) => e.path === 'b.txt' && !e.staged) ? 'ok' : JSON.stringify(dirty.entries))
  const added = await git.add({ workdir: fresh, all: true })
  console.log('add:', JSON.stringify(added.staged))
  const staged = await git.status({ workdir: fresh })
  console.log('status(staged):', staged.entries.some((e) => e.path === 'b.txt' && e.staged) ? 'ok' : JSON.stringify(staged.entries))
  await git.commit({ workdir: fresh, message: 'bootstrap', all: true })
  console.log('status(after commit):', (await git.status({ workdir: fresh })).clean ? 'ok' : 'dirty')
  await git.remoteAdd({ workdir: fresh, url: 'https://example.com/o/r.git' })
  console.log('remote:', (await git.remote({ workdir: fresh })).url)
  rmSync(fresh, { recursive: true, force: true })

  // push/pull round-trip via a local bare remote — regression for the
  // `git push -u <branch>` remote-arg bug (branch must not be treated as a remote)
  const bareRepo = mkdtempSync(join(tmpdir(), 'dsh-git-bare-'))
  execSync('git init --bare -q', { cwd: bareRepo })
  const worker = mkdtempSync(join(tmpdir(), 'dsh-git-worker-'))
  await git.init({ workdir: worker, defaultBranch: 'main' })
  writeFileSync(join(worker, 'w.txt'), 'w\n')
  await git.add({ workdir: worker, all: true })
  await git.commit({ workdir: worker, message: 'w', all: true })
  await git.remoteAdd({ workdir: worker, url: bareRepo })
  const pushed = await git.push({ workdir: worker, branch: 'main', setUpstream: true })
  console.log('push(bare, no explicit remote):', pushed.ok ? 'ok' : JSON.stringify(pushed))
  execSync('git symbolic-ref HEAD refs/heads/main', { cwd: bareRepo }) // make main the bare repo's default HEAD
  const cloneDest = mkdtempSync(join(tmpdir(), 'dsh-git-clone-'))
  const cloned = await git.clone({ url: bareRepo, destination: cloneDest })
  console.log('clone:', cloned.branch === 'main' ? 'ok' : JSON.stringify(cloned))
  writeFileSync(join(worker, 'w2.txt'), 'w2\n')
  await git.add({ workdir: worker, all: true })
  await git.commit({ workdir: worker, message: 'w2', all: true })
  await git.push({ workdir: worker, branch: 'main' })
  const pulled = await git.pull({ workdir: cloneDest, branch: 'main' })
  console.log('pull(branch):', pulled.ok ? 'ok' : JSON.stringify(pulled))
  const pulledLog = await git.log({ workdir: cloneDest, maxCount: 2 })
  console.log('pull got both commits:', pulledLog.entries.length === 2 ? 'ok' : JSON.stringify(pulledLog.entries.map((e) => e.subject)))
  rmSync(bareRepo, { recursive: true, force: true })
  rmSync(worker, { recursive: true, force: true })
  rmSync(cloneDest, { recursive: true, force: true })

  // error taxonomy: a directory OUTSIDE any repo should throw GIT_NOT_A_REPO
  try {
    await git.log({ workdir: notRepo })
    console.log('ERROR: expected a GitError for a non-repo directory')
  } catch (error) {
    console.log('non-repo error code:', error.code)
  }

  console.log('\nSMOKE OK')
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(notRepo, { recursive: true, force: true })
}
