import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY;

const ONESIGNAL_APP_ID =
  process.env.ONESIGNAL_APP_ID;

const ONESIGNAL_API_KEY =
  process.env.ONESIGNAL_API_KEY;

const APP_URL =
  process.env.APP_URL || "";


/* =====================================
   ADAMS OPTION
   LIVE SIGNAL SERVER
   M1 + M5 ONLY
===================================== */

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

const TIMEFRAMES = [1, 5];

const config = {

  scanSeconds:
    Number(
      process.env.SCAN_SECONDS || 10
    ),

  minConfidence:
    Number(
      process.env.MIN_CONFIDENCE || 85
    ),

  minScoreGap:
    Number(
      process.env.MIN_SCORE_GAP || 20
    ),

  maxApiRequestsPerMinute:
    Number(
      process.env.MAX_API_REQUESTS_PER_MINUTE || 7
    ),

  notificationCooldownSeconds:
    Number(
      process.env.NOTIFICATION_COOLDOWN_SECONDS || 55
    )
};


/* =====================================
   STATE
===================================== */

let state = {

  liveSignals: true,

  autoDemo: true,

  currentPair: null,

  currentTimeframe: 1,

  currentSignal: "WAIT",

  currentConfidence: 0,

  currentPrice: null,

  openTrade: null,

  lastScan: null,

  lastMessage:
    "LIVE SIGNAL SERVER starting...",

  dataSource:
    "Twelve Data",

  oneSignalConfigured:
    Boolean(
      ONESIGNAL_APP_ID &&
      ONESIGNAL_API_KEY
    )
};

let signalHistory = [];

let scanning = false;

let scanIndex = 0;

const cache = new Map();

const lastNotification =
  new Map();

const lastSignalByMarket =
  new Map();

let apiRequestTimes = [];

let apiGate =
  Promise.resolve();


/* =====================================
   HELPERS
===================================== */

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

function marketKey(
  pair,
  timeframe
) {

  return `${pair}|${timeframe}`;
}

function intervalFromMinutes(
  minutes
) {

  const tf =
    Number(minutes);

  if (tf === 5) {
    return "5min";
  }

  return "1min";
}

function candleBucket(
  timeframe,
  datetime
) {

  if (datetime) {
    return String(datetime);
  }

  const ms =
    Number(timeframe) *
    60 *
    1000;

  return Math.floor(
    Date.now() / ms
  ).toString();
}


/* =====================================
   API CREDIT GUARD
===================================== */

async function reserveApiCredit() {

  const run =
    apiGate.then(
      async () => {

        while (true) {

          const now =
            Date.now();

          apiRequestTimes =
            apiRequestTimes.filter(
              t =>
                now - t <
                60000
            );

          if (
            apiRequestTimes.length <
            config.maxApiRequestsPerMinute
          ) {

            apiRequestTimes.push(
              Date.now()
            );

            return;
          }

          const oldest =
            apiRequestTimes[0];

          const waitMs =
            Math.max(
              500,
              60000 -
              (now - oldest) +
              300
            );

          await sleep(waitMs);
        }
      }
    );

  apiGate =
    run.catch(() => {});

  return run;
}


/* =====================================
   CACHE
===================================== */

function getCacheTTL(
  timeframe
) {

  return Number(timeframe) === 5
    ? 25000
    : 8000;
}

function getCached(
  pair,
  timeframe
) {

  const key =
    marketKey(
      pair,
      timeframe
    );

  const item =
    cache.get(key);

  if (!item) {
    return null;
  }

  if (
    Date.now() -
    item.savedAt >
    getCacheTTL(timeframe)
  ) {

    cache.delete(key);

    return null;
  }

  return item.data;
}

function saveCache(
  pair,
  timeframe,
  data
) {

  cache.set(
    marketKey(
      pair,
      timeframe
    ),
    {
      savedAt:
        Date.now(),

      data
    }
  );
}


/* =====================================
   TWELVE DATA
===================================== */

