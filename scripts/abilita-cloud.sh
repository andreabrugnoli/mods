#!/usr/bin/env bash
# Abilita le mod di andrea-mods in un'altra repo, così partono anche nelle sessioni cloud (iPad, web).
# Uso: scripts/abilita-cloud.sh <percorso-repo> [mod ...]   (default: cache-meter)
set -euo pipefail

repo="${1:?Uso: abilita-cloud.sh <percorso-repo> [mod ...]}"
shift || true
mods=("${@:-cache-meter}")

command -v jq >/dev/null || { echo "serve jq (brew install jq)" >&2; exit 1; }
[ -d "$repo/.git" ] || { echo "$repo non è una repo Git" >&2; exit 1; }

file="$repo/.claude/settings.json"
mkdir -p "$repo/.claude"
[ -f "$file" ] || echo '{}' > "$file"

# Unisce marketplace e plugin abilitati senza toccare il resto delle impostazioni
plugins=$(printf '%s\n' "${mods[@]}" | jq -R '{(. + "@andrea-mods"): true}' | jq -s 'add')
tmp=$(mktemp)
jq --argjson plugins "$plugins" '
  .extraKnownMarketplaces["andrea-mods"] = {source: {source: "github", repo: "andreabrugnoli/mods"}}
  | .enabledPlugins = ((.enabledPlugins // {}) + $plugins)
' "$file" > "$tmp" && mv "$tmp" "$file"

echo "Aggiornato $file:"
cat "$file"
echo "Il gitignore globale esclude .claude/settings.json: usa  git -C \"$repo\" add -f .claude/settings.json  poi commit e push."
