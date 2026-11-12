import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  @IsString()
  @MaxLength(200)
  model?: string;

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
