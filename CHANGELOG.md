# Changelog

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
