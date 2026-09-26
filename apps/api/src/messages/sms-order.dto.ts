import { ArrayMinSize, ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class SmsOrderDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  partIds!: string[];
}
