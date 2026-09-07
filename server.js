import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TWELVE_DATA_API_KEY;

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

const config = {
  scanSeconds: 12,
  riskPercent: Number(process.env.RISK_PERCENT || 1),
  minConfidence: Number(process.env.MIN_CONFIDENCE || 80),
  maxConsecutiveLosses: Number(process.env.MAX_CONSECUTIVE_LOSSES || 2),
  timeframeMinutes: Number(process.env.TIMEFRAME_MINUTES || 1)
};

let state = {
  autoDemo: true,

  balance: Number(process.env.DEMO_BALANCE || 1000),

  wins: 0,
  losses: 0,
  consecutiveLosses: 0,

  currentPair: null,
  currentSignal: "WAIT",
  currentConfidence: 0,
  currentPrice: null,

  openTrade: null,

  lastScan: null,
  lastMessage: "AUTO DEMO starting...",

  dataSource: "Twelve Data"
};

let history = [];
let scanning = false;
let scanPairIndex = 0;

const cache = new Map();

const CACHE_TTL_MS = {
  1: 60000,
  5: 180000,
  15: 300000
};

let apiBlockedUntil = 0;


/* =====================================
   CACHE
===================================== */

function cacheKey(pair, timeframe) {
  return `${pair}|${timeframe}`;
}

function getCacheTTL(timeframe) {
  return CACHE_TTL_MS[Number(timeframe)] || 60000;
}

function getCached(pair, timeframe) {

  const key = cacheKey(pair, timeframe);
  const item = cache.get(key);

  if (!item) {
    return null;
  }

  if (Date.now() - item.savedAt > getCacheTTL(timeframe)) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function saveCache(pair, timeframe, data) {

  cache.set(
    cacheKey(pair, timeframe),
    {
      savedAt: Date.now(),
      data
    }
  );
}


/* =====================================
   TIMEFRAME
===================================== */

function intervalFromMinutes(minutes) {

  const tf = Number(minutes);

  if (tf === 5) return "5min";
  if (tf === 15) return "15min";

  return "1min";
}


/* =====================================
   TWELVE DATA
===================================== */

async function getMarketData(
  pair,
  timeframe = 1,
  outputsize = 60,
  allowCache = true
) {

  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY missing");
  }

  if (Date.now() < apiBlockedUntil) {
    throw new Error("API_COOLDOWN");
  }

  if (allowCache) {

    const cached = getCached(pair, timeframe);

    if (cached) {
      return cached;
    }
  }

  const interval = intervalFromMinutes(timeframe);

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" + encodeURIComponent(pair) +
    "&interval=" + encodeURIComponent(interval) +
    "&outputsize=" + outputsize +
    "&apikey=" + encodeURIComponent(API_KEY);

  const response = await fetch(url);

  if (response.status === 429) {

    apiBlockedUntil = Date.now() + 70000;

    throw new Error("API_RATE_LIMIT");
  }

  if (!response.ok) {
    throw new Error("Twelve Data HTTP " + response.status);
  }

  const data = await response.json();

  if (data.status === "error") {

    const msg = String(data.message || "");

    if (
      msg.toLowerCase().includes("credit") ||
      msg.toLowerCase().includes("limit")
    ) {

      apiBlockedUntil = Date.now() + 70000;

      throw new Error("API_RATE_LIMIT");
    }

    throw new Error(msg || "Twelve Data error");
  }

  if (!Array.isArray(data.values) || !data.values.length) {
    throw new Error("No market data");
  }

  const candles = data.values
    .map(item => ({
      datetime: item.datetime,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close)
    }))
    .reverse();

  saveCache(pair, timeframe, candles);

  return candles;
}


/* =====================================
   INDICATORS
===================================== */

