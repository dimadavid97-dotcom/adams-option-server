import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT =
  Number(process.env.PORT || 3000);

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const ONESIGNAL_APP_ID =
  process.env.ONESIGNAL_APP_ID || "";

const ONESIGNAL_REST_API_KEY =
  process.env.ONESIGNAL_REST_API_KEY || "";

const MIN_CONFIDENCE =
  Number(process.env.MIN_CONFIDENCE || 80);


// =====================================================
// ADAMS OPTION — POCKET MODE
// DEMO SIGNALS / MANUAL EXECUTION
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

const TIMEFRAMES = [
  "M1",
  "M5",
  "M15"
];

const MAX_HISTORY = 500;

const MAX_OPEN_TRADES = 2;

const HISTORY_FILE =
  "./history.json";

const SCAN_CACHE_MS =
  60 * 1000;

const PAIR_CACHE_MS =
  60 * 1000;

const CHECK_CACHE_MS =
  60 * 1000;


// =====================================================
// URLS
// =====================================================

const TD_TIME_SERIES =
  "https://api.twelvedata.com/time_series";

const TD_PRICE =
  "https://api.twelvedata.com/price";

const ONESIGNAL_URL =
  "https://api.onesignal.com/notifications";


// =====================================================
// MEMORY
// =====================================================

let history = [];

let wins = 0;

let losses = 0;

let draws = 0;

const openTrades =
  new Map();

const lastTradeTime =
  new Map();

const pairCache =
  new Map();

let scanCache = {
  timestamp: 0,
  data: null
};

let checkCache = {
  timestamp: 0,
  data: null
};


// =====================================================
// HELPERS
// =====================================================

function nowIso() {

  return new Date()
    .toISOString();
}


function round(
  value,
  digits = 5
) {

  if (
    !Number.isFinite(value)
  ) {
    return null;
  }

  return Number(
    value.toFixed(digits)
  );
}


function digitsForPair(pair) {

  return pair.includes("JPY")
    ? 3
    : 5;
}


function formatPrice(
  pair,
  value
) {

  return round(
    Number(value),
    digitsForPair(pair)
  );
}


function tradeKey(
  pair,
  timeframe
) {

  return `${pair}|${timeframe}`;
}


function expiryMs(timeframe) {

  if (
    timeframe === "M15"
  ) {

    return (
      15 *
      60 *
      1000
    );
  }

  if (
    timeframe === "M5"
  ) {

    return (
      5 *
      60 *
      1000
    );
  }

  return (
    60 *
    1000
  );
}


function cooldownMs(timeframe) {

  if (
    timeframe === "M15"
  ) {

    return (
      15 *
      60 *
      1000
    );
  }

  if (
    timeframe === "M5"
  ) {

    return (
      5 *
      60 *
      1000
    );
  }

  return (
    2 *
    60 *
    1000
  );
}


// =====================================================
// HISTORY
// =====================================================

function loadHistory() {

  try {

    if (
      !fs.existsSync(
        HISTORY_FILE
      )
    ) {

      return;
    }

    const data =
      JSON.parse(
        fs.readFileSync(
          HISTORY_FILE,
          "utf8"
        )
      );

    if (
      Array.isArray(data)
    ) {

      history =
        data.slice(
          0,
          MAX_HISTORY
        );
    }

  } catch (error) {

    console.log(
      "History load:",
      error.message
    );

    history = [];
  }

  wins =
    history.filter(
      x =>
        x.result ===
        "WIN"
    ).length;

  losses =
    history.filter(
      x =>
        x.result ===
        "LOST"
    ).length;

  draws =
    history.filter(
      x =>
        x.result ===
        "DRAW"
    ).length;
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
      ),

      "utf8"
    );

  } catch (error) {

    console.log(
      "History save:",
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
    trade.result ===
    "WIN"
  ) {
    wins++;
  }

  if (
    trade.result ===
    "LOST"
  ) {
    losses++;
  }

  if (
    trade.result ===
    "DRAW"
  ) {
    draws++;
  }

  saveHistory();
}


// =====================================================
// INDICATORS
// =====================================================

