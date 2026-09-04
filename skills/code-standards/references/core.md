# Shared Standards

Apply these rules to every supported language.

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
- Keep handwritten files below roughly 500 lines unless their size is
  structurally justified by generated code, data, schemas, or configuration.

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
- After non-trivial logic changes, run the narrowest relevant formatter,
  linter, type check, build, or test. Add one focused regression check when
  the changed behavior has a meaningful failure mode.
