import { HttpException } from '@nestjs/common';

/** 422 domain-rule violation with a machine-readable code, e.g. BATCH_EXPIRED. */
export class DomainException extends HttpException {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super({ code, message, details }, 422);
  }
}

export class ConflictWithBody extends HttpException {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super({ code, message, details }, 409);
  }
}
