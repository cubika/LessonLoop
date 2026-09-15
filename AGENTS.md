# Repository instructions

- Before editing code or documentation, create a dedicated worktree from local `main`: `git worktree add -b codex/<task> .local-validation/<task>/worktree main`. Choose an unused task name and run all edits and checks in that worktree.
- Keep the primary checkout on `main`. If work started there, transfer only this task's uncommitted changes into its worktree. Preserve unrelated changes, branches, and worktrees.
- Validate the actual outcome with the relevant tests, build, or document checks. Fix failures before merging; if blocked, keep the worktree and report what remains unresolved.
- Before merging, check whether `main` advanced. Merge its latest changes into the task branch, resolve conflicts there, and rerun affected checks. Never overwrite another task's work.
- After validation passes, commit the task and merge it into local `main` with `git merge --ff-only codex/<task>` from the primary checkout. Complete this workflow without an extra confirmation unless instructed otherwise. Push only when requested.
- After confirming the task branch is merged and its worktree has no uncommitted changes, remove that worktree with `git worktree remove <path>`, then delete the branch with `git branch -d codex/<task>`. Run cleanup from the primary checkout; do not force removal or discard unmerged work.
- Before cleanup, verify the absolute target is this task's worktree inside the workspace. Remove any shared dependency junction itself without traversing its target. Verify cleanup and report the merge commit, validation results, and change totals.