async function getMarketData(
  pair,
  timeframe = 1,
  outputsize = 80,
  allowCache = true
) {

  if (!TWELVE_DATA_API_KEY) {

    throw new Error(
      "TWELVE_DATA_API_KEY missing"
    );
  }

  if (allowCache) {

    const cached =
      getCached(
        pair,
        timeframe
      );

    if (cached) {
      return cached;
    }
  }

  await reserveApiCredit();

  const interval =
    intervalFromMinutes(
      timeframe
    );

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(pair) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&outputsize=" +
    outputsize +
    "&apikey=" +
    encodeURIComponent(
      TWELVE_DATA_API_KEY
    );

  const response =
    await fetch(url);

  if (
    response.status === 429
  ) {

    throw new Error(
      "API_RATE_LIMIT"
    );
  }

  if (!response.ok) {

    throw new Error(
      "Twelve Data HTTP " +
      response.status
    );
  }

  const data =
    await response.json();

  if (
    data.status === "error"
  ) {

    const msg =
      String(
        data.message || ""
      );

    if (
      msg
        .toLowerCase()
        .includes("credit") ||
      msg
        .toLowerCase()
        .includes("limit")
    ) {

      throw new Error(
        "API_RATE_LIMIT"
      );
    }

    throw new Error(
      msg ||
      "Twelve Data error"
    );
  }

  if (
    !Array.isArray(
      data.values
    ) ||
    !data.values.length
  ) {

    throw new Error(
      "No market data"
    );
  }

  const candles =
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

      .filter(c =>

        [
          c.open,
          c.high,
          c.low,
          c.close

        ].every(
          Number.isFinite
        )

      )

      .reverse();

  if (
    candles.length < 30
  ) {

    throw new Error(
      "Not enough market data"
    );
  }

  saveCache(
    pair,
    timeframe,
    candles
  );

  return candles;
}


/* =====================================
   EMA
===================================== */

function calculateEMA(
  values,
  period
) {

  if (
    values.length <
    period
  ) {

    return null;
  }

  const multiplier =
    2 /
    (period + 1);

  let ema =
    values

      .slice(
        0,
        period
      )

      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) /
    period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    ema =
      (
        values[i] -
        ema
      ) *
      multiplier +
      ema;
  }

  return ema;
}


/* =====================================
   EMA ARRAY
===================================== */

function calculateEMAArray(
  values,
  period
) {

  if (
    values.length <
    period
  ) {

    return [];
  }

  const multiplier =
    2 /
    (period + 1);

  let ema =
    values

      .slice(
        0,
        period
      )

      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) /
    period;

  const out =
    Array(
      period - 1
    ).fill(null);

  out.push(ema);

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    ema =
      (
        values[i] -
        ema
      ) *
      multiplier +
      ema;

    out.push(ema);
  }

  return out;
}


/* =====================================
   RSI
===================================== */

function calculateRSI(
  values,
  period = 14
) {

  if (
    values.length <
    period + 1
  ) {

    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    if (
      change >= 0
    ) {

      gains += change;
    }
    else {

      losses +=
        Math.abs(change);
    }
  }

  let avgGain =
    gains /
    period;

  let avgLoss =
    losses /
    period;

  for (
    let i =
      period + 1;

    i <
      values.length;

    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    const gain =
      change > 0
        ? change
        : 0;

    const loss =
      change < 0
        ? Math.abs(change)
        : 0;

    avgGain =
      (
        avgGain *
        (period - 1) +
        gain
      ) /
      period;

    avgLoss =
      (
        avgLoss *
        (period - 1) +
        loss
      ) /
      period;
  }

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


/* =====================================
   ATR
===================================== */

function calculateATR(
  candles,
  period = 14
) {

  if (
    candles.length <
    period + 1
  ) {

    return null;
  }

  const trueRanges = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const cur =
      candles[i];

    const prev =
      candles[i - 1];

    trueRanges.push(

      Math.max(

        cur.high -
        cur.low,

        Math.abs(
          cur.high -
          prev.close
        ),

        Math.abs(
          cur.low -
          prev.close
        )
      )
    );
  }

  const recent =
    trueRanges.slice(
      -period
    );

  return (
    recent.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    recent.length
  );
}


