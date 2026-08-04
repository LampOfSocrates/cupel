# Loom
Read these before any work, in order:
1. react-migration.md — evidence rules: quote spec lines, cite file:line, check lockfiles
2. loom-phases.md — we build phase by phase; NEVER build ahead of the current phase
3. feature-spec.md — the what; sketches/clean/ = target density, sketches/ = API wiring

Current phase: 1. Current task: P1-T18b Mock server core (contract = openapi.yaml v0.2.0).
Invariants (never break): versions/judgments/snapshots append-only ·
generator writes only via public API · /me always called ·
no AUTH_MODE branches · one config artifact.
