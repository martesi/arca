# Go

Load this reference for Go source and `core.md`. Do not load unrelated language
or scope references.

## Tooling and project fit

- Inspect the existing module, package boundaries, Go version, and dependencies
  before editing.
- Use `gofmt`, the project's configured vet or lint checks, and focused
  `go test` commands after non-trivial changes.
- Prefer the standard library and existing project packages before adding a
  dependency.

## Go idioms

- Return errors explicitly and add context while preserving the cause with
  `%w` when wrapping is useful.
- Do not ignore errors without a deliberate reason. Keep error handling near
  the operation that can fail and handle policy at a higher boundary.
- Pass `context.Context` through operations that can block, honor cancellation,
  and avoid starting goroutines whose lifetime is not owned.
- Define small interfaces at the consuming boundary when multiple
  implementations or test seams justify them. Do not create interfaces for a
  single concrete implementation by reflex.
- Keep packages focused and exported APIs minimal. Prefer simple structs and
  functions over manager or service objects that only group methods.

Keep this guidance Go-native; do not import standards from another language.
