# Claude model sources and DSH role mappings

The Claude Code settings page selects DSH or native Claude model configuration. Haiku, Sonnet and Opus store independent provider/model references. DSH owns model labels, capabilities, endpoints, credentials and the default selection; the plugin reads the same LLM registry that supplies Cowork. [DSH model connections](../../../AIKO.md#dsh-model-connections) owns the user-visible behavior and compatibility limits.

DSH mode is the default. Unset roles follow the live DSH default. A selected Claude alias resolves its role, while existing direct DSH selections retain an explicit main model. All role mappings enter the query revision, so a background-model change also rebuilds the query on the next turn. Native mode injects no DSH connection and imports Claude user/project/local settings. The supervisor resumes the same Claude conversation when changing source. Initialization from a mapped DSH query never replaces the native CLI catalog cache.

References are validated when saved from the live picker and when read from disk. Catalog edits do not invalidate saved IDs. Invalid files, unsupported provider references and missing DSH credentials fail explicitly. Browser responses contain model labels and references, never credentials. Settings writes preserve unrelated plugin fields and do not modify the user's Claude settings when saving model configuration.

Verification on Windows, Aiko DSH 0.1.5-alpha.2, plugin 0.1.51-aiko.4:

- `pnpm check`: Host and Client typechecks, 96 test files, 918 passed and 1 skipped, four localized UI snapshots, bundle build.
- `pnpm pack`: `norman-else-dsh-claude-0.1.51-aiko.4.tgz`.
- Focused tests cover settings persistence and rejection, native credential isolation, independent mappings, live defaults, retained catalog IDs, DSH title routing, and query recreation/resume across both modes.
- Authenticated web-profile smoke saves each role from the existing DSH list, switches both settings modes and confirms mappings survive, then runs Haiku, Opus, native default and Sonnet in the same conversation. The CLI transcript records `deepseek-flash`, `deepseek-flash`, the local native configuration's `k3`, and `deepseek-flash`, all under one Claude session ID.
- The browser reports no page errors. Cowork's settings file has the same SHA-256 before and after the smoke. The preview remains in DSH mode with all three roles mapped to the existing `deepseek-flash` entry.

The bridge currently supports DSH DeepSeek connections with an Anthropic-compatible endpoint. It does not translate arbitrary provider protocols. Native Claude MCP, hooks and plugins are imported only in native mode. Role mappings do not change this isolation requirement.
