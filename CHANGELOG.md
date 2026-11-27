# Changelog

## Unreleased

- Jira: a comment that mentions `@kurultay`, or an edited description, changes the request – also while Kurultay is working. The issue is read again every `jira.pollSeconds` (30 s); the change reaches the running agent at its next step (only what changed in the description is passed on). After the merge request the work goes on on the same branch, on top of the earlier commits, and the merge request is updated.
- Jira: when no model answers, Kurultay keeps trying (at most every `jira.retryMinutes`, 5) for `jira.maxWaitMinutes` (120), then comments that the issue is paused, goes on with the next one and comes back to it later. The issue is no longer marked as failed.
- Jira: every issue has its own git work tree next to the shared clone; the index and analysis are shared. After every agent step the changed files, the todo list and the agent's last note are saved, so a paused or interrupted issue (shutdown, Ctrl+C) goes on from where it stopped.
- Jira: fixed `git add` failing on the `.kurultay` folder in the work tree.
- `config_template.json` in the Kurultay folder: a commented user configuration to copy to `~/.kurultay/config.json`, with every value to enter marked `<...>`; until they are filled in, Kurultay names the ones left.

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