function ema(
  values,
  period
) {

  if (
    !values ||
    values.length < period
  ) {

    return null;
  }

  const multiplier =
    2 /
    (period + 1);

  let current =
    values
      .slice(
        0,
        period
      )
      .reduce(
        (
          total,
          value
        ) =>
          total + value,
        0
      ) /
    period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    current =
      (
        values[i] -
        current
      ) *
      multiplier +
      current;
  }

  return current;
}


function rsi(
  values,
  period = 14
) {

  if (
    !values ||
    values.length <
      period + 1
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
    let i =
      start + 1;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];

    if (
      diff > 0
    ) {

      gains += diff;

    } else {

      lossesLocal +=
        Math.abs(diff);
    }
  }

  const avgGain =
    gains /
    period;

  const avgLoss =
    lossesLocal /
    period;

  if (
    avgLoss === 0
  ) {
    return 100;
  }

  const rs =
    avgGain /
    avgLoss;

  return (
    100 -
    100 /
    (1 + rs)
  );
}


function momentum(
  values,
  period = 3
) {

  if (
    !values ||
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
// CANDLES
// =====================================================

function parseDate(
  value
) {

  if (!value) {
    return null;
  }

  const iso =
    value.includes("T")
      ? value
      : value.replace(
          " ",
          "T"
        );

  const date =
    new Date(
      iso.endsWith("Z")
        ? iso
        : iso + "Z"
    );

  const ms =
    date.getTime();

  return Number.isFinite(ms)
    ? Math.floor(
        ms / 1000
      )
    : null;
}


function parseCandles(
  values
) {

  if (
    !Array.isArray(values)
  ) {
    return [];
  }

  return values
    .map(row => ({

      start:
        parseDate(
          row.datetime
        ),

      open:
        Number(
          row.open
        ),

      high:
        Number(
          row.high
        ),

      low:
        Number(
          row.low
        ),

      close:
        Number(
          row.close
        )
    }))
    .filter(candle =>

      Number.isFinite(
        candle.start
      ) &&

      Number.isFinite(
        candle.open
      ) &&

      Number.isFinite(
        candle.high
      ) &&

      Number.isFinite(
        candle.low
      ) &&

      Number.isFinite(
        candle.close
      )
    )
    .sort(
      (
        a,
        b
      ) =>
        a.start -
        b.start
    );
}


function aggregateCandles(
  source,
  intervalSec
) {

  const groups =
    new Map();

  for (
    const candle
    of source
  ) {

    const bucket =
      Math.floor(
        candle.start /
        intervalSec
      ) *
      intervalSec;

    if (
      !groups.has(
        bucket
      )
    ) {

      groups.set(
        bucket,
        {

          start:
            bucket,

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
        groups.get(
          bucket
        );

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
  )
  .sort(
    (
      a,
      b
    ) =>
      a.start -
      b.start
  );
}


// =====================================================
// RAW SIGNAL
// =====================================================

function rawSignal(
  pair,
  timeframe,
  candles
) {

  if (
    !candles ||
    candles.length < 15
  ) {

    return {

      pair,

      timeframe,

      side:
        "WAIT",

      confidence:
        0,

      score:
        0,

      reason:
        "NOT_ENOUGH_DATA",

      bars:
        candles?.length || 0
    };
  }

  const recent =
    candles.slice(
      -80
    );

  const closes =
    recent.map(
      x => x.close
    );

  const last =
    recent[
      recent.length - 1
    ];

  const fast =
    ema(
      closes,
      5
    );

  const slow =
    ema(
      closes,
      13
    );

  const currentRsi =
    rsi(
      closes,
      14
    );

  const mom =
    momentum(
      closes,
      3
    );

  if (
    !Number.isFinite(fast) ||
    !Number.isFinite(slow) ||
    !Number.isFinite(currentRsi)
  ) {

    return {

      pair,

      timeframe,

      side:
        "WAIT",

      confidence:
        0,

      score:
        0,

      reason:
        "WARMING_UP",

      bars:
        recent.length
    };
  }

  let score = 0;

  // EMA trend

  if (
    fast > slow
  ) {
    score += 3;
  }

  if (
    fast < slow
  ) {
    score -= 3;
  }

  // Price vs EMA

  if (
    last.close >
    fast
  ) {
    score += 1;
  }

  if (
    last.close <
    fast
  ) {
    score -= 1;
  }

  // RSI

  if (
    currentRsi >= 54 &&
    currentRsi <= 72
  ) {
    score += 2;
  }

  if (
    currentRsi <= 46 &&
    currentRsi >= 28
  ) {
    score -= 2;
  }

  // Momentum

  if (
    mom > 0
  ) {
    score += 1;
  }

  if (
    mom < 0
  ) {
    score -= 1;
  }

  // Candle direction

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
    score >= 6
  ) {
    side =
      "CALL";
  }

  if (
    score <= -6
  ) {
    side =
      "PUT";
  }

  let confidence =
    Math.min(
      96,
      52 +
      Math.abs(
        score
      ) * 5
    );

  if (
    side === "WAIT"
  ) {

    confidence =
      Math.min(
        79,
        confidence
      );
  }

  return {

    pair,

    timeframe,

    side,

    confidence:
      Math.round(
        confidence
      ),

    score,

    price:
      formatPrice(
        pair,
        last.close
      ),

    entry:
      formatPrice(
        pair,
        last.close
      ),

    emaFast:
      formatPrice(
        pair,
        fast
      ),

    emaSlow:
      formatPrice(
        pair,
        slow
      ),

    rsi:
      round(
        currentRsi,
        1
      ),

    momentum:
      round(
        mom,
        6
      ),

    bars:
      recent.length,

    updatedAt:
      nowIso()
  };
}


// =====================================================
// MULTI-TIMEFRAME SIGNALS
// =====================================================

function analysePairCandles(
  pair,
  m1
) {

  const m5 =
    aggregateCandles(
      m1,
      300
    );

  const m15 =
    aggregateCandles(
      m1,
      900
    );

  const result = {

    M1:
      rawSignal(
        pair,
        "M1",
        m1
      ),

    M5:
      rawSignal(
        pair,
        "M5",
        m5
      ),

    M15:
      rawSignal(
        pair,
        "M15",
        m15
      )
  };

  // M1 confirmation from M5

  if (
    result.M1.side !==
    "WAIT"
  ) {

    if (
      result.M5.side ===
      result.M1.side
    ) {

      result.M1.confidence +=
        6;
    }

    if (
      result.M5.side !==
        "WAIT" &&
      result.M5.side !==
        result.M1.side
    ) {

      result.M1.confidence -=
        8;
    }
  }

  // M5 confirmation from M15

  if (
    result.M5.side !==
    "WAIT"
  ) {

    if (
      result.M15.side ===
      result.M5.side
    ) {

      result.M5.confidence +=
        6;
    }

    if (
      result.M15.side !==
        "WAIT" &&
      result.M15.side !==
        result.M5.side
    ) {

      result.M5.confidence -=
        8;
    }
  }

  // M15 confirmation from M5

  if (
    result.M15.side !==
    "WAIT"
  ) {

    if (
      result.M5.side ===
      result.M15.side
    ) {

      result.M15.confidence +=
        4;
    }
  }

  for (
    const tf
    of TIMEFRAMES
  ) {

    result[tf].confidence =
      Math.max(
        0,
        Math.min(
          98,
          Math.round(
            result[tf]
              .confidence
          )
        )
      );

    if (
      result[tf].side !==
        "WAIT" &&
      result[tf]
        .confidence <
        MIN_CONFIDENCE
    ) {

      result[tf].side =
        "WAIT";
    }
  }

  return result;
}


// =====================================================
// TWELVE DATA
// =====================================================

async function fetchOnePair(
  pair
) {

  const cached =
    pairCache.get(pair);

  if (
    cached &&
    Date.now() -
      cached.timestamp <
      PAIR_CACHE_MS
  ) {

    return cached.data;
  }

  const params =
    new URLSearchParams({

      symbol:
        pair,

      interval:
        "1min",

      outputsize:
        "320",

      timezone:
        "UTC",

      apikey:
        TWELVE_DATA_API_KEY
    });

  const response =
    await fetch(
      `${TD_TIME_SERIES}?${params.toString()}`
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.status === "error"
  ) {

    throw new Error(
      data.message ||
      "Twelve Data error"
    );
  }

  const candles =
    parseCandles(
      data.values
    );

  const result =
    analysePairCandles(
      pair,
      candles
    );

  pairCache.set(
    pair,
    {

      timestamp:
        Date.now(),

      data:
        result
    }
  );

  return result;
}


// =====================================================
// BATCH SCAN — 8 PAIRS = 8 CREDITS
// =====================================================

function extractBatchPayload(
  data,
  pair
) {

  if (
    data?.[pair]
  ) {

    return data[pair];
  }

  if (
    data?.data?.[pair]
  ) {

    return data.data[pair];
  }

  const clean =
    pair.replace(
      "/",
      ""
    );

  if (
    data?.[clean]
  ) {

    return data[clean];
  }

  if (
    data?.data?.[clean]
  ) {

    return data.data[
      clean
    ];
  }

  return null;
}


async function fetchAllPairs() {

  if (
    scanCache.data &&
    Date.now() -
      scanCache.timestamp <
      SCAN_CACHE_MS
  ) {

    return {
      ...scanCache.data,
      cached: true
    };
  }

  const params =
    new URLSearchParams({

      symbol:
        PAIRS.join(","),

      interval:
        "1min",

      outputsize:
        "320",

      timezone:
        "UTC",

      apikey:
        TWELVE_DATA_API_KEY
    });

  const response =
    await fetch(
      `${TD_TIME_SERIES}?${params.toString()}`
    );

  const data =
    await response.json();

  if (
    !response.ok
  ) {

    throw new Error(
      data.message ||
      "Twelve Data error"
    );
  }

  const result = {};

  for (
    const pair
    of PAIRS
  ) {

    const payload =
      extractBatchPayload(
        data,
        pair
      );

    if (
      !payload ||
      payload.status ===
        "error"
    ) {

      result[pair] = {

        M1: {
          pair,
          timeframe:
            "M1",
          side:
            "WAIT",
          confidence:
            0,
          reason:
            payload?.message ||
            "NO_DATA"
        },

        M5: {
          pair,
          timeframe:
            "M5",
          side:
            "WAIT",
          confidence:
            0,
          reason:
            payload?.message ||
            "NO_DATA"
        },

        M15: {
          pair,
          timeframe:
            "M15",
          side:
            "WAIT",
          confidence:
            0,
          reason:
            payload?.message ||
            "NO_DATA"
        }
      };

      continue;
    }

    const candles =
      parseCandles(
        payload.values
      );

    result[pair] =
      analysePairCandles(
        pair,
        candles
      );

    pairCache.set(
      pair,
      {

        timestamp:
          Date.now(),

        data:
          result[pair]
      }
    );
  }

  const finalData = {

    pairs:
      result,

    timestamp:
      nowIso(),

    cached:
      false,

    creditsUsed:
      response.headers.get(
        "api-credits-used"
      ),

    creditsLeft:
      response.headers.get(
        "api-credits-left"
      )
  };

  scanCache = {

    timestamp:
      Date.now(),

    data:
      finalData
  };

  return finalData;
}


// =====================================================
// BEST SIGNAL
// =====================================================

function bestSignalFromScan(
  scan,
  timeframe
) {

  const candidates = [];

  for (
    const pair
    of PAIRS
  ) {

    const signal =
      scan?.pairs?.[pair]?.[
        timeframe
      ];

    if (
      !signal ||
      signal.side ===
        "WAIT"
    ) {
      continue;
    }

    candidates.push(
      signal
    );
  }

  candidates.sort(
    (
      a,
      b
    ) =>
      b.confidence -
      a.confidence
  );

  return (
    candidates[0] ||
    null
  );
}


// =====================================================
// ONESIGNAL
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
      "OneSignal not configured"
    );

    return false;
  }

  try {

    const response =
      await fetch(
        ONESIGNAL_URL,
        {

          method:
            "POST",

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
                en:
                  title
              },

              contents: {
                en:
                  message
              },

              data:
                extra
            })
        }
      );

    if (
      !response.ok
    ) {

      const error =
        await response
          .text();

      console.log(
        "OneSignal:",
        error
      );

      return false;
    }

    return true;

  } catch (error) {

    console.log(
      "OneSignal:",
      error.message
    );

    return false;
  }
}


