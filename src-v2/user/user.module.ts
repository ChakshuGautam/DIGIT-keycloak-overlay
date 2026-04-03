import { Module } from "@nestjs/common";
import { DigitClientService } from "./digit-client.service";
import { UserResolverService } from "./user-resolver.service";

@Module({
  providers: [DigitClientService, UserResolverService],
  exports: [DigitClientService, UserResolverService],
})
export class UserModule {}
