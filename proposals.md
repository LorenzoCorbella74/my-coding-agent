# Refactoring proposals – "corbe‑code" workspace

*Based on a quick scan of `src/`, `package.json` and the ideas in `todo.md`*

Below are the most high‑impact, low‑effort changes that will make the codebase easier to maintain, test and extend. I grouped them by file/area and kept the "smallest‑complete‑change" principle: each proposal can be implemented with a few edits or a new helper, no massive rewrites.

---

## 1. `src/config.ts` – configuration & environment

| Issue | Proposed fix | Why it helps |
|------|--------------|--------------|
| **Hard‑coded `CONTEXT_LIMIT = 50000`** and `MODEL` taken directly from `process.env` without a default. | • Move all env‑defaults to a single `loadEnv()` function that returns a typed config object.<br>• Add a runtime check / friendly error if `OPENROUTER_API_KEY` is missing. | Centralises secrets, makes it easy to swap provider or add a `.env.example`. |
| **`createOpenRouter` call at module level** – runs early, fails fast if key missing, but makes testing harder. | • Export a `initApi()` function that the CLI (or tests) can call once, or mock in unit tests. | Decouples side‑effects from module import; enables mocking in tests. |
| **`WORKDIR` computed with `path.resolve(process.env.CORBEAGENT_WORKDIR ?? process.cwd())`** – duplicated logic in other files. | • Export `getWorkdir()` and import it wherever `WORKDIR` is needed (e.g. `skills.ts`, `tools.ts`). | Guarantees a single source of truth; avoids subtle bugs when the env var changes. |

**Smallest change** – add a `config.ts` export:

```ts
// src/config.ts  (add at bottom)
export const getWorkdir = () => path.resolve(process.env.CORBEAGENT_WORKDIR ?? process.cwd());
export const loadConfig = () => ({
  contextLimit: Number(process.env.CONTEXT_LIMIT ?? 50000),
  model: process.env.MODEL ?? "default-model",
});
```

Import `{ getWorkdir, loadConfig }` wherever needed.

---

## 2. `src/skills.ts` – skill loader

| Issue | Proposed fix | Why it helps |
|------|--------------|--------------|
| **`SkillLoader` constructor reads the skills directory every time a new instance is created** and does `fs.readFileSync` for each skill on every start. | • Cache the loader as a **singleton** (`export const SKILLS = new SkillLoader()` already done, but the class still re‑reads on each construction).<br>• Add a `reload()` method for hot‑reload scenarios. | Avoids unnecessary I/O on every agent start; gives an explicit way to refresh without restart. |
| **`parseFrontmatter` returns `Record<string, string>` for meta, losing typed metadata** (e.g. `description` could be `null`). | • Define a `SkillMeta` interface (`description?: string`) and parse with `zod` or a simple typed mapper. | Gives compile‑time safety, better autocomplete, clearer docs. |
| **`getContent` returns a raw string wrapped in `<skill name="…">`** – no validation that the skill actually exists. | • Keep the existing fallback message, but add a `has(name: string): boolean` getter. | Lets callers test existence before rendering, useful for UI or tool APIs. |

**Smallest change** – add a typed meta interface and a `has` method:

```ts
export interface SkillMeta {
  description?: string;
}
// inside SkillLoader
parseFrontmatter(text: string): { meta: SkillMeta; body: string } {
  // existing parsing, just cast
}
has(name: string) { return name in this.skills; }
```

---

## 3. `src/tools.ts` – tool registry & constants

| Issue | Proposed fix | Why it helps |
|------|--------------|--------------|
| **Large hard‑coded constant sets** (`MAX_READ_CHARS`, `MAX_BATCH_READ_FILES`, `MAX_SEARCH_FILE_BYTES`, `DEFAULT_EXCLUDED_DIRS`). | • Move them to `src/config.ts` (or a new `src/constants.ts`) and import them. | Single source of truth; easier to adjust without touching tool definitions. |
| **`SKILLS` instance created at module level** but `SkillLoader` constructor has side‑effects (mkdir, readdir). | • Lazy‑initialise `SKILLS` inside a `getSkills()` function, or keep the singleton but ensure it’s only created once (already the case, but document it). | Prevents accidental double‑initialisation in tests. |
| **`getProjectExclusions` reads `.gitignore` on every call**. | • Cache the result (e.g. a module‑level `let cachedExclusions | null;`). | Reduces filesystem hits on each tool execution. |
| **`TOOLS` object is a huge plain‑object** – adding a new tool requires editing this file and remembering to export it. | • Consider a **dynamic registration**: each tool file exports a `metadata` object; a tiny `registerTools()` loop builds `TOOLS`. (Optional – a bigger change, not required now.) | Future‑proof, reduces merge conflicts when many contributors add tools. |

**Smallest change** – relocate the exclusion constants to `config.ts`:

```ts
// src/config.ts
export const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git", ".corbecode", "node_modules", "dist", "build", "coverage", "out", "target", ".next", ".nuxt", ".cache", ".angular"
]);
```

Then import: `import { DEFAULT_EXCLUDED_DIRS } from "./config";` in `tools.ts`.

---

## 4. `src/flowStore.ts` – workflow state management

