# shellcheck shell=bash
# shellcheck disable=SC2016 # single-quoted scripts run inside the containers: they expand there
# e2e phases 5–8 (sourced by scripts/live/e2e.sh): the audit trail (explain, replay,
# signed chain against the rsyslog copy, truncation and tampering), the OpenShell
# compiler, uninstall, and the Codex/OpenCode fake-API round trips.

explain_one() { # label tool needle verdict [audit-in-container]
  local id
  id=$(event_of "${5:-$AUDIT}" "$2" "$3" "$4")
  if [ -z "$id" ]; then
    fail "cops explain ($1): no $4 event found"
    return
  fi
  local audit_arg=()
  [ -n "${6:-}" ] && audit_arg=(--audit "$6")
  expect "cops explain $id ($1 → $4)" \
    bash -c "docker exec -u dev -w /home/dev $LIVE_PROJECT-claude-code-1 cops explain $id ${audit_arg[*]} | tee /dev/stderr | grep -qw $4"
}

phase_audit() {
  begin 5.1 "cops explain: one event per verdict"
  pull claude-code
  explain_one allow Bash '"command":"ls"' allow
  explain_one annotate Bash "python3 -c" annotate
  explain_one hold Bash "git push --force" hold
  explain_one deny Bash "rm -rf /home/dev/work/repo/.cache" deny
  explain_one kill Write "/home/dev/work/repo/.claude/settings.json" kill
  explain_one rewrite Bash "rm -rf ./build" rewrite "$A/claude-code-rewrite-audit.jsonl" \
    /home/dev/live/rewrite/audit.jsonl
  end

  begin 5.2 "cops replay over the whole session log: no unexplained delta"
  expect "replay exits 0" ccsh 'cops replay ~/.jev-cops/audit.jsonl > ~/live/replay.out 2>&1; rc=$?; cat ~/live/replay.out; exit $rc'
  # The log keeps no tool output (spec: secrets are not copied), so a verdict that came
  # from taint cannot be replayed; replay says so in a "history partial" note.
  expect "every delta is an event replay notes as 'history partial' (its tool output is not in the log)" \
    ccsh 'deltas=$(grep " → " ~/live/replay.out | cut -d" " -f1 | sort -u); noted=$(grep "note: history partial" ~/live/replay.out | cut -d" " -f1 | sort -u); echo "deltas: ${deltas:-none}"; for d in $deltas; do grep -qx "$d" <<< "$noted" || { echo "unexplained delta $d"; exit 1; }; done'
  note "deltas: $(ccsh 'tail -1 ~/live/replay.out')"
  end

  begin 5.3 "signed chain + the rsyslog off-box copy: cops audit verify --remote passes"
  expect "copsd stops cleanly (shutdown line, checkpoint, forwarder flush)" cc "$BIN/copsd.sh" stop
  sleep 3
  run live_cp_out syslog /var/log/remote/copsd.log "$A/syslog-copsd.log"
  run live_cp_in "$A/syslog-copsd.log" claude-code /home/dev/live/remote-copy.log
  run ccsh 'wc -l ~/.jev-cops/audit.jsonl ~/live/remote-copy.log'
  expect "audit verify with the public key and the remote copy: verified" \
    ccsh 'cops audit verify ~/.jev-cops/audit.jsonl --pubkey ~/.config/jev-cops/audit-ed25519.pub --remote ~/live/remote-copy.log'
  end

  begin 5.4 "a truncated local tail is caught by the off-box copy"
  run ccsh 'head -n -3 ~/.jev-cops/audit.jsonl > ~/live/audit-truncated.jsonl; wc -l ~/live/audit-truncated.jsonl'
  expect_not "audit verify fails on the truncated log" \
    ccsh 'cops audit verify ~/live/audit-truncated.jsonl --pubkey ~/.config/jev-cops/audit-ed25519.pub --remote ~/live/remote-copy.log'
  expect "it says the copy goes past the local log" \
    ccsh 'cops audit verify ~/live/audit-truncated.jsonl --pubkey ~/.config/jev-cops/audit-ed25519.pub --remote ~/live/remote-copy.log | grep -Ei "truncat|past the local|longer"'
  end

  begin 5.5 "a tampered middle line breaks the chain"
  run ccsh 'n=$(grep -n "\"verdict\":\"deny\"" ~/.jev-cops/audit.jsonl | head -1 | cut -d: -f1); echo "tampering line $n"; sed "${n}s/\"verdict\":\"deny\"/\"verdict\":\"allow\"/" ~/.jev-cops/audit.jsonl > ~/live/audit-tampered.jsonl; diff <(sed -n "${n}p" ~/.jev-cops/audit.jsonl | cut -c1-200) <(sed -n "${n}p" ~/live/audit-tampered.jsonl | cut -c1-200) || true'
  expect_not "audit verify fails on the tampered log" \
    ccsh 'cops audit verify ~/live/audit-tampered.jsonl --pubkey ~/.config/jev-cops/audit-ed25519.pub'
  expect "it names the broken line" \
    ccsh 'cops audit verify ~/live/audit-tampered.jsonl --pubkey ~/.config/jev-cops/audit-ed25519.pub | grep -Ei "hash|chain"'
  end
}

