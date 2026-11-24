# Shared Standards

Apply these rules to every language and framework.

## Project conventions and scaffolding

- Prefer the official CLI or generator when scaffolding a project or framework
  component, provided it fits the project and the task. Review its output and
  preserve existing conventions.
- Before creating a `.gitignore` or establishing project structure for a
  language or framework without a dedicated reference in this skill, research
  its upstream repository, official examples, and well-known downstream
  projects. Compare their patterns with the project's needs; do not copy them
  blindly. Record applicable common patterns in the target repository's agent
  instructions so future work can follow them. If sources are unavailable,
  disclose the gap rather than presenting an assumption as a convention.
- Do not commit temporary environment probes, orphan test scripts, or similar
  one-off diagnostic artifacts without explicit user confirmation. Keep useful
  durable tests integrated with the project's test workflow; keep temporary
  artifacts out of commits.

## Scope and design

- Understand the real flow and relevant callers before editing. Fix shared
  causes where all affected paths converge.
- Keep each value, function, effect, type, export, and dependency in the
  smallest scope that needs it.
- Keep code beside its consumer. Move local code to shared scope only for real
  reuse or a clearer boundary.
- Reuse existing project helpers, patterns, and dependencies before adding
  abstractions.
- Do not create one-purpose factories, managers, repositories, utility
  dumping grounds, or public APIs without a concrete need.

## Observability

- When a failure is shown to a user, provide a safe, actionable user-facing
  message and developer-facing diagnostics. Do not silently swallow unexpected
  failures.
- Use the project's existing logging and telemetry conventions. Include a stable
  event or operation name, relevant non-sensitive context, and the original cause
  or stack when available. Never log secrets, credentials, tokens, or unnecessary
  personal data.
- Expected validation still needs clear user feedback; record it at the project's
  appropriate diagnostic level when it is useful for development, without making
  normal validation noise look like an unexpected system failure.
- When a meaningful failure path changes and a test seam exists, verify both the
  user-facing result and the developer-facing log or telemetry event.

## Readability

- Make the meaningful flow readable from top to bottom.
- Name conceptual operations instead of exposing incidental mechanics.
- Prefer early exits and shallow nesting when they fit the language.
- Extract code when its name clarifies the flow, not to satisfy an arbitrary
  line count. Keep small duplication when extraction would widen scope or
  obscure intent.
- Keep independent work concurrent when safe and make task dependencies
  explicit.

## Modules and files

- Keep implementation private by default and expose only deliberate APIs.
- Colocate by feature or responsibility. Do not create technical dumping
  grounds or barrel files merely to shorten imports.
- Keep every handwritten file at or below 500 physical lines, including blank
  lines and comments. Split along a real responsibility boundary before adding
  beyond the limit. An agent may exceed 500 lines only when a task-specific
  instruction explicitly authorizes it, and the file has a comment explaining
  why it must remain together; a comment alone is not permission.

## Names and comments

- Use semantic names: verbs for actions, nouns for values, and clear boolean
  prefixes where appropriate.
- Comment why, external constraints, compatibility behavior, invariants, magic
  numbers, or intentionally unusual code. Do not narrate obvious code.

## Dependencies and checks

- Check the platform, standard library, project, and existing dependencies
  before adding a package.
- Choose the smallest maintained dependency that meaningfully reduces code or
  risk. Do not add overlapping libraries.
- Default end-to-end tests to the real backend and real application integration,
  using isolated test data and safe test services. Use mocks or stubs only when
  explicitly requested or when a real dependency is unavailable or unsafe;
  disclose the substitution and its coverage limits. Do not call a mocked flow
  full end-to-end coverage.
- After non-trivial logic changes, run the narrowest relevant formatter,
  linter, type check, build, or test. Add one focused regression check when
  the changed behavior has a meaningful failure mode.
