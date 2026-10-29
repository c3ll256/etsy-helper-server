import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, IsNull, Repository } from 'typeorm';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { User } from '../users/entities/user.entity';
import { QueryRattleIconsDto } from './dto/query-rattle-icons.dto';
import { RattleIconAsset } from './entities/rattle-icon-asset.entity';

@Injectable()
export class RattleIconLibraryService {
  constructor(
    @InjectRepository(RattleIconAsset)
    private readonly rattleIconAssetRepository: Repository<RattleIconAsset>,
  ) {}

  async list(
    query: QueryRattleIconsDto,
    currentUser: User,
  ): Promise<PaginatedResponse<RattleIconAsset>> {
    const page = query.page && query.page > 0 ? Number(query.page) : 1;
    const limit = query.limit && query.limit > 0 ? Number(query.limit) : 20;
    const skip = (page - 1) * limit;

    const groupFilter = query.groupCode ? { groupCode: query.groupCode === '__none' ? IsNull() : query.groupCode.toUpperCase() } : {};
    const where = currentUser.isAdmin
      ? {
          isActive: true,
          ...groupFilter,
          ...(query.search ? { name: ILike(`%${query.search}%`) } : {}),
        }
      : {
          userId: currentUser.id as string,
          isActive: true,
          ...groupFilter,
          ...(query.search ? { name: ILike(`%${query.search}%`) } : {}),
        };

    const [items, total] = await this.rattleIconAssetRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return {
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async createAsset(data: {
    userId: string;
    name: string;
    filePath: string;
    mimeType: string;
    width?: number | null;
    height?: number | null;
  }): Promise<RattleIconAsset> {
    const asset = this.rattleIconAssetRepository.create({
      userId: data.userId,
      name: data.name,
      filePath: data.filePath,
      mimeType: data.mimeType,
      width: data.width ?? null,
      height: data.height ?? null,
      isActive: true,
    });

    return this.rattleIconAssetRepository.save(asset);
  }

  async remove(id: number, currentUser: User): Promise<void> {
    const asset = await this.rattleIconAssetRepository.findOne({
      where: { id, isActive: true },
    });

    if (!asset) {
      throw new NotFoundException(`Rattle icon asset with ID ${id} not found`);
    }

    if (!currentUser.isAdmin && asset.userId !== currentUser.id) {
      throw new ForbiddenException('You do not have permission to delete this icon asset');
    }

    asset.isActive = false;
    await this.rattleIconAssetRepository.save(asset);
  }

  async rename(id: number, name: string, currentUser: User): Promise<RattleIconAsset> {
    const asset = await this.rattleIconAssetRepository.findOne({
      where: { id, isActive: true },
    });

    if (!asset) {
      throw new NotFoundException(`Rattle icon asset with ID ${id} not found`);
    }

    if (!currentUser.isAdmin && asset.userId !== currentUser.id) {
      throw new ForbiddenException('You do not have permission to update this icon asset');
    }

    asset.name = name.trim();
    return this.rattleIconAssetRepository.save(asset);
  }

  private normalizeCode(value?: string | null): string | null {
    const code = String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
    return code || null;
  }

  private async assertCodeFree(code: string, exceptId?: number) {
    const existing = await this.rattleIconAssetRepository
      .createQueryBuilder('asset')
      .where('UPPER(asset.code) = :code', { code })
      .andWhere('asset.isActive = true')
      .getOne();
    if (existing && existing.id !== exceptId) {
      throw new BadRequestException(`编号 ${code} 已被图标「${existing.name}」使用`);
    }
  }

  /** 设置图标的分组和完整编号（编号须以分组开头，如 A 组的 A1） */
  async setCode(id: number, body: { groupCode?: string | null; code?: string | null }, currentUser: User): Promise<RattleIconAsset> {
    const asset = await this.rattleIconAssetRepository.findOne({ where: { id, isActive: true } });
    if (!asset) throw new NotFoundException(`Rattle icon asset with ID ${id} not found`);
    if (!currentUser.isAdmin && asset.userId !== currentUser.id) {
      throw new ForbiddenException('You do not have permission to update this icon asset');
    }
    const groupCode = this.normalizeCode(body.groupCode);
    const code = this.normalizeCode(body.code);
    if (code && groupCode && !code.startsWith(groupCode)) {
      throw new BadRequestException(`编号 ${code} 必须以图标组 ${groupCode} 开头`);
    }
    if (code && !/^[A-Z]{1,3}\d{1,3}$/.test(code)) {
      throw new BadRequestException('编号格式应为字母 + 数字，如 A1、C10');
    }
    if (code) await this.assertCodeFree(code, id);
    asset.groupCode = groupCode;
    asset.code = code;
    return this.rattleIconAssetRepository.save(asset);
  }

  /**
   * 批量分组：把选中的图标归到某个图标组；名称是纯数字的（如 "3"）自动编号为 组 + 数字（A3）。
   * 名称不是数字的只设置分组，编号需要单独填写。
   */
  async assignGroup(ids: number[], groupCodeRaw: string, currentUser: User) {
    const groupCode = this.normalizeCode(groupCodeRaw);
    if (!groupCode || !/^[A-Z]{1,3}$/.test(groupCode)) throw new BadRequestException('图标组应为 1-3 个字母，如 A、C');
    const assets = await this.rattleIconAssetRepository.find({ where: { id: In(ids || []), isActive: true } });
    const results: Array<{ id: number; name: string; code: string | null; note?: string }> = [];
    for (const asset of assets) {
      if (!currentUser.isAdmin && asset.userId !== currentUser.id) continue;
      asset.groupCode = groupCode;
      const number = asset.name.trim().match(/^\d{1,3}$/) ? asset.name.trim() : null;
      let note: string | undefined;
      if (number) {
        const code = `${groupCode}${Number(number)}`;
        try {
          await this.assertCodeFree(code, asset.id);
          asset.code = code;
        } catch (error) {
          note = error.message;
        }
      } else {
        note = '名称不是数字，未自动编号';
      }
      await this.rattleIconAssetRepository.save(asset);
      results.push({ id: asset.id, name: asset.name, code: asset.code, note });
    }
    return { groupCode, updated: results.length, results };
  }

  /**
   * 核对图标组素材：按资料里的编号区间（如 A1-A13）列出每个编号是否有素材、是否重复，
   * 以及组内不在区间里的编号。不因为编号在区间内就假定素材存在。
   */
  async checkGroup(groupCodeRaw: string, from: number, to: number) {
    const groupCode = this.normalizeCode(groupCodeRaw);
    if (!groupCode) throw new BadRequestException('请指定图标组');
    const assets = await this.rattleIconAssetRepository.find({ where: { groupCode, isActive: true } });
    const byCode = new Map<string, RattleIconAsset[]>();
    for (const asset of assets) {
      if (!asset.code) continue;
      const list = byCode.get(asset.code.toUpperCase()) || [];
      list.push(asset);
      byCode.set(asset.code.toUpperCase(), list);
    }
    const expected = [];
    for (let i = from; i <= to; i++) {
      const code = `${groupCode}${i}`;
      const found = byCode.get(code) || [];
      expected.push({
        code,
        status: found.length === 0 ? 'missing' : 'ok',
        asset: found[0] ? { id: found[0].id, name: found[0].name, filePath: found[0].filePath } : null,
      });
    }
    const inRange = new Set(expected.map(item => item.code));
    const extra = assets
      .filter(asset => asset.code && !inRange.has(asset.code.toUpperCase()))
      .map(asset => ({ id: asset.id, name: asset.name, code: asset.code }));
    const uncoded = assets.filter(asset => !asset.code).map(asset => ({ id: asset.id, name: asset.name }));
    return {
      groupCode,
      range: `${groupCode}${from}-${groupCode}${to}`,
      missing: expected.filter(item => item.status === 'missing').map(item => item.code),
      expected,
      extra,
      uncoded,
    };
  }
}