// =====================================================
// DEMO TRADES
// =====================================================

function canOpenTrade(
  pair,
  timeframe
) {

  if (
    openTrades.size >=
    MAX_OPEN_TRADES
  ) {

    return false;
  }

  const key =
    tradeKey(
      pair,
      timeframe
    );

  if (
    openTrades.has(key)
  ) {

    return false;
  }

  const last =
    lastTradeTime.get(
      key
    ) || 0;

  return (
    Date.now() -
    last >=
    cooldownMs(
      timeframe
    )
  );
}


async function openDemoTrade(
  signal
) {

  if (
    !signal ||
    signal.side === "WAIT" ||
    signal.confidence <
      MIN_CONFIDENCE
  ) {

    return null;
  }

  if (
    !canOpenTrade(
      signal.pair,
      signal.timeframe
    )
  ) {

    return null;
  }

  const opened =
    Date.now();

  const key =
    tradeKey(
      signal.pair,
      signal.timeframe
    );

  const trade = {

    id:
      `${opened}-${signal.pair.replace(
        "/",
        ""
      )}-${signal.timeframe}`,

    mode:
      "DEMO",

    pair:
      signal.pair,

    timeframe:
      signal.timeframe,

    direction:
      signal.side,

    confidence:
      signal.confidence,

    entry:
      signal.entry ||
      signal.price,

    exit:
      null,

    result:
      "OPEN",

    openedAt:
      new Date(
        opened
      ).toISOString(),

    expiresAt:
      new Date(
        opened +
        expiryMs(
          signal.timeframe
        )
      ).toISOString(),

    closedAt:
      null
  };

  openTrades.set(
    key,
    trade
  );

  lastTradeTime.set(
    key,
    opened
  );

  await sendPush(

    `ADAMS OPTION — ${trade.direction} ${trade.pair}`,

    `${trade.timeframe} | Confidence ${trade.confidence}% | Entry ${trade.entry}`,

    {
      event:
        "NEW_SIGNAL",

      trade
    }
  );

  return trade;
}


