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
- Reuse existing project primitives. Add shadcn components through the
  official CLI when that stack is in use, and treat generated components as
  owned source.
