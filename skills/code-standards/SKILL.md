---
name: code-standards
description: Apply scoped coding standards while creating, reviewing, refactoring, or debugging JavaScript, TypeScript, Rust, Go, React, and frontend code. Read only the language and scope references relevant to the changed code; Rust, Go, backend, CLI, and native-only work must not load frontend or UI guidance.
---

# Code Standards

Identify the language and scope before editing. Read `references/core.md` and
only the matching references:

- JavaScript or TypeScript: `references/javascript-typescript.md`
- React, browser, frontend, or UI: add `references/frontend.md`
- Rust: `references/rust.md`
- Go: `references/go.md`

For mixed changes, load one language reference per changed language and add
only the scope reference that applies. Do not read `frontend.md` for Rust, Go,
backend, CLI, or native-only work.

Use existing project conventions and explicit user requirements as authority.
Prefer the smallest correct change, and run the smallest relevant check after
non-trivial edits.
