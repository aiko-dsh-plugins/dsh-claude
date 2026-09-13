# Aiko native Code workbench

This fork starts at [Norman-else/dsh-claude commit 0196b31](https://github.com/Norman-else/dsh-claude/commit/0196b31b07fd4aac0a461116f15b5a4accc40a69), version 0.1.51. The upstream MIT license and attribution remain in [LICENSE](LICENSE). The package retains its upstream module name for preset and client module resolution; Aiko distributions use an `-aiko` version suffix and local tarballs.

The tested host is Aiko DSH 0.1.5-alpha.2 with native workbench registration, preset-scoped model providers and per-session model selection. The unmodified upstream development manifest also targets DSH 0.1.5-rc.1. An alpha version number alone does not imply that an unmodified public host supplies the Aiko workbench APIs.

## Interface and sessions

The default renderer is `native`. DSH owns the sidebar, Workspace browser, Session identity, history, composer, tool cards, approvals and questions. Claude Code owns execution, tools and resume state. Selecting Code or Cowork changes which native Sessions are displayed; it does not transfer a conversation between engines. The companion `aiko-dsh-code` plugin registers Code with the `claude` preset. New Sessions inherit the DSH default model; existing model selections remain intact. Code model changes affect only that Session.

Client configuration `enhancedInterface: true` opts into the upstream repository controls, composer additions, hero and shell restyling. It is false by default. The Claude settings page, slash commands, transcript projections and activity details remain available. A saved renderer preference takes precedence over the default; existing turns retain their recorded renderer. Native prose is emitted when a Claude result completes; activity and tool events can arrive earlier.

## DSH model connections

For `deepseek-official`, Code preserves the selected provider/model in DSH request headers and runs the Claude Code loop through DeepSeek's [Anthropic-compatible API](https://api-docs.deepseek.com/guides/anthropic_api/). It reads the resolved `llm-deepseek` settings and resolves the configured credential reference on each turn. The endpoint keeps the configured origin and path, removes a trailing `/v1`, and appends `/anthropic` unless already present. Custom gateways must expose that API; an OpenAI-only endpoint fails rather than silently selecting another service.

The exact selected model is applied to the main model, fast model and subagent model defaults. Public DeepSeek model names are checked to prevent the compatibility API's silent unknown-name fallback. Endpoint, credential or model changes rebuild the query and resume its Claude session. Only the explicit subprocess environment receives the credential; SDK settings, argv, DSH logs and browser data do not receive it. Missing DSH credentials fail without using a personal Claude login. DSH titles use the selected DSH provider directly.

DSH-routed queries use `settingSources: []` to prevent user/project/local Claude settings from overriding the DSH endpoint or credentials. Claude settings-based MCP servers, hooks and plugins therefore are not imported in this mode. The native Claude provider remains an explicit option and retains the user's Claude settings/authentication. Its title requests use isolated Haiku and reject authentication errors. Other DSH providers require their own compatible connection implementation before they can be offered in Code.

## Develop against the Aiko checkout

Keep this checkout and `dsh-code` under a directory adjacent to `deepseek-harness`. Build the host first, then run:

```powershell
node scripts/link-aiko-host.mjs
pnpm install --ignore-scripts
git restore -- pnpm-workspace.yaml pnpm-lock.yaml
$env:pnpm_config_verify_deps_before_run = 'false'
pnpm check
pnpm pack
```

The linking script generates machine-local workspace overrides. Restoring the manifests after installation preserves the links in `node_modules` without committing local paths. The command-scoped pnpm setting prevents pnpm 11 from replacing those deliberate links with registry packages when running scripts. Pass an absolute host directory as the script's first argument for another layout.

Install the fork tarball and the companion Code tarball through the same `dsh plugin --profile web add` command, then launch the `web` profile. Use the authenticated URL printed by `dsh`; a bare URL in a browser without its cookie returns 401. Claude Code must be installed on the host. DSH DeepSeek selections need a DSH credential; explicit native Claude selections need Claude authentication.

Old `aiko_code` records stay in their original store and are exposed by the companion's read-only archive. No released DSH Session generation or Claude sidecar is rewritten.
