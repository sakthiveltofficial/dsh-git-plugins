// Smoke test for @dsh-git/memory + @dsh-git/tool-git-memory.
// Drives the service against an in-memory storage-domain double: record/recall/
// forget, dedupe (hits), auto-capture (failure → open, success → resolved),
// secret scrubbing, and the system-prompt digest.
// Run with: node scripts/smoke-memory.mjs
import { GitMemoryService } from '../packages/git/git-memory/lib/index.js'
import * as toolMemory from '../packages/git/tool-git-memory/lib/index.js'

let failures = 0
function check(name, condition, extra = '') {
  if (condition) console.log(`ok - ${name}`)
  else { failures += 1; console.log(`FAIL - ${name} ${extra}`) }
}

function fakeStorageDomain() {
  const store = new Map()
  const prefix = 'git.memory:entries:'
  const table = {
    get: (k) => store.get(`${prefix}${k}`),
    put: async (k, v) => { store.set(`${prefix}${k}`, v) },
    delete: async (k) => store.delete(`${prefix}${k}`),
    entries: function* () {
      for (const [k, v] of store) if (k.startsWith(prefix)) yield [k.slice(prefix.length), v]
    },
    keys: function* () {},
    size: 0,
  }
  return { open: async () => ({ name: 'git.memory', table: () => table, close: async () => {} }) }
}

let capturedSection = null
const ctx = {
  reflect: { provide() {} },
  get: (name) => (name === 'storageDomain' ? fakeStorageDomain() : undefined),
  on: () => () => {},
  effect: () => () => {},
  systemPrompt: { section: (s) => { capturedSection = s; return () => {} } },
}

const memory = new GitMemoryService(ctx, {})

// ── record / recall / dedupe ─────────────────────────────────────────────────

const pref = await memory.record({ kind: 'preference', text: 'always squash merge on this repo', project: '/proj/a', source: 'stated' })
check('record returns entry with key', typeof pref.key === 'string' && pref.key.startsWith('preference:'), pref.key)

const again = await memory.record({ kind: 'preference', text: 'always squash merge on this repo', project: '/proj/a', source: 'stated' })
check('dedupe bumps hits', again.hits === 2, `hits=${again.hits}`)
check('dedupe keeps one entry', (await memory.recall({ kind: 'preference' })).length === 1)

await memory.record({ kind: 'project', text: 'branch prefix: feat/', project: '/proj/a', source: 'stated' })
await memory.record({ kind: 'project', text: 'branch prefix: fix/', project: '/proj/b', source: 'stated' })
check('recall filters by project', (await memory.recall({ project: '/proj/b' })).every((e) => e.scope.project === '/proj/b'))

// ── auto-capture: failure → open, success → resolved ─────────────────────────

const execBase = { name: 'git_repo', arguments: { action: 'clone' }, agent: { session: { header: { cwd: '/proj/a' } } } }
await memory.observe(execBase, { isError: true, error: { message: 'fatal: not a git repository', info: { code: 'GIT_NOT_A_REPO' } }, content: [] })
let errors = await memory.recall({ kind: 'error', project: '/proj/a' })
check('failure recorded as open error', errors.length === 1 && errors[0].status === 'open' && errors[0].key === 'error:git_repo:clone:GIT_NOT_A_REPO', JSON.stringify(errors.map((e) => e.key)))

await memory.observe(execBase, { isError: false, value: {}, content: [] })
errors = await memory.recall({ kind: 'error', project: '/proj/a' })
check('success resolves the open error', errors[0].status === 'resolved' && errors[0].fix === 'resolved on retry', JSON.stringify(errors[0]))

// ── scrubbing ────────────────────────────────────────────────────────────────

await memory.record({ kind: 'fact', text: 'token ghp_abcdefghijklmnopqrstuvwxyzABCDEF was needed; path /home/johndoe/work', project: '/proj/a', source: 'observed' })
const scrubbed = await memory.recall({ kind: 'fact', text: 'token', project: '/proj/a' })
const text = scrubbed[0]?.text ?? ''
check('scrubs github tokens', !text.includes('ghp_abcdefghijklmnopqrstuvwxyzABCDEF') && text.includes('<redacted-token>'), text.slice(0, 100))
check('scrubs username paths', text.includes('~/work') && !text.includes('/home/johndoe'), text.slice(0, 100))

// ── forget / supersede ───────────────────────────────────────────────────────

const removed = await memory.forget(pref.key)
check('forget removes the entry', removed && (await memory.recall({ kind: 'preference' })).length === 0)
check('forget of absent key returns false', (await memory.forget(pref.key)) === false)

// ── system-prompt digest ─────────────────────────────────────────────────────

await new Promise((r) => setTimeout(r, 20)) // let refreshDigest settle
const digest = typeof capturedSection.text === 'function' ? capturedSection.text() : ''
check('digest section renders memory', digest.includes('Known git memory') && digest.includes('GIT_NOT_A_REPO'), digest.slice(0, 120))

// ── tool package shape ───────────────────────────────────────────────────────

check('tool-git-memory exports', toolMemory.name === 'tool-git-memory' && Array.isArray(toolMemory.inject) && typeof toolMemory.apply === 'function')

console.log(failures === 0 ? '\nSMOKE OK' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
