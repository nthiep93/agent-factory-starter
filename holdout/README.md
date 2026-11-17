# Holdout scenarios

End-to-end acceptance scenarios that coding agents must not see or edit. They exist so an agent cannot pass by tuning code to the tests.

Agents are denied `Read` and `Edit` here in `.claude/settings.json`, and the `protect-files.sh` hook blocks writes. Empty in Phase 0. Scenarios are added in Phase 4 and run only in CI.