// =====================================================
// SETTLE TRADE
// =====================================================

function settleTrade(
  trade,
  currentPrice
) {

  const exit =
    formatPrice(
      trade.pair,
      currentPrice
    );

  let result =
    "DRAW";

  if (
    trade.direction ===
    "CALL"
  ) {

    if (
      exit >
      trade.entry
    ) {
      result =
        "WIN";
    }

    if (
      exit <
      trade.entry
    ) {
      result =
        "LOST";
    }
  }

  if (
    trade.direction ===
    "PUT"
  ) {

    if (
      exit <
      trade.entry
    ) {
      result =
        "WIN";
    }

    if (
      exit >
      trade.entry
    ) {
      result =
        "LOST";
    }
  }

  return {

    ...trade,

    exit,

    result,

    closedAt:
      nowIso()
  };
}


// =====================================================
// STATS
// =====================================================

function getStats() {

  const completed =
    wins +
    losses;

  return {

    totalHistory:
      history.length,

    wins,

    losses,

    draws,

    winRate:
      completed > 0
        ? round(
            wins /
            completed *
            100,
            1
          )
        : 0,

    openTrades:
      openTrades.size,

    maxOpenTrades:
      MAX_OPEN_TRADES
  };
}


// =====================================================
// HOME
// =====================================================

