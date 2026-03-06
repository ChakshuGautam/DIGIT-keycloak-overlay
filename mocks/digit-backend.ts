import express from "express";

export function createDigitBackendMock() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Echo back the RequestInfo and path for verification
  app.all("*", (req, res) => {
    res.json({
      echo: true,
      path: req.path,
      method: req.method,
      receivedRequestInfo: req.body?.RequestInfo || null,
      receivedBody: req.body || null,
      headers: {
        authorization: req.headers.authorization || null,
        "content-type": req.headers["content-type"] || null,
      },
      query: req.query,
    });
  });

  return app;
}
