import { Controller, Get, Param } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller()
export class BarcodesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('barcodes/:code')
  lookup(@Param('code') code: string) {
    return this.catalog.lookupBarcode(code);
  }

  // Offline cache feed (ADR-006) — sits with catalog, path per api-schema.md
  @Get('catalog/snapshot')
  snapshot() {
    return this.catalog.snapshot();
  }
}
