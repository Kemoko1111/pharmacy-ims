import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CatalogService } from './catalog.service';
import { ImportService } from './import.service';
import { AddBarcodeDto, AddUnitDto, CreateProductDto, ProductsQuery, UpdateProductDto } from './dto';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly importer: ImportService,
  ) {}

  /** US-16: QuickBooks POS item-list CSV. `?importStock=true` also creates
   *  placeholder OPENING batches (flagged for pharmacist review). */
  @Post('import')
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('importStock') importStock: string | undefined,
    @CurrentUser() actor: RequestUser,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException({ code: 'NO_FILE', message: 'Attach the CSV as "file"' });
    }
    return this.importer.importCsv(file.buffer, importStock === 'true', actor);
  }

  @Get()
  list(@Query() q: ProductsQuery) {
    return this.catalog.listProducts(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.getProduct(id);
  }

  @Post()
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  create(@Body() dto: CreateProductDto, @CurrentUser() actor: RequestUser) {
    return this.catalog.createProduct(dto, actor);
  }

  @Patch(':id')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.catalog.updateProduct(id, dto, actor);
  }

  @Delete(':id')
  @Roles('MANAGER')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: RequestUser) {
    await this.catalog.softDeleteProduct(id, actor);
  }

  @Post(':id/units')
  @Roles('MANAGER')
  addUnit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddUnitDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.catalog.addUnit(id, dto, actor);
  }

  @Post(':id/units/:unitId/retire')
  @Roles('MANAGER')
  retireUnit(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.catalog.retireUnit(id, unitId, actor);
  }

  @Post(':id/barcodes')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  addBarcode(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddBarcodeDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.catalog.addBarcode(id, dto, actor);
  }
}
