/**
 * Unit tests (*.spec.ts, colocated with src) — no database, no NestJS test
 * module bootstrap, plain Jest + mocked PrismaService. Separate from
 * test/jest-e2e.json, which spins up a real Postgres via global-setup.ts.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testEnvironment: 'node',
  testRegex: '\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json', isolatedModules: true }],
  },
};
