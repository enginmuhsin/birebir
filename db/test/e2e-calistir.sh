#!/bin/sh
# Uygulama uçtan uca testini çalıştırır; artakalan süreçleri temizler.
cd "$(dirname "$0")/../.."
db/test/pg-baslat.sh >/dev/null
npm run -s build:app >/dev/null 2>&1
timeout 300 node test/app/e2e.mjs
for p in $(pgrep -f "db/test/yig[i]n"); do kill $p; done
for p in $(pgrep -f "postgres[t]"); do kill $p; done
