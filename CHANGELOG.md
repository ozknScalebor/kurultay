# Changelog

## v0.1.1

- Console start screen: Jira & GitLab connection – Jira version, signed-in user, issues waiting for `@kurultay`, GitLab version, the branch that will be used, start-up watch on or off.
- `/jira`, `/jira run [KEY]`, `/jira startup`, `/jira log` in the console – no workspace needed, the Jira work runs in its own clone.
- Windows: the portable `kurultay.cmd` starts Node with `--use-system-ca`, so company certificates in the Windows store are trusted; `kurultay jira startup` keeps the Node flags in the start-up entry.
- Windows: `--pause` or `KURULTAY_PAUSE=1` keeps Kurultay's window open until Enter (for PCs where Node runs in a window of its own); `kurultay.cmd` started on its own waits for a key; unexpected errors also go to `~/.kurultay/last-error.log`.

## v0.1.0

First release.

- One agent with one model at a time works the whole task through: it explores the code, edits, runs the build and tests itself and keeps the task's requirements as a todo list.
- The build and tests decide when a task is done; failing checks go to a coder in the next round.
- When the model stops answering (no first token, a silent stream, errors, or much slower than usual) it is quarantined and the same conversation continues on another model.
- Capability probe, project index (symbols, dependency graph, PageRank, BM25, optional embeddings) and architecture analysis spread over all models.
- Interactive console, `kurultay run`, live dashboard, sessions with rewind and git worktrees, skills, MCP and LSP.
- `kurultay jira`: issues assigned to you that mention `@kurultay` are done on a branch named from `gitlab.branchPrefix` and the issue key (e.g. `feature/ABC-12`) and sent back as GitLab merge requests, with the link as a comment on the issue.
- Several models at once (race, council reviews, parallel subtasks) only with `--mode multi`.
- Offline packages for Linux x64 and Windows x64; no npm runtime dependencies.
