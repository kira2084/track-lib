const axios = require("axios");

function trackMiddleware({ trackingUrl = "http://localhost:3000", apiKey }) {
  if (!apiKey) throw new Error("API Key required");

  const validApiKeys = [
    "9FrsPB3OQIZYP2h2qzF8UF",
    "435RqYOT1Jnc4C35VQGzRx",
    "hardcoded-test-key",
  ];

  if (!validApiKeys.includes(apiKey)) {
    throw new Error("Invalid API Key");
  }

  // --- Global console patch ---
  const originalConsole = {};
  const consoleMethods = Object.keys(console).filter(
    (k) => typeof console[k] === "function"
  );
  consoleMethods.forEach((method) => {
    originalConsole[method] = console[method];
    console[method] = function (...args) {
      if (global.activeRequests) {
        global.activeRequests.forEach((reqEvent) => {
          reqEvent.consoleLogs.push({
            level: method,
            message: args
              .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
              .join(" "),
            timestamp: new Date(),
          });
        });
      }
      originalConsole[method](...args);
    };
  });

  // --- Axios interceptors for external calls ---
  const TRACK_ENDPOINT = `${trackingUrl}/api/track`;
  axios.interceptors.request.use((cfg) => {
    cfg.metadata = { start: Date.now() };
    return cfg;
  });

  axios.interceptors.response.use(
    (res) => {
      if (!res.config.url.includes(TRACK_ENDPOINT) && global.activeRequests) {
        global.activeRequests.forEach((reqEvent) => {
          reqEvent.externalCalls.push({
            method: res.config.method,
            url: res.config.url,
            status: res.status,
            durationMs: Date.now() - res.config.metadata.start,
            response: res.data,
            timestamp: new Date(),
          });
        });
      }
      return res;
    },
    (err) => {
      const cfg = err.config || {};
      if (!cfg.url?.includes(TRACK_ENDPOINT) && global.activeRequests) {
        global.activeRequests.forEach((reqEvent) => {
          reqEvent.externalCalls.push({
            method: cfg.method,
            url: cfg.url,
            status: err.response?.status || 0,
            durationMs: cfg.metadata ? Date.now() - cfg.metadata.start : 0,
            response: err.response?.data,
            error: err.message,
            timestamp: new Date(),
          });
        });
      }
      return Promise.reject(err);
    }
  );

  // --- Helper: send event & respond ---
  async function sendEventAndRespond(
    res,
    requestEvent,
    body,
    status,
    apiKey,
    trackingUrl,
    start
  ) {
    requestEvent.response = body;
    requestEvent.status = status;
    requestEvent.durationMs = Date.now() - start;

    await axios.post(
      `${trackingUrl}/api/track`,
      { events: [requestEvent] },
      { headers: { "x-track-api-key": apiKey } }
    );

    global.activeRequests = global.activeRequests.filter(
      (r) => r !== requestEvent
    );

    return res.status(status).json(body);
  }

  // --- Middleware function ---
  return async (req, res, next) => {
    if (!global.activeRequests) global.activeRequests = [];
    let finalized = false;
    const start = Date.now();
    const requestEvent = {
      apiKey,
      type: "incoming",
      method: req.method,
      path: req.originalUrl,
      timestamp: new Date(),
      consoleLogs: [],
      externalCalls: [],
      response: null,
      status: null,
      durationMs: null,
    };

    global.activeRequests.push(requestEvent);

    try {
      // --- Get backend config ---
      const cfgRes = await axios.get(
        `${trackingUrl}/api/config?path=${encodeURIComponent(req.originalUrl)}`,
        { headers: { "x-track-api-key": apiKey } }
      );
      const config = cfgRes.data;

      // --- Config checks ---
      if (!config.tracer) {
        return sendEventAndRespond(
          res,
          requestEvent,
          { error: "Tracer disabled" },
          400,
          apiKey,
          trackingUrl,
          start
        );
      }

      if (config.apiEnabled) {
        return sendEventAndRespond(
          res,
          requestEvent,
          { error: "API Enabled by config" },
          403,
          apiKey,
          trackingUrl,
          start
        );
      }

      if (config.scheduling?.enabled) {
        const now = new Date();
        const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(
          now.getMinutes()
        ).padStart(2, "0")}`;

        if (
          hhmm < config.scheduling.startTime ||
          hhmm > config.scheduling.endTime
        ) {
          return sendEventAndRespond(
            res,
            requestEvent,
            { error: "Outside schedule window" },
            403,
            apiKey,
            trackingUrl,
            start
          );
        }
      }

      if (config.requestLimit?.enabled) {
        const rlRes = await axios.get(
          `${trackingUrl}/api/requestCount?path=${encodeURIComponent(
            req.originalUrl
          )}`,
          { headers: { "x-track-api-key": apiKey } }
        );
        if (rlRes.data.blocked) {
          return sendEventAndRespond(
            res,
            requestEvent,
            { error: "Rate limit exceeded" },
            429,
            apiKey,
            trackingUrl,
            start
          );
        }
      }

      // --- Patch res.send / res.json for normal flow ---
      const originalSend = res.send;
      const originalJson = res.json;
      const originalEnd = res.end;
      const finalizeResponse = async (body) => {
        if (finalized) return; // prevent double logging
        finalized = true;
        requestEvent.response = body;
        requestEvent.status = res.statusCode;
        requestEvent.durationMs = Date.now() - start;

        await axios.post(
          `${trackingUrl}/api/track`,
          { events: [requestEvent] },
          { headers: { "x-track-api-key": apiKey } }
        );

        global.activeRequests = global.activeRequests.filter(
          (r) => r !== requestEvent
        );
      };

      res.send = function (body) {
        finalizeResponse(body).catch(() => {});
        return originalSend.call(this, body);
      };

      res.json = function (body) {
        finalizeResponse(body).catch(() => {});
        return originalJson.call(this, body);
      };
      res.end = function (chunk, encoding) {
        finalizeResponse(chunk).catch(() => {});
        return originalEnd.call(this, chunk, encoding);
      };
      next();
    } catch (err) {
      console.error("Tracking error:", err.message);
      next(); // don’t break the app
    }
  };
}

module.exports = { trackMiddleware };
