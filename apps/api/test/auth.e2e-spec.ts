import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, createUser, login, prisma, resetDb } from './helpers';

describe('Auth (US-01)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await resetDb();
    await createUser('akosua', 'CASHIER');
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('logs in with correct credentials and returns tokens + user', async () => {
    const res = await login(app, 'akosua');
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user).toMatchObject({ username: 'akosua', role: 'CASHIER' });
  });

  it('rejects a wrong password with a uniform 401', async () => {
    const res = await login(app, 'akosua', 'WrongPass1');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after 5 failed attempts (423) and audits the lockout', async () => {
    await createUser('locky', 'CASHIER');
    for (let i = 0; i < 4; i++) {
      const res = await login(app, 'locky', 'WrongPass1');
      expect(res.status).toBe(401);
    }
    const fifth = await login(app, 'locky', 'WrongPass1');
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');

    // even the right password is refused while locked
    const locked = await login(app, 'locky');
    expect(locked.status).toBe(423);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'auth.lockout' } });
    expect(audit).not.toBeNull();
  });

  it('rotates the refresh token and detects reuse of a revoked token', async () => {
    const first = await login(app, 'akosua');
    const oldRefresh = first.body.refreshToken;

    const rotated = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: oldRefresh });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(oldRefresh);

    // replaying the revoked token must revoke the whole family
    const reuse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: oldRefresh });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('TOKEN_REUSED');

    const familyDead = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken });
    expect(familyDead.status).toBe(401);
  });

  it('guards protected routes: no token → 401, valid token → 200 /auth/me', async () => {
    const anon = await request(app.getHttpServer()).get('/api/v1/auth/me');
    expect(anon.status).toBe(401);

    const session = await login(app, 'akosua');
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${session.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('akosua');
  });
});
