/**
 * @dsh-git/github — GitHub adapter for `gitPlatform`.
 *
 * The reference implementation: REST endpoints against `api.github.com`
 * through Node's global fetch, every response normalized into the seam's
 * vocabulary. Tokens are optional (public repos work anonymously) and resolved
 * per operation through `ctx.credentials` from the configured env-var
 * reference — never cached, never inlined.
 */
import type { Context } from '@deepseek-ai/cordis';
export interface Config {
    /** Env-var REFERENCE for the token (e.g. `GITHUB_TOKEN`), resolved per operation. */
    tokenRef?: string;
    /** API base URL (default `https://api.github.com`). */
    baseUrl?: string;
}
export declare const name = "git-github";
export declare const inject: string[];
export declare function apply(ctx: Context, config?: Config): () => void;
export declare namespace apply {
    var inject: string[];
}
export default apply;
//# sourceMappingURL=index.d.ts.map