# Skeg

Stay light. Hold course.

Skeg is a minimal engineering workflow for coding agents.

It does not tell the agent how to work.
It tracks intent, enforces critical boundaries, collects verification
evidence, and preserves only the decisions worth keeping.

The default workflow is:

```
Orient → Change → Prove → Close
```

Everything else is an extension.

## Install (Pi)

```bash
pi install /absolute/path/to/skeg
# or, from a project:
pi install -l ./path/to/skeg
```

In a repo:

```
/init
/run fix redirect query loss after login
/status
/record incident Avatar cache | clear current-user query on logout
/finish
```

Prompt template:

```
/fix user still sees old avatar after logout
```

## Status

**v0.1.0 ready** — `npm run verify` PASS, Pi smoke PASS (`dogfood/PI_SMOKE.md`).

## Design

See [DESIGN.md](./DESIGN.md), [NON_GOALS.md](./NON_GOALS.md), [CHANGELOG.md](./CHANGELOG.md).

## Develop

```bash
npm install
npm run verify    # test + typecheck + budgets + dogfood
npm run smoke     # Pi 实机抽测（需本机已装 pi）
```

Reports: `dogfood/LAST_RUN.md`, `dogfood/PI_SMOKE.md`.
