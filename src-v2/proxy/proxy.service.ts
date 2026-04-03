import { Injectable } from "@nestjs/common";
import { initRoutes, resolveUpstream } from "../routes";
import type { DigitUser } from "../types";

@Injectable()
export class ProxyService {
  constructor() {
    initRoutes(process.env.UPSTREAM_SERVICES);
  }

  rewriteRequestInfo(body: any, user: DigitUser, token: string): any {
    body.RequestInfo = body.RequestInfo || {};
    body.RequestInfo.authToken = token;
    body.RequestInfo.userInfo = {
      uuid: user.uuid,
      userName: user.userName,
      name: user.name,
      emailId: user.emailId,
      mobileNumber: user.mobileNumber,
      tenantId: user.tenantId,
      type: user.type,
      roles: user.roles,
    };
    return body;
  }

  resolveUpstreamUrl(path: string): string | null {
    return resolveUpstream(path);
  }

  appendAuthParam(url: string, token: string): string {
    const u = new URL(url);
    u.searchParams.set("auth-token", token);
    return u.toString();
  }

  async forward(
    method: string,
    upstreamUrl: string,
    headers: Record<string, string>,
    body?: any,
  ): Promise<{ status: number; headers: Record<string, string>; body: any }> {
    const serialized = body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined;
    if (serialized && upstreamUrl.includes("pgr-services")) {
      console.log(`[PROXY-DEBUG] Sending to ${upstreamUrl}:\n${serialized.substring(0, 500)}`);
    }
    const resp = await fetch(upstreamUrl, {
      method,
      headers,
      body: body
        ? typeof body === "string"
          ? body
          : JSON.stringify(body)
        : undefined,
    });
    const responseBody = await resp.text();
    const responseHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });
    return { status: resp.status, headers: responseHeaders, body: responseBody };
  }
}
