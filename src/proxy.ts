import type { Request, Response } from "express";
import type { DigitUser } from "./types.js";

export async function proxyRequest(
  req: Request,
  res: Response,
  digitUser: DigitUser,
  citizenToken: string,
  gatewayUrl: string,
): Promise<void> {
  // Preserve query string from original request
  const queryString = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
    : "";
  const upstreamUrl = `${gatewayUrl}${req.path}${queryString}`;

  const contentType = req.headers["content-type"] || "";

  try {
    if (contentType.includes("application/json")) {
      // JSON: rewrite RequestInfo in body
      const body = req.body || {};
      body.RequestInfo = body.RequestInfo || {};
      body.RequestInfo.authToken = citizenToken;
      body.RequestInfo.userInfo = digitUser;

      const upstreamResp = await fetch(upstreamUrl, {
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
      const url = new URL(upstreamUrl);
      url.searchParams.set("auth-token", citizenToken);

      const upstreamResp = await fetch(url.toString(), {
        method: req.method,
        headers: {
          "Content-Type": req.headers["content-type"]!,
          "Content-Length": req.headers["content-length"] || "",
        },
        body: req as any,
        // @ts-expect-error duplex is valid in Node.js fetch but not in @types/node
        duplex: "half",
      });

      res.status(upstreamResp.status);
      const ct = upstreamResp.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const responseBody = await upstreamResp.text();
      res.send(responseBody);
    } else {
      // Unknown content type: pass-through with auth header
      const upstreamResp = await fetch(upstreamUrl, {
        method: req.method,
        headers: {
          ...Object.fromEntries(
            Object.entries(req.headers).filter(
              ([k]) => !["host", "connection"].includes(k),
            ),
          ) as Record<string, string>,
          Authorization: `Bearer ${citizenToken}`,
        },
        body: ["GET", "HEAD"].includes(req.method)
          ? undefined
          : (req as any),
        // @ts-expect-error duplex is valid in Node.js fetch but not in @types/node
        duplex: "half",
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

/**
 * Forward a request to the DIGIT gateway unchanged (no token rewriting).
 * Used for requests without a Keycloak JWT (existing DIGIT auth).
 */
export async function forwardToGateway(
  req: Request,
  res: Response,
  gatewayUrl: string,
): Promise<void> {
  const queryString = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
    : "";
  const upstreamUrl = `${gatewayUrl}${req.path}${queryString}`;

  try {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!["host", "connection"].includes(k) && typeof v === "string") {
        headers[k] = v;
      }
    }

    // Express json() middleware already consumed the body stream.
    // Re-serialize if body was parsed; otherwise use undefined for bodyless methods.
    const contentType = req.headers["content-type"] || "";
    let body: string | undefined;
    if (!["GET", "HEAD"].includes(req.method)) {
      if (contentType.includes("application/json") && req.body) {
        body = JSON.stringify(req.body);
      }
      // For non-JSON bodies (multipart, form-urlencoded), express.json() doesn't
      // consume the stream, but in practice non-KC requests are typically JSON.
    }

    const upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
    });

    res.status(upstreamResp.status);
    const ct = upstreamResp.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    const responseBody = await upstreamResp.text();
    res.send(responseBody);
  } catch (err) {
    console.error("Gateway forward error:", err);
    res.status(502).json({ error: "Bad gateway", details: String(err) });
  }
}
