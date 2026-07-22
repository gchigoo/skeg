# Contributing

## Setup

```bash
npm install
npm run verify
```

## Rules

- Keep `extensions/core.ts` as a thin Pi adapter; put logic in `src/`.
- All RunState changes go through `reduce()` in `src/reducer.ts`.
- Do not mark a run `done` without `evaluateClosure` returning `ok`.
- Prefer adversarial invariants over scenario completion rates.
- Do not expand scope into Mission / Skills / multi-agent / Web UI (see `NON_GOALS.md`).

## Tests

```bash
npm test
npm run dogfood:adversarial
npm run check:budgets
```

## PR checklist

- [ ] `npm run verify` passes
- [ ] Schema changes include v1 migration coverage
- [ ] CHANGELOG updated
