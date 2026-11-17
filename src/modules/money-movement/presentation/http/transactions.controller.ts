import { successResponse, errorResponse, objectSchema, uuidSchema } from '@src/common/http/swagger/response.schemas';
import { GetTransactionFeedUseCase } from '../../application/use-cases/get-transaction-feed.use-case';
import { TransactionFeedQueryDto } from './dto/transaction-feed-query.dto';
import { transactionResponseSchema } from './dto/money-movement-response.schema';
import { 
  Body, 
  Controller, 
  Get, 
  HttpCode, 
  HttpStatus, 
  Param, 
  Post, 
  Query,
  ParseUUIDPipe,
  Headers,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags, ApiParam, ApiHeader } from '@nestjs/swagger';
import type { Response } from 'express';
import { Paginated } from '../../../../common/http/interceptors/response-envelope.interceptor';
import { CurrentUser } from '../../../../common/security/decorators';
import { AccessTokenPayload } from '../../../../common/security/ports';
import { CreateTransactionDto, TransactionTypeDto } from './dto/create-transaction.dto';
import { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';
import { DepositMoneyUseCase } from '../../application/use-cases/deposit-money.use-case';
import { WithdrawMoneyUseCase } from '../../application/use-cases/withdraw-money.use-case';
import { GetTransactionHistoryUseCase } from '../../application/use-cases/get-transaction-history.use-case';

@ApiTags('Money Movement')
@ApiBearerAuth('access-token')
@ApiResponse(errorResponse(400, 'VALIDATION_ERROR: dữ liệu đầu vào không hợp lệ.'))
@ApiResponse(errorResponse(500, 'INTERNAL_ERROR: lỗi nội bộ hệ thống.'))
@ApiResponse(errorResponse(401, 'UNAUTHORIZED: thiếu hoặc không chấp nhận access token.'))
@Controller('accounts') 
export class TransactionController {
  constructor(
    private readonly depositMoneyUseCase: DepositMoneyUseCase,
    private readonly withdrawMoneyUseCase: WithdrawMoneyUseCase,
    private readonly getTransactionHistoryUseCase: GetTransactionHistoryUseCase,
    private readonly getTransactionFeedUseCase: GetTransactionFeedUseCase,
  ) {}

  @Get(':accountId/transactions/feed')
  @ApiOperation({ summary: 'Browse history using an indexed cursor (no OFFSET or total count)' })
  @ApiParam({ name: 'accountId', format: 'uuid' })
  @ApiResponse(successResponse(200, 'History page, with a cursor for the next page', objectSchema({
    items: { type: 'array', items: transactionResponseSchema },
    nextCursor: { ...uuidSchema, nullable: true },
    hasMore: { type: 'boolean' },
  })))
  @ApiResponse(errorResponse(404, 'ACCOUNT_NOT_FOUND: account is not owned by authenticated user'))
  async getTransactionFeed(
    @Param('accountId', new ParseUUIDPipe({ version: '4' })) accountId: string,
    @Query() query: TransactionFeedQueryDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.getTransactionFeedUseCase.execute({
      accountId, userId: user.sub, limit: query.limit ?? 20,
      cursor: query.cursor, type: query.type,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @ApiOperation({ summary: 'Create a deposit or withdrawal transaction (UC-05, UC-06)' })
  @ApiHeader({
    name: 'Idempotency-Key', required: false,
    description: 'Tùy chọn, trim 16–128 ký tự. Cùng tài khoản/key/nội dung trả lại bút toán cũ (200); khác loại, số tiền hoặc mô tả trả 409. Bỏ header: mỗi request là giao dịch mới.',
    schema: { type: 'string', minLength: 16, maxLength: 128 },
  })
  @ApiResponse(successResponse(201, 'Transaction executed successfully', transactionResponseSchema))
  @ApiResponse(successResponse(200, 'Replay of an identical completed deposit or withdrawal', transactionResponseSchema))
  @ApiResponse(errorResponse(400, 'VALIDATION_ERROR: Invalid amount or transaction type'))
  @ApiResponse(errorResponse(404, 'ACCOUNT_NOT_FOUND: Account not found or not owned by user'))
  @ApiResponse(errorResponse(409, 'INSUFFICIENT_FUNDS, ACCOUNT_NOT_ACTIVE hoặc IDEMPOTENCY_KEY_REUSED'))
  @ApiResponse(errorResponse(503, 'TRANSACTION_BUSY: transaction đã rollback nhưng vẫn bận sau một lần thử lại'))
  @ApiParam({ name: 'accountId', description: 'UUID of the bank account', format: 'uuid' })
  @Post(':accountId/transactions')
  @HttpCode(HttpStatus.CREATED)
  async createTransaction(
    @Param('accountId', new ParseUUIDPipe({ version: '4' })) accountId: string,  
    @Body() dto: CreateTransactionDto,
    @CurrentUser() user: AccessTokenPayload,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const command = { accountId, userId: user.sub, amount: dto.amount,
      description: dto.description, idempotencyKey };
    const result = dto.type === TransactionTypeDto.CREDIT
      ? await this.depositMoneyUseCase.executeWithResult(command)
      : await this.withdrawMoneyUseCase.executeWithResult(command);
    res.status(result.isReplay ? HttpStatus.OK : HttpStatus.CREATED);
    return result.transaction;
  }

  @ApiOperation({ summary: 'Get paginated transaction history with filters (UC-06)' })
  @ApiParam({ name: 'accountId', description: 'UUID of the bank account', format: 'uuid' })
  @ApiResponse(successResponse(200, 'Paginated list of transactions', transactionResponseSchema, true))
  @ApiResponse(errorResponse(404, 'ACCOUNT_NOT_FOUND: Account not found or not owned by authenticated user'))
  @Get(':accountId/transactions')
  async getTransactions(
    @Param('accountId', new ParseUUIDPipe({ version: '4' })) accountId: string,
    @Query() query: ListTransactionsQueryDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    const result = await this.getTransactionHistoryUseCase.execute({
      accountId,
      userId: user.sub,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      type: query.type,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });

    return new Paginated(
      result.items,
      result.page,
      result.limit,
      result.total,
    );
  }
}
