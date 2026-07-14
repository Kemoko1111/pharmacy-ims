import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../../common/domain.exception';
import type { RequestUser } from '../../common/jwt-auth.guard';

/**
 * US-16: QuickBooks POS item-list import. QB Desktop POS exports vary by
 * version/locale, so headers are matched against aliases after normalizing
 * (lowercase, strip non-alphanumerics). Confirm the real column set at
 * Site Visit 2 (Open Question 9) and extend ALIASES if needed.
 */
const ALIASES: Record<string, string[]> = {
  name: ['itemname', 'name', 'item', 'description1', 'itemdescription', 'desc'],
  price: ['price1', 'regularprice', 'price', 'sellingprice', 'retailprice'],
  department: ['department', 'departmentname', 'category', 'dept'],
  itemNumber: ['itemnumber', 'itemno', 'item#', 'number'],
  barcode: ['upc', 'upccode', 'barcode', 'ean', 'alu'],
  reorderPoint: ['reorderpoint', 'reorderlevel', 'reorder'],
  onHand: ['onhandqty', 'qtyonhand', 'onhand', 'quantityonhand', 'qty1', 'quantity'],
  cost: ['averageunitcost', 'avgcost', 'cost', 'unitcost'],
  baseUnit: ['baseunitofmeasure', 'unitofmeasure', 'uom', 'baseunit', 'unit'],
};

const IMPORT_BATCH_EXPIRY_MONTHS = 6;

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: { row: number; message: string }[];
  stockImported: boolean;
}

