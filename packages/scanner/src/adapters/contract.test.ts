import { afterAll, beforeAll } from "bun:test";
import { join } from "node:path";
import { createScanner } from "../index.ts";
import { fakeSkillspector, type ScanWorld, scanWorld } from "../testing/fake-binary.ts";
import { describeScannerContract, type ScannerHarness } from "./contract.ts";

let world: ScanWorld;
let fake: string;

beforeAll(async () => {
  world = scanWorld();
  fake = await fakeSkillspector();
});
afterAll(() => world.dispose());

const env = () => ({ HOME: world.home, PATH: "/usr/bin:/bin" });
/** A PATH with nothing on it: the tool is missing. */
const emptyPath = () => ({ HOME: world.home, PATH: world.home });

function harness(
  label: string,
  build: () => Parameters<typeof createScanner>[0],
  missing: (() => Parameters<typeof createScanner>[0]) | null,
): ScannerHarness {
  return {
    label,
    runsTool: label !== "none",
    scanner: () => createScanner(build(), { env: env() }),
    missing: () => (missing === null ? null : createScanner(missing(), { env: emptyPath() })),
    target: (scenario) => world.skill(scenario),
    runs: () => world.calls().length,
  };
}

describeScannerContract(harness("none", () => ({ adapter: "none" }), null));

describeScannerContract(
  harness(
    "skillspector",
    () => ({ adapter: "skillspector", binary: fake }),
    () => ({ adapter: "skillspector" }),
  ),
);

describeScannerContract(
  harness(
    "command",
    () => ({ adapter: "command", argv: [fake, "--contract"], network: "none" }),
    () => ({ adapter: "command", argv: [join(world.root, "no-such-scanner")] }),
  ),
);
