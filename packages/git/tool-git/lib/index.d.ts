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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "tool-git";
export declare const inject: string[];
export declare const Config: z<Schemastery.ObjectS<{
    /** Require explicit approval for destructive actions (force-push, merge, rebase, tag delete, PR merge, release). */
    confirmDestructive: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    /** Require explicit approval for destructive actions (force-push, merge, rebase, tag delete, PR merge, release). */
    confirmDestructive: z<boolean, boolean>;
}>>;
export declare function apply(ctx: Context, config?: {
    confirmDestructive?: boolean;
}): void;
//# sourceMappingURL=index.d.ts.map