interface MappedRow {
  name: string;
  price: string | undefined;
  department: string | undefined;
  itemNumber: string | undefined;
  barcode: string | undefined;
  reorderPoint: string | undefined;
  onHand: string | undefined;
  cost: string | undefined;
  baseUnit: string | undefined;
}

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async importCsv(buffer: Buffer, importStock: boolean, actor: RequestUser): Promise<ImportResult> {
    let records: Record<string, string>[];
    try {
      records = parse(buffer, {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });
    } catch (err) {
      throw new DomainException('CSV_UNREADABLE', `Could not parse the CSV: ${(err as Error).message}`);
    }
    if (records.length === 0) {
      throw new DomainException('CSV_EMPTY', 'The file has no data rows');
    }

    // Build the header map once from the first record's keys
    const headerMap = new Map<string, keyof MappedRow>();
    for (const rawHeader of Object.keys(records[0])) {
      const normalized = rawHeader.toLowerCase().replace(/[^a-z0-9#]/g, '');
      for (const [field, aliases] of Object.entries(ALIASES)) {
        if (aliases.includes(normalized)) {
          if (!headerMap.has(rawHeader)) headerMap.set(rawHeader, field as keyof MappedRow);
          break;
        }
      }
    }
    const mappedFields = new Set(headerMap.values());
    if (!mappedFields.has('name') || !mappedFields.has('price')) {
      throw new DomainException(
        'CSV_HEADERS_UNRECOGNIZED',
        'Could not find item-name and price columns',
        { seenHeaders: Object.keys(records[0]), needed: ['Item Name', 'Price 1'] },
      );
    }

    const result: ImportResult = { imported: 0, skipped: 0, errors: [], stockImported: importStock };
    const categoryCache = new Map<string, string>();
    const importExpiry = new Date();
    importExpiry.setMonth(importExpiry.getMonth() + IMPORT_BATCH_EXPIRY_MONTHS);

    for (let i = 0; i < records.length; i++) {
      const rowNum = i + 2; // header is row 1
      const row = this.mapRow(records[i], headerMap);
      try {
        if (!row.name) {
          result.errors.push({ row: rowNum, message: 'Missing item name' });
          continue;
        }
        const price = this.parseMoney(row.price);
        if (price === null) {
          result.errors.push({ row: rowNum, message: `Bad price "${row.price}"` });
          continue;
        }

        // Dedupe: legacy item number first, then exact name
        const existing = await this.prisma.product.findFirst({
          where: row.itemNumber
            ? { OR: [{ legacyItemNo: row.itemNumber }, { name: row.name }], deletedAt: null }
            : { name: row.name, deletedAt: null },
        });
        if (existing) {
          result.skipped++;
          continue;
        }

        const categoryName = row.department?.trim() || 'Imported';
        let categoryId = categoryCache.get(categoryName);
        if (!categoryId) {
          const category = await this.prisma.category.upsert({
            where: { name: categoryName },
            create: { id: uuid(), name: categoryName },
            update: {},
          });
          categoryId = category.id;
          categoryCache.set(categoryName, categoryId);
        }

        const productId = uuid();
        await this.prisma.$transaction(async (tx) => {
          await tx.product.create({
            data: {
              id: productId,
              name: row.name,
              form: 'OTHER', // QB has no dosage form; pharmacist refines later
              categoryId: categoryId!,
              baseUnit: row.baseUnit?.trim() || 'piece',
              sellingPriceBase: price,
              reorderLevel: this.parseIntSafe(row.reorderPoint) ?? 0,
              legacyItemNo: row.itemNumber ?? null,
              notes: 'Imported from QuickBooks POS',
              createdBy: actor.id,
            },
          });

          if (row.barcode) {
            const taken = await tx.productBarcode.findUnique({ where: { barcode: row.barcode } });
            if (taken) {
              result.errors.push({
                row: rowNum,
                message: `Barcode ${row.barcode} already belongs to another product — imported without it`,
              });
            } else {
              await tx.productBarcode.create({
                data: { id: uuid(), productId, barcode: row.barcode },
              });
            }
          }

          const onHand = this.parseIntSafe(row.onHand);
          if (importStock && onHand && onHand > 0) {
            const batchId = uuid();
            const cost = this.parseMoney(row.cost) ?? new Prisma.Decimal(0);
            // QB has no batch/expiry data — placeholder expiry, flagged for
            // pharmacist review; do NOT trust it for FEFO compliance.
            await tx.batch.create({
              data: {
                id: batchId,
                productId,
                batchNumber: 'QB-IMPORT',
                expiryDate: importExpiry,
                qtyOnHand: onHand,
                unitCost: cost,
                status: 'ACTIVE',
              },
            });
            await tx.stockMovement.create({
              data: {
                productId,
                batchId,
                qtyDelta: onHand,
                type: 'OPENING',
                refType: 'qb_import',
                refId: productId,
                unitCost: cost,
                performedBy: actor.id,
              },
            });
          }
        });

        result.imported++;
      } catch (err) {
        result.errors.push({ row: rowNum, message: (err as Error).message.slice(0, 200) });
      }
    }

    if (importStock && result.imported > 0) {
      await this.prisma.notification.create({
        data: {
          id: uuid(),
          type: 'QB_IMPORT_REVIEW',
          payload: {
            imported: result.imported,
            note: `Imported stock uses placeholder batch QB-IMPORT expiring ${importExpiry.toISOString().slice(0, 10)} — enter real batches/expiries before relying on FEFO.`,
          },
        },
      });
    }

    await this.audit.log({
      userId: actor.id,
      action: 'catalog.qb_import',
      entity: 'product',
      entityId: 'bulk',
      after: { imported: result.imported, skipped: result.skipped, errors: result.errors.length, importStock },
    });
    return result;
  }

  private mapRow(record: Record<string, string>, headerMap: Map<string, keyof MappedRow>): MappedRow {
    const out: Partial<MappedRow> = {};
    for (const [rawHeader, field] of headerMap) {
      const value = record[rawHeader]?.trim();
      if (value && out[field] === undefined) out[field] = value;
    }
    return out as MappedRow;
  }

  private parseMoney(value: string | undefined): Prisma.Decimal | null {
    if (!value) return null;
    const cleaned = value.replace(/[^\d.-]/g, ''); // strip GHS/₵/commas
    if (!cleaned || Number.isNaN(Number(cleaned))) return null;
    try {
      return new Prisma.Decimal(cleaned).toDecimalPlaces(2);
    } catch {
      return null;
    }
  }

  private parseIntSafe(value: string | undefined): number | null {
    if (!value) return null;
    const n = Math.trunc(Number(value.replace(/[^\d.-]/g, '')));
    return Number.isFinite(n) ? n : null;
  }
}
