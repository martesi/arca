---
name: new-project
description: Interview the user to define a new software project's real purpose, users, constraints, integrations, distribution, and success criteria; then research existing apps and reusable foundations before deciding whether anything new should be built. Use for new project ideas, greenfield applications, tools, libraries, or services. Prefer reuse, extension, or integration over unnecessary greenfield work.
---

# New Project

Treat this as a product interview before an implementation task.

1. Read `references/grilling.md` and load the upstream grilling skill. Interview for the problem before discussing frameworks or scaffolding. Treat explicit user decisions as settled unless they conflict with another requirement.
2. Establish, at minimum: intended users, problem/pain, current workaround, triggering context, inputs/outputs, must-haves, optional features, integrations, deployment/distribution, permissions/data constraints, success criteria, and what the project must not become. Ask the highest-value unresolved question first rather than dumping a questionnaire.
3. If the project is intended as an upstream/reusable tool, library, CLI, integration, or service, prefer Node-compatible or Node/TypeScript-compatible foundations and interfaces when choices are otherwise comparable. Do not force Node where native, platform, or ecosystem constraints dominate.
4. Once the interview is sufficiently settled, search current apps, services, libraries, CLIs, and maintained repositories that already solve the problem or a large part of it. Compare actual fit against the requirements rather than popularity alone.
5. Present the result from least new code to most:
   - **Use directly** — if dropping or relaxing a named requirement makes an existing option fit, state exactly which requirement and which option.
   - **Use with a tweak** — identify an existing option plus the smallest configuration, plugin, wrapper, patch, or fork needed.
   - **Build upon/with** — identify a maintained foundation or companion tool that can own a substantial part of the solution.
   - **Build new** — only when the remaining requirements justify custom implementation; name the gaps that force it.
6. If a build remains justified, read `references/environment.md` and establish the reproducible environment before relying on host-installed tools.
7. Before choosing implementation details, inspect installed or available skills for relevant stack-selection guidance and load the best matching skill if present. Do not embed a fixed stack in this skill.
8. Scaffold only after the preceding decisions are settled, and implement the smallest useful slice first.

Keep the final recommendation layered enough that the user can see which constraint causes each jump in implementation cost.
