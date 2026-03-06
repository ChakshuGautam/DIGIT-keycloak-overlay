import type { Request, Response } from "express";
import { resolveUpstream } from "./routes.js";
import { getSystemToken } from "./digit-client.js";
import type { DigitUser } from "./types.js";

export async function proxyRequest(
  req: Request,
  res: Response,
  digitUser: DigitUser,
): Promise<void> {
  const upstream = resolveUpstream(req.path);
  if (!upstream) {
    res.status(404).json({ error: "No upstream service for path", path: req.path });
    return;
  }

  const contentType = req.headers["content-type"] || "";
  const systemToken = getSystemToken();

  try {
    if (contentType.includes("application/json")) {
      // JSON: rewrite RequestInfo in body
      const body = req.body || {};
      body.RequestInfo = body.RequestInfo || {};
      body.RequestInfo.authToken = systemToken;
      body.RequestInfo.userInfo = digitUser;

      const upstreamResp = await fetch(upstream, {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      res.status(upstreamResp.status);
      const ct = upstreamResp.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const responseBody = await upstreamResp.text();
      res.send(responseBody);
    } else if (contentType.includes("multipart/form-data")) {
      // Multipart: stream body, pass token via query param
      const url = new URL(upstream);
      url.searchParams.set("auth-token", systemToken);

      const upstreamResp = await fetch(url.toString(), {
        method: req.method,
        headers: {
          "Content-Type": req.headers["content-type"]!,
          "Content-Length": req.headers["content-length"] || "",
        },
        body: req as any,
        duplex: "half" as any,
      });

      res.status(upstreamResp.status);
      const ct = upstreamResp.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const responseBody = await upstreamResp.text();
      res.send(responseBody);
    } else {
      // Unknown content type: pass-through with auth header
      const upstreamResp = await fetch(upstream, {
        method: req.method,
        headers: {
          ...Object.fromEntries(
            Object.entries(req.headers).filter(
              ([k]) => !["host", "connection"].includes(k),
            ),
          ) as Record<string, string>,
          Authorization: `Bearer ${systemToken}`,
        },
        body: ["GET", "HEAD"].includes(req.method)
          ? undefined
          : (req as any),
        duplex: "half" as any,
      });

      res.status(upstreamResp.status);
      const ct = upstreamResp.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const responseBody = await upstreamResp.text();
      res.send(responseBody);
    }
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(502).json({ error: "Bad gateway", details: String(err) });
  }
}
