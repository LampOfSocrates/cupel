import { spawnSync } from "node:child_process";

// P2-E2E — pre-existing data for the journeys that need it, from THE
// deterministic generator seed (mock/generator.py: every random choice is
// drawn from `random.Random(seed)` before any HTTP, so the dataset is a pure
// function of the seed). Seed 42 = the mock's own default and what the Docker
// image boots with (mock/entrypoint.py SKEIN_SEED), so the suite walks the
// same dataset a reviewer sees on the demo: 20 conversations (14 agent1,
// 6 agent2), 4 forks, 3 replay runs, 2 judged, 2 rubrics, 3 thumbs.
//
// Costs ~1.4s against the scratch DB. Journeys still create their own
// conversations for anything they assert on by title — the seed is BACKGROUND,
// so the specs stay order-independent.
//
// AUTH_MODE=on runs skip it: the generator writes through the public API with
// no JWT, so every call would 401. Those journeys (10-12) seed via the admin
// token themselves, which is also what they are testing.

const MOCK = "http://localhost:4010";

async function waitForMock(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${MOCK}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`mock never came up at ${MOCK}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export default async function globalSetup(): Promise<void> {
  if (process.env.AUTH_E2E === "1") return;
  await waitForMock();
  const result = spawnSync(
    `python -m mock.generator seed --base ${MOCK} --seed 42`,
    { stdio: "inherit", shell: true },
  );
  if (result.status !== 0) throw new Error("generator seed failed");
}