| Issue | Proposed fix | Why it helps |
|------|--------------|--------------|
| **`flowSchema` is a huge Zod schema** (≈ 70 lines) mixed with type definitions. | • Split into separate schemas: `flowCoreSchema` (id, title, phase, etc.) and `flowPlanSchema`, `flowReportSchema`. Compose them with `z.object({...})`. | Smaller, more focused validation; easier to reason about errors. |
| **`renderPlan`, `renderTasks`, `renderReports` produce markdown strings** by manually concatenating. | • Move the markdown templates to **separate helper functions** that receive a `Flow` partial. | Allows changing the format (e.g. JSON, HTML) without touching the store logic. |
| **Atomic write logic** (`atomicWrite`) is duplicated pattern (temp file + rename). | • Keep it as is, but extract the “temp‑file‑rename” into a reusable utility `writeAtomic(file, content)` that other modules can import. | Reduces boilerplate if other places need safe writes. |
| **`progress`, `finish`, `interrupt` methods perform many checks** and throw generic errors. | • Create typed error classes (`InvalidPhaseError`, `PlanNotApprovedError`) and throw those; catch them at a higher level to produce user‑friendly messages. | Better error reporting for the CLI/UI, easier testing. |

**Smallest change** – extract the markdown rendering into pure functions:

```ts
// at bottom of flowStore.ts
export const renderPlan = (flow: Flow) => `# ${flow.title}\n...`; // unchanged signature, just move
export const renderTasks = (flow: Flow) => `# Tasks ...`;   // same
export const renderReports = (flow: Flow) => `# Reports ...`; // same
```

Now the class methods just delegate: `renderPlan(flow) { return renderPlan(flow); }`.

---

## 5. `src/agents.ts` – agent definitions & loading

| Issue | Proposed fix | Why it helps |
|------|--------------|--------------|
| **`DEFAULT_AGENTS` are defined as plain objects** but the schema validation (`agentSchema`) is applied only when loading custom agents. | • Export a `validateAgent` function that runs `agentSchema` on any agent data (including defaults). | Guarantees all agents (default or custom) conform to the same contract. |
| **`AgentLoader` constructor does `fs.readdirSync` and throws on first error** – makes it hard to list “available” agents without failing. | • Add a `listAgents()` method that returns only valid agents, silently skipping malformed files. | Allows UI/tooling to display “available agents” even when some are broken. |
| **`TOOL_ALIASES` mapping** is spread across the file; some aliases (`grep`, `bash`, `powershell`) map to `shell`. | • Document the alias table or generate it from a central list; consider a test that ensures every tool used in `DEFAULT_AGENTS` has an alias. | Prevents “unknown tool” errors when a new role is added. |

**Smallest change** – add a `listAgents` method:

```ts
listAgents(): CustomAgent[] {
  const directory = path.join(this.workspace, ".corbecode", "agents");
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith(".md"))
      .map(e => {
        const file = path.join(directory, e.name);
        const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
        const { name } = agentSchema.parse(meta);
        return this.get(name); // will throw if invalid, but we caught above
      });
  } catch { return []; }
}
```

(Wrap in try/catch to skip bad files.)

---

## 6. General & test‑ability

| Area | Proposal | Impact |
|------|----------|--------|
| **Type‑only exports** – many functions return `any` or implicit `unknown`. | • Add explicit return types (`typeof runRead`, `Promise<…>`, etc.). | Improves IDE autocomplete and catches mismatches at compile time. |
| **`todo.md` ideas** – many “quick‑win” items (persistent history, git tool, lint/check). | • Prioritise the **high‑priority** ones (history, git, lint) and implement them as small, self‑contained modules. They can be added later without breaking existing code. | Gives the project a clear roadmap and immediate value. |
| **Error messages** – several `throw new Error(...)` with vague text. | • Prefix messages with the file/func name, e.g. `throw new Error `[FlowStore] setPlan: task already completed`;`. | Makes debugging faster, especially when the agent runs in headless mode. |
| **Module boundaries** – `src/index.ts` only re‑exports a few things. | • Add a barrel file that re‑exports the most-used APIs (`TOOLS`, `SKILLS`, `AGENTS`, `FlowStore`, `config`). | Consumers (tests, external scripts) can import `@corbe-code/toolbox` instead of navigating the whole `src/`. |

---

### Quick “first‑pass” checklist (what you can do today)

1. **Add `getWorkdir()` and `loadConfig()` to `config.ts`** and import them where needed.  
2. **Typed `SkillMeta` + `has()` method** in `skills.ts`.  
3. **Move `DEFAULT_EXCLUDED_DIRS` to `config.ts`** and import in `tools.ts`.  
4. **Extract render functions** from `flowStore.ts` (keep existing method signatures, just delegate).  
5. **Add `listAgents()`** to `AgentLoader` (skip malformed files).  
6. **Run `pnpm test`** (or `npm test`) to ensure nothing breaks after each tiny change.

These steps collectively improve **type safety**, **reduce duplication**, **centralise configuration**, and **make the codebase more testable**—all with minimal code movement and no breaking changes to the public API.

---

#### Risks / things to double‑check

- **Export changes**: Adding new exported functions (`getWorkdir`, `listAgents`, `has`) is backward‑compatible, but make sure nothing else depends on the *old* missing names.  
- **`flowStore` render changes**: The rendered markdown strings stay exactly the same because we keep the functions’ output unchanged; only the internal implementation moves.  
- **Skill loader caching**: The `SkillLoader` is already a singleton (`SKILLS`), but if you add `reload()` be sure the CLI restarts or the test suite clears the cache, otherwise you might see stale skills after a code change.

Feel free to let me know which of these you’d like to tackle first, and I can produce the exact edit diffs or even a small prototype.