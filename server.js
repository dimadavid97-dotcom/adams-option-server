import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

// ======================================================
// ENVIRONMENT VARIABLES
// ======================================================

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const ONESIGNAL_APP_ID =
  process.env.ONESIGNAL_APP_ID || "";

const ONESIGNAL_REST_API_KEY =
  process.env.ONESIGNAL_REST_API_KEY || "";

// ======================================================
// POCKET OPTION PAIRS
// ======================================================

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "EUR/GBP",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "USD/CHF",
  "NZD/USD"
];

// ======================================================
// SETTINGS
// ======================================================

// Aproximativ 6 cereri/minut.
// Protecție pentru contul Twelve Data cu limită 8/min.

const REQUEST_GAP_MS = 10000;

const RATE_LIMIT_WAIT_MS = 70000;

const HISTORY_FILE = "./history.json";

const MAX_HISTORY = 500;

// ======================================================
// MEMORY
// ======================================================

const signals = new Map();

const openTrades = new Map();

const lastTradeTime = new Map();

let history = [];

let wins = 0;
let losses = 0;
let draws = 0;

let scannerRunning = false;

let pairIndex = 0;

let lastApiRequest = 0;

// ======================================================
// HELPERS
// ======================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round(value, digits = 5) {
  if (!Number.isFinite(value)) return null;

  return Number(value.toFixed(digits));
}

function digitsForPair(pair) {
  return pair.includes("JPY") ? 3 : 5;
}

function formatPrice(pair, value) {
  return round(value, digitsForPair(pair));
}

