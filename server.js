import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

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
  scanSeconds: Number(process.env.SCAN_SECONDS || 5),
  riskPercent: Number(process.env.RISK_PERCENT || 1),
  minConfidence: Number(process.env.MIN_CONFIDENCE || 80),
  maxConsecutiveLosses: Number(
    process.env.MAX_CONSECUTIVE_LOSSES || 2
  ),
  timeframeMinutes: Number(
    process.env.TIMEFRAME_MINUTES || 1
  )
};

let state = {
  autoDemo:
    String(process.env.AUTO_START || "true") === "true",

  balance:
    Number(process.env.DEMO_BALANCE || 1000),

  wins: 0,
  losses: 0,
  consecutiveLosses: 0,

  currentPair: null,
  currentSignal: "WAIT",
  currentConfidence: 0,

  openTrade: null,

  lastScan: null,
  lastMessage: "Server started"
};

let history = [];

let scanning = false;


/* -------------------------------
   HELPERS
-------------------------------- */

function random(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function basePrice(pair) {

  const map = {
    "EUR/USD": 1.10500,
    "GBP/USD": 1.28500,
    "EUR/GBP": 0.86000,
    "USD/JPY": 147.200,
    "AUD/USD": 0.66500,
    "USD/CAD": 1.36500,
    "USD/CHF": 0.80500,
    "NZD/USD": 0.61500
  };

  return map[pair] || 1;
}

function priceScale(pair) {
  return pair.includes("JPY")
    ? 0.012
    : 0.00012;
}


/* -------------------------------
   SIGNAL ENGINE
-------------------------------- */

function analysePair(pair) {

  const momentum = random(-100, 100);
  const trend = random(-100, 100);
  const strength = random(0, 100);
  const volatility = random(15, 100);

  const score =
    momentum * 0.42 +
    trend * 0.38 +
    (strength - 50) * 0.14 +
    (volatility - 50) * 0.06;

  let direction = "WAIT";

  if (score > 20) {
    direction = "CALL";
  }
  else if (score < -20) {
    direction = "PUT";
  }

  let confidence;

  if (direction === "WAIT") {

    confidence =
      Math.round(
        random(50, 74)
      );

  }
  else {

    confidence =
      Math.round(
        clamp(
          60 +
          Math.abs(score) * 0.38 +
          random(-5, 7),
          55,
          96
        )
      );

  }

  return {
    pair,
    direction,
    confidence,
    score
  };
}


/* -------------------------------
   SCAN ALL 8 PAIRS
-------------------------------- */

function scanMarket() {

  if (!state.autoDemo) {
    return;
  }

  if (state.openTrade) {
    return;
  }

  if (scanning) {
    return;
  }

  scanning = true;

  try {

    if (
      state.consecutiveLosses >=
      config.maxConsecutiveLosses
    ) {

      state.autoDemo = false;

      state.lastMessage =
        "AUTO stopped: maximum consecutive losses reached.";

      return;
    }

    state.lastScan =
      new Date().toISOString();

    const results =
      PAIRS.map(
        pair => analysePair(pair)
      );

    const valid =
      results.filter(
        result =>
          result.direction !== "WAIT"
      );

    if (!valid.length) {

      state.currentPair = null;
      state.currentSignal = "WAIT";
      state.currentConfidence = 0;

      state.lastMessage =
        "No valid signal.";

      return;
    }

    valid.sort(
      (a, b) =>
        b.confidence -
        a.confidence
    );

    const best = valid[0];

    state.currentPair =
      best.pair;

    state.currentSignal =
      best.direction;

    state.currentConfidence =
      best.confidence;

    state.lastMessage =
      `BEST ${best.pair} ${best.direction} ${best.confidence}%`;

    console.log(
      new Date().toISOString(),
      state.lastMessage
    );

    if (
      best.confidence >=
      config.minConfidence
    ) {

      openDemoTrade(best);

    }

  }
  finally {

    scanning = false;

  }
}


/* -------------------------------
   OPEN DEMO TRADE
-------------------------------- */

function openDemoTrade(signal) {

  if (state.openTrade) {
    return;
  }

  const amount =
    Math.max(
      0.50,
      state.balance *
      config.riskPercent /
      100
    );

  if (
    state.balance <= 0 ||
    amount > state.balance
  ) {

    state.autoDemo = false;

    state.lastMessage =
      "AUTO stopped: demo balance empty.";

    return;
  }

  const pair = signal.pair;

  const entry =
    basePrice(pair) +
    random(-1, 1) *
    priceScale(pair) *
    4;

  const durationSeconds =
    config.timeframeMinutes * 60;

  state.openTrade = {
    id:
      Date.now().toString(),

    pair,

    direction:
      signal.direction,

    confidence:
      signal.confidence,

    amount,

    entry,

    currentPrice:
      entry,

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
    `OPEN ${pair} ${signal.direction} ${signal.confidence}%`;

  console.log(
    new Date().toISOString(),
    state.lastMessage
  );
}


/* -------------------------------
   SIMULATE OPEN TRADE PRICE
-------------------------------- */

function updateOpenTrade() {

  const trade =
    state.openTrade;

  if (!trade) {
    return;
  }

  const scale =
    priceScale(trade.pair);

  const directionalBias =
    (
      trade.confidence - 50
    )
    /
    50
    *
    scale
    *
    (
      trade.direction === "CALL"
        ? 0.16
        : -0.16
    );

  trade.currentPrice +=
    random(-scale, scale) +
    directionalBias;

  trade.remainingSeconds--;

  if (
    trade.remainingSeconds <= 0
  ) {

    closeDemoTrade();

  }
}


/* -------------------------------
   CLOSE DEMO TRADE
-------------------------------- */

function closeDemoTrade() {

  const trade =
    state.openTrade;

  if (!trade) {
    return;
  }

  let result = "DRAW";

  if (
    trade.direction === "CALL"
  ) {

    if (
      trade.currentPrice >
      trade.entry
    ) {

      result = "WIN";

    }
    else if (
      trade.currentPrice <
      trade.entry
    ) {

      result = "LOSS";

    }

  }
  else {

    if (
      trade.currentPrice <
      trade.entry
    ) {

      result = "WIN";

    }
    else if (
      trade.currentPrice >
      trade.entry
    ) {

      result = "LOSS";

    }

  }

  let profit = 0;

  if (result === "WIN") {

    profit =
      trade.amount * 0.82;

    state.balance +=
      profit;

    state.wins++;

    state.consecutiveLosses =
      0;

  }
  else if (
    result === "LOSS"
  ) {

    profit =
      -trade.amount;

    state.balance -=
      trade.amount;

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
    history.slice(
      0,
      200
    );

  state.openTrade =
    null;

  state.lastMessage =
    `${result} ${trade.pair} ${profit >= 0 ? "+" : ""}£${profit.toFixed(2)}`;

  console.log(
    new Date().toISOString(),
    state.lastMessage
  );

  if (
    state.consecutiveLosses >=
    config.maxConsecutiveLosses
  ) {

    state.autoDemo =
      false;

    state.lastMessage =
      "AUTO stopped after loss limit.";

  }
}


/* -------------------------------
   API
-------------------------------- */

app.get("/", (req, res) => {

  res.json({
    app:
      "ADAMS OPTION SERVER",

    mode:
      "DEMO",

    status:
      "online"
  });

});


app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,
      time:
        new Date().toISOString()
    });

  }
);


