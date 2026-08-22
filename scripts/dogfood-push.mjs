// Dogfood: push this plugin to GitHub USING the plugin's own tool code.
// Drives the real built packages (LocalGitService, GitPlatformRegistry,
// GitMemoryService, tool-git's git_repo, tool-git-memory's git_memory) through
// a ctx double whose `shell` runs real git. Run with:
//   node scripts/dogfood-push.mjs
import { execSync } from 'node:child_process'
import { resolve as pathResolve } from 'node:path'
import LocalGitService from '../packages/git/git-local/lib/index.js'
import GitPlatformRegistry from '../packages/git/git-platform/lib/index.js'
import GitMemoryService from '../packages/git/git-memory/lib/index.js'
import * as tool from '../packages/git/tool-git/lib/index.js'
import * as toolMemory from '../packages/git/tool-git-memory/lib/index.js'

const REPO = process.cwd()
const REMOTE_URL = process.env.DOGFOOD_REMOTE_URL ?? 'https://github.com/sakthiveltofficial/dsh-git-plugins.git'

const fakeShell = {
  resolve(request) {
    return { command: request.command, workdir: request.workdir ?? process.cwd(), timeoutMs: 120000, stdoutMaxBytes: 8 << 20, signal: request.signal, stdin: request.stdin, env: request.env, sandboxPolicy: request.sandboxPolicy }
  },
  async run(spec) {
    try {
      const stdout = execSync(spec.command, { cwd: spec.workdir, shell: '/bin/bash', encoding: 'utf8', env: { ...process.env, ...spec.env }, maxBuffer: 64 << 20 })
      return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs, stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false } }
    } catch (error) {
      return { exitCode: error.status ?? 1, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs, stdout: { text: error.stdout?.toString() ?? '', truncated: false }, stderr: { text: error.stderr?.toString() ?? '', truncated: false } }
    }
  },
}

const store = new Map()
const prefix = 'git_memory:entries:'
const fakeStorage = { open: async () => ({ name: 'git_memory', table: () => ({
  get: (k) => store.get(`${prefix}${k}`),
  put: async (k, v) => { store.set(`${prefix}${k}`, v) },
  delete: async (k) => store.delete(`${prefix}${k}`),
  entries: function* () { for (const [k, v] of store) if (k.startsWith(prefix)) yield [k.slice(prefix.length), v] },
  keys: function* () {}, size: 0,
}), close: async () => {} }) }

const defs = []
const ctx = {
  reflect: { provide() {} },
  shell: fakeShell,
  get: (name) => (name === 'storageDomain' ? fakeStorage : undefined),
  on: () => () => {},
  effect: () => () => {},
  systemPrompt: { section: () => () => {} },
  tools: { register: (d) => { defs.push(d); return () => {} } },
}
ctx.gitLocal = new LocalGitService(ctx, {})
ctx.gitPlatform = new GitPlatformRegistry(ctx, { cacheTtlMs: 0, maxRetries: 0, backoffMs: 1 })
ctx.gitMemory = new GitMemoryService(ctx, {})
tool.apply(ctx, { confirmDestructive: true })
toolMemory.apply(ctx, {})

const gitRepo = defs.find((d) => d.name === 'git_repo')
const gitInspect = defs.find((d) => d.name === 'git_inspect')
const gitMemoryTool = defs.find((d) => d.name === 'git_memory')
if (!gitRepo || !gitMemoryTool) { console.error('tools not registered'); process.exit(1) }

const exec = () => ({ agent: { session: { header: { cwd: REPO } } }, signal: new AbortController().signal, callId: 'dogfood', arguments: {} })

async function runTool(def, args, label) {
  try {
    const result = await def.execute(args, exec())
    console.log(`\n▶ ${label}\n${result.text}`)
    return result
  } catch (error) {
    console.error(`\n✗ ${label} FAILED: [${error.code ?? '?'}] ${error.message}`)
    throw error
  }
}

console.log(`Dogfooding against: ${REPO}\nRemote: ${REMOTE_URL}`)

await runTool(gitRepo, { action: 'init', path: REPO, default_branch: 'main' }, 'git_repo init')
await runTool(gitRepo, { action: 'add', path: REPO, all: true }, 'git_repo add (--all)')
const st = await runTool(gitInspect, { action: 'status', path: REPO }, 'git_inspect status')
const branch = st.text.match(/branch: (\S+)/)?.[1] ?? 'main'
const commit = await runTool(gitRepo, { action: 'commit', path: REPO, message: "dsh-git: Git & source-control plugin suite for DeepSeek Harness\n\nPushed through the plugin's own git_repo tool (dogfood run).", all: true }, 'git_repo commit')
const hash = commit.text.split(' ')[0]
await runTool(gitRepo, { action: 'remote_add', path: REPO, remote_url: REMOTE_URL, remote_name: 'origin' }, 'git_repo remote_add')
await runTool(gitRepo, { action: 'push', path: REPO, branch, set_upstream: true }, `git_repo push (${branch})`)
await runTool(gitMemoryTool, { action: 'record', kind: 'fact', text: `dsh-git repo pushed to ${REMOTE_URL} at commit ${hash} using the plugin itself`, project: REPO, source: 'observed' }, 'git_memory record')

console.log(`\n✅ DOGFOOD PUSH OK — commit ${hash} on branch ${branch}`)
