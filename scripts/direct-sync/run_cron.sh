#!/bin/bash
set -uo pipefail

# The direct-sync script needs the musl-linked better-sqlite3 binding that
# only exists inside the already-running actual-mcp-prod container (built
# from node:20-alpine), so it's run via `docker exec` rather than on the
# host directly — running it on the host fails with ERR_DLOPEN_FAILED
# (glibc host, musl .node binary) and can't reach the internal
# actual-actual_server-1 hostname anyway.
#
# Covers accounts linked via Actual's built-in bank-sync (GoCardless/
# SimpleFIN, e.g. Dan - Mastercard) that the separate actual-plaid cron
# job doesn't touch — that job only imports the accounts it's explicitly
# configured for via the Plaid API, not accounts linked through Actual's
# own bank-sync feature.

# Reuse the bot token already configured for the home telegram bot,
# so the credential only lives in one place.
TELEGRAM_API_KEY=$(grep -E '^TELEGRAM_API_KEY=' /home/dan/dev/python/home_telegram_bot/.env | cut -d= -f2-)
CHAT_ID="-4625874053" # home group

send_telegram() {
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_API_KEY}/sendMessage" \
        --data-urlencode "chat_id=${CHAT_ID}" \
        --data-urlencode "text=$1" > /dev/null
}

OUTPUT=$(docker exec -w /app actual-mcp-prod node scripts/direct-sync/bank-sync-direct.mjs --no-file-log 2>&1)
EXIT_CODE=$?

echo "$OUTPUT"

if [ $EXIT_CODE -eq 0 ]; then
    send_telegram "ActualBudget SimpleFIN Sync: Success"
else
    send_telegram "ActualBudget SimpleFIN Sync: Failed (see direct-sync-cron.log for details)"
fi

exit $EXIT_CODE
