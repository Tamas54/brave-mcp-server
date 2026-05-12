#!/bin/bash
# Container stress test — tests the Dockerized brave-mcp-server (with Webclaw L3
# side-car) against a wide range of URL types: anti-bot, paywall, JS-render-only,
# baseline-clean. Verifies escalation chain works correctly and content flags
# are honest about what was retrieved.

BASE="http://127.0.0.1:3030"

declare -a CASES=(
  # category|name|url|expected
  "0-baseline|Eurostat newsroom|https://ec.europa.eu/eurostat/web/products-euro-indicators|OK"
  "0-baseline|Wikipedia (control)|https://en.wikipedia.org/wiki/Inflation|OK"
  "1-basic-cf|Bloomberg homepage|https://www.bloomberg.com/|OK"
  "1-basic-cf|AP News hub|https://apnews.com/hub/world-news|OK"
  "2-turnstile|biddr aukcio|https://www.biddr.com/auctions/leu/browse?a=1839&l=1972015|OK-via-L3"
  "2-aggregator|NumisBids individual lot|https://www.numisbids.com/n.php?p=lot&sid=8589&lot=2|OK"
  "3-datadome|Reuters world hub|https://www.reuters.com/world/|OK-via-L3"
  "3-datadome|Reuters cikk (US CPI)|https://www.reuters.com/business/us-consumer-prices-increase-further-april-2026-05-12/|OK-via-L3"
  "3-datadome|Bloomberg cikk (Iran ceasefire)|https://www.bloomberg.com/news/articles/2026-05-12/iran-war-ceasefire-fragile-as-us-rejects-tehran-s-latest-offer|OK"
  "paywall|FT cikk (hard paywall)|https://www.ft.com/content/ce609605-8f82-42d7-8364-5ca5fbfb02cb|paywall_banner"
  "js-spa|NYT live blog (JS-render-only)|https://www.nytimes.com/live/2026/05/12/business/inflation-report-cpi|all_levels_blocked (FS skip lokál)"
  "404|Reuters fiktiv URL|https://www.reuters.com/world/nonexistent-article-test-xyz-2026-05-12/|404 (legitim)"
)

echo "=================================================================="
echo "Container stress test — brave-mcp-server + Webclaw L3 side-car"
echo "Started: $(date -Iseconds)"
echo "=================================================================="
printf "%-12s %-40s | %-7s %-7s %-19s %s\n" "TIER" "CASE" "TIME" "MD_LEN" "VERDICT" "PATH"
echo "------------+------------------------------------------+---------+--------+--------------------+---------"

for entry in "${CASES[@]}"; do
  IFS='|' read -r tier name url expected <<< "$entry"

  start=$(date +%s%N)
  resp=$(curl -sS -X POST "$BASE/tools/brave_scrape" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg u "$url" '{url:$u, auto_fallback:true}')" \
    --max-time 180 2>&1) || resp='{"result":{}}'
  end=$(date +%s%N)
  elapsed_ms=$(( (end - start) / 1000000 ))

  result=$(echo "$resp" | jq -c '.result // {}' 2>/dev/null)
  cu=$(echo "$result" | jq -r '.content_usable // false' 2>/dev/null)
  br=$(echo "$result" | jq -r '.block_reason // ""' 2>/dev/null)
  cs=$(echo "$result" | jq -r '.cf_status // ""' 2>/dev/null)
  src=$(echo "$result" | jq -r '.content_source // ""' 2>/dev/null)
  md_len=$(echo "$result" | jq -r '.markdown // ""' 2>/dev/null | wc -c)

  # Compact escalation path
  path=$(echo "$result" | jq -r '.escalation_path // [] | map(if .ok then "L\(.level)\(.mode|.[0:1])✓" elif .skipped then "L\(.level)\(.mode|.[0:1])-sk" else "L\(.level)\(.mode|.[0:1])✗(\(.block_reason//"err"))" end) | join(" → ")' 2>/dev/null)
  [ -z "$path" ] && path="(no chain)"

  # Verdict
  if [ "$cu" = "true" ]; then
    verdict="PASS"
  elif [ -n "$br" ]; then
    verdict="BLOCK:$br"
  else
    verdict="?"
  fi

  printf "%-12s %-40s | %5dms %7d %-20s %s\n" "$tier" "$(echo "$name" | cut -c1-40)" "$elapsed_ms" "$md_len" "$verdict" "$path"
done

echo "------------+------------------------------------------+---------+--------+--------------------+---------"
echo "Done: $(date -Iseconds)"