app.get(
  "/",
  (
    req,
    res
  ) => {

    res.json({

      app:
        "ADAMS OPTION SERVER",

      version:
        "POCKET MODE 3.0",

      mode:
        "POCKET OPTION DEMO / MANUAL",

      dataMode:
        "ON-DEMAND 8 PAIR SCAN",

      pairs:
        PAIRS,

      timeframes:
        TIMEFRAMES,

      minConfidence:
        MIN_CONFIDENCE,

      stats:
        getStats(),

      status:
        "online"
    });
  }
);


// =====================================================
// HEALTH
// =====================================================

app.get(
  "/health",
  (
    req,
    res
  ) => {

    res.json({

      ok:
        true,

      apiKey:
        TWELVE_DATA_API_KEY
          ? "loaded"
          : "missing",

      oneSignal:
        (
          ONESIGNAL_APP_ID &&
          ONESIGNAL_REST_API_KEY
        )
          ? "loaded"
          : "missing",

      timestamp:
        nowIso()
    });
  }
);


// =====================================================
// ANALYSE ONE PAIR
// Costs 1 credit when not cached
// =====================================================

app.get(
  "/api/analyse",
  async (
    req,
    res
  ) => {

    try {

      const pair =
        String(
          req.query.pair ||
          "EUR/USD"
        ).toUpperCase();

      const timeframe =
        String(
          req.query.timeframe ||
          "M1"
        ).toUpperCase();

      if (
        !PAIRS.includes(
          pair
        )
      ) {

        return res
          .status(400)
          .json({
            error:
              "Invalid pair"
          });
      }

      if (
        !TIMEFRAMES.includes(
          timeframe
        )
      ) {

        return res
          .status(400)
          .json({
            error:
              "Invalid timeframe"
          });
      }

      const result =
        await fetchOnePair(
          pair
        );

      const signal =
        result[
          timeframe
        ];

      let trade =
        null;

      if (
        signal.side !==
        "WAIT"
      ) {

        trade =
          await openDemoTrade(
            signal
          );
      }

      res.json({

        ...signal,

        trade
      });

    } catch (error) {

      res
        .status(500)
        .json({

          error:
            error.message
        });
    }
  }
);


