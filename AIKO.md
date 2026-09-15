# Aiko native Code workbench

This fork starts at [Norman-else/dsh-claude commit 0196b31](https://github.com/Norman-else/dsh-claude/commit/0196b31b07fd4aac0a461116f15b5a4accc40a69), version 0.1.51. The upstream MIT license and attribution remain in [LICENSE](LICENSE). The package retains its upstream module name for preset and client module resolution; Aiko distributions use an `-aiko` version suffix and local tarballs.

The tested host is Aiko DSH 0.1.5-alpha.2 with native workbench registration, preset-scoped model providers and per-session model selection. The unmodified upstream development manifest also targets DSH 0.1.5-rc.1. An alpha version number alone does not imply that an unmodified public host supplies the Aiko workbench APIs.

## Interface and sessions

The default renderer is `native`. DSH owns the sidebar, Workspace browser, Session identity, history, composer, tool cards, approvals and questions. Claude Code owns execution, tools and resume state. Selecting Code or Cowork changes which native Sessions are displayed; it does not transfer a conversation between engines. The companion `aiko-dsh-code` plugin registers Code with the `claude` preset. New Sessions inherit the DSH default model; existing model selections remain intact. Code model changes affect only that Session.

Client configuration `enhancedInterface: true` opts into the upstream repository controls, composer additions, hero and shell restyling. It is false by default. The Claude settings page, slash commands, transcript projections, task controls, plan review, diff comments and rewind remain available. A saved renderer preference takes precedence over the default; existing turns retain their recorded renderer. Native prose streams immediately; root tool calls close the preceding prose block, and one final event settles the turn.

## Native conversation controls

Native Session references and shared resources use DSH's context row. The adapter forwards the newest human text/images followed by adjacent `session-reference` context and `aiko-dsh-workbench-kit` plugin `snapshot` text, in logged order and before assistant/tool history. DSH owns native Session discovery, preparation, read-only warnings and omission notices; these reach Claude unchanged. Native Session references work without the kit. Shared resources require the paired kit build. Unrelated DSH context and prior reference snapshots are excluded; Claude owns its history and tools. Existing logged messages remain unchanged. See the [reference input evidence](docs/aegis/evidence/2026-09-15-resource-input.md).

Code sessions expose Tasks and workflows and Diff in the existing DSH session header. A pending Claude plan opens the native right sidebar once per proposal; closing it does not reopen it until another proposal arrives. Review comments appear above the native composer. Diff shows a localized empty state when the workspace has no Git repository or changes are unavailable. Rewind remains attached to user messages and uses the existing confirmation dialog. These controls are independent of `enhancedInterface`; Cowork keeps its own controls, session tree and composer.

The task panel shows the session's retained task history from the header, or one turn from its transcript launcher. Finished records survive Claude process recreation; stale live records from the old process are removed. Filters separate Claude subagents, workflows and other background work. Engine-supplied workflow names, progress summaries, usage and paused state are displayed without parsing workflow scripts. Housekeeping tasks do not count as user work. The public SDK currently exposes task lifecycle and stop, but no structured phase graph or pause/resume/retry controls; the UI does not invent these controls.

Stop task calls `Query.stopTask()` only on an existing process and a task observed in that session. It never starts a process, changes the selected model, interrupts sibling tasks or marks a task stopped optimistically. Claude's lifecycle notification owns the resulting status; unavailable tasks and failed requests have localized feedback. Native DSH Stop continues to cancel the whole turn. Claude Code remains the sole owner of execution and orchestration.

## DSH model connections

Configured DSH providers are available in Code's native model picker. The picker refreshes its provider policy when the host adapter registry changes or reconnects, while keeping the Claude engine provider out of Cowork. Other DSH providers and mixed-provider role mappings use a query-scoped loopback Messages endpoint backed by the public `ctx.llm.stream` service. Each endpoint has an ephemeral authentication token, rejects browser-origin requests, honors cancellation and closes with its query. Provider credentials remain inside DSH; the Claude process receives only the local endpoint token. Inner model calls bypass the Code engine route, preventing recursion.

For `deepseek-official`, Code preserves the selected provider/model in DSH request headers and runs the Claude Code loop through DeepSeek's [Anthropic-compatible API](https://api-docs.deepseek.com/guides/anthropic_api/). It reads the resolved `llm-deepseek` settings and resolves the configured credential reference on each turn. The endpoint keeps the configured origin and path, removes a trailing `/v1`, and appends `/anthropic` unless already present. Custom gateways must expose that API; an OpenAI-only endpoint fails rather than silently selecting another service.

Claude Code settings offer `Use DSH models` (the default) and `Use native Claude configuration`. In DSH mode, Haiku, Sonnet and Opus independently reference models from the same live LLM registry used by Cowork, including different providers. Unset roles follow the live DSH default model. The settings page stores only provider/model references in the plugin settings file and preserves mappings when switching modes. Refresh model list reads updated registry labels.

Selecting a Claude role in the composer resolves its mapped main model; `default` resolves Sonnet, and `[1m]` aliases use their role's DSH capabilities. A direct DSH selection remains an explicit main-model selection, with the configured role mappings available for background work and subagents. The mappings use Claude Code's [model environment variables](https://code.claude.com/docs/en/model-config); subagents without an explicit role inherit the main model. DSH title requests for Claude roles use the Haiku mapping through DSH's provider, without a separate Claude conversation or native authentication.

DSH's catalog supplies discovery labels and capabilities; it does not restrict dispatch. Renaming a display label or removing a catalog entry leaves saved references usable. A new mapping must be chosen from the current list. The configured endpoint owns model availability and alias resolution, including DeepSeek's documented unknown-name fallback. Source, endpoint, credential or any role mapping changes rebuild the query on its next turn and resume its Claude session. Only the explicit subprocess environment receives the credential; SDK settings, argv, DSH logs and browser data do not receive it. Missing DSH credentials fail without using a personal Claude login.

DSH-routed queries use `settingSources: []` to prevent user/project/local Claude settings from overriding the DSH endpoint or credentials. Claude settings-based MCP servers, hooks and plugins therefore are not imported in this mode. Native mode reads the local Claude model lineup and retains user/project/local Claude settings and authentication without injecting DSH credentials or mappings. An existing direct DSH selection uses Claude's default on its next turn in native mode; explicit Claude aliases are preserved. Native title requests use isolated Haiku and reject authentication errors. Source and mapping changes apply only to Code and do not write Cowork's model configuration.

The generic transport supports text, base64 images admitted through DSH attachments, reasoning, client tool calls/results, streaming and non-streaming replies. It translates supported effort values to the selected provider; other effort values retain that provider's default. Forced tool selection, server-hosted tools, documents and unsupported Messages fields fail explicitly. Provider-private replay data is retained only for matching assistant content and the same provider/model; it never inserts extra history. Model request/response records live under `DSH_HOME/plugins/dsh-claude/model-requests` with credential-like values redacted and no content truncation. They are separate from released DSH Session records; transport headers and provider credentials are excluded. This transport does not promise every Anthropic beta feature on every provider.

Configuration limits are `modelRequestMaxBytes` and `modelResponseMaxBytes` (32 MiB each), and `modelRequestTimeoutMs` (10 minutes). DSH adapter settings and credentials are resolved by the provider on each inner request. Query recreation is needed for role/source changes; generic-provider credential rotation does not require transferring a new credential into Claude.

## DSH skills, connectors and Kit resources

The Code preset mounts DSH's `skill-filesystem` and `tool-skill` plugins. The native `/` menu retains the DSH catalog and explicit skill invocation; its logged `skill-invocation` instructions accompany the latest input. A resolved DSH slash directive is translated to a plain instruction for Claude so it cannot be mistaken for a missing Claude slash command. Model-invoked skill discovery uses the same scoped registry and excludes user-only skills.

Each Claude query has an official SDK in-process MCP server named `dsh`. It exposes `list_skills`, `load_skill`, `list_connectors`, `call_connector`, `list_resources` and `read_resource`. Connectors are the currently visible DSH `mcp__` tools, excluding Claude's presentation-only mirrors. Resource operations call Kit's existing `workbench_resource_list` and `workbench_resource_read`; the Kit remains optional. No connector transport, credential configuration, resource registry or duplicate settings UI is created.

The managed bridge delegates connector/resource execution to DSH's tool runtime, including argument validation, permission policy and native approvals. The Claude wrapper does not open a second approval dialog. Calls are serialized per query, bound to their originating Agent/turn, cancelled on owner teardown and logged using native tool events. `capabilityMaxResultBytes` defaults to 64 KiB; oversized or unsupported results fail explicitly. SDK-native Claude tools retain the existing Claude-to-DSH permission bridge.

See [Kit and Code integration evidence](docs/aegis/evidence/2026-09-15-kit-code-capabilities.md) for keyless SDK protocol checks and the remaining live-test limits. Studio connectivity is handled separately.

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

Old `aiko_code` records stay in their original store; the companion no longer lists their archive in the sidebar. No released DSH Session generation or Claude sidecar is rewritten.
