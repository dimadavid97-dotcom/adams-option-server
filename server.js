import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const ONESIGNAL_APP_ID =
  process.env.ONESIGNAL_APP_ID || "";

const ONESIGNAL_REST_API_KEY =
  process.env.ONESIGNAL_REST_API_KEY || "";


// =====================================================
// POCKET OPTION PAIRS
// =====================================================

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


// =====================================================
// SETTINGS
// =====================================================

// ~6 Twelve Data requests/minute.
// Below an 8 requests/minute limit.

const REQUEST_GAP_MS = 10000;

const RATE_LIMIT_WAIT_MS = 70000;

const CACHE_MS = 50000;

const HISTORY_FILE = "./history.json";

const MAX_HISTORY = 500;


// =====================================================
// MEMORY
// =====================================================

const marketCache = new Map();

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


// =====================================================
// HELPERS
// =====================================================

function sleep(ms) {

  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}


function round(value, digits = 5) {

  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(
    value.toFixed(digits)
  );
}


function digits(pair) {

  return pair.includes("JPY")
    ? 3
    : 5;
}


function price(pair, value) {

  return round(
    value,
    digits(pair)
  );
}


function key(pair, timeframe) {

  return `${pair}|${timeframe}`;
}


// =====================================================
// HISTORY
// =====================================================

function loadHistory() {

  try {

    if (
      !fs.existsSync(HISTORY_FILE)
    ) {

      history = [];

      return;
    }


    history =
      JSON.parse(
        fs.readFileSync(
          HISTORY_FILE,
          "utf8"
        )
      );


    if (
      !Array.isArray(history)
    ) {

      history = [];
    }


    wins =
      history.filter(
        t => t.result === "WIN"
      ).length;


    losses =
      history.filter(
        t => t.result === "LOST"
      ).length;


    draws =
      history.filter(
        t => t.result === "DRAW"
      ).length;


    console.log(
      "History loaded:",
      history.length
    );

  } catch (error) {

    console.log(
      "History error:",
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
        history.slice(
          0,
          MAX_HISTORY
        ),
        null,
        2
      )
    );

  } catch (error) {

    console.log(
      "History save error:",
      error.message
    );
  }
}


function addHistory(trade) {

  history.unshift(trade);

  history =
    history.slice(
      0,
      MAX_HISTORY
    );


  if (
    trade.result === "WIN"
  ) {

    wins++;
  }


  if (
    trade.result === "LOST"
  ) {

    losses++;
  }


  if (
    trade.result === "DRAW"
  ) {

    draws++;
  }


  saveHistory();
}


// =====================================================
// EMA
// =====================================================

function ema(values, period) {

  if (
    values.length < period
  ) {

    return null;
  }


  let value =
    values
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;


  const multiplier =
    2 / (period + 1);


  for (
    let i = period;
    i < values.length;
    i++
  ) {

    value =
      (
        values[i] - value
      ) *
      multiplier +
      value;
  }


  return value;
}


// =====================================================
// RSI
// =====================================================

