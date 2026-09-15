# DSH model catalog edits

The DSH DeepSeek catalog is advisory. The Claude connection resolver forwards the selected model ID to the configured endpoint, including IDs absent from the current catalog. Existing Sessions retain their selected ID when the catalog changes; the composer selects a replacement explicitly. Display labels do not change the connection or restart its query. [DSH model connections](../../../AIKO.md#dsh-model-connections) owns the configuration and endpoint requirements.

The regression replaces the catalog with `deepseek-flash` while a Session selects `deepseek-v4-flash`. Before the fix, `pnpm exec vitest run test/dsh-models.test.ts` reproduces `model deepseek-v4-flash is not in the DSH DeepSeek catalog`. The bridge's catalog membership check and fixed public-model list incorrectly imposed restrictions absent from the DSH provider. Both checks are removed; endpoint validation, credential resolution and supported-provider checks remain.

Verification on Windows with Aiko DSH 0.1.5-alpha.2 and plugin 0.1.51-aiko.3:

- `pnpm exec vitest run test/dsh-models.test.ts`: 17 passed, covering replacement IDs, custom IDs, display-name changes and an empty catalog.
- `pnpm check`: Host and Client typechecks, 94 test files with 908 passed and 1 skipped, and bundle build succeeded.
- `pnpm pack`: produced `norman-else-dsh-claude-0.1.51-aiko.3.tgz`.
- Authenticated `dsh --profile web` browser smoke: a new Code Session retains the uncatalogued default `deepseek-v4-flash` and replies successfully; selecting the configured `deepseek-flash` then succeeds in the same Session. The local Claude transcript reports those exact model IDs under the same Claude session ID. No browser page errors were observed.

No DSH setting or existing user Session is rewritten. The live smoke adds one validation Session. No upstream endpoint support is inferred for arbitrary model IDs; the endpoint remains responsible for resolving or rejecting them.
