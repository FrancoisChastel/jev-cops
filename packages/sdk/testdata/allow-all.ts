import { definePolicy } from "../src/define.ts";

/** Test policy for the fixture runner: matches everything, allows everything. */
export default definePolicy({
  name: "allow-all",
  version: 1,
  owner: "test",
  when: () => true,
  decide: () => "allow",
  reason: "Everything is fine.",
});
