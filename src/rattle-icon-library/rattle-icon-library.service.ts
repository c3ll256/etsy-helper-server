import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
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

    const where = currentUser.isAdmin
      ? {
          isActive: true,
          ...(query.search ? { name: ILike(`%${query.search}%`) } : {}),
        }
      : {
          userId: currentUser.id as string,
          isActive: true,
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
}
