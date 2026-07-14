process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://pharmatrack:pharmatrack@localhost:5432/pharmatrack_test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL_HOURS = '12';
process.env.THROTTLE_DISABLED = 'true';
process.env.LOG_LEVEL = 'silent';
