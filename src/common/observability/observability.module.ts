import { Global, Module } from "@nestjs/common";
import { LoggerService } from "./logger.service";
import { MoneyMovementTelemetry } from './money-movement-telemetry';

@Global()
@Module({
  providers: [LoggerService, MoneyMovementTelemetry],
  exports: [LoggerService, MoneyMovementTelemetry],
})
export class ObservabilityModule {}
