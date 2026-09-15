# Native Code workbench controls

Code keeps the native DSH workspace tree, sessions, composer and transcript. Plan, Diff, review comments and rewind register independently of the optional upstream shell redesign. A task header opens retained history, while existing turn launchers preserve their turn scope.

The pinned SDK supplies task kind, workflow name, background status, paused state and per-task stop. Task display uses these fields and redacted progress summaries. No DSH subagent/workflow engine is mounted. Structured workflow phases and pause/resume/retry controls are not exposed by this SDK integration.

Task stop validates session ownership and observed task identity before calling the existing Query. Completion remains engine-owned; control rejection preserves the query and sibling tasks. Housekeeping is excluded from user activity counts. Native whole-turn cancellation remains unchanged.

Verification includes localized task-panel snapshots, filtering and stale-stop interactions, route ownership/validation/redaction, supervisor task isolation, existing plan/Diff/rewind regressions, typechecks and the package build. The authenticated web profile was exercised with two real read-only Claude subagents, a background task stopped through the new button, and a real plan sent back through the sidebar. The CLI acknowledged the task stop and emitted its stopped lifecycle event; plan feedback returned successfully and the turn ended without applying the plan. Diff empty-state opening/closing, rewind dialog cancellation and Cowork isolation were also exercised without browser errors. Workflow metadata is covered by fixtures; a real dynamic-workflow execution was not part of this verification.

Finished task history is loaded into each new Query's observed task map and survives process recreation. Old running/paused entries are discarded on the first initialization; repeated initialization on the same process preserves its live work.
