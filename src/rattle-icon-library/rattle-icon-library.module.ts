import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RattleIconAsset } from './entities/rattle-icon-asset.entity';
import { RattleIconLibraryController } from './rattle-icon-library.controller';
import { RattleIconLibraryService } from './rattle-icon-library.service';

@Module({
  imports: [TypeOrmModule.forFeature([RattleIconAsset])],
  controllers: [RattleIconLibraryController],
  providers: [RattleIconLibraryService],
  exports: [RattleIconLibraryService],
})
export class RattleIconLibraryModule {}
