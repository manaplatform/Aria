import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBase64,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ChatInputDto } from '../chat/chat.dto';
export class VoiceStartDto {
  @IsIn(['start']) type!: 'start';
  @IsString() @MinLength(1) @MaxLength(200) model!: string;
  @IsString() @MinLength(1) @MaxLength(200) chatModel!: string;
  @IsIn(['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'])
  voice!: string;
  @IsArray()
  @ArrayMaxSize(41)
  @ValidateNested({ each: true })
  @Type(() => ChatInputDto)
  messages!: ChatInputDto[];
}
export class VoiceControlDto {
  @IsIn(['audio', 'mute', 'end']) type!: 'audio' | 'mute' | 'end';
  @IsOptional() @IsBase64() @MaxLength(64000) audio?: string;
  @IsOptional() @IsBoolean() muted?: boolean;
}
