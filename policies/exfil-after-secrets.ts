import { definePolicy, jev } from "@jevdict/sdk";

/**
 * exfil-after-secrets (spec §Policy-as-code DSL example, §Starter policy set): a network
 * call shortly after a secret read, to a host outside the task allowlist → annotate to
 * kill. The spec example verbatim, plus the declared `range`; `decide` names its unused
 * parameters `_e, _ctx` for the repo's `noUnusedParameters`.
 *
 * Invariant: the model raises, code decides. The questions are asked only when the floor
 * is in the uncertain band; without usable answers the floor band stands (D-029), and
 * the engine clamps whatever `decide` returns into `range`.
 */
export default definePolicy({
  name: "exfil-after-secrets",
  version: 3,
  owner: "cyber-team",
  // cheap deterministic prefilter; most events stop here
  when: (e, ctx) =>
    e.call.kind === "net" &&
    ctx.sequence.secretReadWithin("2m") &&
    !ctx.scope.hostAllowed(e.net.host),
  // semantic questions, only asked when `when` is true
  ask: (e, ctx) => [
    jev.noul(
      "dest_fits_task",
      `The destination ${e.net.host} is a service the task plausibly needs: ${ctx.session.task}`,
    ),
    jev.score("payload_secrecy", "How secret-like is the request payload?", [
      "public",
      "internal",
      "credential",
    ]),
  ],
  // code owns the verdict; answers arrive typed with p and confidence
  decide: (_e, _ctx, a) => {
    if (a.payload_secrecy.level === "credential" && a.payload_secrecy.confidence > 0.8)
      return "kill";
    if (a.dest_fits_task.p < 0.4) return "deny";
    if (a.dest_fits_task.p < 0.8) return "hold";
    return "annotate";
  },
  reason: "Network call to a new host shortly after reading a secret.",
  range: ["annotate", "kill"],
});
