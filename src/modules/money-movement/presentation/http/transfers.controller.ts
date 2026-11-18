import { successResponse, errorResponse } from '@src/common/http/swagger/response.schemas';
import { transferResponseSchema } from './dto/money-movement-response.schema';
import { 
  Body, 
  Controller, 
  Post, 
  Headers, 
  Res, 
  HttpStatus, 
  BadRequestException 
} from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags, ApiHeader } from '@nestjs/swagger';
import { CurrentUser } from '../../../../common/security/decorators';
import { AccessTokenPayload } from '../../../../common/security/ports';
import { TransferMoneyDto } from './dto/transfer-money.dto';
import { TransferMoneyUseCase } from '../../application/use-cases/transfer-money.use-case';
import { TransferAdmission } from '../../infrastructure/transfer-admission';

@ApiTags('Money Movement')
@ApiBearerAuth('access-token')
@ApiResponse(errorResponse(400, 'VALIDATION_ERROR: dữ liệu đầu vào không hợp lệ.'))
@ApiResponse(errorResponse(500, 'INTERNAL_ERROR: lỗi nội bộ hệ thống.'))
@ApiResponse(errorResponse(401, 'UNAUTHORIZED: thiếu hoặc không chấp nhận access token.'))
@Controller('transfers')
export class TransfersController {
  constructor(
    private readonly transferMoneyUseCase: TransferMoneyUseCase,
    private readonly admission: TransferAdmission,
  ) {}

  @ApiOperation({ summary: 'Transfer money between two accounts (UC-08)' })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'Khóa không rỗng do client tạo; được trim và dùng cùng tài khoản nguồn để nhận lại kết quả giao dịch trước đó. Khi thử lại, gửi cùng khóa và payload.',
    required: true,
    schema: { type: 'string', minLength: 16, maxLength: 128, example: 'transfer-20261020-001' },
  })
  @ApiResponse(successResponse(201, 'Transfer successfully created', transferResponseSchema))
  @ApiResponse(successResponse(200, 'Replay of existing transfer with identical Idempotency-Key', transferResponseSchema))
  @ApiResponse(errorResponse(400, 'VALIDATION_ERROR, SAME_ACCOUNT_TRANSFER hoặc HTTP_ERROR khi thiếu Idempotency-Key'))
  @ApiResponse(errorResponse(404, 'ACCOUNT_NOT_FOUND: Source or destination account not found'))
  @ApiResponse(errorResponse(409, 'INSUFFICIENT_FUNDS, ACCOUNT_NOT_ACTIVE hoặc IDEMPOTENCY_KEY_REUSED khi cùng khóa nhưng khác payload'))
  @ApiResponse(errorResponse(503, 'TRANSFER_OVERLOADED hoặc TRANSACTION_BUSY. Thử lại với cùng Idempotency-Key.'))
  @Post()
  async transfer(
    @Body() dto: TransferMoneyDto,
    @CurrentUser() user: AccessTokenPayload,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length < 16 || idempotencyKey.trim().length > 128) {
      throw new BadRequestException('Idempotency-Key header must be between 16 and 128 characters');
    }

    const disconnected = new AbortController();
    const onClose = () => disconnected.abort(new Error('Client disconnected before admission'));
    res.once('close', onClose);
    const command = {
      ...dto,
      initiatedByUserId: user.sub,
      idempotencyKey: idempotencyKey.trim(),
    };
    let result;
    try {
      result = await this.admission.run(dto.sourceAccountId, dto.destinationAccountNumber,
        () => this.transferMoneyUseCase.execute(command), disconnected.signal);
    } finally {
      res.off('close', onClose);
    }

    if (result.isReplay) {
      res.status(HttpStatus.OK);
    } else {
      res.status(HttpStatus.CREATED);
    }

    return result.transfer;
  }
}
