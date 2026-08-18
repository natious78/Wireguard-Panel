#!/bin/sh
set -eu

./node_modules/.bin/tsx scripts/migrate.ts
./node_modules/.bin/tsx scripts/init-admin.ts
exec "$@"