/* =====================================
   MOMENTUM
===================================== */

function calculateMomentum(
  values,
  lookback = 5
) {

  if (
    values.length <=
    lookback
  ) {

    return 0;
  }

  const last =
    values[
      values.length - 1
    ];

  const previous =
    values[
      values.length -
      1 -
      lookback
    ];

  return (

    (
      last -
      previous
    ) /

    Math.max(
      Math.abs(previous),
      1e-9
    ) *

    100
  );
}


/* =====================================
   TREND SLOPE
===================================== */

function calculateTrendSlope(
  emaArray,
  lookback = 4
) {

  const clean =
    emaArray.filter(
      Number.isFinite
    );

  if (
    clean.length <=
    lookback
  ) {

    return 0;
  }

  const last =
    clean[
      clean.length - 1
    ];

  const previous =
    clean[
      clean.length -
      1 -
      lookback
    ];

  return (

    (
      last -
      previous
    ) /

    Math.max(
      Math.abs(previous),
      1e-9
    ) *

    100
  );
}


/* =====================================
   SIGNAL ENGINE
===================================== */

async function analysePair(
  pair,
  timeframe = 1,
  allowCache = true
) {

  const tf =
    Number(timeframe);

  if (
    !TIMEFRAMES.includes(tf)
  ) {

    throw new Error(
      "Only M1 and M5 are supported"
    );
  }

  const candles =
    await getMarketData(
      pair,
      tf,
      80,
      allowCache
    );

  const closes =
    candles.map(
      candle =>
        candle.close
    );

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const price =
    current.close;

  const ema9 =
    calculateEMA(
      closes,
      9
    );

  const ema21 =
    calculateEMA(
      closes,
      21
    );

  const ema50 =
    calculateEMA(
      closes,
      50
    );

  const ema21Array =
    calculateEMAArray(
      closes,
      21
    );

  const rsi =
    calculateRSI(
      closes,
      14
    );

  const atr =
    calculateATR(
      candles,
      14
    );

  const momentum =
    calculateMomentum(
      closes,
      5
    );

  const trendSlope =
    calculateTrendSlope(
      ema21Array,
      4
    );

  if (
    ema9 === null ||
    ema21 === null ||
    ema50 === null ||
    rsi === null ||
    atr === null
  ) {

    return {

      pair,

      timeframe:
        tf,

      direction:
        "WAIT",

      confidence:
        0,

      price,

      candleTime:
        current.datetime
    };
  }

  const body =
    Math.abs(
      current.close -
      current.open
    );

  const range =
    Math.max(
      current.high -
      current.low,
      1e-9
    );

  const bodyRatio =
    body /
    range;

  const atrPercent =
    atr /
    Math.max(
      Math.abs(price),
      1e-9
    ) *
    100;

  let bullishScore = 0;
  let bearishScore = 0;


  /* EMA STRUCTURE */

  if (
    ema9 > ema21
  ) {

    bullishScore += 22;
  }
  else {

    bearishScore += 22;
  }

  if (
    ema21 > ema50
  ) {

    bullishScore += 16;
  }
  else {

    bearishScore += 16;
  }


  /* PRICE */

  if (
    price > ema9
  ) {

    bullishScore += 12;
  }
  else {

    bearishScore += 12;
  }

  if (
    price > ema21
  ) {

    bullishScore += 8;
  }
  else {

    bearishScore += 8;
  }


  /* RSI */

  if (
    rsi >= 53 &&
    rsi <= 69
  ) {

    bullishScore += 16;
  }

  else if (
    rsi <= 47 &&
    rsi >= 31
  ) {

    bearishScore += 16;
  }


  /* MOMENTUM */

  if (
    momentum >
    0.012
  ) {

    bullishScore += 10;
  }

  else if (
    momentum <
    -0.012
  ) {

    bearishScore += 10;
  }


  /* TREND */

  if (
    trendSlope >
    0.006
  ) {

    bullishScore += 7;
  }

  else if (
    trendSlope <
    -0.006
  ) {

    bearishScore += 7;
  }


  /* CURRENT CANDLE */

  if (
    current.close >
    current.open
  ) {

    bullishScore += 4;
  }

  else if (
    current.close <
    current.open
  ) {

    bearishScore += 4;
  }


  /* TWO CANDLES */

  if (
    current.close >
      current.open &&

    previous.close >
      previous.open
  ) {

    bullishScore += 3;
  }

  if (
    current.close <
      current.open &&

    previous.close <
      previous.open
  ) {

    bearishScore += 3;
  }


  /* STRONG BODY */

  if (
    bodyRatio >=
    0.52
  ) {

    if (
      current.close >
      current.open
    ) {

      bullishScore += 2;
    }
    else {

      bearishScore += 2;
    }
  }


  const maxScore =
    Math.max(
      bullishScore,
      bearishScore
    );

  const scoreGap =
    Math.abs(
      bullishScore -
      bearishScore
    );

  let direction =
    "WAIT";


  const volatilityOK =
    atrPercent >
    0.002;


  const buyTrend =

    ema9 >
      ema21 &&

    ema21 >
      ema50 &&

    price >
      ema21 &&

    trendSlope >=
      0;


  const sellTrend =

    ema9 <
      ema21 &&

    ema21 <
      ema50 &&

    price <
      ema21 &&

    trendSlope <=
      0;


  if (
    volatilityOK &&

    bullishScore >=
      78 &&

    scoreGap >=
      config.minScoreGap &&

    buyTrend &&

    rsi < 72 &&

    momentum >
      -0.005
  ) {

    direction =
      "CALL";
  }


  if (
    volatilityOK &&

    bearishScore >=
      78 &&

    scoreGap >=
      config.minScoreGap &&

    sellTrend &&

    rsi > 28 &&

    momentum <
      0.005
  ) {

    direction =
      "PUT";
  }


  let confidence;


  if (
    direction ===
    "WAIT"
  ) {

    confidence =
      Math.min(
        79,

        Math.round(
          50 +
          maxScore *
          0.28
        )
      );
  }

  else {

    confidence =
      Math.max(
        80,

        Math.min(
          96,

          Math.round(

            62 +

            maxScore *
            0.28 +

            scoreGap *
            0.08
          )
        )
      );
  }


  return {

    pair,

    timeframe:
      tf,

    direction,

    confidence,

    price,

    candleTime:
      current.datetime,

    ema9:
      Number(
        ema9.toFixed(6)
      ),

    ema21:
      Number(
        ema21.toFixed(6)
      ),

    ema50:
      Number(
        ema50.toFixed(6)
      ),

    rsi:
      Number(
        rsi.toFixed(2)
      ),

    atr:
      Number(
        atr.toFixed(6)
      ),

    atrPercent:
      Number(
        atrPercent.toFixed(4)
      ),

    momentum:
      Number(
        momentum.toFixed(4)
      ),

    trendSlope:
      Number(
        trendSlope.toFixed(4)
      ),

    bullishScore,

    bearishScore,

    scoreGap
  };
}