function rsi(
  values,
  period = 14
) {

  if (
    values.length <
    period + 1
  ) {

    return null;
  }


  let gain = 0;

  let loss = 0;


  const start =
    values.length -
    period -
    1;


  for (
    let i = start + 1;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];


    if (
      change > 0
    ) {

      gain += change;

    } else {

      loss +=
        Math.abs(change);
    }
  }


  const averageGain =
    gain / period;

  const averageLoss =
    loss / period;


  if (
    averageLoss === 0
  ) {

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


// =====================================================
// MOMENTUM
// =====================================================

function momentum(
  values,
  period = 5
) {

  if (
    values.length <= period
  ) {

    return 0;
  }


  return (
    values[
      values.length - 1
    ] -

    values[
      values.length -
      1 -
      period
    ]
  );
}


// =====================================================
// M1 -> M5
// =====================================================

function makeM5(candles) {

  const groups =
    new Map();


  for (
    const candle
    of candles
  ) {

    const match =
      String(
        candle.datetime
      ).match(
        /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/
      );


    if (!match) {
      continue;
    }


    const minute =
      Math.floor(
        Number(match[3]) / 5
      ) * 5;


    const bucket =
      `${match[1]} ${match[2]}:${String(
        minute
      ).padStart(2, "0")}:00`;


    if (
      !groups.has(bucket)
    ) {

      groups.set(
        bucket,
        {
          datetime: bucket,

          open:
            candle.open,

          high:
            candle.high,

          low:
            candle.low,

          close:
            candle.close
        }
      );

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


// =====================================================
// TWELVE DATA
// =====================================================

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


async function getMarket(pair) {

  const cached =
    marketCache.get(pair);


  if (
    cached &&
    Date.now() -
    cached.time <
    CACHE_MS
  ) {

    return cached.data;
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
    message.includes(
      "rate limit"
    ) ||
    message.includes(
      "api credits"
    )
  ) {

    throw new Error(
      "API_RATE_LIMIT"
    );
  }


  if (
    data?.status === "error"
  ) {

    throw new Error(
      data.message
    );
  }


  if (
    !Array.isArray(
      data?.values
    )
  ) {

    throw new Error(
      "NO_DATA"
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

      .reverse();


  const result = {

    M1: m1,

    M5:
      makeM5(m1),

    currentPrice:
      m1[
        m1.length - 1
      ]?.close || null
  };


  marketCache.set(
    pair,
    {
      time:
        Date.now(),

      data:
        result
    }
  );


  return result;
}


// =====================================================
// SIGNAL ANALYSIS
// =====================================================

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
      c => c.close
    );


  const last =
    candles[
      candles.length - 1
    ];


  const ema9 =
    ema(closes, 9);


  const ema21 =
    ema(closes, 21);


  const RSI =
    rsi(closes, 14);


  const MOM =
    momentum(
      closes,
      5
    );


  let score = 0;


  if (
    ema9 > ema21
  ) {

    score += 2;
  }


  if (
    ema9 < ema21
  ) {

    score -= 2;
  }


  if (
    last.close > ema9
  ) {

    score += 1;
  }


  if (
    last.close < ema9
  ) {

    score -= 1;
  }


  if (
    RSI >= 52 &&
    RSI <= 72
  ) {

    score += 1;
  }


  if (
    RSI <= 48 &&
    RSI >= 28
  ) {

    score -= 1;
  }


  if (
    MOM > 0
  ) {

    score += 1;
  }


  if (
    MOM < 0
  ) {

    score -= 1;
  }


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


  if (
    score >= 5
  ) {

    side =
      "CALL";
  }


  if (
    score <= -5
  ) {

    side =
      "PUT";
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
      price(
        pair,
        last.close
      ),

    rsi:
      round(
        RSI,
        1
      ),

    ema9:
      price(
        pair,
        ema9
      ),

    ema21:
      price(
        pair,
        ema21
      ),

    momentum:
      round(
        MOM,
        6
      ),

    updatedAt:
      new Date()
        .toISOString()
  };
}


// =====================================================
// ONESIGNAL NOTIFICATION
// =====================================================

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


    if (
      !response.ok
    ) {

      console.log(
        "ONESIGNAL ERROR",
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


// =====================================================
// OPEN NEW OPTION TRADE
// =====================================================

async function openTrade(signal) {

  if (
    signal.side === "WAIT"
  ) {

    return;
  }


  const tradeId =
    key(
      signal.pair,
      signal.timeframe
    );


  if (
    openTrades.has(
      tradeId
    )
  ) {

    return;
  }


  const last =
    lastTradeTime.get(
      tradeId
    ) || 0;


  const cooldown =
    signal.timeframe === "M5"
      ? 300000
      : 120000;


  if (
    Date.now() -
    last <
    cooldown
  ) {

    return;
  }


  const duration =
    signal.timeframe === "M5"
      ? 300000
      : 60000;


  const trade = {

    id:
      `${Date.now()}-${signal.pair.replace("/", "")}-${signal.timeframe}`,

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
      new Date()
        .toISOString(),

    expiresAt:
      new Date(
        Date.now() +
        duration
      ).toISOString()
  };


  openTrades.set(
    tradeId,
    trade
  );


  lastTradeTime.set(
    tradeId,
    Date.now()
  );


  await sendPush(

    `ADAMS OPTION — ${trade.pair} ${trade.direction}`,

    `${trade.timeframe} | Entry ${trade.entry} | Expiry ${
      trade.timeframe === "M5"
        ? "5 min"
        : "1 min"
    } | Confidence ${trade.confidence}%`,

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
    trade.timeframe
  );
}


// =====================================================
// CHECK WIN / LOST
// =====================================================

async function checkTrades(
  pair,
  currentPrice
) {

  for (
    const timeframe
    of ["M1", "M5"]
  ) {

    const tradeId =
      key(
        pair,
        timeframe
      );


    const trade =
      openTrades.get(
        tradeId
      );


    if (!trade) {
      continue;
    }


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
      price(
        pair,
        currentPrice
      );


    let result =
      "DRAW";


    if (
      trade.direction === "CALL"
    ) {

      if (
        exit > trade.entry
      ) {

        result =
          "WIN";
      }


      if (
        exit < trade.entry
      ) {

        result =
          "LOST";
      }
    }


    if (
      trade.direction === "PUT"
    ) {

      if (
        exit < trade.entry
      ) {

        result =
          "WIN";
      }


      if (
        exit > trade.entry
      ) {

        result =
          "LOST";
      }
    }


    const closedTrade = {

      ...trade,

      exit,

      result,

      closedAt:
        new Date()
          .toISOString()
    };


    openTrades.delete(
      tradeId
    );


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
      pair,
      timeframe,
      result
    );
  }
}


// =====================================================
// PROCESS PAIR
// =====================================================

async function processPair(
  pair
) {

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
    key(pair, "M1"),
    M1
  );


  signals.set(
    key(pair, "M5"),
    M5
  );


  if (
    market.currentPrice
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


// =====================================================
// LIVE SCANNER
// =====================================================

async function scanner() {

  if (
    scannerRunning
  ) {

    return;
  }


  scannerRunning =
    true;


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
        await processPair(
          pair
        );


      console.log(

        pair,

        "| M1",

        result.M1.side,

        result.M1.confidence + "%",

        "| M5",

        result.M5.side,

        result.M5.confidence + "%"
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
          "API limit. Waiting 70 seconds..."
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


// =====================================================
// STATISTICS
// =====================================================

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

    signals:
      history.length,

    wins,

    losses,

    draws,

    winRate,

    openTrades:
      openTrades.size
  };
}


// =====================================================
// HOME
// =====================================================

app.get(
  "/",
  (req, res) => {

    res.json({

      app:
        "ADAMS OPTION SERVER",

      mode:
        "POCKET OPTION SIGNALS",

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
  }
);


// =====================================================
// SIGNALS API
// =====================================================

app.get(
  "/api/signals",
  (req, res) => {

    const data = {};


    for (
      const pair
      of PAIRS
    ) {

      data[pair] = {

        M1:
          signals.get(
            key(pair, "M1")
          ) || {

            pair,

            timeframe: "M1",

            side: "WAIT",

            confidence: 0
          },


        M5:
          signals.get(
            key(pair, "M5")
          ) || {

            pair,

            timeframe: "M5",

            side: "WAIT",

            confidence: 0
          }
      };
    }


    res.json(data);
  }
);


// =====================================================
// HISTORY API
// =====================================================

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


// =====================================================
// WIN RATE
// =====================================================

app.get(
  "/api/stats",
  (req, res) => {

    res.json(
      getStats()
    );
  }
);


// =====================================================
// OPEN TRADES
// =====================================================

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


// =====================================================
// HEALTH
// =====================================================

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
        new Date()
          .toISOString()
    });
  }
);


// =====================================================
// TEST ONESIGNAL
// =====================================================

app.post(
  "/api/test-notification",
  async (req, res) => {

    const success =
      await sendPush(

        "ADAMS OPTION ✅",

        "Notifications are working."
      );


    res.json({
      success
    });
  }
);


// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  () => {

    loadHistory();


    console.log(
      "===================================="
    );


    console.log(
      `ADAMS OPTION SERVER running on port ${PORT}`
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
      "SAFE POCKET OPTION SCANNER STARTED"
    );


    console.log(
      "===================================="
    );


    scanner();
  }
);
