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

const HISTORY_FILE = "./history.json";

const MAX_HISTORY = 500;

const MAX_CANDLES = 200;

const HEARTBEAT_MS = 10000;

const PING_MS = 30000;

const RECONNECT_MAX_MS = 30000;


// Build URLs without exposing keys in source code.

const TD_WS_BASE = [
  "wss:",
  "",
  "ws.twelvedata.com",
  "v1",
  "quotes",
  "price"
].join("/");

const ONESIGNAL_URL = [
  "https:",
  "",
  "api.onesignal.com",
  "notifications"
].join("/");


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


// =====================================================
// HELPERS
// =====================================================

function round(value, digits = 5) {

  if (!Number.isFinite(value)) {
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


function formatPrice(pair, value) {

  return round(
    Number(value),
    digitsForPair(pair)
  );
}


function nowIso() {

  return new Date()
    .toISOString();
}


function tradeKey(
  pair,
  timeframe
) {

  return `${pair}|${timeframe}`;
}


function expiryMs(timeframe) {

  return timeframe === "M5"
    ? 5 * 60 * 1000
    : 60 * 1000;
}


function cooldownMs(timeframe) {

  return timeframe === "M5"
    ? 5 * 60 * 1000
    : 2 * 60 * 1000;
}


// =====================================================
// PAIR STATE
// =====================================================

function ensureState(pair) {

  if (!states.has(pair)) {

    states.set(
      pair,
      {
        pair,

        lastPrice: null,

        lastTickAt: null,

        currentM1: null,

        currentM5: null,

        closedM1: [],

        closedM5: []
      }
    );
  }

  return states.get(pair);
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

    const parsed =
      JSON.parse(
        fs.readFileSync(
          HISTORY_FILE,
          "utf8"
        )
      );

    if (
      Array.isArray(parsed)
    ) {

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


  if (
    trade.result === "WIN"
  ) {

    wins += 1;
  }


  if (
    trade.result === "LOST"
  ) {

    losses += 1;
  }


  if (
    trade.result === "DRAW"
  ) {

    draws += 1;
  }


  saveHistory();
}


// =====================================================
// EMA
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


// =====================================================
// RSI
// =====================================================

function rsi(
  values,
  period = 7
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
    let i = start + 1;
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
    gains / period;


  const avgLoss =
    lossesLocal / period;


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
    100 / (1 + rs)
  );
}


// =====================================================
// MOMENTUM
// =====================================================

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
    candles.length < 8 ||
    !Number.isFinite(
      livePrice
    )
  ) {

    return {

      pair,

      timeframe,

      side: "WAIT",

      confidence: 0,

      reason:
        "WARMING_UP",

      bars:
        candles?.length || 0,

      updatedAt:
        nowIso()
    };
  }


  const recent =
    candles.slice(-40);


  const closes =
    recent.map(
      candle =>
        candle.close
    );


  const last =
    recent[
      recent.length - 1
    ];


  const fast =
    ema(
      closes,
      3
    );


  const slow =
    ema(
      closes,
      7
    );


  const currentRsi =
    rsi(
      closes,
      7
    );


  const mom =
    momentum(
      closes,
      3
    );


  let score = 0;


  if (
    fast > slow
  ) {

    score += 2;
  }


  if (
    fast < slow
  ) {

    score -= 2;
  }


  if (
    last.close > fast
  ) {

    score += 1;
  }


  if (
    last.close < fast
  ) {

    score -= 1;
  }


  if (
    currentRsi >= 55 &&
    currentRsi <= 72
  ) {

    score += 1;
  }


  if (
    currentRsi <= 45 &&
    currentRsi >= 28
  ) {

    score -= 1;
  }


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


    if (
      !response.ok
    ) {

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
// OPEN TRADE
// =====================================================

function canOpenTrade(
  pair,
  timeframe
) {

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
    signal.side === "WAIT"
  ) {

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

    "NEW SIGNAL",

    trade.pair,

    trade.timeframe,

    trade.direction,

    trade.confidence + "%"
  );
}


// =====================================================
// WIN / LOST
// =====================================================

async function settleExpiredTrades(
  pair,
  currentPrice,
  tickTimeMs
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

      `${trade.pair} ${trade.timeframe} — ${result} ${icon}`,

      `${trade.direction} | Entry ${trade.entry} | Exit ${exit}`,

      {
        event:
          result,

        trade:
          closedTrade
      }
    );


    console.log(

      "RESULT",

      trade.pair,

      trade.timeframe,

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
  intervalSec,
  priceValue,
  timestampSec
) {

  const state =
    ensureState(pair);


  const currentKey =
    timeframe === "M1"
      ? "currentM1"
      : "currentM5";


  const closedKey =
    timeframe === "M1"
      ? "closedM1"
      : "closedM5";


  const bucket =
    candleBucket(
      timestampSec,
      intervalSec
    );


  let current =
    state[currentKey];


  if (!current) {

    state[currentKey] = {

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


  state[closedKey]
    .push({
      ...current
    });


  if (
    state[closedKey]
      .length >
    MAX_CANDLES
  ) {

    state[closedKey]
      .shift();
  }


  state[currentKey] = {

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

      state[closedKey],

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

    signal.confidence + "%",

    "bars",

    signal.bars
  );


  await openTradeFromSignal(
    signal
  );
}


// =====================================================
// PRICE EVENT
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
    !Number.isFinite(
      priceValue
    ) ||
    !Number.isFinite(
      timestampSec
    )
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

    timestampSec *
    1000
  );


  await updateCandle(

    pair,

    "M1",

    60,

    priceValue,

    timestampSec
  );


  await updateCandle(

    pair,

    "M5",

    300,

    priceValue,

    timestampSec
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
    message.event ===
    "price"
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
      JSON.stringify(
        message
      )
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
    JSON.stringify(
      message
    )
  );
}


// =====================================================
// WEBSOCKET TIMERS
// =====================================================

function clearWsTimers() {

  if (
    heartbeatTimer
  ) {

    clearInterval(
      heartbeatTimer
    );
  }


  if (
    pingTimer
  ) {

    clearInterval(
      pingTimer
    );
  }


  heartbeatTimer =
    null;


  pingTimer =
    null;
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

  if (
    !TWELVE_DATA_API_KEY
  ) {

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

      wsConnected =
        true;


      reconnectAttempt =
        0;


      acceptedSymbols =
        [];


      rejectedSymbols =
        [];


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

      wsConnected =
        false;


      clearWsTimers();


      console.log(

        "WEBSOCKET CLOSED:",

        code,

        reason?.toString()
        || ""
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
      openTrades.size
  };
}


// =====================================================
// WEBSOCKET STATUS
// =====================================================

function wsStatus() {

  const pairStatus =
    {};


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

      m1Bars:
        state.closedM1.length,

      m5Bars:
        state.closedM5.length
    };
  }


  return {

    connected:
      wsConnected,

    acceptedSymbols,

    rejectedSymbols,

    lastEvent:
      wsLastEvent,

    pairs:
      pairStatus
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
        "POCKET OPTION SIGNALS / MANUAL EXECUTION",

      feed:
        "TWELVE DATA WEBSOCKET",

      pairs:
        PAIRS,

      timeframes: [
        "M1",
        "M5"
      ],

      oneSignal:
        (
          ONESIGNAL_APP_ID &&
          ONESIGNAL_REST_API_KEY
        )

          ? "ready"

          : "missing env vars",

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

    const result =
      {};


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
          )
          || {

            pair,

            timeframe:
              "M1",

            side:
              "WAIT",

            confidence:
              0,

            reason:
              "WARMING_UP"
          },


        M5:
          signals.get(
            tradeKey(
              pair,
              "M5"
            )
          )
          || {

            pair,

            timeframe:
              "M5",

            side:
              "WAIT",

            confidence:
              0,

            reason:
              "WARMING_UP"
          }
      };
    }


    res.json(result);
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
// TEST NOTIFICATION
// =====================================================

async function testNotification(
  req,
  res
) {

  const success =
    await sendPush(

      "ADAMS OPTION ✅",

      "OneSignal notifications are working."
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
  () => {

    loadHistory();


    console.log(
      "========================================"
    );


    console.log(
      `ADAMS OPTION SERVER running on port ${PORT}`
    );


    console.log(
      "MODE: POCKET OPTION SIGNALS / WEBSOCKET"
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
      "NO TWELVE DATA REST POLLING"
    );


    console.log(
      "========================================"
    );


    connectWebSocket();
  }
);


// =====================================================
// SAFE SHUTDOWN
// =====================================================

function shutdown() {

  shuttingDown =
    true;


  clearWsTimers();


  if (
    reconnectTimer
  ) {

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
