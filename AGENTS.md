# AGENTS.md — Optimized Operating Rules (for Codex)

## North Star
Ship correct, maintainable code with minimal churn.
Optimize for: (1) correctness & safety, (2) minimal risk, (3) performance, (4) clarity.

## Default Workflow
1) Understand: restate goal + constraints + acceptance criteria (1–5 lines).
2) Plan if needed (see "When to Plan").
3) Implement with smallest viable change-set.
4) Verify (targeted checks/tests).
5) Report: what changed + how verified + any follow-ups.

---

## When to Plan (Gate)
Use a written plan **only if** at least one is true:
- Requires 3+ meaningful steps across files/modules
- Involves architecture/API decisions or non-trivial refactor
- Risky change (state, persistence, concurrency, security, performance-critical path)
- Requirements are ambiguous or multiple valid approaches exist

Plan format (keep it short):
- Goal
- Steps (checklist)
- Risks + mitigations
- Verification steps

If task is trivial, skip plan and proceed.

---

## When to Ask Questions (Gate)
Do **not** ask the user for hand-holding.
Ask a clarifying question **only if** missing info blocks correct implementation.
Otherwise, make assumptions explicitly (bulleted) and proceed.

---

## Minimal-Churn Rule
- Touch only what is necessary.
- Avoid sweeping refactors, renames, formatting-only changes.
- Prefer localized fixes over broad rewrites unless the rewrite is clearly cheaper long-term.

---

## Subagents / Parallelism (Use Sparingly)
Use subagents **only** for:
- Researching unfamiliar APIs/framework behavior
- Comparing 2–3 design options with pros/cons
- Large codebase exploration (finding entry points, call graphs)

One subagent = one narrow task.
Main agent integrates results and keeps final decisions consistent.
If no clear benefit, do not spawn subagents.

---

## Verification Before "Done"
Never claim completion without evidence.
Choose the **cheapest sufficient** verification:
- Run targeted unit/integration tests relevant to the change
- If no tests exist, add a minimal test or a deterministic repro
- Validate via logs/error output for bugfixes
- For performance-sensitive changes: measure (micro-benchmark or profiling note)

Avoid running full CI unless:
- change is broad, or
- targeted tests are unavailable, or
- regression risk is high.

---

## Elegance (Balanced)
For non-trivial work, do a quick elegance pass:
- Can this be simpler without losing correctness?
- Is there an obvious cleaner design with the same scope?

Do **not** over-engineer:
- no abstractions without reuse
- no premature optimization
- no “framework within framework”

---

## Bugfix Protocol (Autonomous)
When given a bug report:
1) Reproduce or create a deterministic failing test.
2) Identify root cause (not symptoms).
3) Fix minimally.
4) Add/adjust tests to prevent regression.
5) Verify and summarize.

---

## Task Tracking (Only if repo supports it)
If `tasks/` exists:
- For non-trivial tasks, write a checklist to `tasks/todo.md`.
- Update it as you complete steps.
- Write a short post-check in the same file: what changed + verification.

Write to `tasks/lessons.md` **only if**:
- the user corrected the same type of mistake twice, or
- a mistake reveals a reusable rule that prevents future regressions.
Keep lessons short and actionable.

If `tasks/` does not exist, keep plan + lessons in the conversation output only.

---

## Output Contract (What you must include in responses)
- What you changed (files/areas)
- Why (brief)
- How you verified (commands/tests/logs)
- Any risks/trade-offs + next steps (if relevant)

If something goes sideways: STOP, explain what failed, and re-plan.
