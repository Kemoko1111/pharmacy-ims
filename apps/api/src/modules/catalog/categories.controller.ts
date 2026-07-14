import { Body, Controller, Get, Post } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CreateCategoryDto } from './dto';
import { Roles } from '../../common/roles.decorator';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list() {
    return this.catalog.listCategories();
  }

  @Post()
  @Roles('MANAGER')
  create(@Body() dto: CreateCategoryDto) {
    return this.catalog.createCategory(dto.name);
  }
}
