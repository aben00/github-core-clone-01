# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aben00/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aben00/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and MCP, served from its own in-memory store with no UI, no outside service and no git binary.

## Run it

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the make.fun trial env (`MAKEFUN_ENV_URL`), serves the forge, and exits 0 once the env reports done. Node 22 only, standard library only — there is nothing to install.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bh1grvtt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