function tradeKey(pair, timeframe) {
  return `${pair}|${timeframe}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ======================================================
// HISTORY
// ======================================================

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      history = [];
      return;
    }

    const data = JSON.parse(
      fs.readFileSync(HISTORY_FILE, "utf8")
    );

    history = Array.isArray(data) ? data : [];

    wins = history.filter(
      t => t.result === "WIN"
    ).length;

    losses = history.filter(
      t => t.result === "LOST"
    ).length;

    draws = history.filter(
      t => t.result === "DRAW"
    ).length;

    console.log(
      `HISTORY loaded: ${history.length}`
    );

  } catch (error) {
    console.log(
      "HISTORY LOAD ERROR:",
      error.message
    );

    history = [];
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(
        history.slice(0, MAX_HISTORY),
        null,
        2
      )
    );
  } catch (error) {
    console.log(
      "HISTORY SAVE ERROR:",
      error.message
    );
  }
}

function addHistory(trade) {
  history.unshift(trade);

  history = history.slice(
    0,
    MAX_HISTORY
  );

  if (trade.result === "WIN") wins++;

  if (trade.result === "LOST") losses++;

  if (trade.result === "DRAW") draws++;

  saveHistory();
}

// ======================================================
// EMA
// ======================================================

function ema(values, period) {
  if (!values || values.length < period) {
    return null;
  }

  let value =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

  const multiplier =
    2 / (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    value =
      (values[i] - value) *
        multiplier +
      value;
  }

  return value;
}

// ======================================================
// RSI
// ======================================================

function rsi(values, period = 14) {
  if (
    !values ||
    values.length < period + 1
  ) {
    return null;
  }

  let gains = 0;
  let lossesLocal = 0;

  const start =
    values.length -
    period -
    1;

  for (
    let i = start + 1;
    i < values.length;
    i++
  ) {
    const difference =
      values[i] -
      values[i - 1];

    if (difference > 0) {
      gains += difference;
    } else {
      lossesLocal +=
        Math.abs(difference);
    }
  }

  const averageGain =
    gains / period;

  const averageLoss =
    lossesLocal / period;

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

// ======================================================
// MOMENTUM
// ======================================================

function momentum(values, period = 5) {
  if (
    !values ||
    values.length <= period
  ) {
    return 0;
  }

  return (
    values[values.length - 1] -
    values[
      values.length -
      1 -
      period
    ]
  );
}

// ======================================================
// M1 -> M5
// ======================================================

function makeM5(candles) {
  const groups = new Map();

  for (const candle of candles) {
    const match =
      String(
        candle.datetime
      ).match(
        /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/
      );

    if (!match) continue;

    const minute =
      Math.floor(
        Number(match[3]) / 5
      ) * 5;

    const bucket =
      `${match[1]} ${match[2]}:${String(
        minute
      ).padStart(2, "0")}:00`;

    if (!groups.has(bucket)) {
      groups.set(bucket, {
        datetime: bucket,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      });

    } else {
      const item =
        groups.get(bucket);

      item.high =
        Math.max(
          item.high,
          candle.high
        );

      item.low =
        Math.min(
          item.low,
          candle.low
        );

      item.close =
        candle.close;
    }
  }

  return Array.from(
    groups.values()
  );
}

// ======================================================
// TWELVE DATA RATE LIMIT
// ======================================================

async function waitForApi() {
  const elapsed =
    Date.now() -
    lastApiRequest;

  if (
    elapsed <
    REQUEST_GAP_MS
  ) {
    await sleep(
      REQUEST_GAP_MS -
      elapsed
    );
  }
}

// ======================================================
// GET MARKET DATA
// ======================================================

async function getMarket(pair) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_KEY_MISSING"
    );
  }

  await waitForApi();

  lastApiRequest =
    Date.now();

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(pair) +
    "&interval=1min" +
    "&outputsize=120" +
    "&apikey=" +
    encodeURIComponent(
      TWELVE_DATA_API_KEY
    );

  const response =
    await fetch(url);

  const data =
    await response.json();

  const message =
    String(
      data?.message || ""
    ).toLowerCase();

  if (
    response.status === 429 ||
    data?.code === 429 ||
    message.includes("rate limit") ||
    message.includes("api credits") ||
    message.includes("too many")
  ) {
    throw new Error(
      "API_RATE_LIMIT"
    );
  }

  if (
    !response.ok ||
    data?.status === "error"
  ) {
    throw new Error(
      data?.message ||
      "TWELVE_DATA_ERROR"
    );
  }

  if (
    !Array.isArray(data?.values)
  ) {
    throw new Error(
      "NO_MARKET_DATA"
    );
  }

  const m1 =
    data.values
      .map(item => ({
        datetime:
          item.datetime,

        open:
          Number(item.open),

        high:
          Number(item.high),

        low:
          Number(item.low),

        close:
          Number(item.close)
      }))
      .filter(item =>
        Number.isFinite(item.open) &&
        Number.isFinite(item.high) &&
        Number.isFinite(item.low) &&
        Number.isFinite(item.close)
      )
      .reverse();

  return {
    M1: m1,
    M5: makeM5(m1),

    currentPrice:
      m1[
        m1.length - 1
      ]?.close || null
  };
}

// ======================================================
// ANALYSE SIGNAL
// ======================================================

function analyse(
  pair,
  candles,
  timeframe
) {
  if (
    !candles ||
    candles.length < 30
  ) {
    return {
      pair,
      timeframe,
      side: "WAIT",
      confidence: 0
    };
  }

  const closes =
    candles.map(
      candle => candle.close
    );

  const last =
    candles[
      candles.length - 1
    ];

  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);

  const currentRsi =
    rsi(closes, 14);

  const currentMomentum =
    momentum(closes, 5);

  let score = 0;

  // TREND

  if (ema9 > ema21) {
    score += 2;
  }

  if (ema9 < ema21) {
    score -= 2;
  }

  // PRICE

  if (last.close > ema9) {
    score += 1;
  }

  if (last.close < ema9) {
    score -= 1;
  }

  // RSI

  if (
    currentRsi >= 52 &&
    currentRsi <= 72
  ) {
    score += 1;
  }

  if (
    currentRsi <= 48 &&
    currentRsi >= 28
  ) {
    score -= 1;
  }

  // MOMENTUM

  if (currentMomentum > 0) {
    score += 1;
  }

  if (currentMomentum < 0) {
    score -= 1;
  }

  // CURRENT CANDLE

  if (
    last.close >
    last.open
  ) {
    score += 1;
  }

  if (
    last.close <
    last.open
  ) {
    score -= 1;
  }

  let side =
    "WAIT";

  if (score >= 5) {
    side = "CALL";
  }

  if (score <= -5) {
    side = "PUT";
  }

  const confidence =
    side === "WAIT"
      ? Math.min(
          69,
          50 +
            Math.abs(score) * 4
        )
      : Math.min(
          95,
          60 +
            Math.abs(score) * 6
        );

  return {
    pair,
    timeframe,

    side,

    confidence,

    score,

    entry:
      formatPrice(
        pair,
        last.close
      ),

    rsi:
      round(
        currentRsi,
        1
      ),

    ema9:
      formatPrice(
        pair,
        ema9
      ),

    ema21:
      formatPrice(
        pair,
        ema21
      ),

    momentum:
      round(
        currentMomentum,
        6
      ),

    updatedAt:
      nowIso()
  };
}

// ======================================================
// ONESIGNAL
// ======================================================

async function sendPush(
  title,
  message,
  extra = {}
) {
  if (
    !ONESIGNAL_APP_ID ||
    !ONESIGNAL_REST_API_KEY
  ) {
    console.log(
      "ONESIGNAL env vars missing"
    );

    return false;
  }

  try {
    const response =
      await fetch(
        "https://api.onesignal.com/notifications",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "Authorization":
              `Key ${ONESIGNAL_REST_API_KEY}`
          },

          body:
            JSON.stringify({
              app_id:
                ONESIGNAL_APP_ID,

              included_segments: [
                "Subscribed Users"
              ],

              headings: {
                en: title
              },

              contents: {
                en: message
              },

              data:
                extra
            })
        }
      );

    const result =
      await response.json();

    if (!response.ok) {
      console.log(
        "ONESIGNAL ERROR:",
        result
      );

      return false;
    }

    console.log(
      "NOTIFICATION SENT:",
      title
    );

    return true;

  } catch (error) {
    console.log(
      "ONESIGNAL ERROR:",
      error.message
    );

    return false;
  }
}

// ======================================================
// NEW TRADE
// ======================================================

async function openTrade(signal) {
  if (
    signal.side === "WAIT"
  ) {
    return;
  }

  const id =
    tradeKey(
      signal.pair,
      signal.timeframe
    );

  if (
    openTrades.has(id)
  ) {
    return;
  }

  const lastTrade =
    lastTradeTime.get(id) || 0;

  const cooldown =
    signal.timeframe === "M5"
      ? 5 * 60 * 1000
      : 2 * 60 * 1000;

  if (
    Date.now() -
      lastTrade <
    cooldown
  ) {
    return;
  }

  const duration =
    signal.timeframe === "M5"
      ? 5 * 60 * 1000
      : 60 * 1000;

  const trade = {
    id:
      `${Date.now()}-${signal.pair.replace(
        "/",
        ""
      )}-${signal.timeframe}`,

    pair:
      signal.pair,

    timeframe:
      signal.timeframe,

    direction:
      signal.side,

    confidence:
      signal.confidence,

    entry:
      signal.entry,

    exit:
      null,

    result:
      "OPEN",

    openedAt:
      nowIso(),

    expiresAt:
      new Date(
        Date.now() +
        duration
      ).toISOString()
  };

  openTrades.set(
    id,
    trade
  );

  lastTradeTime.set(
    id,
    Date.now()
  );

  const expiry =
    trade.timeframe === "M5"
      ? "5 min"
      : "1 min";

  await sendPush(
    `ADAMS OPTION — ${trade.pair} ${trade.direction}`,

    `${trade.timeframe} | Entry ${trade.entry} | Expiry ${expiry} | Confidence ${trade.confidence}%`,

    {
      event:
        "NEW_SIGNAL",

      trade
    }
  );

  console.log(
    "NEW SIGNAL:",
    trade.pair,
    trade.direction,
    trade.timeframe,
    trade.confidence + "%"
  );
}

// ======================================================
// CHECK WIN / LOST
// ======================================================

async function checkTrades(
  pair,
  currentPrice
) {
  for (
    const timeframe
    of ["M1", "M5"]
  ) {
    const id =
      tradeKey(
        pair,
        timeframe
      );

    const trade =
      openTrades.get(id);

    if (!trade) continue;

    const expiry =
      new Date(
        trade.expiresAt
      ).getTime();

    if (
      Date.now() <
      expiry
    ) {
      continue;
    }

    const exit =
      formatPrice(
        pair,
        currentPrice
      );

    let result =
      "DRAW";

    if (
      trade.direction === "CALL"
    ) {
      if (
        exit >
        trade.entry
      ) {
        result = "WIN";
      }

      if (
        exit <
        trade.entry
      ) {
        result = "LOST";
      }
    }

    if (
      trade.direction === "PUT"
    ) {
      if (
        exit <
        trade.entry
      ) {
        result = "WIN";
      }

      if (
        exit >
        trade.entry
      ) {
        result = "LOST";
      }
    }

    const closedTrade = {
      ...trade,

      exit,

      result,

      closedAt:
        nowIso()
    };

    openTrades.delete(id);

    addHistory(
      closedTrade
    );

    if (
      result === "WIN"
    ) {
      await sendPush(
        `${pair} ${timeframe} — WIN ✅`,

        `${trade.direction} | Entry ${trade.entry} | Exit ${exit}`,

        {
          event: "WIN",
          trade: closedTrade
        }
      );
    }

    if (
      result === "LOST"
    ) {
      await sendPush(
        `${pair} ${timeframe} — LOST ❌`,

        `${trade.direction} | Entry ${trade.entry} | Exit ${exit}`,

        {
          event: "LOST",
          trade: closedTrade
        }
      );
    }

    if (
      result === "DRAW"
    ) {
      await sendPush(
        `${pair} ${timeframe} — DRAW`,

        `Entry ${trade.entry} | Exit ${exit}`,

        {
          event: "DRAW",
          trade: closedTrade
        }
      );
    }

    console.log(
      "RESULT:",
      pair,
      timeframe,
      result
    );
  }
}

// ======================================================
// PROCESS PAIR
// ======================================================

async function processPair(pair) {
  const market =
    await getMarket(pair);

  const M1 =
    analyse(
      pair,
      market.M1,
      "M1"
    );

  const M5 =
    analyse(
      pair,
      market.M5,
      "M5"
    );

  signals.set(
    tradeKey(
      pair,
      "M1"
    ),
    M1
  );

  signals.set(
    tradeKey(
      pair,
      "M5"
    ),
    M5
  );

  if (
    Number.isFinite(
      market.currentPrice
    )
  ) {
    await checkTrades(
      pair,
      market.currentPrice
    );
  }

  await openTrade(M1);

  await openTrade(M5);

  return {
    M1,
    M5
  };
}

// ======================================================
// LIVE SCANNER
// ======================================================

async function scanner() {
  if (scannerRunning) return;

  scannerRunning = true;

  console.log(
    "SAFE POCKET OPTION SCANNER STARTED"
  );

  while (true) {
    const pair =
      PAIRS[pairIndex];

    try {
      console.log(
        "Scanning:",
        pair
      );

      const result =
        await processPair(pair);

      console.log(
        `${pair} | M1 ${result.M1.side} ${result.M1.confidence}% | M5 ${result.M5.side} ${result.M5.confidence}%`
      );

    } catch (error) {
      console.log(
        "LIVE SCAN:",
        error.message
      );

      if (
        error.message ===
        "API_RATE_LIMIT"
      ) {
        console.log(
          "Twelve Data API limit detected."
        );

        console.log(
          "Waiting 70 seconds..."
        );

        await sleep(
          RATE_LIMIT_WAIT_MS
        );
      }
    }

    pairIndex =
      (
        pairIndex + 1
      ) %
      PAIRS.length;

    await sleep(
      REQUEST_GAP_MS
    );
  }
}

// ======================================================
// STATS
// ======================================================

function getStats() {
  const completed =
    wins + losses;

  const winRate =
    completed > 0
      ? round(
          wins /
            completed *
            100,
          1
        )
      : 0;

  return {
    total:
      history.length,

    wins,

    losses,

    draws,

    winRate,

    openTrades:
      openTrades.size
  };
}

// ======================================================
// HOME
// ======================================================

app.get("/", (req, res) => {
  res.json({
    app:
      "ADAMS OPTION SERVER",

    mode:
      "POCKET OPTION SIGNALS / MANUAL EXECUTION",

    pairs:
      PAIRS,

    timeframes: [
      "M1",
      "M5"
    ],

    twelveData:
      TWELVE_DATA_API_KEY
        ? "ready"
        : "missing",

    oneSignal:
      (
        ONESIGNAL_APP_ID &&
        ONESIGNAL_REST_API_KEY
      )
        ? "ready"
        : "missing env vars",

    rateLimitProtection:
      "active",

    stats:
      getStats(),

    status:
      "online"
  });
});

// ======================================================
// SIGNALS
// ======================================================

app.get(
  "/api/signals",
  (req, res) => {
    const result = {};

    for (
      const pair
      of PAIRS
    ) {
      result[pair] = {
        M1:
          signals.get(
            tradeKey(
              pair,
              "M1"
            )
          ) || {
            pair,
            timeframe: "M1",
            side: "WAIT",
            confidence: 0
          },

        M5:
          signals.get(
            tradeKey(
              pair,
              "M5"
            )
          ) || {
            pair,
            timeframe: "M5",
            side: "WAIT",
            confidence: 0
          }
      };
    }

    res.json(result);
  }
);

// ======================================================
// HISTORY
// ======================================================

app.get(
  "/api/history",
  (req, res) => {
    res.json({
      stats:
        getStats(),

      history
    });
  }
);

// ======================================================
// STATS API
// ======================================================

app.get(
  "/api/stats",
  (req, res) => {
    res.json(
      getStats()
    );
  }
);

// ======================================================
// OPEN TRADES
// ======================================================

app.get(
  "/api/open-trades",
  (req, res) => {
    res.json(
      Array.from(
        openTrades.values()
      )
    );
  }
);

// ======================================================
// HEALTH
// ======================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      scanner:
        scannerRunning
          ? "running"
          : "starting",

      time:
        nowIso()
    });
  }
);

// ======================================================
// TEST NOTIFICATION
// ======================================================

async function testNotification(
  req,
  res
) {
  const success =
    await sendPush(
      "ADAMS OPTION ✅",
      "Notifications are working."
    );

  res.json({
    success,

    oneSignal:
      (
        ONESIGNAL_APP_ID &&
        ONESIGNAL_REST_API_KEY
      )
        ? "configured"
        : "missing"
  });
}

app.get(
  "/api/test-notification",
  testNotification
);

app.post(
  "/api/test-notification",
  testNotification
);

// ======================================================
// START
// ======================================================

app.listen(
  PORT,
  () => {
    loadHistory();

    console.log(
      "======================================"
    );

    console.log(
      `ADAMS OPTION SERVER running on port ${PORT}`
    );

    console.log(
      "MODE: POCKET OPTION SIGNALS"
    );

    console.log(
      TWELVE_DATA_API_KEY
        ? "TWELVE DATA KEY loaded"
        : "TWELVE DATA KEY MISSING"
    );

    console.log(
      (
        ONESIGNAL_APP_ID &&
        ONESIGNAL_REST_API_KEY
      )
        ? "ONESIGNAL env vars loaded"
        : "ONESIGNAL env vars missing"
    );

    console.log(
      "RATE LIMIT PROTECTION: ACTIVE"
    );

    console.log(
      "======================================"
    );

    scanner().catch(
      error => {
        console.log(
          "SCANNER FATAL ERROR:",
          error.message
        );
      }
    );
  }
);
