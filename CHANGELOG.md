# Changelog

## v0.1.4

- Settings split in two: `~/.kurultay/config.json` holds only what has to be entered – the models and keys, Jira and GitLab access; `~/.kurultay/settings.json` holds every setting with a default (timeouts, Jira timings, limits) and is written with the defaults on the first start. `config.json` and a project's `kurultay.config.json` still win over it; `/llm set` writes to `settings.json`; `config_template.json` lists only what has to be entered.
- Console: no workspace question on start – the prompt takes commands at once. `/workspace <path>` opens a project, `/workspace` lists the recent ones, `/workspace 2` opens the second; commands that need a project say so, `/jira` needs none.
- Models without a capability profile are measured right after the start screen (and before the first Jira issue), once – not only when a project was opened.
- Jira: the analysis belongs to the repository, not to the issue. Its first issue analyses the repository (file summaries, `ARCHITECTURE.md`, flows, project notes) in the shared clone at the target branch, and keeps it with the index, skills and rules in the project folder `~/.kurultay/projects/<group_project>/`. Later issues fetch first and summarise only the files that changed on the target branch (`jira.reanalyzeFiles`, default 30, makes the whole analysis again); an issue's own branch never goes into it. `jira.analyze: false` turns it off.
- Jira: an issue can name its repository with the mention: `@kurultay{repo:<url>}` (plain, in `<…>` or quotes, or a pasted Jira link); `gitlab.repo` is then not needed. The setting is not part of the task text.
- Jira: skills and rules for a repository go into its project folder (`skills/`, `rules/`); the issue header shows the folder and the skills found.
- The analysis no longer counts data files it never summarises as "changed" (they made every start look out of date).
- CI: every commit on main runs on its own, so a later push can no longer drop a release run that is still waiting.

## v0.1.3

- Jira: every agent step on screen, with a heading per issue – the issue key and summary, then labelled lines (repository, branch, request, build/test commands), numbered steps with the elapsed time (`0:40  step 2 · reading Panel.java`), model changes, the build/test result and the merge request. After a quiet minute a line says what Kurultay waits for; an outage is one line instead of every retry. `/jira run` in the console gets the live activity block of `/run` (spinner, model, step, Ctrl+C); `/jira` no longer repeats the start panel; long lines wrap; `jira.log` names the issue on every line.
- Build and test commands from the CI pipeline: with no `verify` configured, Kurultay takes them from `.gitlab-ci.yml`, GitHub/Gitea/Forgejo workflows, `azure-pipelines.yml`, `bitbucket-pipelines.yml`, Drone or Woodpecker, YAML files in `.gitlab/` and `ci/`, with GitLab `include:` files of the same repository – only build/test tools, the pipeline's variables filled in; deploy, publish, container, network and install steps are left out. `kurultay init` writes them too; `verify.pipelineFile` names a file kept under another name, `verify.fromPipeline: false` turns it off.
- Jira: submodules are checked out in every issue's work tree (recursively, with the same credentials); one that cannot be fetched is a warning; changes inside a submodule are not committed and are reported.
- Jira screen: the start of every line has its own colour (headings and labels cyan, times gray, step numbers magenta) – a classic Windows console shows dim text as plain text.
- Fixed: a configuration loaded without a section shared that section with the built-in defaults, so a change to one loaded configuration showed up in the next one of the same process.

## v0.1.2

- Jira: a comment that mentions `@kurultay`, or an edited description, changes the request – also while Kurultay is working. The issue is read again every `jira.pollSeconds` (30 s); the change reaches the running agent at its next step (only what changed in the description is passed on). After the merge request the work goes on on the same branch, on top of the earlier commits, and the merge request is updated.
- Jira: when no model answers, Kurultay keeps trying (at most every `jira.retryMinutes`, 5) for `jira.maxWaitMinutes` (120), then comments that the issue is paused, goes on with the next one and comes back to it later. The issue is no longer marked as failed.
- Jira: every issue has its own git work tree next to the shared clone; the index and analysis are shared. After every agent step the changed files, the todo list and the agent's last note are saved, so a paused or interrupted issue (shutdown, Ctrl+C) goes on from where it stopped.
- Jira: fixed `git add` failing on the `.kurultay` folder in the work tree.
- Fixed: the rate limiter could report a 1 ms wait for a request that went through at once.
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
