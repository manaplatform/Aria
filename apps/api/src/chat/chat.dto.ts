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
  IsObject,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { ManagedExecution, UserPersonalization } from '@aria/shared';

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

class AvailableProjectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  branch!: string | null;
}

class MemoryContextHintDto {
  @IsUUID()
  id!: string;

  @IsIn(['profile', 'project', 'conversation'])
  scope!: 'profile' | 'project' | 'conversation';

  @IsIn(['episode', 'fact', 'preference', 'procedure', 'project', 'task'])
  category!: 'episode' | 'fact' | 'preference' | 'procedure' | 'project' | 'task';

  @IsString()
  @MaxLength(300)
  content!: string;

  @IsIn(['confirmed', 'inferred'])
  confirmation!: 'confirmed' | 'inferred';

  @IsInt()
  @Min(0)
  observedAt!: number;
}

class MemoryTurnDto {
  @IsBoolean()
  enabled!: boolean;

  @IsBoolean()
  suggestions!: boolean;

  @IsOptional()
  @IsBoolean()
  temporary?: boolean;

  @IsOptional()
  @IsBoolean()
  privateHistory?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2400)
  workingSummary?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => MemoryContextHintDto)
  contextHints?: MemoryContextHintDto[];
}

class PersonalizationDto implements UserPersonalization {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  profileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  profileBio?: string;

  @IsOptional()
  @IsIn(['balanced', 'concise', 'detailed'])
  responseStyle?: 'balanced' | 'concise' | 'detailed';

  @IsOptional()
  @IsString()
  @MaxLength(60)
  communicationLanguage?: string;
}

export class ChatRequestDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => PersonalizationDto)
  personalization?: PersonalizationDto;

  @IsOptional()
  @IsObject()
  execution?: ManagedExecution;

  @IsOptional()
  @IsBoolean()
  programPrivateHistory?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  activeProjectId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AvailableProjectDto)
  availableProjects?: AvailableProjectDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => MemoryTurnDto)
  memory?: MemoryTurnDto;

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
