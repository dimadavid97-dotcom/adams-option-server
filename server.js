import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import WebSocket from "ws";

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

const TF_SECONDS = {
  M1: 60,
  M5: 300,
  M15: 900
};

const HISTORY_FILE = "./history.json";

const MAX_HISTORY = 500;

const MAX_CANDLES = 220;

const MAX_OPEN_TRADES = 2;

const HEARTBEAT_MS = 10000;

const PING_MS = 30000;

const RECONNECT_MAX_MS = 30000;

const STALE_FEED_MS = 120000;


// =====================================================
// URLS
// =====================================================

const TD_WS_BASE =
  "wss://ws.twelvedata.com/v1/quotes/price";

const TD_TIME_SERIES =
  "https://api.twelvedata.com/time_series";

const ONESIGNAL_URL =
  "https://api.onesignal.com/notifications";


// =====================================================
// MEMORY
// =====================================================

const states = new Map();

const signals = new Map();

const openTrades = new Map();

const lastTradeTime = new Map();

let history = [];

let wins = 0;

let losses = 0;

let draws = 0;

let ws = null;

let wsConnected = false;

let wsLastEvent = null;

let acceptedSymbols = [];

let rejectedSymbols = [];

let reconnectAttempt = 0;

let reconnectTimer = null;

let heartbeatTimer = null;

let pingTimer = null;

let shuttingDown = false;

let warmingUp = false;


// =====================================================
// HELPERS
// =====================================================

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round(value, digits = 5) {

  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}

function digitsForPair(pair) {

  return pair.includes("JPY")
    ? 3
    : 5;
}

function formatPrice(pair, value) {

  return round(
    Number(value),
    digitsForPair(pair)
  );
}

function tradeKey(pair, timeframe) {

  return `${pair}|${timeframe}`;
}

function expiryMs(timeframe) {

  if (timeframe === "M15") {
    return 15 * 60 * 1000;
  }

  if (timeframe === "M5") {
    return 5 * 60 * 1000;
  }

  return 60 * 1000;
}

function cooldownMs(timeframe) {

  if (timeframe === "M15") {
    return 15 * 60 * 1000;
  }

  if (timeframe === "M5") {
    return 5 * 60 * 1000;
  }

  return 2 * 60 * 1000;
}

function feedIsFresh(state) {

  if (!state?.lastTickAt) {
    return false;
  }

  const age =
    Date.now() -
    new Date(state.lastTickAt).getTime();

  return age <= STALE_FEED_MS;
}


// =====================================================
// STATE
// =====================================================

function ensureState(pair) {

  if (!states.has(pair)) {

    states.set(pair, {

      pair,

      lastPrice: null,

      lastTickAt: null,

      current: {
        M1: null,
        M5: null,
        M15: null
      },

      closed: {
        M1: [],
        M5: [],
        M15: []
      }
    });
  }

  return states.get(pair);
}


// =====================================================
// HISTORY
// =====================================================

function loadHistory() {

  try {

    if (!fs.existsSync(HISTORY_FILE)) {
      return;
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          HISTORY_FILE,
          "utf8"
        )
      );

    if (Array.isArray(parsed)) {

      history =
        parsed.slice(
          0,
          MAX_HISTORY
        );
    }

  } catch (error) {

    console.log(
      "History load warning:",
      error.message
    );

    history = [];
  }

  wins =
    history.filter(
      x => x.result === "WIN"
    ).length;

  losses =
    history.filter(
      x => x.result === "LOST"
    ).length;

  draws =
    history.filter(
      x => x.result === "DRAW"
    ).length;
}

