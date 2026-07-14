/**
 * Zero-install local PostgreSQL 16 for machines without Docker.
 * Team members with Docker can use `docker compose up -d` instead — same URL.
 *
 * Usage: node scripts/local-db.mjs   (keeps running; Ctrl-C stops it)
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.pgdata');

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'pharmatrack',
  password: 'pharmatrack',
  port: 5432,
  persistent: true,
});

if (!existsSync(join(dataDir, 'PG_VERSION'))) {
  console.log('Initialising data directory…');
  await pg.initialise();
}

await pg.start();

for (const db of ['pharmatrack_dev', 'pharmatrack_test']) {
  try {
    await pg.createDatabase(db);
    console.log(`created database ${db}`);
  } catch {
    // already exists
  }
}

console.log('PostgreSQL 16 ready on postgresql://pharmatrack:pharmatrack@localhost:5432/pharmatrack_dev');

const stop = async () => {
  console.log('Stopping PostgreSQL…');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
