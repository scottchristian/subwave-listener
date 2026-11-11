#!/bin/bash
# E2E entrypoint: migrate a sqlite db, seed one admin + session, start under pm2.
set -u
cd /app

: "${PM2_APP_NAME:=subwave-e2e}"
: "${PORT:=3000}"
export PM2_BIN="${PM2_BIN:-$(command -v pm2)}"

# Minimal configured station. BACKEND points nowhere real: the update route's
# listener check then returns null, which is exactly the "unknown room" path
# the E2E asserts refuses-then-proceeds-with-confirm.
cat > .env.local <<EOF
DATABASE_URL="file:./data/e2e.db"
DB_PROVIDER=sqlite
PII_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001
NEXTAUTH_SECRET=e2e-test-secret-not-a-real-secret
GOOGLE_CLIENT_ID=e2e-client-id
GOOGLE_CLIENT_SECRET=e2e-client-secret
NEXTAUTH_URL=http://127.0.0.1:${PORT}
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:9
PM2_APP_NAME=${PM2_APP_NAME}
PM2_BIN=${PM2_BIN}
EOF
chmod 600 .env.local
# Prisma CLI reads .env, not .env.local — export explicitly so migrate, generate
# and the seed below see the same DATABASE_URL the app will read at runtime.
set -a
. ./.env.local
set +a
mkdir -p data/brand/icons

node scripts/gen-schema.mjs sqlite prisma/.gen-sqlite.prisma >/dev/null
cp prisma/.gen-sqlite.prisma prisma/schema.prisma
npx prisma generate >/dev/null 2>&1
npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null 2>&1

# Fixed-token admin session so the driver can authenticate with a Cookie header.
# Throwaway container, throwaway secret — this token is worthless elsewhere.
DATABASE_URL="file:./data/e2e.db" node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const user = await p.user.upsert({
    where: { email: 'e2e@example.com' },
    update: { isAdmin: true, isApproved: true },
    create: { email: 'e2e@example.com', name: 'E2E', isAdmin: true, isApproved: true },
  });
  await p.session.deleteMany({ where: { userId: user.id } });
  await p.session.create({
    data: { sessionToken: 'e2e-test-session-token', userId: user.id, expires: new Date(Date.now() + 3600000) },
  });
  console.log('seeded admin, token=e2e-test-session-token');
  await p.\$disconnect();
})().catch((e) => { console.log('seed failed: ' + e.message); process.exit(1); });
"

npm run build
pm2 start npm --name "${PM2_APP_NAME}" -- start -- -p "${PORT}"
pm2 save --force >/dev/null 2>&1 || true

# Stay up. pm2 runs daemonized; without this the container exits.
tail -f /dev/null