/* =====================================
   M1 + M5 CONFIRMATION
===================================== */

function confirmationFor(
  signal
) {

  const otherTf =
    signal.timeframe === 1
      ? 5
      : 1;

  const other =
    lastSignalByMarket.get(

      marketKey(
        signal.pair,
        otherTf
      )
    );

  if (!other) {

    return {
      ok: true,
      label:
        "SINGLE TF"
    };
  }

  const ageMs =
    Date.now() -
    other.scannedAt;

  const maxAgeMs =
    7 *
    60 *
    1000;

  if (
    ageMs >
    maxAgeMs
  ) {

    return {
      ok: true,
      label:
        "SINGLE TF"
    };
  }

  if (
    other.direction !==
      "WAIT" &&

    other.direction !==
      signal.direction
  ) {

    return {
      ok: false,
      label:
        `M${otherTf} OPPOSES`
    };
  }

  if (
    other.direction ===
    signal.direction
  ) {

    return {
      ok: true,
      label:
        "M1 + M5 CONFIRMED"
    };
  }

  return {
    ok: true,
    label:
      `M${otherTf} WAIT`
  };
}


/* =====================================
   ONESIGNAL
===================================== */

async function sendPush(
  title,
  body,
  customData = {}
) {

  if (
    !ONESIGNAL_APP_ID ||
    !ONESIGNAL_API_KEY
  ) {

    console.log(
      "OneSignal not configured"
    );

    return {
      ok: false,
      skipped: true
    };
  }

  const payload = {

    app_id:
      ONESIGNAL_APP_ID,

    target_channel:
      "push",

    included_segments: [
      "Subscribed Users"
    ],

    headings: {
      en:
        title
    },

    contents: {
      en:
        body
    },

    custom_data:
      customData
  };


  if (APP_URL) {

    payload.url =
      APP_URL;
  }


  const response =
    await fetch(

      "https://api.onesignal.com/notifications",

      {
        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          Authorization:
            `Key ${ONESIGNAL_API_KEY}`
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );


  const data =
    await response
      .json()
      .catch(
        () => ({})
      );


  if (!response.ok) {

    throw new Error(

      data.errors

        ? JSON.stringify(
            data.errors
          )

        : "OneSignal HTTP " +
          response.status
    );
  }


  return {
    ok: true,
    data
  };
}


/* =====================================
   SIGNAL NOTIFICATION
===================================== */

async function sendSignalNotification(
  signal,
  confirmationLabel
) {

  const key =
    marketKey(
      signal.pair,
      signal.timeframe
    );


  const fingerprint =

    [
      signal.pair,

      signal.timeframe,

      signal.direction,

      candleBucket(
        signal.timeframe,
        signal.candleTime
      )

    ].join("|");


  const previous =
    lastNotification.get(key);

  const now =
    Date.now();


  if (
    previous &&
    previous.fingerprint ===
      fingerprint
  ) {

    return false;
  }


  if (
    previous &&

    now -
      previous.sentAt <

      config
        .notificationCooldownSeconds *
      1000
  ) {

    return false;
  }


  const title =
    `🚨 ${signal.direction} ${signal.pair} • M${signal.timeframe}`;


  const body =

    `${signal.confidence}% • ` +

    `${confirmationLabel} • ` +

    `Price ${signal.price} • ` +

    `Open manually in Pocket Option`;


  await sendPush(

    title,

    body,

    {

      pair:
        signal.pair,

      timeframe:
        signal.timeframe,

      direction:
        signal.direction,

      confidence:
        signal.confidence,

      price:
        signal.price
    }
  );


  lastNotification.set(

    key,

    {

      fingerprint,

      sentAt:
        now
    }
  );


  signalHistory.unshift({

    id:
      `${Date.now()}_${key}`,

    pair:
      signal.pair,

    timeframe:
      signal.timeframe,

    direction:
      signal.direction,

    confidence:
      signal.confidence,

    price:
      signal.price,

    confirmation:
      confirmationLabel,

    candleTime:
      signal.candleTime,

    createdAt:
      new Date()
        .toISOString()
  });


  signalHistory =
    signalHistory.slice(
      0,
      200
    );


  return true;
}


/* =====================================
   SCAN TARGETS
===================================== */

function buildScanTargets() {

  const targets = [];

  for (
    const pair of PAIRS
  ) {

    for (
      const timeframe
      of TIMEFRAMES
    ) {

      targets.push({

        pair,

        timeframe
      });
    }
  }

  return targets;
}


const SCAN_TARGETS =
  buildScanTargets();


/* =====================================
   LIVE SCANNER
===================================== */

async function scanMarket() {

  if (
    !state.liveSignals
  ) {

    return;
  }

  if (scanning) {
    return;
  }

  scanning = true;


  try {

    const target =
      SCAN_TARGETS[

        scanIndex %

        SCAN_TARGETS.length
      ];


    scanIndex++;


    state.lastMessage =

      `Scanning ${target.pair} M${target.timeframe}...`;


    const result =
      await analysePair(

        target.pair,

        target.timeframe,

        false
      );


    const stored = {

      ...result,

      scannedAt:
        Date.now()
    };


    lastSignalByMarket.set(

      marketKey(

        result.pair,

        result.timeframe
      ),

      stored
    );


    state.currentPair =
      result.pair;

    state.currentTimeframe =
      result.timeframe;

    state.currentSignal =
      result.direction;

    state.currentConfidence =
      result.confidence;

    state.currentPrice =
      result.price;

    state.lastScan =
      new Date()
        .toISOString();


    state.lastMessage =

      `${result.pair} M${result.timeframe} ${result.direction} ${result.confidence}%`;


    if (
      result.direction ===
        "WAIT" ||

      result.confidence <
        config.minConfidence
    ) {

      return;
    }


    const confirmation =
      confirmationFor(
        stored
      );


    if (
      !confirmation.ok
    ) {

      state.lastMessage =

        `${result.pair} M${result.timeframe} blocked: ${confirmation.label}`;

      return;
    }


    const sent =
      await sendSignalNotification(

        stored,

        confirmation.label
      );


    if (sent) {

      state.lastMessage =

        `NOTIFIED ${result.pair} M${result.timeframe} ${result.direction} ${result.confidence}%`;

      console.log(
        state.lastMessage
      );
    }

  }

  catch (error) {

    console.error(
      "LIVE SCAN:",
      error
    );


    if (
      error.message ===
      "API_RATE_LIMIT"
    ) {

      state.lastMessage =
        "Twelve Data limit • waiting...";
    }

    else {

      state.lastMessage =

        error.message ||

        "Market data error";
    }

  }

  finally {

    scanning = false;
  }
}


/* =====================================
   HOME ROUTE
===================================== */

app.get(
  "/",
  (req, res) => {

    res.json({

      app:
        "ADAMS OPTION SERVER",

      mode:
        "LIVE SIGNALS / MANUAL EXECUTION",

      timeframes:
        [
          "M1",
          "M5"
        ],

      pairs:
        PAIRS,

      data:
        "TWELVE DATA",

      oneSignal:

        state.oneSignalConfigured
          ? "configured"
          : "missing env vars",

      status:
        "online"
    });
  }
);


/* =====================================
   HEALTH
===================================== */

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      dataSource:
        "Twelve Data",

      liveSignals:
        state.liveSignals,

      oneSignalConfigured:
        state.oneSignalConfigured,

      time:
        new Date()
          .toISOString()
    });
  }
);


