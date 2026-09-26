#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Builds build/ucep-spec.pdf from the Markdown sources.
# Needs pandoc and Google Chrome (or Chromium; set CHROME=/path/to/binary).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/build"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

chrome="${CHROME:-}"
if [[ -z "$chrome" ]]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           "$(command -v chromium || true)" "$(command -v google-chrome || true)"; do
    if [[ -n "$c" && -x "$c" ]]; then chrome="$c"; break; fi
  done
fi
[[ -n "$chrome" ]] || { echo "Chrome/Chromium not found; set CHROME" >&2; exit 1; }

# One document; links between the files become links inside it.
{
  for f in ucep.md ucep-auth.md extensions/invoice.md SECURITY.md; do
    # ./file.md#section -> #section; any other relative link -> the file on GitHub.
    sed -E -e 's#\]\(\./(ucep|ucep-auth|SECURITY|extensions/invoice)\.md\##](\##g' \
           -e 's#\]\(\./#](https://github.com/Le-Space/ucep-spec/blob/main/#g' "$root/$f"
    printf '\n\n'
  done
  printf '# Appendix: messages.proto\n\n```protobuf\n'
  cat "$root/messages.proto"
  printf '```\n'
} > "$tmp/spec.md"

rev="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo draft)"

pandoc "$tmp/spec.md" \
  -f markdown+gfm_auto_identifiers+pipe_tables+backtick_code_blocks \
  -t html5 --standalone --embed-resources \
  --metadata title="Universal Connectivity Extension Protocol (UCEP)" \
  --metadata subtitle="Working Draft, wire revision 2 · $(date +%Y-%m-%d) · $rev · Text CC-BY-4.0, code MIT" \
  --toc --toc-depth=1 \
  --syntax-highlighting=tango \
  --css "$root/build/print.css" \
  -o "$tmp/spec.html"

"$chrome" --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$out/ucep-spec.pdf" "file://$tmp/spec.html" 2>/dev/null

echo "wrote $out/ucep-spec.pdf"
