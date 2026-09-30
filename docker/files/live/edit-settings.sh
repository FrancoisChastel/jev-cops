#!/bin/bash
# Edits ~/.claude/settings.json from outside Claude Code, atomically (a temp file renamed
# over it, as editors save), for the ConfigChange scenarios.
#   edit-settings.sh theme <value>        an unrelated change
#   edit-settings.sh drop <HookEvent>     remove one hook event's registrations
#   edit-settings.sh restore <file>       put a saved copy back
set -euo pipefail

settings=$HOME/.claude/settings.json
tmp=$settings.tmp
case "${1:?usage: edit-settings.sh theme <v> | drop <event> | restore <file>}" in
  theme | drop)
    # shellcheck disable=SC2016 # a JavaScript program: its ${…} are template literals
    bun -e '
      const [path, out, what, arg] = process.argv.slice(1);
      const d = JSON.parse(await Bun.file(path).text());
      if (what === "theme") d.theme = arg;
      else delete d.hooks[arg];
      await Bun.write(out, `${JSON.stringify(d, null, 2)}\n`);
    ' "$settings" "$tmp" "$1" "${2:?value}"
    ;;
  restore)
    cp "${2:?file}" "$tmp"
    ;;
  *)
    echo "edit-settings.sh: unknown edit $1" >&2
    exit 2
    ;;
esac
mv -f "$tmp" "$settings"
echo "settings.json: $* (atomic rename)"
