/**
 * @dsh-git/tool-git — the model-facing tool layer.
 *
 * Grouped tools over `ctx.gitLocal` and `ctx.gitPlatform`:
 * - git_repo / git_inspect: local repository operations and read-only inspection
 * - git_pr / git_issues / git_release / git_security / git_ci: hosted platforms
 *
 * Hardening lives here, not in the providers:
 * - destructive actions route through the host `approval` service
 *   (fail-closed when an answerer exists; the composition decides if none does);
 * - mutating actions stamp the resolved sandbox policy on the gitLocal request,
 *   and advertise `sandbox_permissions`/`justification` escalation when a
 *   sandboxing shell is mounted;
 * - `presentResult`/`presentationMeta` render structured UI cards (search
 *   matches, PR/issue/pipeline lists) in addition to the model-facing text.
 */
import z from '@deepseek-ai/schemastery';
import { defineTool, } from '@deepseek-ai/dsh-tools';
import { approveEscalation, ESCALATION_TARGETS, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox';
import { GitError, parseRemote } from '@dsh-git/core';
export const name = 'tool-git';
export const inject = ['tools', 'gitLocal', 'gitPlatform'];
export const Config = z.object({
    /** Require explicit approval for destructive actions (force-push, merge, rebase, tag delete, PR merge, release). */
    confirmDestructive: z.boolean().default(true),
});
function workdirOf(path, exec) {
    if (path)
        return path;
    const cwd = exec.agent?.session.header.cwd;
    if (cwd)
        return cwd;
    throw new GitError('no repository path: pass `path`, or run in a session with a workspace', 'GIT_INVALID_ARGS');
}
async function repoContext(ctx, exec, args) {
    if (args.owner && args.repo) {
        return { owner: args.owner, repo: args.repo, platform: args.platform };
    }
    const workdir = workdirOf(args.path, exec);
    const remote = await ctx.gitLocal.remote({ workdir, signal: exec.signal });
    if (!remote.url) {
        throw new GitError(`no origin remote in ${workdir}; pass owner and repo explicitly`, 'GIT_NOT_A_REPO');
    }
    const parsed = parseRemote(remote.url);
    if (!parsed) {
        throw new GitError(`cannot parse remote "${remote.url}"; pass owner and repo explicitly`, 'GIT_INVALID_ARGS');
    }
    return { owner: parsed.owner, repo: parsed.repo, platform: args.platform, remoteUrl: remote.url };
}
// ── approval + sandbox hardening ─────────────────────────────────────────────
async function confirmDestructive(ctx, exec, toolName, what) {
    const approval = ctx.get('approval');
    if (!approval || !exec.agent)
        return; // no approval stack: composition decides confinement elsewhere
    const outcome = await approval.request({
        agent: exec.agent,
        toolName,
        callId: exec.callId,
        reason: what,
        signal: exec.signal,
    });
    if (outcome !== 'allowed-once') {
        throw new GitError(`${what} was not approved (${outcome})`, 'GIT_FAILED');
    }
}
function sandboxKit(ctx) {
    const shell = ctx.get('shell');
    const escalationModes = shell?.sandboxMode ? [...ESCALATION_TARGETS] : [];
    const policyService = ctx.get('sandboxPolicy');
    return {
        escalationModes,
        schemaFields() {
            return escalationModes.length > 0 ? {
                sandbox_permissions: { type: 'string', enum: escalationModes, description: 'The wider sandbox mode this mutation needs. Only valid as a one-shot retry of an operation the sandbox just denied; requires justification and user approval.' },
                justification: { type: 'string', description: 'Required with sandbox_permissions: one sentence explaining why this exact operation needs the wider access.' },
            } : {};
        },
        async resolvePolicy(toolName, args, exec) {
            validateEscalationArgs(args.sandbox_permissions, args.justification);
            const standing = policyService?.resolve(exec.agent ? { session: exec.agent.session } : {});
            if (args.sandbox_permissions === undefined || args.justification === undefined)
                return standing;
            if (escalationModes.length === 0)
                throw new GitError('sandbox_permissions is not available in this composition (no sandboxing shell mounted)', 'GIT_SANDBOX_DENIED');
            if (!standing)
                throw new GitError('no sandbox policy to escalate', 'GIT_SANDBOX_DENIED');
            const approvedMode = await approveEscalation({
                requestedMode: args.sandbox_permissions,
                justification: args.justification,
                effectiveMode: standing.mode,
                subject: 'operation',
            }, {
                approver: ctx.get('approval'),
                agent: exec.agent,
                callId: exec.callId,
                toolName,
                signal: exec.signal,
            });
            return { ...standing, mode: approvedMode };
        },
    };
}
// ── UI cards ──
/** Any lossless-JSON value; interfaces lack index signatures, so cast through unknown. */
function jsonify(value) {
    return value;
}
/** Build the result card from presentationMeta (action/ok/text/data). */
function gitResultCard(_args, result) {
    const meta = result.meta;
    if (!meta || !meta.ok)
        return undefined;
    switch (meta.action) {
        case 'search_code': {
            const matches = Array.isArray(meta.data) ? meta.data : [];
            if (matches.length === 0)
                return undefined;
            const files = [];
            const byPath = new Map();
            for (const m of matches) {
                const arr = byPath.get(m.path) ?? [];
                arr.push({ lineNumber: m.line, line: m.text });
                byPath.set(m.path, arr);
            }
            for (const [path, lines] of byPath)
                files.push({ path, matches: lines });
            return { card: 'search', shape: 'matches', title: 'Code search', files, truncated: false, total: matches.length };
        }
        case 'list':
        case 'create':
        case 'get':
            return { card: 'generic', title: meta.title, content: [{ type: 'text', text: meta.text }] };
        default:
            return undefined;
    }
}
function formatLog(entries) {
    return entries.map((e) => `${e.hash.slice(0, 8)} ${e.date} ${e.author}: ${e.subject}`).join('\n');
}
const COMMON_PLATFORM_PARAMS = {
    owner: { type: 'string', description: 'Repository owner (org/user; may include subgroup path segments).' },
    repo: { type: 'string', description: 'Repository name.' },
    path: { type: 'string', description: 'Local repo path; owner/repo are auto-detected from its origin remote.' },
    platform: { type: 'string', enum: ['github', 'gitlab', 'bitbucket', 'azuredevops', 'gitea'], description: 'Host platform; auto-detected from the remote URL when omitted.' },
};
// ── apply ────────────────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
    const confirmDestructiveEnabled = config.confirmDestructive ?? true;
    const kit = sandboxKit(ctx);
    ctx.tools.register(defineTool({
        name: 'git_repo',
        description: 'Local repository operations: clone, branch, checkout, commit, push, pull, stash, tag, merge, rebase. Prefer this over running raw git in bash. Destructive actions (force-push, merge, rebase, tag delete) may require approval.',
        parameters: {
            action: { type: 'string', enum: ['clone', 'init', 'add', 'remote_add', 'branch', 'checkout', 'commit', 'push', 'pull', 'stash', 'tag', 'merge', 'rebase'], required: true, description: 'Which operation to perform.' },
            path: { type: 'string', description: 'Repository working directory (for clone: the parent directory). Defaults to the session workspace.' },
            url: { type: 'string', description: 'clone: remote URL to clone.' },
            destination: { type: 'string', description: 'clone: destination directory (defaults to the URL basename).' },
            branch: { type: 'string', description: 'branch create/checkout/push/pull/merge target.' },
            tag: { type: 'string', description: 'tag: tag name for create/delete.' },
            ref: { type: 'string', description: 'checkout/tag: a commit, branch, or tag ref.' },
            message: { type: 'string', description: 'commit/tag/stash message.' },
            force: { type: 'boolean', description: 'Force the operation (checkout -f, push --force-with-lease). Force-push requires approval.' },
            all: { type: 'boolean', description: 'commit: stage tracked modifications (-a).' },
            amend: { type: 'boolean', description: 'commit: amend the previous commit.' },
            set_upstream: { type: 'boolean', description: 'push: set upstream tracking (-u).' },
            depth: { type: 'integer', description: 'clone: shallow-clone depth.' },
            delete: { type: 'boolean', description: 'branch/tag: delete instead of create/list.' },
            create: { type: 'boolean', description: 'checkout: create a new branch (-b).' },
            subaction: { type: 'string', enum: ['list', 'create', 'push', 'pop', 'apply', 'drop', 'delete'], description: 'stash/tag sub-operation. stash uses list/push/pop/apply/drop; tag uses list/create/delete.' },
            stash_ref: { type: 'string', description: 'stash pop/apply/drop: the stash ref (e.g. stash@{0}).' },
            abort: { type: 'boolean', description: 'merge/rebase: abort the in-progress operation.' },
            continue: { type: 'boolean', description: 'rebase: continue after resolving conflicts.' },
            onto: { type: 'string', description: 'rebase: the base to rebase onto.' },
            no_commit: { type: 'boolean', description: 'merge: do not auto-commit (--no-commit).' },
            ...kit.schemaFields(),
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
            const a = args;
            const workdir = workdirOf(a.path, exec);
            const signal = exec.signal;
            const local = ctx.gitLocal;
            const sandboxPolicy = await kit.resolvePolicy('git_repo', a, exec);
            const destructiveReason = () => {
                if (a.action === 'push' && a.force)
                    return `force-push to ${a.branch ?? 'current branch'} in ${workdir}`;
                if (a.action === 'merge' && !a.abort)
                    return `merge ${a.branch ?? ''} into ${workdir}`;
                if (a.action === 'rebase' && !a.abort && !a.continue)
                    return `rebase in ${workdir}`;
                if (a.action === 'tag' && a.subaction === 'delete')
                    return `delete tag ${a.tag ?? ''} in ${workdir}`;
                return null;
            };
            const reason = destructiveReason();
            if (confirmDestructiveEnabled && reason)
                await confirmDestructive(ctx, exec, 'git_repo', reason);
            switch (a.action) {
                case 'clone': {
                    if (!a.url)
                        throw new GitError('git_repo clone requires `url`', 'GIT_INVALID_ARGS');
                    if (!a.destination)
                        throw new GitError('git_repo clone requires `destination`', 'GIT_INVALID_ARGS');
                    const r = await local.clone({ url: a.url, destination: a.destination, workdir: a.path, branch: a.branch, depth: a.depth, signal, sandboxPolicy });
                    return { action: 'clone', ok: true, text: `Cloned ${a.url}\n→ ${r.destination}\nbranch: ${r.branch}\nremote: ${r.remoteUrl}` };
                }
                case 'init': {
                    const r = await local.init({ workdir, defaultBranch: a.default_branch, signal });
                    return { action: 'init', ok: true, text: `initialized git repository in ${r.workdir}\nbranch: ${r.branch}` };
                }
                case 'add': {
                    const r = await local.add({ workdir, paths: a.paths, all: a.all, signal, sandboxPolicy });
                    return { action: 'add', ok: true, text: r.staged.length ? `staged:\n${r.staged.join('\n')}` : '(nothing to stage)' };
                }
                case 'remote_add': {
                    if (!a.remote_url)
                        throw new GitError('git_repo remote_add requires `remote_url`', 'GIT_INVALID_ARGS');
                    const r = await local.remoteAdd({ workdir, name: a.remote_name, url: a.remote_url, signal, sandboxPolicy });
                    return { action: 'remote_add', ok: true, text: `added remote ${r.name} → ${r.url}` };
                }
                case 'branch': {
                    const r = await local.branch({ workdir, name: a.branch, delete: a.delete, signal, sandboxPolicy });
                    const list = r.branches.join('\n');
                    return { action: 'branch', ok: true, text: a.branch && !a.delete ? `created branch ${a.branch}` : `current: ${r.current}\n${list}` };
                }
                case 'checkout': {
                    const ref = a.ref ?? a.branch;
                    if (!ref)
                        throw new GitError('git_repo checkout requires `ref` or `branch`', 'GIT_INVALID_ARGS');
                    const r = await local.checkout({ workdir, ref, create: a.create, force: a.force, signal, sandboxPolicy });
                    return { action: 'checkout', ok: true, text: `checked out ${r.ref}\ncurrent: ${r.current}` };
                }
                case 'commit': {
                    if (!a.message)
                        throw new GitError('git_repo commit requires `message`', 'GIT_INVALID_ARGS');
                    const r = await local.commit({ workdir, message: a.message, all: a.all, amend: a.amend, signal, sandboxPolicy });
                    return { action: 'commit', ok: true, text: `${r.hash.slice(0, 8)} ${r.summary}` };
                }
                case 'push': {
                    const r = await local.push({ workdir, branch: a.branch, force: a.force, setUpstream: a.set_upstream, signal, sandboxPolicy });
                    return { action: 'push', ok: true, text: r.summary || `pushed ${r.remote} ${r.branch}` };
                }
                case 'pull': {
                    const r = await local.pull({ workdir, branch: a.branch, signal, sandboxPolicy });
                    return { action: 'pull', ok: true, text: r.summary || 'pulled' };
                }
                case 'stash': {
                    const stashActions = new Set(['list', 'push', 'pop', 'apply', 'drop']);
                    const sub = (a.subaction && stashActions.has(a.subaction) ? a.subaction : 'list');
                    const r = await local.stash({ workdir, action: sub, message: a.message, ref: a.stash_ref, signal, sandboxPolicy });
                    const text = r.entries.length > 0 ? r.entries.map((e) => `${e.ref}: ${e.subject}`).join('\n') : (r.summary ?? '');
                    return { action: 'stash', ok: true, text };
                }
                case 'tag': {
                    const tagActions = new Set(['list', 'create', 'delete']);
                    const sub = (a.subaction && tagActions.has(a.subaction) ? a.subaction : 'list');
                    const r = await local.tag({ workdir, action: sub, name: a.tag, message: a.message, ref: a.ref, signal, sandboxPolicy });
                    const text = r.tags.length > 0 ? r.tags.join('\n') : (r.summary ?? '');
                    return { action: 'tag', ok: true, text };
                }
                case 'merge': {
                    if (a.abort) {
                        const r = await local.merge({ workdir, branch: '', abort: true, signal, sandboxPolicy });
                        return { action: 'merge', ok: true, text: r.summary };
                    }
                    if (!a.branch)
                        throw new GitError('git_repo merge requires `branch`', 'GIT_INVALID_ARGS');
                    const r = await local.merge({ workdir, branch: a.branch, noCommit: a.no_commit, signal, sandboxPolicy });
                    return { action: 'merge', ok: r.ok, text: r.summary || (r.conflicted ? 'merge conflict — resolve, then commit' : 'merged') };
                }
                case 'rebase': {
                    const r = await local.rebase({ workdir, onto: a.onto, abort: a.abort, cont: a.continue, signal, sandboxPolicy });
                    return { action: 'rebase', ok: r.ok, text: r.summary || 'rebased' };
                }
                default:
                    throw new GitError(`unknown git_repo action: ${String(a.action)}`, 'GIT_INVALID_ARGS');
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'git_inspect',
        description: 'Read-only repository inspection: diff, blame, log/history, code search, file search. No repository is modified.',
        parameters: {
            action: { type: 'string', enum: ['diff', 'blame', 'log', 'search_code', 'search_files', 'status'], required: true, description: 'Which read-only inspection to perform.' },
            path: { type: 'string', description: 'Repository working directory. Defaults to the session workspace.' },
            file: { type: 'string', description: 'blame: the file to annotate.' },
            query: { type: 'string', description: 'search_code: the text to search for.' },
            pattern: { type: 'string', description: 'search_files: a glob pattern (e.g. "src/**/*.ts").' },
            pathspec: { type: 'array', items: { type: 'string' }, description: 'diff/log/search_code: limit to these paths.' },
            staged: { type: 'boolean', description: 'diff: show staged changes (--staged).' },
            context: { type: 'integer', description: 'diff: number of context lines (--unified).' },
            max_count: { type: 'integer', description: 'log: maximum number of commits.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', required: true },
                    ok: { type: 'boolean', required: true },
                    text: { type: 'string', required: true },
                    data: { type: 'json' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
            presentationMeta: (_args, value) => value,
        },
        presentResult: gitResultCard,
        async execute(args, exec) {
            const a = args;
            const workdir = workdirOf(a.path, exec);
            const signal = exec.signal;
            const local = ctx.gitLocal;
            switch (a.action) {
                case 'diff': {
                    const r = await local.diff({ workdir, staged: a.staged, context: a.context, pathspec: a.pathspec, signal });
                    return { action: 'diff', ok: true, text: r.patch || '(no changes)' + (r.truncated ? '\n[output truncated]' : '') };
                }
                case 'blame': {
                    if (!a.file)
                        throw new GitError('git_inspect blame requires `file`', 'GIT_INVALID_ARGS');
                    const r = await local.blame({ workdir, file: a.file, signal });
                    return { action: 'blame', ok: true, text: r.text };
                }
                case 'log': {
                    const r = await local.log({ workdir, maxCount: a.max_count, pathspec: a.pathspec, signal });
                    return { action: 'log', ok: true, text: r.entries.length ? formatLog(r.entries) : '(no commits)' };
                }
                case 'search_code': {
                    if (!a.query)
                        throw new GitError('git_inspect search_code requires `query`', 'GIT_INVALID_ARGS');
                    const r = await local.searchCode({ workdir, query: a.query, pathspec: a.pathspec, signal });
                    return { action: 'search_code', ok: true, text: r.length ? r.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n') : '(no matches)', data: jsonify(r) };
                }
                case 'search_files': {
                    if (!a.pattern)
                        throw new GitError('git_inspect search_files requires `pattern`', 'GIT_INVALID_ARGS');
                    const r = await local.searchFiles({ workdir, pattern: a.pattern, signal });
                    return { action: 'search_files', ok: true, text: r.length ? r.join('\n') : '(no matches)' };
                }
                case 'status': {
                    const r = await local.status({ workdir, signal });
                    const body = r.entries.length ? r.entries.map((e) => `${e.staged ? '[+]' : '[ ]'} ${e.path}`).join('\n') : '(clean)';
                    return { action: 'status', ok: true, title: `Status of ${workdir}`, text: `branch: ${r.branch}
${body}` };
                }
                default:
                    throw new GitError(`unknown git_inspect action: ${String(a.action)}`, 'GIT_INVALID_ARGS');
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'git_pr',
        description: 'Pull requests on hosted platforms: create, list, merge (requires approval), and post review comments.',
        parameters: {
            action: { type: 'string', enum: ['create', 'list', 'merge', 'comment'], required: true, description: 'Which PR operation to perform.' },
            ...COMMON_PLATFORM_PARAMS,
            title: { type: 'string', description: 'create: PR title.' },
            head: { type: 'string', description: 'create: head branch (source).' },
            base: { type: 'string', description: 'create: base branch (target).' },
            body: { type: 'string', description: 'create/comment: PR body or comment text.' },
            state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'list: which PRs to list.' },
            limit: { type: 'integer', description: 'list: maximum number of PRs.' },
            number: { type: 'integer', description: 'merge/comment: the pull request number.' },
            method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'merge: merge method.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', required: true },
                    ok: { type: 'boolean', required: true },
                    text: { type: 'string', required: true },
                    title: { type: 'string' },
                    data: { type: 'json' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
            presentationMeta: (_args, value) => value,
        },
        presentResult: gitResultCard,
        async execute(args, exec) {
            const a = args;
            const rc = await repoContext(ctx, exec, a);
            const signal = exec.signal;
            const prs = ctx.gitPlatform;
            switch (a.action) {
                case 'create': {
                    if (!a.title || !a.head || !a.base)
                        throw new GitError('git_pr create requires `title`, `head`, and `base`', 'GIT_INVALID_ARGS');
                    const r = await prs.createPullRequest({ ...rc, title: a.title, head: a.head, base: a.base, body: a.body, signal });
                    return { action: 'create', ok: true, title: `PR #${r.number} in ${rc.owner}/${rc.repo}`, text: `PR #${r.number} opened: ${r.title}\n${r.url}` };
                }
                case 'list': {
                    const list = await prs.listPullRequests({ ...rc, state: a.state, limit: a.limit, signal });
                    return {
                        action: 'list', ok: true, title: `Pull requests in ${rc.owner}/${rc.repo}`, data: jsonify(list),
                        text: list.length ? list.map((p) => `#${p.number} [${p.state}] ${p.title} (${p.head} → ${p.base}) by ${p.author}`).join('\n') : '(no pull requests)',
                    };
                }
                case 'merge': {
                    if (!a.number)
                        throw new GitError('git_pr merge requires `number`', 'GIT_INVALID_ARGS');
                    if (confirmDestructiveEnabled)
                        await confirmDestructive(ctx, exec, 'git_pr', `merge PR #${a.number} in ${rc.owner}/${rc.repo}`);
                    await prs.mergePullRequest({ ...rc, number: a.number, method: a.method, signal });
                    return { action: 'merge', ok: true, text: `merged PR #${a.number}` };
                }
                case 'comment': {
                    if (!a.number || !a.body)
                        throw new GitError('git_pr comment requires `number` and `body`', 'GIT_INVALID_ARGS');
                    await prs.addReviewComment({ ...rc, pullNumber: a.number, body: a.body, signal });
                    return { action: 'comment', ok: true, text: `comment posted on PR #${a.number}` };
                }
                default:
                    throw new GitError(`unknown git_pr action: ${String(a.action)}`, 'GIT_INVALID_ARGS');
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'git_issues',
        description: 'Issues on hosted platforms: list and create.',
        parameters: {
            action: { type: 'string', enum: ['list', 'create'], required: true, description: 'Which issue operation to perform.' },
            ...COMMON_PLATFORM_PARAMS,
            state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'list: which issues to list.' },
            limit: { type: 'integer', description: 'list: maximum number of issues.' },
            title: { type: 'string', description: 'create: issue title.' },
            body: { type: 'string', description: 'create: issue body.' },
            labels: { type: 'array', items: { type: 'string' }, description: 'create: issue labels.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', required: true },
                    ok: { type: 'boolean', required: true },
                    text: { type: 'string', required: true },
                    title: { type: 'string' },
                    data: { type: 'json' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
            presentationMeta: (_args, value) => value,
        },
        presentResult: gitResultCard,
        async execute(args, exec) {
            const a = args;
            const rc = await repoContext(ctx, exec, a);
            const signal = exec.signal;
            const issues = ctx.gitPlatform;
            switch (a.action) {
                case 'list': {
                    const list = await issues.listIssues({ ...rc, state: a.state, limit: a.limit, signal });
                    return {
                        action: 'list', ok: true, title: `Issues in ${rc.owner}/${rc.repo}`, data: jsonify(list),
                        text: list.length ? list.map((i) => `#${i.number} [${i.state}] ${i.title}${i.labels.length ? ` (${i.labels.join(', ')})` : ''} by ${i.author}`).join('\n') : '(no issues)',
                    };
                }
                case 'create': {
                    if (!a.title)
                        throw new GitError('git_issues create requires `title`', 'GIT_INVALID_ARGS');
                    const r = await issues.createIssue({ ...rc, title: a.title, body: a.body, labels: a.labels, signal });
                    return { action: 'create', ok: true, title: `Issue #${r.number} in ${rc.owner}/${rc.repo}`, text: `issue #${r.number} created: ${r.title}\n${r.url}` };
                }
                default:
                    throw new GitError(`unknown git_issues action: ${String(a.action)}`, 'GIT_INVALID_ARGS');
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'git_release',
        description: 'Create a release on a hosted platform (requires approval).',
        parameters: {
            action: { type: 'string', enum: ['create'], required: true, description: 'Release operation to perform.' },
            ...COMMON_PLATFORM_PARAMS,
            tag: { type: 'string', required: true, description: 'The tag to release (e.g. v1.2.0).' },
            name: { type: 'string', description: 'Release name; defaults to the tag.' },
            body: { type: 'string', description: 'Release notes / changelog body.' },
            draft: { type: 'boolean', description: 'Create as a draft.' },
            prerelease: { type: 'boolean', description: 'Mark as a prerelease.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', required: true },
                    ok: { type: 'boolean', required: true },
                    text: { type: 'string', required: true },
                    title: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
            presentationMeta: (_args, value) => value,
        },
        presentResult: gitResultCard,
        async execute(args, exec) {
            const a = args;
            const rc = await repoContext(ctx, exec, a);
            const signal = exec.signal;
            if (confirmDestructiveEnabled)
                await confirmDestructive(ctx, exec, 'git_release', `create release ${a.tag} in ${rc.owner}/${rc.repo}`);
            const r = await ctx.gitPlatform.createRelease({ ...rc, tag: a.tag, name: a.name, body: a.body, draft: a.draft, prerelease: a.prerelease, signal });
            return { action: 'create', ok: true, title: `Release ${r.tag} in ${rc.owner}/${rc.repo}`, text: `release ${r.tag} created: ${r.url}` };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'git_security',
        description: 'Security alerts on hosted platforms (read-only): Dependabot/CVE status.',
        parameters: {
            action: { type: 'string', enum: ['list'], required: true, description: 'Security operation to perform.' },
            ...COMMON_PLATFORM_PARAMS,
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', required: true },
                    ok: { type: 'boolean', required: true },
                    text: { type: 'string', required: true },
                    title: { type: 'string' },
                    data: { type: 'json' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
            presentationMeta: (_args, value) => value,
        },
        presentResult: gitResultCard,
        async execute(args, exec) {
            const a = args;
            const rc = await repoContext(ctx, exec, a);
            const list = await ctx.gitPlatform.listSecurityAlerts({ ...rc, signal: exec.signal });
            return {
                action: 'list', ok: true, title: `Security alerts in ${rc.owner}/${rc.repo}`, data: jsonify(list),
                text: list.length ? list.map((al) => `[${al.severity}] ${al.package}: ${al.advisory} (${al.state})${al.url ? ` — ${al.url}` : ''}`).join('\n') : '(no security alerts)',
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'git_ci',
        description: 'CI/CD pipeline status on hosted platforms: list runs and inspect one run.',
        parameters: {
            action: { type: 'string', enum: ['list', 'get'], required: true, description: 'Which pipeline operation to perform.' },
            ...COMMON_PLATFORM_PARAMS,
            branch: { type: 'string', description: 'list: filter by branch.' },
            limit: { type: 'integer', description: 'list: maximum number of runs.' },
            id: { type: 'string', description: 'get: the pipeline run id.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', required: true },
                    ok: { type: 'boolean', required: true },
                    text: { type: 'string', required: true },
                    title: { type: 'string' },
                    data: { type: 'json' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
            presentationMeta: (_args, value) => value,
        },
        presentResult: gitResultCard,
        async execute(args, exec) {
            const a = args;
            const rc = await repoContext(ctx, exec, a);
            const signal = exec.signal;
            const ci = ctx.gitPlatform;
            switch (a.action) {
                case 'list': {
                    const runs = await ci.listPipelines({ ...rc, branch: a.branch, limit: a.limit, signal });
                    return {
                        action: 'list', ok: true, title: `Pipeline runs in ${rc.owner}/${rc.repo}`, data: jsonify(runs),
                        text: runs.length ? runs.map((r) => `#${r.id} ${r.name} [${r.status}${r.conclusion ? `/${r.conclusion}` : ''}]${r.branch ? ` ${r.branch}` : ''}`).join('\n') : '(no pipeline runs)',
                    };
                }
                case 'get': {
                    if (!a.id)
                        throw new GitError('git_ci get requires `id`', 'GIT_INVALID_ARGS');
                    const run = await ci.getPipelineRun({ ...rc, id: a.id, signal });
                    const jobs = run.jobs?.length ? '\n' + run.jobs.map((j) => `  - ${j.name} [${j.status}${j.conclusion ? `/${j.conclusion}` : ''}]`).join('\n') : '';
                    return { action: 'get', ok: true, title: `Pipeline #${run.id} in ${rc.owner}/${rc.repo}`, data: jsonify(run), text: `#${run.id} ${run.name} [${run.status}${run.conclusion ? `/${run.conclusion}` : ''}]${jobs}\n${run.url}` };
                }
                default:
                    throw new GitError(`unknown git_ci action: ${String(a.action)}`, 'GIT_INVALID_ARGS');
            }
        },
    }));
}
//# sourceMappingURL=index.js.map