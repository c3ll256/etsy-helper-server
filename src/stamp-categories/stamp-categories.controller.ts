import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { StampCategoriesService } from './stamp-categories.service';

@ApiTags('stamp-categories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stamp-categories')
export class StampCategoriesController {
  constructor(private readonly service: StampCategoriesService) {}

  @Get()
  @ApiOperation({ summary: '分类列表（含模板数、订单数）' })
  list(@Query('includeDeleted') includeDeleted?: string) {
    return this.service.list({ includeDeleted: includeDeleted === 'true' });
  }

  @Post()
  @ApiOperation({ summary: '（管理员）新增分类' })
  create(@Body() body: { name: string; code?: string; sortOrder?: number }, @CurrentUser() user: User) {
    return this.service.create(body, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: '（管理员）修改分类名称或排序' })
  update(@Param('id', ParseIntPipe) id: number, @Body() body: { name?: string; sortOrder?: number }, @CurrentUser() user: User) {
    return this.service.update(id, body, user);
  }

  @Get(':id/impact')
  @ApiOperation({ summary: '删除前的影响：关联模板、订单' })
  impact(@Param('id', ParseIntPipe) id: number) {
    return this.service.impact(id);
  }

  @Post(':id/transfer')
  @ApiOperation({ summary: '（管理员）把分类下的模板转移到其他分类' })
  transfer(@Param('id', ParseIntPipe) id: number, @Body() body: { targetCode: string; templateIds?: number[] }, @CurrentUser() user: User) {
    return this.service.transfer(id, body, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: '（管理员）删除分类：分类下没有模板时才能删除，不连带删除模板或订单' })
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.service.remove(id, user);
  }
}
