import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * Single error envelope (api-schema.md §Conventions):
 *   { "error": { "code": "BATCH_EXPIRED", "message": "…", "details": {} } }
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        code = defaultCode(status);
      } else {
        const b = body as Record<string, unknown>;
        // class-validator errors arrive as { message: string[] }
        if (Array.isArray(b.message)) {
          code = 'VALIDATION_ERROR';
          message = 'Request validation failed';
          details = { errors: b.message };
        } else {
          code = (b.code as string) ?? defaultCode(status);
          message = (b.message as string) ?? defaultCode(status);
          details = b.details as Record<string, unknown> | undefined;
        }
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = 'DUPLICATE';
        message = 'A record with this value already exists';
        details = { target: exception.meta?.target };
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        code = 'NOT_FOUND';
        message = 'Record not found';
      }
    } else if (exception instanceof Error && process.env.NODE_ENV !== 'production') {
      message = exception.message;
    }

    res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'DOMAIN_RULE';
    case 423:
      return 'LOCKED';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'ERROR';
  }
}
