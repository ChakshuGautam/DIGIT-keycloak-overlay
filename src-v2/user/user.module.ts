import { Module, Global } from "@nestjs/common";
import { DigitClientService } from "./digit-client.service";
import { UserResolverService } from "./user-resolver.service";

@Global()
@Module({
  providers: [DigitClientService, UserResolverService],
  exports: [DigitClientService, UserResolverService],
})
export class UserModule {}