/* =====================================
   ANALYSE API
===================================== */

app.post(
  "/api/analyse",
  async (req, res) => {

    try {

      const pair =

        req.body?.pair ||

        "EUR/USD";


      const timeframe =

        Number(

          req.body?.timeframe ||

          1
        );


      if (
        !PAIRS.includes(pair)
      ) {

        return res
          .status(400)
          .json({

            ok: false,

            error:
              "Invalid Forex pair"
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

            ok: false,

            error:
              "Only M1 and M5 are available"
          });
      }


      const result =

        await analysePair(

          pair,

          timeframe,

          true
        );


      const stored = {

        ...result,

        scannedAt:
          Date.now()
      };


      lastSignalByMarket.set(

        marketKey(

          pair,

          timeframe
        ),

        stored
      );


      state.currentPair =
        result.pair;

      state.currentTimeframe =
        result.timeframe;

      state.currentSignal =
        result.direction;

      state.currentConfidence =
        result.confidence;

      state.currentPrice =
        result.price;

      state.lastScan =
        new Date()
          .toISOString();

      state.lastMessage =

        `${result.pair} M${result.timeframe} ${result.direction} ${result.confidence}%`;


      res.json({

        ok: true,

        source:
          "Twelve Data",

        ...result
      });

    }

    catch (error) {

      const status =

        error.message ===
          "API_RATE_LIMIT"

          ? 429

          : 500;


      res
        .status(status)
        .json({

          ok: false,

          error:
            error.message
        });
    }
  }
);


