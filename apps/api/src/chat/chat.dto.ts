import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  ArrayUnique,
  IsUUID,
  IsIn,
  IsInt,
  Min,
  Max,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class ChatInputDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @IsNotEmpty()
  @MaxLength(100000)
  content!: string;
}

class AvailableAssetDto {
  @IsUUID()
  id!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsString()
  @MaxLength(100)
  mimeType!: string;

  @IsInt()
  @Min(1)
  @Max(64_000_000)
  size!: number;
}

export class ChatRequestDto {
  @IsOptional()
  @IsBoolean()
  programPrivateHistory?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AvailableAssetDto)
  availableAssets?: AvailableAssetDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  attachmentIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  expectedRevision?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  requestId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  assistantMessageId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(41)
  @ValidateNested({ each: true })
  @Type(() => ChatInputDto)
  messages!: ChatInputDto[];
}

export class AttachmentMetadataDto {
  @IsString() @MaxLength(4096) metadata!: string;
}
