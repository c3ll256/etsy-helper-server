import { PartialType } from '@nestjs/swagger';
import { CreateStampTemplateDto } from './create-stamp-template.dto';

export class UpdateStampTemplateDto extends PartialType(CreateStampTemplateDto) {} 