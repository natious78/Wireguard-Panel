#!/bin/sh
set -eu

node dist/migrate.cjs
node dist/init-admin.cjs
exec "$@"
