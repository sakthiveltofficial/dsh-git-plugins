# How to ship and install the dsh-git plugin suite

Two distribution questions, two answers:

- **Source lives on GitHub** — version control, issues, the `dsh-plugin` topic
  for discovery. This repository is that source.
- **Installable packages live on npm** — a DSH profile installs plugins with
  `dsh plugin --profile <name> add <package>`, which is a thin `pnpm add`
  forwarder. The one package to install is **`@dsh-git/bundle`**: it declares
  every other `@dsh-git/*` package as a dependency and carries a
  `dsh.bundle.patch` (`cordis.patch.yml`) that inserts the whole git
  capability into the profile composition. One command, everything wired.

## 1. Publish to npm

```sh
pnpm install
pnpm build
pnpm -r publish --access public --no-git-checks   # dependency order, builds each package first
```

(`pnpm -r publish` publishes in topological order; `prepublishOnly: npm run build`
rebuilds each package. Scoped packages publish public via `publishConfig.access`.)

Or push a `v*` tag and let `.github/workflows/publish.yml` publish for you.

## 2. Install into a DSH profile

```sh
dsh plugin --profile web add @dsh-git/bundle
# restart the profile; verify the rows landed:
dsh --profile web --dump-config | grep -i git
```

The bundle's patch inserts `git-local`, `git-platform`, the five platform
adapters, `git-memory`, `tool-git-memory`, and `tool-git` as host rows — the
same mechanism the existing `dsh-find-plugin` uses to ship its tool. No preset
editing required; the tools become visible to every agent in the profile.

### Secrets

Set the referenced env vars (or configure `ctx.credentials` sources) before
using platform operations:

| Env var | Used by |
| --- | --- |
| `GITHUB_TOKEN` | `@dsh-git/github` |
| `GITLAB_TOKEN` | `@dsh-git/gitlab` |
| `BITBUCKET_APP_PASSWORD` (+ `username` config) | `@dsh-git/bitbucket` |
| `AZURE_DEVOPS_PAT` | `@dsh-git/azuredevops` |
| `GITEA_TOKEN` (+ `baseUrl` config) | `@dsh-git/gitea` |

Unset references fall back to anonymous access: public repos work, writes fail
loud with `GIT_AUTH_FAILED`.

## 3. Alternative: opt-in per agent preset (no host rows)

If you prefer the tools only for agents on a specific preset (the "preset
plane" shape), copy `composition/git.cordis.yml` into that preset's
`agent.cordis.yml` instead of installing the bundle. The services then sit in
an `isolate` realm per session; memory still persists cross-session through the
shared `git_memory` storage domain.

## 4. No npm needed — install straight from GitHub

The repo ROOT is itself a bundle: `package.json` declares `dsh.bundle.patch`
(`cordis.patch.yml`) and depends on every `@dsh-git/*` package by real npm
version, so a git install pulls the whole suite without any build approval
(the root has no `prepare` script):

```sh
dsh plugin --profile web add github:sakthiveltofficial/dsh-git-plugins
```

Use exactly one install path — installing both the npm bundle and the GitHub
root would double-register the same rows. To switch, remove the other first
(`dsh plugin --profile web remove @dsh-git/bundle`).

For private hosting or air-gapped installs: `pnpm add ./packages/git/core` …
works per package from a local checkout.

## Versions

All packages are pinned to exact versions (`cordis 4.0.1`, `schemastery
3.18.1`, `dsh-* 0.1.0-rc.6`) to match the deployment. Bump `@dsh-git/*`
versions together and keep the bundle's dependency ranges in lockstep.
