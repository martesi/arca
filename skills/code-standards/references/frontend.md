# React and Frontend UI

Load this reference only for React, browser, frontend, or UI work. Also load
`javascript-typescript.md` for JavaScript or TypeScript source.

## React

- Use function components and the React Compiler.
- Do not add `useMemo` or `useCallback` as reflexive performance decoration.
- Derive values during render instead of copying derived data into state.
- Use effects to synchronize with external systems such as browser APIs,
  subscriptions, timers, imperative libraries, or lifecycle-bound network work.
- Prefer composition and keep context at a genuine architectural boundary.
- Keep one main exported component per file. Keep local subcomponents, hooks,
  handlers, and helpers nearby until they become independently complex or
  genuinely reusable.

## Accessibility

- Prefer semantic HTML, real buttons, labels, accessible names, keyboard
  access, and correct focus behavior.
- Preserve usable semantics when styling or replacing native controls.

## Styling and components

- In projects using Tailwind, prefer utilities, then established component
  variants, then CSS when utilities become unreasonable.
- Allow arbitrary values when they express the actual design. Do not invent
  tokens to avoid a one-off value.
- Reuse the project's class-merging and variant helpers.
- When a project already uses a CSS framework or UI component library,
  search the local codebase for an existing component first. If there is no
  exact local match, check the framework or component library's website,
  documentation, or catalog for one before writing a replacement.
- Hand-write simple components only when neither the project nor its existing
  UI stack provides an exact match, and still compose them from existing
  project or framework primitives whenever practical.
- For complex components without an exact match, prefer an established
  implementation or library that fits the project's stack and constraints over
  building one from scratch.
- Add shadcn components through the official CLI when that stack is in use,
  and treat generated components as owned source.
