# Rust

Load this reference for Rust source and `core.md`. Do not load unrelated
language or scope references.

## Tooling and project fit

- Inspect the existing toolchain, workspace, crate boundaries, and dependency
  choices before editing.
- Use `cargo fmt`, the project's configured Clippy checks, and focused
  `cargo test` commands after non-trivial changes.
- Prefer the standard library and crates already selected by the project before
  adding a dependency.

## Rust idioms

- Use ownership and borrowing directly. Avoid unnecessary `clone` calls;
  change the API or lifetime when that makes the ownership clear.
- Use `Option` and `Result` for absence and failure. Propagate expected errors
  with `?` and handle them at an intentional boundary.
- Avoid `unwrap` and `expect` on recoverable or external input. Use them only
  for a local invariant that cannot be expressed more clearly, and document
  the invariant when it is not obvious.
- Prefer enums and exhaustive `match` for meaningful state. Use iterators when
  they clarify the transformation and loops when they clarify control flow.
- Define traits for real behavioral boundaries or multiple meaningful
  implementations, not to abstract one concrete type.
- Keep modules and items private by default. Use structs and enums to model
  domain data rather than generic manager objects.

Keep this guidance Rust-native; do not import standards from another language.
