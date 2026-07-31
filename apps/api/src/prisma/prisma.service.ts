import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { branchScopeExtension } from './branch-scope.extension';

/**
 * PrismaClient with branch scoping applied (ADR-010).
 *
 * `$extends` returns a new client rather than mutating this one, so the
 * constructor returns a proxy that forwards model access to the extended
 * client. Every existing `this.prisma.sale.findMany(...)` call site therefore
 * picks up branch isolation unchanged, and Nest still injects `PrismaService`
 * by class token.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super();

    const extended = this.$extends(branchScopeExtension);

    return new Proxy(this, {
      get(target, prop, receiver) {
        // Lifecycle and connection management stay on the base client — the
        // extended one has no independent connection.
        if (
          prop === 'onModuleInit' ||
          prop === 'onModuleDestroy' ||
          prop === '$connect' ||
          prop === '$disconnect'
        ) {
          return Reflect.get(target, prop, receiver);
        }
        const value = Reflect.get(extended as object, prop);
        if (value === undefined) return Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(extended) : value;
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