// =====================================================
// AUTO SCAN ALL 8
// Costs 8 credits once per minute maximum
// =====================================================

app.get(
  "/api/auto-scan",
  async (
    req,
    res
  ) => {

    try {

      const timeframe =
        String(
          req.query.timeframe ||
          "M1"
        ).toUpperCase();

      if (
        !TIMEFRAMES.includes(
          timeframe
        )
      ) {

        return res
          .status(400)
          .json({
            error:
              "Invalid timeframe"
          });
      }

      const scan =
        await fetchAllPairs();

      const best =
        bestSignalFromScan(
          scan,
          timeframe
        );

      if (!best) {

        return res.json({

          side:
            "WAIT",

          confidence:
            0,

          timeframe,

          reason:
            "NO_CONFIRMED_SIGNAL",

          cached:
            scan.cached,

          creditsUsed:
            scan.creditsUsed,

          creditsLeft:
            scan.creditsLeft,

          updatedAt:
            nowIso()
        });
      }

      const trade =
        await openDemoTrade(
          best
        );

      res.json({

        ...best,

        autoScan:
          true,

        cached:
          scan.cached,

        creditsUsed:
          scan.creditsUsed,

        creditsLeft:
          scan.creditsLeft,

        trade
      });

    } catch (error) {

      res
        .status(500)
        .json({

          error:
            error.message
        });
    }
  }
);


// =====================================================
// ALL SIGNALS
// =====================================================

app.get(
  "/api/signals",
  async (
    req,
    res
  ) => {

    try {

      const scan =
        await fetchAllPairs();

      res.json(
        scan
      );

    } catch (error) {

      res
        .status(500)
        .json({

          error:
            error.message
        });
    }
  }
);


// =====================================================
// OPEN TRADES
// =====================================================

app.get(
  "/api/open-trades",
  (
    req,
    res
  ) => {

    res.json(
      Array.from(
        openTrades.values()
      )
    );
  }
);


// =====================================================
// CHECK OPEN DEMO TRADES
// Uses only number of currently open pairs
// =====================================================

