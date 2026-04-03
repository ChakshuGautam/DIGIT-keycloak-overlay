import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "../auth/jwt.service";
import { UserResolverService } from "../user/user-resolver.service";
import { CacheService } from "../cache/cache.service";

@Controller("auth")
export class LoginController {
  private readonly logger = new Logger(LoginController.name);
  private readonly kcInternalUrl: string;
  private readonly kcRealm: string;
  private readonly bffClientId: string;
  private readonly bffClientSecret: string;
  private readonly kcAdminUrl: string;
  private readonly adminClientId: string;
  private readonly adminClientSecret: string;
  private readonly defaultTenant: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly userResolver: UserResolverService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {
    this.kcInternalUrl =
      this.config.get<string>("KEYCLOAK_INTERNAL_URL") ?? "http://keycloak:8080";
    this.kcRealm = this.config.get<string>("KEYCLOAK_USER_REALM") ?? "digit-sandbox";
    this.bffClientId =
      this.config.get<string>("KEYCLOAK_BFF_CLIENT_ID") ?? "bff-login";
    this.bffClientSecret =
      this.config.get<string>("KEYCLOAK_BFF_CLIENT_SECRET") ?? "";
    this.kcAdminUrl =
      this.config.get<string>("KEYCLOAK_ADMIN_URL") ?? this.kcInternalUrl;
    this.adminClientId =
      this.config.get<string>("KEYCLOAK_ADMIN_CLIENT_ID") ?? "admin-cli";
    this.adminClientSecret =
      this.config.get<string>("KEYCLOAK_ADMIN_CLIENT_SECRET") ?? "";
    this.defaultTenant =
      this.config.get<string>("DIGIT_DEFAULT_TENANT") ?? "pg.citya";
  }

  @Post("login")
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async login(
    @Body() body: { email: string; password: string; tenantId?: string },
  ): Promise<any> {
    const { email, password, tenantId } = body;

    if (!email || !password) {
      throw new HttpException(
        { error: "email and password are required" },
        HttpStatus.BAD_REQUEST,
      );
    }

    // ROPC token request to KC
    const tokenUrl = `${this.kcInternalUrl}/realms/${this.kcRealm}/protocol/openid-connect/token`;
    const params = new URLSearchParams({
      grant_type: "password",
      client_id: this.bffClientId,
      client_secret: this.bffClientSecret,
      username: email,
      password,
      scope: "openid",
    });

    const kcResp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const kcData = await kcResp.json();

    if (!kcResp.ok) {
      throw new HttpException(
        {
          error: kcData.error || "authentication_failed",
          message: kcData.error_description || "Invalid credentials",
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Validate the returned JWT
    const claims = await this.jwt.validate(`Bearer ${kcData.access_token}`);
    if (!claims) {
      throw new HttpException(
        { error: "jwt_validation_failed", message: "Could not validate KC token" },
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Resolve DIGIT user
    const effectiveTenant = tenantId || this.defaultTenant;
    const { user } = await this.userResolver.resolve(claims, effectiveTenant);

    // Return response WITHOUT refresh_token
    return {
      access_token: kcData.access_token,
      id_token: kcData.id_token,
      expires_in: kcData.expires_in,
      digit_user_type: user.type,
      digit_roles: user.roles,
      digit_tenant_id: user.tenantId,
      digit_user_name: user.userName,
      digit_uuid: user.uuid,
    };
  }

  @Post("register")
  async register(
    @Body() body: { email: string; password: string; name: string },
  ): Promise<any> {
    const { email, password, name } = body;

    if (!email || !password || !name) {
      throw new HttpException(
        { error: "email, password, and name are required" },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Get admin token
    const adminToken = await this.getAdminToken();

    // Create KC user
    const createUrl = `${this.kcAdminUrl}/admin/realms/${this.kcRealm}/users`;
    const createResp = await fetch(createUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        email,
        username: email,
        firstName: name,
        enabled: true,
        emailVerified: true,
        credentials: [
          {
            type: "password",
            value: password,
            temporary: false,
          },
        ],
      }),
    });

    if (!createResp.ok) {
      const errData = await createResp.json().catch(() => ({}));
      throw new HttpException(
        {
          error: "registration_failed",
          message: (errData as any).errorMessage || "Could not create user",
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    return { success: true, email };
  }

  @Get("check-email")
  async checkEmail(@Query("email") email: string): Promise<any> {
    if (!email) {
      throw new HttpException(
        { error: "email query parameter is required" },
        HttpStatus.BAD_REQUEST,
      );
    }

    const adminToken = await this.getAdminToken();

    const searchUrl = `${this.kcAdminUrl}/admin/realms/${this.kcRealm}/users?email=${encodeURIComponent(email)}&exact=true`;
    const searchResp = await fetch(searchUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });

    if (!searchResp.ok) {
      throw new HttpException(
        { error: "search_failed" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const users = await searchResp.json();
    return { exists: Array.isArray(users) && users.length > 0 };
  }

  private async getAdminToken(): Promise<string> {
    const tokenUrl = `${this.kcAdminUrl}/realms/master/protocol/openid-connect/token`;
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.adminClientId,
      client_secret: this.adminClientSecret,
    });

    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!resp.ok) {
      throw new HttpException(
        { error: "admin_auth_failed" },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const data = await resp.json();
    return data.access_token;
  }
}
