import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { ListTransactionsQueryDto } from './list-transactions-query.dto';

export class TransactionFeedQueryDto extends PickType(ListTransactionsQueryDto, ['limit', 'type', 'from', 'to'] as const) {
  @ApiPropertyOptional({ format: 'uuid', description: 'ID returned as nextCursor. Omit for the first page; keep account and filters unchanged. No exact total is returned.' })
  @IsOptional()
  @IsUUID('4')
  cursor?: string;
}
