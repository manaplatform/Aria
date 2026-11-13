import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ArrayUnique,
  IsUUID,
  IsIn,
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

export class ChatRequestDto {
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
