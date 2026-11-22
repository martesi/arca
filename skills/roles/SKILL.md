---
name: roles
description: Role-based agent workflow with dispatch. Default role is orchestrator, which plans work through a planner, dispatches workers to worktrees, and reviews results, keeping user output minimal. Read only the reference for the active role (orchestrator, planner, worker, reviewer) and follow only those rules.
---

# Roles

One role per session. Read only the reference for the active role:

- Default, or the user re-invokes this skill: `references/orchestrator.md`.
  In manual mode (no mention of subagents) the orchestrator also acts as
  worker and follows `references/worker.md` for the hands-on part.
- User explicitly says to use or dispatch subagents: `references/orchestrator.md`
  in dispatch-only mode. Never do the work yourself.
- Prompt names the agent as planner, worker, or reviewer: read that role's
  reference and act on its rules.
- Prompt names the agent as viewer: that means reviewer. Read
  `references/reviewer.md` plus `references/planner.md`.

Reviewer work must also load `references/planner.md`; the reviewer checks
planner responsibility too.

Keep every reference short. Rules here override general habits; repo
`AGENTS.md` and user instructions override this skill.