/* =====================================
   STATE API
===================================== */

app.get(
  "/api/state",
  (req, res) => {

    res.json({

      ...state,

      balance:
        1000,

      wins:
        0,

      losses:
        0,

      consecutiveLosses:
        0,

      trades:
        signalHistory.length,

      winRate:
        0,

      config,

      timeframes:
        TIMEFRAMES,

      latestSignals:

        Array.from(

          lastSignalByMarket
            .values()

        )

        .sort(

          (a, b) =>

            b.scannedAt -
            a.scannedAt
        )

        .slice(
          0,
          20
        ),

      notificationsSent:
        signalHistory.length
    });
  }
);


/* =====================================
   HISTORY
===================================== */

app.get(
  "/api/history",
  (req, res) => {

    res.json(
      signalHistory
    );
  }
);


/* =====================================
   SIGNALS
===================================== */

app.get(
  "/api/signals",
  (req, res) => {

    const latest =

      Array.from(

        lastSignalByMarket
          .values()

      )

      .sort(

        (a, b) =>

          b.scannedAt -
          a.scannedAt
      );


    res.json({

      ok: true,

      signals:
        latest
    });
  }
);


/* =====================================
   START LIVE
===================================== */

app.post(
  "/api/start",
  (req, res) => {

    state.liveSignals =
      true;

    state.autoDemo =
      true;

    state.lastMessage =
      "LIVE SIGNALS started";


    res.json({

      ok: true,

      liveSignals:
        true,

      autoDemo:
        true
    });
  }
);


