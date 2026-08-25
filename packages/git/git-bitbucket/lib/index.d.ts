/**
 * @dsh-git/bitbucket — Bitbucket adapter for `gitPlatform` (Cloud REST 2.0).
 *
 * Auth is HTTP Basic with `username` + an app password (env-var reference).
 * Bitbucket Cloud has no releases API, so `createRelease` creates a tag ref;
 * `listSecurityAlerts` is unsupported and fails loudly with GIT_UNSUPPORTED.
 */
import type { Context } from '@deepseek-ai/cordis';
export interface Config {
    /** Bitbucket account username for Basic auth. */
    username?: string;
    /** Env-var REFERENCE for the app password (e.g. `BITBUCKET_APP_PASSWORD`). */
    appPasswordRef?: string;
    /** API base URL (default `https://api.bitbucket.org/2.0`). */
    baseUrl?: string;
}
export declare const name = "git-bitbucket";
export declare const inject: string[];
export declare function apply(ctx: Context, config?: Config): () => void;
export declare namespace apply {
    var inject: string[];
}
export default apply;
//# sourceMappingURL=index.d.ts.map