function saveHistory() {

  try {

    fs.writeFileSync(

      HISTORY_FILE,

      JSON.stringify(
        history.slice(0, MAX_HISTORY),
        null,
        2
      ),

      "utf8"
    );

  } catch (error) {

    console.log(
      "History save warning:",
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

  if (trade.result === "WIN") {
    wins += 1;
  }

  if (trade.result === "LOST") {
    losses += 1;
  }

  if (trade.result === "DRAW") {
    draws += 1;
  }

  saveHistory();
}


// =====================================================
// INDICATORS
// =====================================================

function ema(values, period) {

  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let current =
    values
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

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

function rsi(values, period = 14) {

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
    let i = start + 1;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];

    if (diff > 0) {

      gains += diff;

    } else {

      lossesLocal +=
        Math.abs(diff);
    }
  }

  const avgGain =
    gains / period;

  const avgLoss =
    lossesLocal / period;

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

function momentum(values, period = 3) {

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
// MULTI TIMEFRAME CONFIRMATION
// =====================================================

function confirmationForPair(
  pair,
  timeframe,
  side
) {

  const check = [];

  if (timeframe === "M1") {

    check.push(
      signals.get(
        tradeKey(pair, "M5")
      )
    );
  }

  if (timeframe === "M5") {

    check.push(
      signals.get(
        tradeKey(pair, "M15")
      )
    );
  }

  if (timeframe === "M15") {

    check.push(
      signals.get(
        tradeKey(pair, "M5")
      )
    );
  }

  let bonus = 0;

  for (const signal of check) {

    if (!signal) {
      continue;
    }

    if (signal.side === side) {
      bonus += 6;
    }

    if (
      signal.side !== "WAIT" &&
      signal.side !== side
    ) {
      bonus -= 8;
    }
  }

  return bonus;
}


// =====================================================
// SIGNAL ANALYSIS
// =====================================================

function analyseSignal(
  pair,
  timeframe,
  candles,
  livePrice
) {

  if (
    !candles ||
    candles.length < 20 ||
    !Number.isFinite(livePrice)
  ) {

    return {

      pair,

      timeframe,

      side: "WAIT",

      confidence: 0,

      reason: "WARMING_UP",

      bars:
        candles?.length || 0,

      updatedAt:
        nowIso()
    };
  }

  const recent =
    candles.slice(-80);

  const closes =
    recent.map(
      candle => candle.close
    );

  const last =
    recent[
      recent.length - 1
    ];

  const fast =
    ema(closes, 5);

  const slow =
    ema(closes, 13);

  const currentRsi =
    rsi(closes, 14);

  const mom =
    momentum(closes, 3);

  if (
    !Number.isFinite(fast) ||
    !Number.isFinite(slow) ||
    !Number.isFinite(currentRsi)
  ) {

    return {

      pair,
      timeframe,
      side: "WAIT",
      confidence: 0,
      reason: "INDICATORS_WARMING",
      bars: recent.length,
      updatedAt: nowIso()
    };
  }

  let score = 0;

  // EMA TREND

  if (fast > slow) {
    score += 3;
  }

  if (fast < slow) {
    score -= 3;
  }

  // PRICE VS EMA

  if (last.close > fast) {
    score += 1;
  }

  if (last.close < fast) {
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

  // MOMENTUM

  if (mom > 0) {
    score += 1;
  }

  if (mom < 0) {
    score -= 1;
  }

  // LAST CANDLE

  if (last.close > last.open) {
    score += 1;
  }

  if (last.close < last.open) {
    score -= 1;
  }

  let side = "WAIT";

  if (score >= 6) {
    side = "CALL";
  }

  if (score <= -6) {
    side = "PUT";
  }

  let confidence =
    Math.min(
      96,
      52 +
      Math.abs(score) * 5
    );

  if (side !== "WAIT") {

    confidence +=
      confirmationForPair(
        pair,
        timeframe,
        side
      );

    confidence =
      Math.max(
        0,
        Math.min(
          98,
          confidence
        )
      );
  }

  if (
    side !== "WAIT" &&
    confidence < MIN_CONFIDENCE
  ) {

    side = "WAIT";
  }

  if (side === "WAIT") {

    confidence =
      Math.min(
        confidence,
        MIN_CONFIDENCE - 1
      );
  }

  return {

    pair,

    timeframe,

    side,

    confidence:
      Math.round(confidence),

    score,

    entry:
      formatPrice(
        pair,
        livePrice
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
      await response
        .json()
        .catch(() => ({}));

    if (!response.ok) {

      console.log(
        "OneSignal error:",
        result
      );

      return false;
    }

    console.log(
      "Push sent:",
      title
    );

    return true;

  } catch (error) {

    console.log(
      "OneSignal send error:",
      error.message
    );

    return false;
  }
}


// =====================================================
// OPEN DEMO TRADE
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

  const id =
    tradeKey(
      pair,
      timeframe
    );

  if (
    openTrades.has(id)
  ) {
    return false;
  }

  const last =
    lastTradeTime.get(id)
    || 0;

  return (
    Date.now() -
    last >=
    cooldownMs(timeframe)
  );
}

async function openTradeFromSignal(
  signal
) {

  if (
    warmingUp ||
    signal.side === "WAIT" ||
    signal.confidence <
      MIN_CONFIDENCE
  ) {
    return;
  }

  const state =
    ensureState(signal.pair);

  if (!feedIsFresh(state)) {
    return;
  }

  if (
    !canOpenTrade(
      signal.pair,
      signal.timeframe
    )
  ) {
    return;
  }

  const openedAtMs =
    Date.now();

  const id =
    tradeKey(
      signal.pair,
      signal.timeframe
    );

  const trade = {

    id:
      `${openedAtMs}-${signal.pair.replace(
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

    mode:
      "DEMO",

    openedAt:
      new Date(
        openedAtMs
      ).toISOString(),

    expiresAt:
      new Date(
        openedAtMs +
        expiryMs(
          signal.timeframe
        )
      ).toISOString(),

    closedAt:
      null
  };

  openTrades.set(
    id,
    trade
  );

  lastTradeTime.set(
    id,
    openedAtMs
  );

  await sendPush(

    `ADAMS OPTION — ${trade.direction} ${trade.pair}`,

    `${trade.timeframe} | ${trade.confidence}% | Entry ${trade.entry}`,

    {
      event:
        "NEW_SIGNAL",

      trade
    }
  );

  console.log(
    "NEW DEMO SIGNAL:",
    trade.pair,
    trade.timeframe,
    trade.direction,
    trade.confidence + "%"
  );
}


// =====================================================
// SETTLE TRADES
// =====================================================

async function settleExpiredTrades(
  pair,
  currentPrice,
  tickTimeMs
) {

  for (
    const timeframe
    of TIMEFRAMES
  ) {

    const id =
      tradeKey(
        pair,
        timeframe
      );

    const trade =
      openTrades.get(id);

    if (!trade) {
      continue;
    }

    const expiresAtMs =
      new Date(
        trade.expiresAt
      ).getTime();

    if (
      tickTimeMs <
      expiresAtMs
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

      if (exit > trade.entry) {
        result = "WIN";
      }

      if (exit < trade.entry) {
        result = "LOST";
      }
    }

    if (
      trade.direction === "PUT"
    ) {

      if (exit < trade.entry) {
        result = "WIN";
      }

      if (exit > trade.entry) {
        result = "LOST";
      }
    }

    const closedTrade = {

      ...trade,

      exit,

      result,

      closedAt:
        new Date(
          tickTimeMs
        ).toISOString()
    };

    openTrades.delete(id);

    addHistory(
      closedTrade
    );

    const icon =
      result === "WIN"
        ? "✅"
        : result === "LOST"
          ? "❌"
          : "➖";

    await sendPush(

      `${pair} ${timeframe} — ${result} ${icon}`,

      `${trade.direction} | ${trade.entry} → ${exit}`,

      {
        event:
          result,

        trade:
          closedTrade
      }
    );

    console.log(
      "RESULT:",
      pair,
      timeframe,
      result,
      trade.entry,
      "->",
      exit
    );
  }
}


// =====================================================
// CANDLE ENGINE
// =====================================================

function candleBucket(
  timestampSec,
  intervalSec
) {

  return (
    Math.floor(
      timestampSec /
      intervalSec
    ) *
    intervalSec
  );
}

async function updateCandle(
  pair,
  timeframe,
  priceValue,
  timestampSec
) {

  const state =
    ensureState(pair);

  const intervalSec =
    TF_SECONDS[timeframe];

  const bucket =
    candleBucket(
      timestampSec,
      intervalSec
    );

  let current =
    state.current[
      timeframe
    ];

  if (!current) {

    state.current[
      timeframe
    ] = {

      start:
        bucket,

      open:
        priceValue,

      high:
        priceValue,

      low:
        priceValue,

      close:
        priceValue
    };

    return;
  }

  if (
    bucket ===
    current.start
  ) {

    current.high =
      Math.max(
        current.high,
        priceValue
      );

    current.low =
      Math.min(
        current.low,
        priceValue
      );

    current.close =
      priceValue;

    return;
  }

  if (
    bucket <
    current.start
  ) {
    return;
  }

  state.closed[
    timeframe
  ].push({
    ...current
  });

  if (
    state.closed[
      timeframe
    ].length >
    MAX_CANDLES
  ) {

    state.closed[
      timeframe
    ].shift();
  }

  state.current[
    timeframe
  ] = {

    start:
      bucket,

    open:
      priceValue,

    high:
      priceValue,

    low:
      priceValue,

    close:
      priceValue
  };

  const signal =
    analyseSignal(

      pair,

      timeframe,

      state.closed[
        timeframe
      ],

      priceValue
    );

  signals.set(

    tradeKey(
      pair,
      timeframe
    ),

    signal
  );

  console.log(
    pair,
    timeframe,
    signal.side,
    signal.confidence + "%"
  );

  await openTradeFromSignal(
    signal
  );
}


// =====================================================
// LIVE PRICE EVENT
// =====================================================

async function handlePriceEvent(
  message
) {

  const pair =
    String(
      message.symbol || ""
    ).toUpperCase();

  if (
    !PAIRS.includes(pair)
  ) {
    return;
  }

  const priceValue =
    Number(
      message.price
    );

  const timestampSec =
    Number(
      message.timestamp
    );

  if (
    !Number.isFinite(priceValue) ||
    !Number.isFinite(timestampSec)
  ) {
    return;
  }

  const state =
    ensureState(pair);

  state.lastPrice =
    formatPrice(
      pair,
      priceValue
    );

  state.lastTickAt =
    new Date(
      timestampSec *
      1000
    ).toISOString();

  wsLastEvent =
    nowIso();

  await settleExpiredTrades(
    pair,
    priceValue,
    timestampSec * 1000
  );

  await updateCandle(
    pair,
    "M1",
    priceValue,
    timestampSec
  );

  await updateCandle(
    pair,
    "M5",
    priceValue,
    timestampSec
  );

  await updateCandle(
    pair,
    "M15",
    priceValue,
    timestampSec
  );
}


// =====================================================
// BUILD HIGHER TIMEFRAME FROM M1
// =====================================================

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
      candleBucket(
        candle.start,
        intervalSec
      );

    if (
      !groups.has(bucket)
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

  return Array
    .from(
      groups.values()
    )
    .sort(
      (a, b) =>
        a.start - b.start
    )
    .slice(
      -MAX_CANDLES
    );
}


// =====================================================
// STARTUP HISTORICAL WARMUP
// Uses only 1-minute request per pair
// M5/M15 are built locally
// =====================================================

async function warmPair(pair) {

  if (!TWELVE_DATA_API_KEY) {
    return;
  }

  try {

    const url =
      `${TD_TIME_SERIES}` +
      `?symbol=${encodeURIComponent(pair)}` +
      `&interval=1min` +
      `&outputsize=${MAX_CANDLES}` +
      `&apikey=${encodeURIComponent(
        TWELVE_DATA_API_KEY
      )}`;

    console.log(
      "Warming:",
      pair
    );

    const response =
      await fetch(url);

    const data =
      await response.json();

    if (
      !response.ok ||
      !Array.isArray(data.values)
    ) {

      console.log(
        "Warmup failed:",
        pair,
        data?.message ||
        data?.status ||
        "unknown"
      );

      return;
    }

    const m1 =
      data.values
        .map(row => ({

          start:
            Math.floor(
              new Date(
                row.datetime.replace(
                  " ",
                  "T"
                ) + "Z"
              ).getTime() /
              1000
            ),

          open:
            Number(row.open),

          high:
            Number(row.high),

          low:
            Number(row.low),

          close:
            Number(row.close)
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
          (a, b) =>
            a.start - b.start
        );

    const state =
      ensureState(pair);

    state.closed.M1 =
      m1.slice(
        -MAX_CANDLES
      );

    state.closed.M5 =
      aggregateCandles(
        m1,
        300
      );

    state.closed.M15 =
      aggregateCandles(
        m1,
        900
      );

    if (m1.length) {

      const last =
        m1[
          m1.length - 1
        ];

      state.lastPrice =
        formatPrice(
          pair,
          last.close
        );

      for (
        const timeframe
        of TIMEFRAMES
      ) {

        const signal =
          analyseSignal(

            pair,

            timeframe,

            state.closed[
              timeframe
            ],

            last.close
          );

        signals.set(

          tradeKey(
            pair,
            timeframe
          ),

          signal
        );
      }
    }

    console.log(
      "Warmup ready:",
      pair,
      "M1",
      state.closed.M1.length,
      "M5",
      state.closed.M5.length,
      "M15",
      state.closed.M15.length
    );

  } catch (error) {

    console.log(
      "Warmup error:",
      pair,
      error.message
    );
  }
}

async function warmAllPairs() {

  if (
    !TWELVE_DATA_API_KEY
  ) {
    return;
  }

  warmingUp = true;

  console.log(
    "========================================"
  );

  console.log(
    "STARTING HISTORICAL WARMUP"
  );

  console.log(
    "8 pairs / 1 request each"
  );

  console.log(
    "========================================"
  );

  for (
    let i = 0;
    i < PAIRS.length;
    i++
  ) {

    await warmPair(
      PAIRS[i]
    );

    if (
      i <
      PAIRS.length - 1
    ) {

      // Protect low API credit plans

      await sleep(8500);
    }
  }

  warmingUp = false;

  console.log(
    "HISTORICAL WARMUP COMPLETE"
  );
}


// =====================================================
// WEBSOCKET MESSAGE
// =====================================================

async function handleWsMessage(
  raw
) {

  let message;

  try {

    message =
      JSON.parse(
        raw.toString()
      );

  } catch {

    return;
  }

  if (
    message.event === "price"
  ) {

    await handlePriceEvent(
      message
    );

    return;
  }

  if (
    message.event ===
    "subscribe-status"
  ) {

    acceptedSymbols =
      Array.isArray(
        message.success
      )
        ? message.success
            .map(
              x => x.symbol
            )
            .filter(Boolean)
        : acceptedSymbols;

    const rejected =
      message.fails ||
      message.failed ||
      message.errors ||
      [];

    rejectedSymbols =
      Array.isArray(
        rejected
      )
        ? rejected.map(
            x =>
              x.symbol ||
              x.message ||
              JSON.stringify(x)
          )
        : rejectedSymbols;

    console.log(
      "SUBSCRIBE STATUS:",
      JSON.stringify(message)
    );

    return;
  }

  if (
    message.event ===
    "heartbeat"
  ) {
    return;
  }

  console.log(
    "WS EVENT:",
    JSON.stringify(message)
  );
}


// =====================================================
// WEBSOCKET TIMERS
// =====================================================

function clearWsTimers() {

  if (heartbeatTimer) {

    clearInterval(
      heartbeatTimer
    );
  }

  if (pingTimer) {

    clearInterval(
      pingTimer
    );
  }

  heartbeatTimer = null;

  pingTimer = null;
}


// =====================================================
// RECONNECT
// =====================================================

function scheduleReconnect() {

  if (
    shuttingDown ||
    reconnectTimer
  ) {
    return;
  }

  reconnectAttempt += 1;

  const waitMs =
    Math.min(

      RECONNECT_MAX_MS,

      1000 *
      2 **
      Math.min(
        reconnectAttempt - 1,
        5
      )
    );

  console.log(
    "WebSocket reconnect in",
    Math.round(
      waitMs / 1000
    ),
    "seconds"
  );

  reconnectTimer =
    setTimeout(
      () => {

        reconnectTimer =
          null;

        connectWebSocket();

      },
      waitMs
    );
}


// =====================================================
// CONNECT WEBSOCKET
// =====================================================

function connectWebSocket() {

  if (!TWELVE_DATA_API_KEY) {

    console.log(
      "TWELVE DATA KEY MISSING"
    );

    return;
  }

  if (
    ws &&
    (
      ws.readyState ===
        WebSocket.OPEN ||
      ws.readyState ===
        WebSocket.CONNECTING
    )
  ) {
    return;
  }

  const socketUrl =
    `${TD_WS_BASE}?apikey=${encodeURIComponent(
      TWELVE_DATA_API_KEY
    )}`;

  console.log(
    "Connecting Twelve Data WebSocket..."
  );

  ws =
    new WebSocket(
      socketUrl
    );

  ws.on(
    "open",
    () => {

      wsConnected = true;

      reconnectAttempt = 0;

      acceptedSymbols = [];

      rejectedSymbols = [];

      console.log(
        "TWELVE DATA WEBSOCKET CONNECTED"
      );

      ws.send(
        JSON.stringify({

          action:
            "subscribe",

          params: {

            symbols:
              PAIRS.join(",")
          }
        })
      );

      clearWsTimers();

      heartbeatTimer =
        setInterval(
          () => {

            if (
              ws?.readyState ===
              WebSocket.OPEN
            ) {

              ws.send(
                JSON.stringify({
                  action:
                    "heartbeat"
                })
              );
            }

          },
          HEARTBEAT_MS
        );

      pingTimer =
        setInterval(
          () => {

            if (
              ws?.readyState ===
              WebSocket.OPEN
            ) {

              ws.ping();
            }

          },
          PING_MS
        );
    }
  );

  ws.on(
    "message",
    raw => {

      handleWsMessage(
        raw
      ).catch(
        error => {

          console.log(
            "WS MESSAGE ERROR:",
            error.message
          );
        }
      );
    }
  );

  ws.on(
    "error",
    error => {

      console.log(
        "WEBSOCKET ERROR:",
        error.message
      );
    }
  );

  ws.on(
    "close",
    (
      code,
      reason
    ) => {

      wsConnected = false;

      clearWsTimers();

      console.log(
        "WEBSOCKET CLOSED:",
        code,
        reason?.toString() ||
        ""
      );

      scheduleReconnect();
    }
  );
}


// =====================================================
// STATS
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

    totalHistory:
      history.length,

    wins,

    losses,

    draws,

    winRate,

    openTrades:
      openTrades.size,

    maxOpenTrades:
      MAX_OPEN_TRADES
  };
}


// =====================================================
// WS STATUS
// =====================================================

function wsStatus() {

  const pairStatus = {};

  for (
    const pair
    of PAIRS
  ) {

    const state =
      ensureState(pair);

    pairStatus[pair] = {

      lastPrice:
        state.lastPrice,

      lastTickAt:
        state.lastTickAt,

      feedFresh:
        feedIsFresh(state),

      m1Bars:
        state.closed.M1.length,

      m5Bars:
        state.closed.M5.length,

      m15Bars:
        state.closed.M15.length
    };
  }

  return {

    connected:
      wsConnected,

    warmingUp,

    acceptedSymbols,

    rejectedSymbols,

    lastEvent:
      wsLastEvent,

    pairs:
      pairStatus
  };
}


// =====================================================
// GET BEST SIGNAL
// =====================================================

function getBestSignal(
  timeframe = null
) {

  const all = [];

  for (
    const pair
    of PAIRS
  ) {

    for (
      const tf
      of TIMEFRAMES
    ) {

      if (
        timeframe &&
        tf !== timeframe
      ) {
        continue;
      }

      const signal =
        signals.get(
          tradeKey(
            pair,
            tf
          )
        );

      if (
        !signal ||
        signal.side === "WAIT"
      ) {
        continue;
      }

      const state =
        ensureState(pair);

      if (
        !feedIsFresh(state)
      ) {
        continue;
      }

      all.push(signal);
    }
  }

  all.sort(
    (a, b) =>
      b.confidence -
      a.confidence
  );

  return (
    all[0] ||
    null
  );
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

      version:
        "POCKET MODE 2.0",

      mode:
        "DEMO SIGNALS / MANUAL POCKET OPTION EXECUTION",

      pairs:
        PAIRS,

      timeframes:
        TIMEFRAMES,

      minConfidence:
        MIN_CONFIDENCE,

      websocket:
        wsStatus(),

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
  (req, res) => {

    res.json({

      ok: true,

      websocketConnected:
        wsConnected,

      warmingUp,

      lastEvent:
        wsLastEvent,

      timestamp:
        nowIso()
    });
  }
);


// =====================================================
// WS STATUS
// =====================================================

app.get(
  "/api/ws-status",
  (req, res) => {

    res.json(
      wsStatus()
    );
  }
);


// =====================================================
// SIGNALS
// =====================================================

app.get(
  "/api/signals",
  (req, res) => {

    const result = {};

    for (
      const pair
      of PAIRS
    ) {

      result[pair] = {};

      for (
        const timeframe
        of TIMEFRAMES
      ) {

        result[pair][
          timeframe
        ] =
          signals.get(
            tradeKey(
              pair,
              timeframe
            )
          )
          || {

            pair,

            timeframe,

            side:
              "WAIT",

            confidence:
              0,

            reason:
              "WARMING_UP"
          };
      }
    }

    res.json(result);
  }
);


// =====================================================
// ANALYSE ONE PAIR
// Example:
// /api/analyse?pair=EUR/USD&timeframe=M1
// =====================================================

app.get(
  "/api/analyse",
  (req, res) => {

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
      !PAIRS.includes(pair)
    ) {

      return res.status(400)
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

      return res.status(400)
        .json({

          error:
            "Invalid timeframe"
        });
    }

    const state =
      ensureState(pair);

    const signal =
      signals.get(
        tradeKey(
          pair,
          timeframe
        )
      )
      || {

        pair,

        timeframe,

        side:
          "WAIT",

        confidence:
          0,

        reason:
          "WARMING_UP"
      };

    res.json({

      ...signal,

      price:
        state.lastPrice,

      feedFresh:
        feedIsFresh(state),

      openTrade:
        openTrades.get(
          tradeKey(
            pair,
            timeframe
          )
        ) || null
    });
  }
);


// =====================================================
// AUTO SCAN
// Example:
// /api/auto-scan?timeframe=M1
// =====================================================

app.get(
  "/api/auto-scan",
  (req, res) => {

    const requested =
      req.query.timeframe
        ? String(
            req.query.timeframe
          ).toUpperCase()
        : null;

    if (
      requested &&
      !TIMEFRAMES.includes(
        requested
      )
    ) {

      return res.status(400)
        .json({

          error:
            "Invalid timeframe"
        });
    }

    const best =
      getBestSignal(
        requested
      );

    if (!best) {

      return res.json({

        side:
          "WAIT",

        confidence:
          0,

        reason:
          "NO_CONFIRMED_SIGNAL",

        timeframe:
          requested ||
          "ALL",

        updatedAt:
          nowIso()
      });
    }

    res.json({

      ...best,

      autoScan:
        true
    });
  }
);


// =====================================================
// BEST SIGNAL
// =====================================================

app.get(
  "/api/best-signal",
  (req, res) => {

    const best =
      getBestSignal();

    if (!best) {

      return res.json({

        side:
          "WAIT",

        confidence:
          0,

        reason:
          "NO_CONFIRMED_SIGNAL",

        updatedAt:
          nowIso()
      });
    }

    res.json(best);
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
// HISTORY
// =====================================================

app.get(
  "/api/history",
  (req, res) => {

    const requestedLimit =
      Number(
        req.query.limit ||
        100
      );

    const limit =
      Math.max(
        1,
        Math.min(
          MAX_HISTORY,
          requestedLimit
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
  (req, res) => {

    res.json(
      getStats()
    );
  }
);


// =====================================================
// TEST NOTIFICATION
// =====================================================

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
        : "missing env vars"
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


// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  async () => {

    loadHistory();

    console.log(
      "========================================"
    );

    console.log(
      `ADAMS OPTION running on port ${PORT}`
    );

    console.log(
      "MODE: POCKET OPTION DEMO / MANUAL"
    );

    console.log(
      "TIMEFRAMES: M1 M5 M15"
    );

    console.log(
      "MIN CONFIDENCE:",
      MIN_CONFIDENCE + "%"
    );

    console.log(
      "MAX OPEN DEMO TRADES:",
      MAX_OPEN_TRADES
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
        ? "ONESIGNAL loaded"
        : "ONESIGNAL missing"
    );

    console.log(
      "========================================"
    );

    connectWebSocket();

    warmAllPairs()
      .catch(
        error => {

          warmingUp = false;

          console.log(
            "Warmup fatal error:",
            error.message
          );
        }
      );
  }
);


// =====================================================
// SAFE SHUTDOWN
// =====================================================

function shutdown() {

  shuttingDown = true;

  clearWsTimers();

  if (reconnectTimer) {

    clearTimeout(
      reconnectTimer
    );
  }

  try {

    if (
      ws?.readyState ===
      WebSocket.OPEN
    ) {

      ws.send(
        JSON.stringify({
          action:
            "reset"
        })
      );

      ws.close(
        1000,
        "server shutdown"
      );
    }

  } catch {}

  process.exit(0);
}

process.on(
  "SIGTERM",
  shutdown
);

process.on(
  "SIGINT",
  shutdown
);
