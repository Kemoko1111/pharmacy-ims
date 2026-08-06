/**
 * Zero-install local PostgreSQL 17 for machines without Docker.
 * Team members with Docker can use `docker compose up -d` instead — same URL.
 *
 * Usage: node scripts/local-db.mjs   (keeps running; Ctrl-C stops it)
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MAJOR = '17';
const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.pgdata');

// A data directory written by an older major will not start under a newer one,
// and the failure reads as an opaque startup error. Say what it actually is.
const versionFile = join(dataDir, 'PG_VERSION');
if (existsSync(versionFile)) {
  const existing = readFileSync(versionFile, 'utf8').trim();
  if (existing !== MAJOR) {
    console.error(
      `.pgdata holds a PostgreSQL ${existing} data directory, but this script now runs ${MAJOR} ` +
        `(matching Neon production).\nIt is local dev data only — delete it and rerun:\n\n  rm -rf apps/api/.pgdata\n`,
    );
    process.exit(1);
  }
}

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

console.log(`PostgreSQL ${MAJOR} ready on postgresql://pharmatrack:pharmatrack@localhost:5432/pharmatrack_dev`);

const stop = async () => {
  console.log('Stopping PostgreSQL…');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
