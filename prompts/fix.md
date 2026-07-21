---
description: Start a Skeg run for a defect
argument-hint: "<defect description>"
---
<!-- skeg:run -->
Start a Skeg run for the following defect:

$@

Prioritize:
- reproducing or identifying the failure
- the smallest correct change
- a targeted regression check

Follow Orient → Change → Prove → Close.
Default lean: no design docs, no subagents.
If risk triggers fire, upgrade to guarded and stop at gates.
