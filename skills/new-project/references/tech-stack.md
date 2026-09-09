# Tech stack

Apply this skill only while starting a project. Inspect the actual product
before selecting tools, use current stable compatible releases, and install
only the subset the project needs.

## Start with the smallest coherent stack

1. Classify the project as a substantial web app, desktop app, static site,
   userscript, or small utility.
2. Choose the matching baseline below.
3. Check current package compatibility before installing.
4. Scaffold the smallest understandable layout.
5. Add optional libraries only when a concrete requirement justifies them.

Do not force this stack onto an existing repository. Preserve existing
conventions unless migration is requested.

## Baseline

- Use Bun as the runtime, package manager, script runner, and test runner.
- Use TypeScript with strict checking for application and project scripts.
- Use Biome for formatting, linting, and import organization.
- Use Zod at untrusted external boundaries.
- Use Remeda for functional collection and value composition when it reduces
  code or improves consistency.
- Use True Myth for `Result`, `Maybe`, and safe asynchronous task contracts.
- Use `ts-pattern` only when structured exhaustive branching is genuinely
  clearer.
- Prefer current stable compatible releases in the preferred lines of
  TypeScript 7, React 19, Vite 8, Tailwind CSS 4, Wails 3, and Tauri 2 where
  the project and ecosystem support them. Never force a version line that
  breaks compatibility.

Install packages with Bun:

```sh
bun add package
bun add -d package
```

Write meaningful project scripts in TypeScript rather than shell when
practical. Run independent tasks concurrently when possible and keep their
dependencies explicit.

## TypeScript and Biome

- Enable strict TypeScript.
- Avoid compiler checks that merely duplicate Biome's lint responsibilities.
- Prefer `as const` objects over string enums and derive their value types.

  ```ts
  type ValueOf<T> = T[keyof T]

  const PluginState = {
    Ready: 'ready',
    Loading: 'loading',
    Failed: 'failed',
  } as const

  type PluginState = ValueOf<typeof PluginState>
  ```

- Configure Biome for single quotes, no semicolons, ES5 trailing commas,
  two-space indentation, an 80-character line width, organized imports, and
  recommended lint rules.
- Enable promise-safety rules where the installed Biome version supports them.
- Confirm option names against the installed Biome version instead of copying
  stale configuration.

## Web applications

For a substantial interactive web app, prefer:

- React with the React Compiler
- Vite
- TypeScript, Bun, and Biome
- TanStack Router with file-based routing
- Tailwind CSS
- shadcn/ui with Base UI
- Lingui
- Zod
- TanStack Form for substantial forms
- True Myth and Remeda

Use the smallest subset that fits the product. Do not install every default
before the first useful screen renders.

### State and data

Place state in this order unless the product requires otherwise:

1. local component state
2. derived state
3. URL or router state
4. server or remote state
5. context
6. external global state

Treat routable state as URL state instead of copying it into unrelated stores.
Use native `fetch` for straightforward HTTP. For substantial HTTP interaction,
choose deliberately among native fetch, a small fetch-based abstraction,
TanStack Query, request hooks, or Axios based on the actual requirements. Keep
Axios if an existing project already uses it. Do not add TanStack Query merely
because an API exists.

Validate remote, persisted, URL, and imported data at their boundaries with
Zod. Use TanStack Form for substantial forms and native or local state for
trivial forms.

### UI

- Use Tailwind utilities first, established variants second, and custom CSS
  when utilities become unreasonable.
- Use arbitrary values when they express a real one-off design value.
- Add shadcn components with the official CLI. Reuse and modify project-owned
  components instead of recreating available primitives.
- Localize user-visible text with Lingui from the beginning. Use its Vite
  integration, generated message IDs, and shared message definitions for
  reusable text.

### Testing

- Use Bun's test runner.
- Use React Testing Library or Happy DOM for component tests when needed.
- Use Playwright for browser-level tests when browser behavior matters.
- Do not add Vitest by default when Bun covers the requirements.

## Desktop applications

Reuse the web baseline unless native requirements justify a change. Keep native
capabilities behind narrow typed boundaries and expose semantic operations:

```ts
installPlugin(path)
```

Prefer that over exposing a generic command executor. A user-selected path may
cross the boundary as data; arbitrary executable strings should not.

### Wails

- Use Wails 3 with a Go backend and the standard React frontend.
- Keep Go and native operations behind typed frontend bindings.
- Do not apply JS and TS syntax rules mechanically to Go.

### Tauri

- Use Tauri 2 with a Rust backend and the standard React frontend.
- Keep filesystem, operating-system, and native services behind narrow typed
  commands.
- Prefer semantic Rust commands over generic shell or process access.
- Do not apply JS and TS syntax rules mechanically to Rust.

### Electron

- Use Electron with the standard React frontend.
- Require `contextIsolation`, a narrow preload API, and typed IPC.
- Keep arbitrary Node and process access out of the renderer.
- Treat the renderer as an ordinary web application and expose semantic native
  operations through preload.

## Static sites and small utilities

- Use plain HTML, CSS, and TypeScript for small pages where an application
  framework adds little value.
- CDN-hosted libraries are acceptable for a genuinely small one-page utility
  when a build system would add more machinery than value.
- For documentation, marketing, or mostly static content, consider Astro or
  another suitable static-site generator instead of forcing SPA architecture.
- Use the normal React and Vite baseline for a substantial client application.

## Userscripts

- Use `vite-plugin-monkey`.
- Target the common userscript API subset where practical and avoid
  manager-specific APIs without a real need.
- For small host-page changes, use native DOM APIs and no UI framework.
- For substantial owned UI, prefer Solid mounted in Shadow DOM. Consider Lit
  for reusable isolated Web Components. React is not the default userscript
  UI framework.
- Keep host integration styles narrow. Use `GM_addStyle` only for intentional
  host-page changes when supported.
- Keep owned UI styles inside its ShadowRoot. Inject only the generated CSS it
  needs, avoid Tailwind Preflight against the host document, and do not rely on
  class prefixes as the isolation boundary.

## Structure, paths, and dependencies

- Start with a small layout that follows the product's real boundaries.

  ```text
  src/
    app.tsx
    feature-list.tsx
    load-feature.ts
    settings.tsx
  ```

- As responsibilities grow, colocate by feature rather than creating global
  technical folders.
- Enable TypeScript path resolution and use a clear `@/` alias for `src/`.
- Do not create barrel files merely to shorten imports.
- Before adding a dependency, check whether the requirement is already covered
  by the platform, Bun, the project, or a dependency already selected.
- Do not introduce Effect automatically. Consider it only when the project's
  complexity genuinely benefits from a comprehensive effect system.
- Prefer the smallest coherent subset. A small project should not install the
  entire baseline before it needs it.