function calculateEMA(values, period) {

  if (values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {

    ema =
      (values[i] - ema) *
      multiplier +
      ema;
  }

  return ema;
}

function calculateRSI(values, period = 14) {

  if (values.length < period + 1) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {

    const change = values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {

    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain =
      (avgGain * (period - 1) + gain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) + loss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}


/* =====================================
   SIGNAL ENGINE
===================================== */

async function analysePair(pair, timeframe = 1) {

  const candles =
    await getMarketData(
      pair,
      timeframe,
      60,
      true
    );

  const closes =
    candles.map(candle => candle.close);

  const price =
    closes[closes.length - 1];

  const previousPrice =
    closes[closes.length - 2];

  const ema9 =
    calculateEMA(closes, 9);

  const ema21 =
    calculateEMA(closes, 21);

  const rsi =
    calculateRSI(closes, 14);

  if (
    ema9 === null ||
    ema21 === null ||
    rsi === null
  ) {

    return {
      pair,
      direction: "WAIT",
      confidence: 0,
      price,
      ema9,
      ema21,
      rsi
    };
  }

  let bullishScore = 0;
  let bearishScore = 0;

  if (ema9 > ema21) bullishScore += 35;
  if (ema9 < ema21) bearishScore += 35;

  if (price > ema9) bullishScore += 20;
  if (price < ema9) bearishScore += 20;

  if (rsi >= 52 && rsi <= 70) bullishScore += 25;
  if (rsi <= 48 && rsi >= 30) bearishScore += 25;

  if (price > previousPrice) bullishScore += 20;
  if (price < previousPrice) bearishScore += 20;

  let direction = "WAIT";

  let confidence =
    Math.max(
      bullishScore,
      bearishScore
    );

  if (
    bullishScore >= 65 &&
    bullishScore > bearishScore
  ) {

    direction = "CALL";
    confidence = bullishScore;
  }
  else if (
    bearishScore >= 65 &&
    bearishScore > bullishScore
  ) {

    direction = "PUT";
    confidence = bearishScore;
  }

  confidence =
    Math.min(
      95,
      Math.round(confidence)
    );

  return {
    pair,
    direction,
    confidence,
    price,

    ema9: Number(ema9.toFixed(6)),
    ema21: Number(ema21.toFixed(6)),
    rsi: Number(rsi.toFixed(2)),

    bullishScore,
    bearishScore,
    timeframe
  };
}


/* =====================================
   OPEN TRADE
===================================== */

function openDemoTrade(signal) {

  if (state.openTrade) {
    return;
  }

  if (signal.direction === "WAIT") {
    return;
  }

  if (signal.confidence < config.minConfidence) {
    return;
  }

  const amount =
    Math.min(
      state.balance,
      Math.max(
        0.50,
        state.balance *
        config.riskPercent /
        100
      )
    );

  if (amount <= 0 || state.balance <= 0) {

    state.autoDemo = false;

    state.lastMessage =
      "AUTO stopped: demo balance empty.";

    return;
  }

  const durationSeconds =
    config.timeframeMinutes * 60;

  state.openTrade = {
    id: Date.now().toString(),

    pair: signal.pair,
    direction: signal.direction,
    confidence: signal.confidence,

    amount,

    entry: signal.price,
    currentPrice: signal.price,

    openedAt:
      new Date().toISOString(),

    closesAt:
      new Date(
        Date.now() +
        durationSeconds * 1000
      ).toISOString(),

    remainingSeconds:
      durationSeconds
  };

  state.lastMessage =
    `OPEN ${signal.pair} ${signal.direction} ${signal.confidence}%`;

  console.log(state.lastMessage);
}


/* =====================================
   CLOSE TRADE
===================================== */

async function closeDemoTrade() {

  const trade = state.openTrade;

  if (!trade) {
    return;
  }

  try {

    /*
      force new data at expiry
    */

    cache.delete(
      cacheKey(
        trade.pair,
        config.timeframeMinutes
      )
    );

    const candles =
      await getMarketData(
        trade.pair,
        config.timeframeMinutes,
        2,
        false
      );

    const last =
      candles[candles.length - 1];

    trade.currentPrice =
      last.close;

    let result = "DRAW";

    if (trade.direction === "CALL") {

      if (trade.currentPrice > trade.entry) {
        result = "WIN";
      }
      else if (trade.currentPrice < trade.entry) {
        result = "LOSS";
      }

    } else {

      if (trade.currentPrice < trade.entry) {
        result = "WIN";
      }
      else if (trade.currentPrice > trade.entry) {
        result = "LOSS";
      }
    }

    let profit = 0;

    if (result === "WIN") {

      profit =
        trade.amount * 0.82;

      state.balance += profit;
      state.wins++;
      state.consecutiveLosses = 0;

    }
    else if (result === "LOSS") {

      profit =
        -trade.amount;

      state.balance -= trade.amount;
      state.losses++;
      state.consecutiveLosses++;
    }

    history.unshift({
      ...trade,

      result,
      profit,

      closedAt:
        new Date().toISOString(),

      closePrice:
        trade.currentPrice
    });

    history =
      history.slice(0, 200);

    state.openTrade = null;

    state.lastMessage =
      `${result} ${trade.pair} ${profit >= 0 ? "+" : ""}£${profit.toFixed(2)}`;

    if (
      state.consecutiveLosses >=
      config.maxConsecutiveLosses
    ) {

      state.autoDemo = false;

      state.lastMessage =
        "AUTO stopped after loss limit.";
    }

  } catch (error) {

    console.error(
      "Close trade:",
      error
    );

    state.lastMessage =
      "Waiting for market data to close trade.";
  }
}


/* =====================================
   AUTO SCAN
===================================== */

async function scanMarket() {

  if (!state.autoDemo) {
    return;
  }

  if (state.openTrade) {
    return;
  }

  if (scanning) {
    return;
  }

  if (Date.now() < apiBlockedUntil) {

    state.lastMessage =
      "API cooldown...";

    return;
  }

  if (
    state.consecutiveLosses >=
    config.maxConsecutiveLosses
  ) {

    state.autoDemo = false;

    state.lastMessage =
      "AUTO stopped: loss limit.";

    return;
  }

  scanning = true;

  try {

    const pair =
      PAIRS[
        scanPairIndex %
        PAIRS.length
      ];

    scanPairIndex++;

    state.lastMessage =
      `Scanning ${pair}...`;

    const result =
      await analysePair(
        pair,
        config.timeframeMinutes
      );

    state.currentPair =
      result.pair;

    state.currentSignal =
      result.direction;

    state.currentConfidence =
      result.confidence;

    state.currentPrice =
      result.price;

    state.lastScan =
      new Date().toISOString();

    state.lastMessage =
      `${result.pair} ${result.direction} ${result.confidence}%`;

    if (
      result.direction !== "WAIT" &&
      result.confidence >=
      config.minConfidence
    ) {

      openDemoTrade(result);
    }

  } catch (error) {

    console.error(
      "AUTO:",
      error
    );

    if (
      error.message === "API_RATE_LIMIT" ||
      error.message === "API_COOLDOWN"
    ) {

      state.lastMessage =
        "Twelve Data limit • waiting...";

    } else {

      state.lastMessage =
        error.message ||
        "Market data error";
    }

  } finally {

    scanning = false;
  }
}


/* =====================================
   TIMER
===================================== */

setInterval(
  async () => {

    if (!state.openTrade) {
      return;
    }

    const closesAt =
      new Date(
        state.openTrade.closesAt
      ).getTime();

    state.openTrade.remainingSeconds =
      Math.max(
        0,
        Math.ceil(
          (
            closesAt -
            Date.now()
          ) /
          1000
        )
      );

    if (
      state.openTrade.remainingSeconds <= 0
    ) {

      await closeDemoTrade();
    }

  },
  1000
);


/* =====================================
   API ROUTES
===================================== */

app.get("/", (req,res) => {

  res.json({
    app: "ADAMS OPTION SERVER",
    mode: "REAL DATA / AUTO DEMO",
    data: "TWELVE DATA",
    status: "online"
  });
});

app.get("/health", (req,res) => {

  res.json({
    ok: true,
    dataSource: "Twelve Data",
    time: new Date().toISOString()
  });
});

app.post("/api/analyse", async (req,res) => {

  try {

    const pair =
      req.body?.pair || "EUR/USD";

    const timeframe =
      Number(
        req.body?.timeframe || 1
      );

    if (!PAIRS.includes(pair)) {

      return res
        .status(400)
        .json({
          ok: false,
          error: "Invalid Forex pair"
        });
    }

    const result =
      await analysePair(
        pair,
        timeframe
      );

    state.currentPair =
      result.pair;

    state.currentSignal =
      result.direction;

    state.currentConfidence =
      result.confidence;

    state.currentPrice =
      result.price;

    state.lastScan =
      new Date().toISOString();

    state.lastMessage =
      `${result.pair} ${result.direction} ${result.confidence}%`;

    res.json({
      ok: true,
      source: "Twelve Data",
      ...result
    });

  } catch (error) {

    if (
      error.message === "API_RATE_LIMIT" ||
      error.message === "API_COOLDOWN"
    ) {

      return res
        .status(429)
        .json({
          ok: false,
          error:
            "Twelve Data limit reached. AUTO is waiting automatically."
        });
    }

    res
      .status(500)
      .json({
        ok: false,
        error: error.message
      });
  }
});

app.get("/api/state", (req,res) => {

  const total =
    state.wins +
    state.losses;

  res.json({
    ...state,

    config,

    trades: total,

    winRate:
      total
        ? Math.round(
            state.wins /
            total *
            100
          )
        : 0,

    apiCooldownSeconds:
      Math.max(
        0,
        Math.ceil(
          (
            apiBlockedUntil -
            Date.now()
          ) /
          1000
        )
      )
  });
});

app.get("/api/history", (req,res) => {

  res.json(history);
});

app.post("/api/start", (req,res) => {

  state.autoDemo = true;
  state.consecutiveLosses = 0;

  state.lastMessage =
    "AUTO DEMO started";

  res.json({
    ok: true,
    autoDemo: true
  });
});

app.post("/api/stop", (req,res) => {

  state.autoDemo = false;

  state.lastMessage =
    "AUTO DEMO stopped";

  res.json({
    ok: true,
    autoDemo: false
  });
});


/* =====================================
   AUTO SCAN LOOP
===================================== */

setInterval(
  scanMarket,
  config.scanSeconds * 1000
);


/* =====================================
   START SERVER
===================================== */

app.listen(PORT, () => {

  console.log(
    `ADAMS OPTION SERVER running on port ${PORT}`
  );

  console.log(
    "Market data: Twelve Data"
  );

  console.log(
    API_KEY
      ? "API KEY loaded"
      : "API KEY missing"
  );

  console.log(
    "AUTO DEMO starts ON"
  );

  setTimeout(
    scanMarket,
    5000
  );
});
