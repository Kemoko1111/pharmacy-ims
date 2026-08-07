import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Observable, from, switchMap, tap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { ConflictWithBody, DomainException } from './domain.exception';

/**
 * Replay protection for writes that were made offline and drained later
 * (ADR-013).
 *
 * A till that posts a queued write and then loses the answer cannot tell
 * "never arrived" from "arrived, reply lost". Retrying is the only option it
 * has, and without a key on the request that retry posts the delivery, the
 * adjustment or the price change a second time. Sales were already safe —
 * `sales.client_sale_id` is a natural key with a unique constraint — but every
 * other endpoint had nothing.
 *
 * Opt-in by header, so nothing changes for the online app: a request without
 * `Idempotency-Key` behaves exactly as before.
 *
 * Only successful responses are recorded. A write the server *refused* is not
 * replayed from the store — the refusal was about the request, and if the
 * client fixes it and retries with the same key it deserves a fresh answer.
 * That also keeps a validation failure from permanently poisoning a key.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const key: string | undefined = req.headers['idempotency-key'];

    if (!key || req.method === 'GET' || req.method === 'HEAD') return next.handle();

    const userId: string | undefined = req.user?.sub ?? req.user?.id;
    // Unauthenticated routes have no owner to bind the key to, and an
    // unowned key is a replay oracle for anyone who guesses it.
    if (!userId) return next.handle();

    if (key.length > 200) {
      throw new DomainException('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 200 characters or fewer');
    }

    const path: string = req.route?.path ?? req.url;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ method: req.method, path: req.url, body: req.body ?? null }))
      .digest('hex');

    return from(this.claim(key, userId, req.method, path, requestHash)).pipe(
      switchMap((claim) => {
        if (claim.replay) return from(Promise.resolve(claim.body));
        return next.handle().pipe(
          tap({
            next: (body) => {
              const status = context.switchToHttp().getResponse().statusCode ?? 200;
              void this.complete(key, status, body);
            },
            // The write failed, so the key never described a completed
            // operation. Release it rather than leave a tombstone that would
            // make every future attempt look like an in-flight duplicate.
            error: () => void this.release(key),
          }),
        );
      }),
    );
  }

  /**
   * Take ownership of the key, or report what already happened under it.
   * The insert is the lock: a unique-violation means another request got there
   * first, which is exactly the concurrent-retry case.
   */
  private async claim(
    key: string,
    userId: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<{ replay: true; body: unknown } | { replay: false }> {
    const existing = await this.prisma.idempotencyKey.findUnique({ where: { key } });

    if (existing) {
      // A key belongs to the user who first used it. Anything else is either a
      // client bug or someone probing for another user's responses.
      if (existing.userId !== userId) {
        throw new ConflictWithBody('IDEMPOTENCY_KEY_IN_USE', 'This Idempotency-Key belongs to another session');
      }
      if (existing.requestHash !== requestHash) {
        throw new DomainException(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request',
        );
      }
      if (existing.completedAt) return { replay: true, body: existing.responseBody };
      // Claimed but unfinished: the first attempt is still running, or died
      // mid-flight. Either way the caller must not run the write again.
      throw new ConflictWithBody(
        'IDEMPOTENT_REQUEST_IN_PROGRESS',
        'An identical request is still being processed — retry shortly',
      );
    }

    try {
      await this.prisma.idempotencyKey.create({
        data: { key, userId, method, path, requestHash },
      });
      return { replay: false };
    } catch {
      // Lost the insert race; the winner is in flight.
      throw new ConflictWithBody(
        'IDEMPOTENT_REQUEST_IN_PROGRESS',
        'An identical request is still being processed — retry shortly',
      );
    }
  }

  private async complete(key: string, status: number, body: unknown): Promise<void> {
    await this.prisma.idempotencyKey
      .update({
        where: { key },
        data: {
          responseStatus: status,
          responseBody: (body ?? null) as never,
          completedAt: new Date(),
        },
      })
      .catch(() => {
        // The write itself succeeded; failing to record that must not turn a
        // good response into an error. Worst case the retry is refused as a
        // duplicate, which is the safe direction.
      });
  }

  private async release(key: string): Promise<void> {
    await this.prisma.idempotencyKey.delete({ where: { key } }).catch(() => {});
  }
}
