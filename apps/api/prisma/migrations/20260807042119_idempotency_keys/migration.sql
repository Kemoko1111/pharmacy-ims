-- Generic replay protection for writes made offline and drained later (ADR-013).
--
-- Hand-written. `prisma migrate dev` wanted to drop and recreate ~70 foreign
-- keys and, more seriously, to DROP ix_products_name_trgm and
-- ix_products_generic_trgm — the trigram indexes that make product search meet
-- its <300 ms target. Those are declared in raw SQL in the init migration, so
-- Prisma does not know they are ours and treats them as drift. Only the new
-- table belongs in this migration.

CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "ix_idempotency_created" ON "idempotency_keys"("created_at");

ALTER TABLE "idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