app.get(
  "/api/check-trades",
  async (
    req,
    res
  ) => {

    try {

      if (
        Date.now() -
        checkCache.timestamp <
          CHECK_CACHE_MS &&
        checkCache.data
      ) {

        return res.json({

          ...checkCache.data,

          cached:
            true
        });
      }

      const trades =
        Array.from(
          openTrades.values()
        );

      const expired =
        trades.filter(
          trade =>
            Date.now() >=
            new Date(
              trade.expiresAt
            ).getTime()
        );

      if (
        expired.length === 0
      ) {

        const result = {

          checked:
            0,

          closed:
            [],

          open:
            trades
        };

        checkCache = {

          timestamp:
            Date.now(),

          data:
            result
        };

        return res.json(
          result
        );
      }

      const pairs =
        [
          ...new Set(
            expired.map(
              x => x.pair
            )
          )
        ];

      const params =
        new URLSearchParams({

          symbol:
            pairs.join(","),

          apikey:
            TWELVE_DATA_API_KEY
        });

      const response =
        await fetch(
          `${TD_PRICE}?${params.toString()}`
        );

      const data =
        await response.json();

      const closed = [];

      for (
        const trade
        of expired
      ) {

        let priceData =
          data?.[
            trade.pair
          ] ||
          data?.data?.[
            trade.pair
          ];

        if (
          pairs.length === 1 &&
          data?.price
        ) {

          priceData =
            data;
        }

        const price =
          Number(
            priceData?.price
          );

        if (
          !Number.isFinite(
            price
          )
        ) {
          continue;
        }

        const finalTrade =
          settleTrade(
            trade,
            price
          );

        openTrades.delete(
          tradeKey(
            trade.pair,
            trade.timeframe
          )
        );

        addHistory(
          finalTrade
        );

        closed.push(
          finalTrade
        );

        const icon =
          finalTrade.result ===
            "WIN"
            ? "✅"
            : finalTrade.result ===
              "LOST"
              ? "❌"
              : "➖";

        await sendPush(

          `${finalTrade.pair} — ${finalTrade.result} ${icon}`,

          `${finalTrade.direction} | ${finalTrade.entry} → ${finalTrade.exit}`,

          {
            event:
              finalTrade.result,

            trade:
              finalTrade
          }
        );
      }

      const result = {

        checked:
          expired.length,

        closed,

        open:
          Array.from(
            openTrades.values()
          ),

        creditsUsed:
          response.headers.get(
            "api-credits-used"
          ),

        creditsLeft:
          response.headers.get(
            "api-credits-left"
          )
      };

      checkCache = {

        timestamp:
          Date.now(),

        data:
          result
      };

      res.json(
        result
      );

    } catch (error) {

      res
        .status(500)
        .json({

          error:
            error.message
        });
    }
  }
);


// =====================================================
// HISTORY
// =====================================================

app.get(
  "/api/history",
  (
    req,
    res
  ) => {

    const limit =
      Math.max(
        1,
        Math.min(
          MAX_HISTORY,
          Number(
            req.query.limit ||
            100
          )
        )
      );

    res.json({

      stats:
        getStats(),

      history:
        history.slice(
          0,
          limit
        )
    });
  }
);


// =====================================================
// STATS
// =====================================================

app.get(
  "/api/stats",
  (
    req,
    res
  ) => {

    res.json(
      getStats()
    );
  }
);


// =====================================================
// TEST PUSH
// =====================================================

app.get(
  "/api/test-notification",
  async (
    req,
    res
  ) => {

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


app.post(
  "/api/test-notification",
  async (
    req,
    res
  ) => {

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
// START
// =====================================================

app.listen(
  PORT,
  () => {

    loadHistory();

    console.log(
      "===================================="
    );

    console.log(
      `ADAMS OPTION PORT ${PORT}`
    );

    console.log(
      "POCKET MODE 3.0"
    );

    console.log(
      "M1 / M5 / M15"
    );

    console.log(
      "8 PAIR ON-DEMAND AUTO SCAN"
    );

    console.log(
      "MIN CONFIDENCE:",
      MIN_CONFIDENCE + "%"
    );

    console.log(
      TWELVE_DATA_API_KEY
        ? "TWELVE DATA KEY OK"
        : "TWELVE DATA KEY MISSING"
    );

    console.log(
      (
        ONESIGNAL_APP_ID &&
        ONESIGNAL_REST_API_KEY
      )
        ? "ONESIGNAL OK"
        : "ONESIGNAL MISSING"
    );

    console.log(
      "===================================="
    );
  }
);