phase_openshell() {
  begin 6.1 "OpenShell (M2 preview): cops openshell compile --harness claude-code --dry-run"
  run ccsh 'cops openshell compile --harness claude-code --dry-run > ~/live/openshell-dry-run.out 2>&1; echo "exit $?" >> ~/live/openshell-dry-run.out; cat ~/live/openshell-dry-run.out'
  expect "the dry run exits 0 or 3 (3 = changes against no previous policy)" \
    ccsh 'tail -1 ~/live/openshell-dry-run.out | grep -Eqx "exit (0|3)"'
  expect "cops openshell compile prints the policy" \
    ccsh 'cops openshell compile --harness claude-code --out ~/live/openshell-policy.yaml && grep -q "filesystem_policy:" ~/live/openshell-policy.yaml && head -20 ~/live/openshell-policy.yaml'
  skip "no OpenShell gateway: Docker Desktop host networking is off on this machine (PLAN-M2 §11.3); the sandbox steps need it"
  end
}

phase_uninstall() {
  begin 7.1 "cops install claude-code --uninstall restores the user's settings"
  expect "uninstall exits 0" cc cops install claude-code --uninstall
  run ccsh 'diff -u ~/live/settings.pre-install.json ~/.claude/settings.json && echo "byte-identical"'
  expect "settings.json equals the pre-install snapshot (as JSON)" \
    ccsh 'bun -e "const a = await Bun.file(process.argv[1]).json(); const b = await Bun.file(process.argv[2]).json(); process.exit(Bun.deepEquals(a, b) ? 0 : 1)" ~/live/settings.pre-install.json ~/.claude/settings.json'
  expect "settings.json is byte-identical to the pre-install snapshot" \
    ccsh 'cmp ~/live/settings.pre-install.json ~/.claude/settings.json'
  run ccsh 'cat ~/.config/jev-cops/cops.toml'
  end

  begin 7.2 "cops install pi --uninstall removes the extension"
  expect "uninstall exits 0" pie cops install pi --uninstall
  expect "the extension file is gone" pish 'test ! -e ~/.pi/agent/extensions/jev-cops.ts'
  expect "the extensions dir lists what it listed before the install" \
    pish 'diff <(ls ~/.pi/agent/extensions 2>&1) ~/live/pi-extensions.pre-install.txt'
  end
}

roundtrip() { # step harness api-path
  local step=$1 h=$2 path=$3 before
  begin "$step" "$h: the real CLI in its container reaches the fake API and runs one scripted ls"
  expect "prep the world ($h config at the fake API, dummy key)" live_exec "$h" "$BIN/prep-world.sh" "$h"
  run live_exec "$h" bash -c 'cat /opt/jev-cops-live/harness-version; cops --version'
  before=$(requests_count)
  expect "$h exits 0" live_exec "$h" bash -c "$BIN/run-harness.sh $h /home/dev/live/out/roundtrip 'SCENARIO:ls list the files here' && test \"\$(cat ~/live/out/roundtrip/exit-code)\" = 0"
  pull_api
  requests_since "$before" "$A/requests-$h.jsonl"
  expect "it called $path with the dummy key" \
    line_with "$A/requests-$h.jsonl" "\"path\":\"$path\"" '"dummy"'
  expect "the model's scripted ls call came back with the real output" \
    check saw "$A/requests-$h.jsonl" ls "README.md"
  run check seen "$A/requests-$h.jsonl" ls
  expect_not "cops install $h is not available yet (no adapter: PLAN-M3)" live_exec "$h" cops install "$h"
  end
}
