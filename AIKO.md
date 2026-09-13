# Aiko native Code workbench

This fork starts at [Norman-else/dsh-claude commit 0196b31](https://github.com/Norman-else/dsh-claude/commit/0196b31b07fd4aac0a461116f15b5a4accc40a69), version 0.1.51. The upstream MIT license and attribution remain in [LICENSE](LICENSE). The package retains its upstream module name for preset and client module resolution; Aiko distributions use the version suffix `-aiko.1` and local tarballs.

The tested host is Aiko DSH 0.1.5-alpha.2 with native workbench registration, preset-scoped model providers and per-session model selection. The unmodified upstream development manifest also targets DSH 0.1.5-rc.1. An alpha version number alone does not imply that an unmodified public host supplies the Aiko workbench APIs.

## Interface and sessions

The default renderer is `native`. DSH owns the sidebar, Workspace browser, Session identity, history, composer, tool cards, approvals and questions. Claude Code owns execution, tools, local authentication and resume state. Selecting Code or Cowork changes which native Sessions are displayed; it does not transfer a conversation between engines. The companion `aiko-dsh-code` plugin registers Code with the `claude` preset and selects a Claude model without replacing Cowork's global default.

Client configuration `enhancedInterface: true` opts into the upstream repository controls, composer additions, hero and shell restyling. It is false by default. The Claude settings page, slash commands, transcript projections and activity details remain available. A saved renderer preference takes precedence over the default; existing turns retain their recorded renderer. Native prose is emitted when a Claude result completes; activity and tool events can arrive earlier.

Automatic title generation rejects Claude authentication and result errors so DSH retains the first-message title when the auxiliary Haiku request is unavailable.

## Develop against the Aiko checkout

Keep this checkout and `dsh-code` under a directory adjacent to `deepseek-harness`. Build the host first, then run:

```powershell
node scripts/link-aiko-host.mjs
pnpm install --ignore-scripts
git restore -- pnpm-workspace.yaml pnpm-lock.yaml
pnpm check
pnpm pack
```

The linking script generates machine-local workspace overrides. Restoring the manifests after installation preserves the links in `node_modules` without committing local paths. Pass an absolute host directory as the script's first argument for another layout.

Install the fork tarball and the companion Code tarball through the same `dsh plugin --profile web add` command, then launch the `web` profile. Use the authenticated URL printed by `dsh`; a bare URL in a browser without its cookie returns 401. Claude Code must already be installed and authenticated on the host.

Old `aiko_code` records stay in their original store and are exposed by the companion's read-only archive. No released DSH Session generation or Claude sidecar is rewritten.
