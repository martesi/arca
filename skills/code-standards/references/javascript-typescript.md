# JavaScript and TypeScript

Load this reference for JavaScript, TypeScript, Node, Bun, browser, and shared
frontend code. Add `frontend.md` only for React or browser UI work.

## Data flow

- Prefer immutable transformations, named operations, composition, and
  semantic collection functions over temporary mutable state.
- Prefer `map`, `filter`, `flatMap`, and pipelines when they preserve clarity
  and runtime behavior.
- Use Remeda when the project already has it or the chosen stack calls for it.
  Do not add it merely to replace a clear native operation.
- Check for a maintained typed dependency before recreating collection, retry,
  concurrency, parsing, globbing, memoization, or immutable-data utilities.
- Put the high-level function flow before private helper implementations. Use
  local named function declarations when they keep the flow together.
- Prefer guard clauses and early returns. Avoid `else` and `else if` unless
  they materially improve readability.
- Keep executable nesting to three levels or fewer and executable blocks near
  15 lines when practical. Do not impose a fixed function line limit.
- Move large multiline values out of nested calls into named values.

## Values and types

- Keep domain literals scoped and named when their meaning is not obvious.
  Prefer `as const` objects over string enums.

  ```ts
  const DownloadState = {
    Idle: 'idle',
    Downloading: 'downloading',
    Done: 'done',
  } as const

  type ValueOf<T> = T[keyof T]
  type DownloadState = ValueOf<typeof DownloadState>
  ```

- Enable strict TypeScript.
- Prefer `interface` for object contracts and `type` for unions, aliases,
  function types, mapped types, and conditional types.
- Prefer discriminated unions, `satisfies`, narrowing, and `unknown` over
  loose boolean bags, unnecessary assertions, and `any`.
- Avoid non-null assertions. Treat `as` assertions as a reason to improve the
  type or validate the value.
- Validate untrusted HTTP, URL, storage, file, IPC, native, plugin, and other
  external data with Zod. Do not revalidate trusted internal values without a
  reason.

## Errors, promises, and resources

- Use Effect (`effect`) for nontrivial asynchronous workflows and expected
  failures. When touching code that hand-rolls retry, cancellation,
  concurrency, or resource cleanup, replace it with Effect when compatible.
  Keep Promises at platform and library boundaries, and for a single simple
  asynchronous operation. Do not add Effect just to wrap one Promise or
  migrate unrelated code.
- Use Effect's resource-safety support for effectful resource lifetimes. Use
  native `using` and `await using` when the code does not use Effect and the
  runtime supports them.
- Do not allow floating promises. Await, return, handle, convert, or detach
  them explicitly with `void`.
- Agents must not add JavaScript/TypeScript `try` statements unless a
  task-specific instruction explicitly authorizes them. Every authorized use
  must include a nearby comment explaining why a typed error or resource API
  cannot handle that boundary; a comment alone is not authorization.
- Keep exception capture at the smallest boundary, including when converting a
  throwing API into an Effect.
- Let exceptions propagate only when an intentional upstream boundary owns
  their handling.

## Branching, classes, and modules

- Use `ts-pattern` for nontrivial exhaustive branching over structured unions.
  Keep trivial two-case branches simple.
- Prefer functions and modules. Use classes for naturally stateful,
  identity-based, or lifecycle-oriented problems, not merely to group
  functions. Prefer composition over inheritance.
- Keep declarations ordered for reading behavior: imports, main or public
  implementation, private helpers, then supporting declarations.
- Keep exports private by default. Prefer named exports and avoid barrel files
  unless a deliberate public package entry point requires one.
