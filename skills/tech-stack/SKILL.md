---
name: tech-stack
description: Choose the smallest coherent implementation stack for a software project after product requirements are known. Use for greenfield stack selection, stack comparisons, or implementation planning across web apps, fast SSR/server-owned UIs, desktop apps, static sites, userscripts, and small utilities. Preserve existing-project conventions unless migration is explicitly requested.
---

# Tech Stack

Choose tools only after the product constraints are understood.

1. Inspect the project requirements, deployment target, existing ecosystem, and any already-settled language/runtime choices.
2. Read `references/defaults.md` for the current preferred baselines and select only the subset the project needs.
3. Prefer platform or runtime capabilities before adding dependencies. Check current compatibility before pinning versions.
4. For a new web UI, explicitly compare the fast SSR/server-owned option against a client-heavy SPA before defaulting to React.
5. Keep existing repositories on their established stack unless migration is part of the request.

Return the chosen stack with a short reason for each non-obvious dependency and name the simpler alternative that was rejected, if any.
