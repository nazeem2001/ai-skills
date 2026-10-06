# zustand-skill

A drop-in knowledge pack that teaches AI coding agents how to write Zustand v5 correctly. It works with Claude Code, Codex, Cursor, Copilot CLI, Windsurf, Gemini CLI, opencode, Qwen Code, and any other tool that reads the `SKILL.md` format.

I built this because every agent I use writes plausible-looking Zustand that falls apart in the same three places: selectors that return fresh objects (an infinite-loop crash in v5, not just a wasted render), module-level stores in Next.js that leak state between users on the server, and persist middleware with no hydration plan. The knowledge to avoid all of this exists, but it lives scattered across the official docs, four years of GitHub discussions, TkDodo's blog, and a handful of production post-mortems. This repo is that knowledge compressed into something an agent can actually load and follow.

## What's inside

```
SKILL.md                      the entry point: golden rules, a canonical store
                              template, and a bug-symptom table that routes to
                              the right reference
references/
  core-api.md                 create/setState semantics, the replace flag,
                              Maps and Sets, resets, import paths
  performance.md              the re-render model, every selector mistake with
                              its fix, transient updates, large lists
  typescript.md               the curried create<T>()() form, middleware
                              mutator tuples, typed slices
  middleware.md               persist in full (partialize, version, migrate,
                              merge traps), devtools, immer, composition order
  ssr-nextjs.md               per-request store factories, Context providers,
                              the four hydration fixes
  testing.md                  the official auto-reset mock, per-test store
                              injection, testing stores without React
  architecture.md             what belongs in Zustand at all, slices vs
                              multiple stores, the TanStack Query boundary
  tauri-desktop.md            Tauri v2: Rust-owned state vs webview state,
                              multi-window sync, plugin-store persistence
evals/                        the test prompts and assertions used to
                              benchmark the skill against a no-skill baseline
```

The structure follows progressive disclosure. Agents load the 200-line `SKILL.md` when a task looks Zustand-shaped, then pull in only the reference file that matters for the task at hand. Nothing else touches the context window.

## Installing

The quickest path is the [skills.sh](https://www.skills.sh/) CLI, which detects your agent and puts the skill in the right place:

```bash
npx skills add josephyaduvanshi/zustand-skill
```

If you'd rather skip npx, clone the repo and run the bundled installer. It finds every supported agent tool on your machine and copies the skill into each one:

```bash
git clone https://github.com/josephyaduvanshi/zustand-skill.git
cd zustand-skill
bash install.sh
```

Or copy it by hand into whichever tool you use:

| Tool | Path |
|---|---|
| Claude Code | `~/.claude/skills/zustand/` |
| Codex CLI | `~/.codex/skills/zustand/` |
| Cursor | `~/.cursor/skills/zustand/` |
| GitHub Copilot CLI | `~/.copilot/skills/zustand/` |
| Windsurf | `~/.codeium/windsurf/skills/zustand/` |
| Gemini CLI | `~/.gemini/skills/zustand/` |
| opencode | `~/.config/opencode/skills/zustand/` |
| Qwen Code | `~/.qwen/skills/zustand/` |

For project-level installs, drop the folder into `.claude/skills/`, `.codex/skills/`, or your tool's equivalent inside the repo.

## Using it

Most of the time you do nothing. The skill's description is written so agents pull it in on their own whenever a task mentions Zustand, imports it, or hits one of its signature errors ("Maximum update depth exceeded", "getSnapshot should be cached"). You can also invoke it explicitly:

```
/zustand refactor src/stores/app-store.ts into slices and stop the re-renders
```

or just say "use the zustand skill" in any tool that doesn't support slash commands.

## How this was built

I didn't write this from memory, and I didn't let a single model write it from its training data either. The process had four stages.

**Research.** Eight AI research agents ran in parallel, each owning one lane: the official docs (all 35 pages, fetched from the pmndrs/zustand repo source so the content was verbatim), performance and re-render behavior (maintainer answers across roughly 30 GitHub discussions, TkDodo's essays, Daishi Kato's blog), TypeScript and middleware internals, community wisdom (YouTube transcripts pulled via yt-dlp, Reddit threads, production incident reports like the Dify v5 upgrade crash), and four more lanes covering Tauri v2 after I decided the skill should answer desktop questions too. Together they produced around 6,000 lines of research notes with every claim carrying a source URL. Claims that couldn't be verified against a primary source are flagged as such in the notes rather than laundered into fact.

**Distillation.** The research got compressed into the reference files by hand, keeping the bad-code/good-code pairs, exact API signatures, and maintainer quotes, and cutting everything that was either obvious or unverifiable. Where sources disagreed (one store vs many, atomic selectors vs useShallow everywhere), the reference says so instead of picking a winner silently.

**Benchmarking.** Three realistic eval tasks (an SSR-safe persisted cart for Next.js, a re-render storm to fix in a provided dashboard, a 40-field god-store to restructure) each ran twice: once with an agent that had the skill, once with an agent that didn't. Independent grader agents scored both runs against 18 written assertions. With the skill: 18/18. Without: 17/18. The gap sounds small because modern models already know Zustand reasonably well, but the graders' notes tell the fuller story: the baseline runs missed transient updates for 60fps data, wrote per-keystroke localStorage writes into persisted state, and skipped hydration gates. The eval prompts and assertions live in `evals/` so you can rerun the comparison yourself.

**The Tauri addendum.** A question about whether Zustand fits Tauri apps turned into four more research lanes (official v2 docs verification, multi-window architecture, community practice, Rust-side state). The short answer made it into `tauri-desktop.md`: Zustand handles per-window UI state, Rust owns anything shared or native, and each Tauri window is an isolated JS context, so a store in one window simply does not exist in another. That last fact alone would have saved several teams the debugging sessions described in the issues linked from the reference.

This README itself went through an editing pass against Wikipedia's "Signs of AI writing" guide, which felt only fair given the subject matter.

## What it actually teaches

The ten rules in `SKILL.md` are the spine. A few of them:

1. Never select the whole store. `const { x } = useStore()` subscribes to every change and breaks under React Compiler.
2. Selector outputs must be stable references. In v5 an unstable selector doesn't just re-render, it crashes.
3. Atomic selectors first, `useShallow` for genuine multi-field picks. It compares one level deep and won't save you from nested `.map()` calls.
4. Only export custom hooks, never the raw store.
5. Middleware order is `devtools(subscribeWithSelector(persist(immer(...))))`, applied on the combined store only.
6. Data that changes 60 times a second never goes through React. Subscribe into a ref instead.

The references back each rule with the primary source: the maintainer discussion, the docs page, or the production incident where ignoring it cost someone real time.

## Keeping it current

The skill targets Zustand 5.0.x and React 18+. When Zustand ships something that changes the guidance, the fix goes in the canonical reference file here and gets re-synced to the platform copies. If you spot something stale or wrong, open an issue with a link to the source that contradicts it. Claims in this repo are only as good as their citations.

## Credits

The underlying knowledge belongs to the people who wrote it down first: Daishi Kato and Daniel Britto (Zustand's maintainers, whose GitHub discussion answers settle most of the contested questions), Dominik Dorfmeister (TkDodo), whose two Zustand essays are still the best writing on the library, and the pmndrs docs contributors. The Tauri material leans on the Tauri v2 docs, the Hopp team's multi-window writeup, and Andrew Ferreira's tauri-store project.

## License

MIT