/* =====================================
   STOP LIVE
===================================== */

app.post(
  "/api/stop",
  (req, res) => {

    state.liveSignals =
      false;

    state.autoDemo =
      false;

    state.lastMessage =
      "LIVE SIGNALS stopped";


    res.json({

      ok: true,

      liveSignals:
        false,

      autoDemo:
        false
    });
  }
);


/* =====================================
   TEST NOTIFICATION
===================================== */

app.post(
  "/api/test-notification",
  async (req, res) => {

    try {

      const result =
        await sendPush(

          "✅ ADAMS OPTION",

          "Live notifications are working. M1 + M5 signals are ready.",

          {
            type:
              "test"
          }
        );


      res.json({

        ok: true,

        result
      });

    }

    catch (error) {

      res
        .status(500)
        .json({

          ok: false,

          error:
            error.message
        });
    }
  }
);


/* =====================================
   AUTO SCAN
===================================== */

setInterval(

  scanMarket,

  config.scanSeconds *
  1000
);


/* =====================================
   START SERVER
===================================== */

app.listen(
  PORT,
  () => {

    console.log(

      `ADAMS OPTION SERVER running on port ${PORT}`
    );

    console.log(

      "Mode: LIVE SIGNALS / MANUAL EXECUTION"
    );

    console.log(

      "Timeframes: M1 + M5"
    );

    console.log(

      `Scan every ${config.scanSeconds}s`
    );

    console.log(

      `Minimum confidence ${config.minConfidence}%`
    );


    console.log(

      TWELVE_DATA_API_KEY

        ? "TWELVE DATA KEY loaded"

        : "TWELVE DATA KEY missing"
    );


    console.log(

      ONESIGNAL_APP_ID &&
      ONESIGNAL_API_KEY

        ? "ONESIGNAL configured"

        : "ONESIGNAL env vars missing"
    );


    setTimeout(

      scanMarket,

      3000
    );
  }
);
