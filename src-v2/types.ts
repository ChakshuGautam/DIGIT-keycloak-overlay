export interface JwtClaims {
  sub: string;
  email: string;
  name?: string;
  preferred_username?: string;
  phone_number?: string;
  email_verified?: boolean;
  realm: string;
  roles: string[];
  groups?: string[];
}

export interface DigitUser {
  uuid: string;
  userName: string;
  name: string;
  emailId: string;
  mobileNumber: string;
  tenantId: string;
  type: string;
  roles: Array<{ code: string; name: string; tenantId?: string }>;
  active?: boolean;
}

export interface CachedSession {
  user: DigitUser;
  password: string;
  cachedAt: number;
  token?: string;
  tokenExpiry?: number;
}
