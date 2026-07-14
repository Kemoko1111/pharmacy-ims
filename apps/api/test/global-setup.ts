import { execSync } from 'node:child_process';
import { join } from 'node:path';

export default async function globalSetup() {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://pharmatrack:pharmatrack@localhost:5432/pharmatrack_test';
  execSync('pnpm exec prisma migrate deploy', {
    cwd: join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