app.get(
  "/api/state",
  (req, res) => {

    const total =
      state.wins +
      state.losses;

    res.json({
      ...state,

      config,

      trades:
        total,

      winRate:
        total
          ? Math.round(
              state.wins /
              total *
              100
            )
          : 0
    });

  }
);


app.get(
  "/api/history",
  (req, res) => {

    res.json(history);

  }
);


app.post(
  "/api/start",
  (req, res) => {

    state.autoDemo =
      true;

    state.consecutiveLosses =
      0;

    state.lastMessage =
      "AUTO DEMO started";

    scanMarket();

    res.json({
      ok: true,
      autoDemo:
        state.autoDemo
    });

  }
);


app.post(
  "/api/stop",
  (req, res) => {

    state.autoDemo =
      false;

    state.lastMessage =
      "AUTO DEMO stopped";

    res.json({
      ok: true,
      autoDemo:
        state.autoDemo
    });

  }
);


/* -------------------------------
   SERVER TIMERS
-------------------------------- */

setInterval(
  updateOpenTrade,
  1000
);

setInterval(
  scanMarket,
  config.scanSeconds * 1000
);


/* -------------------------------
   START SERVER
-------------------------------- */

app.listen(
  PORT,
  () => {

    console.log(
      `ADAMS OPTION SERVER running on port ${PORT}`
    );

    console.log(
      `AUTO DEMO: ${state.autoDemo ? "ON" : "OFF"}`
    );

    if (
      state.autoDemo
    ) {

      setTimeout(
        scanMarket,
        1500
      );

    }

  }
);
