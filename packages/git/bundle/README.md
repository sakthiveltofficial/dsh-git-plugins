# @dsh-git/bundle

Profile bundle for the whole dsh-git suite. One install wires everything:

```sh
dsh plugin --profile web add @dsh-git/bundle
```

Declares every other `@dsh-git/*` package as a dependency and carries the `dsh.bundle.patch` (`cordis.patch.yml`) that inserts local git, all five platform adapters, memory, and the tools into a DSH profile's composition.

Part of the [dsh-git](https://github.com/sakthiveltofficial/dsh-git-plugins) plugin suite for DeepSeek Harness — see the root README for install and usage.
