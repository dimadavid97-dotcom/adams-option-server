import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const ONESIGNAL_APP_ID =
  process.env.ONESIGNAL_APP_ID || "";

const ONESIGNAL_API_KEY =
  process.env.ONESIGNAL_REST_API_KEY ||
  process.env.ONESIGNAL_API_KEY ||
  "";

const MIN_CONFIDENCE =
  Number(process.env.MIN_CONFIDENCE || 72);

const MAX_OPEN_TRADES = Math.min(8,Math.max(1,Number(process.env.MAX_OPEN_TRADES || 8)));

// Each cycle checks 3 out of 8 pairs. Each pair returns roughly every 15 min.
const SCAN_SECONDS = 300;
const FOREX_CALLS_PER_CYCLE = 1;
const OPTION_DAILY_CREDIT_LIMIT = 150; // 144 scheduled calls on UK weekdays, leaves room for BIT ADAMS (~576/day).
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
// Keep local snapshots on a configured Render persistent disk, if present.
const DATA_DIR = process.env.PERSISTENCE_DIR || process.env.RENDER_DISK_MOUNT_PATH || ".";
try { fs.mkdirSync(DATA_DIR,{recursive:true}); } catch (e) { console.warn("Data directory:",e.message); }
const USAGE_FILE = path.join(DATA_DIR,"api-usage.json");
let creditsToday=0,creditsDate="",lastM5CycleAt=null,lastTelegramError=null,m5CycleBusy=false;
function utcDay(){return new Date().toISOString().slice(0,10)}
function loadUsage(){
  try{const record=JSON.parse(fs.readFileSync(USAGE_FILE,"utf8"));if(record.date===utcDay()){creditsDate=record.date;creditsToday=Number(record.credits)||0;return;}}catch{}
  creditsDate=utcDay();creditsToday=0;
}
function reserveCredit(){
  if(creditsDate!==utcDay()){creditsDate=utcDay();creditsToday=0}
  if(creditsToday>=OPTION_DAILY_CREDIT_LIMIT)return false;
  creditsToday++;
  try{fs.writeFileSync(USAGE_FILE,JSON.stringify({date:creditsDate,credits:creditsToday}));}catch(e){console.warn("API usage persistence failed:",e.message)}
  return true;
}
function forexWindowOpen(date=new Date()){
  const day=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",weekday:"short"}).format(date);
  const hour=Number(new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",hour:"2-digit",hourCycle:"h23"}).format(date));
  return !["Sat","Sun"].includes(day)&&hour>=8&&hour<20;
}
loadUsage();

const HISTORY_FILE = path.join(DATA_DIR,"history.json");
const DATABASE_URL = process.env.DATABASE_URL || "";
const STORAGE_MODE = DATABASE_URL ? "postgres" :
  (process.env.PERSISTENCE_DIR || process.env.RENDER_DISK_MOUNT_PATH) ? "persistent-disk" : "ephemeral";
let storageReady = false, storageError = null, pgPool = null;
let storageQueue = Promise.resolve();

/* =====================================================
   PAIRS
===================================================== */

const PAIRS = {
  "EUR/USD": 5,
  "GBP/USD": 5,
  "EUR/GBP": 5,
  "USD/JPY": 3,
  "AUD/USD": 5,
  "USD/CAD": 5,
  "USD/CHF": 5,
  "NZD/USD": 5
};

const PAIR_LIST =
  Object.keys(PAIRS);

/* =====================================================
   TIMEFRAMES
===================================================== */

const TF = {
  M1: 60,
  M5: 300,
  M15: 900
};

const COOLDOWN = {
  M1: 3 * 60 * 1000,
  M5: 10 * 60 * 1000,
  M15: 20 * 60 * 1000
};

/* =====================================================
   MEMORY
===================================================== */

const marketData =
  new Map();

const lastSignal =
  new Map();

let autoEnabled = true;
let autoBusy = false;
let refreshBusy = false;
let refreshIndex = 0;
let lastAuto = null;

/* =====================================================
   HISTORY
===================================================== */

function loadHistory() {
  try {
    if (
      !fs.existsSync(
        HISTORY_FILE
      )
    ) {
      return {
        openTrades: [],
        history: []
      };
    }

    const raw =
      JSON.parse(
        fs.readFileSync(
          HISTORY_FILE,
          "utf8"
        )
      );

    if (
      Array.isArray(raw)
    ) {
      return {
        openTrades: [],
        history: raw
      };
    }

    return {
      openTrades:
        raw.openTrades || [],

      history:
        raw.history || []
    };
  } catch {
    return {
      openTrades: [],
      history: []
    };
  }
}

let db = loadHistory();

function normalizeDb(value) {
  return {
    openTrades: Array.isArray(value?.openTrades) ? value.openTrades : [],
    history: Array.isArray(value?.history) ? value.history : []
  };
}

// Postgres is durable across Render restarts. Without DATABASE_URL the server
// retains the legacy local-file fallback; this fallback is NOT durable on Render
// unless PERSISTENCE_DIR or RENDER_DISK_MOUNT_PATH points to a mounted disk.
async function initStorage() {
  if (!DATABASE_URL) {
    db = normalizeDb(db);
    storageReady = true;
    if (STORAGE_MODE === "ephemeral")
      console.warn("HISTORY WARNING: ephemeral storage. Configure DATABASE_URL for durable results.");
    return;
  }
  try {
    if (!pgPool) {
      const { Pool } = await import("pg");
      pgPool = new Pool({
        connectionString: DATABASE_URL,
        max: 2,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000
      });
      pgPool.on("error",error=>{
        storageError=error.message;
        console.error("Database connection:",error.message);
      });
    }
    await pgPool.query(`CREATE TABLE IF NOT EXISTS adams_option_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const saved = await pgPool.query("SELECT data FROM adams_option_state WHERE id = 1");
    if (saved.rows.length) {
      db = normalizeDb(saved.rows[0].data);
    } else {
      db = normalizeDb(db);
      await pgPool.query(
        "INSERT INTO adams_option_state (id,data) VALUES (1,$1::jsonb)",
        [JSON.stringify(db)]
      );
    }
    storageReady = true;
    storageError = null;
    console.log("ADAMS OPTION persistent Postgres history connected.");
  } catch (error) {
    storageReady = false;
    storageError = error.message;
    console.error("History database unavailable; blocking new demo signals:",error.message);
  }
}

function saveHistory() {
  const snapshot = JSON.stringify(db);
  const write = async () => {
    if (!storageReady) throw new Error("History storage unavailable");
    if (DATABASE_URL) {
      await pgPool.query(`INSERT INTO adams_option_state (id,data,updated_at)
        VALUES (1,$1::jsonb,NOW())
        ON CONFLICT (id) DO UPDATE
        SET data=EXCLUDED.data,updated_at=NOW()`,[snapshot]);
    }
    try {
      fs.writeFileSync(HISTORY_FILE,snapshot);
    } catch (error) {
      if (!DATABASE_URL) throw error;
      console.warn("Local history snapshot failed:",error.message);
    }
  };
  const pending = storageQueue.catch(()=>{}).then(write);
  storageQueue = pending;
  return pending;
}

/* =====================================================
   HELPERS
===================================================== */

function clamp(
  value,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}

function normalizePair(value) {
  let pair =
    String(value || "")
      .trim()
      .toUpperCase()
      .replace(/\s/g, "");

  if (
    !pair.includes("/") &&
    pair.length === 6
  ) {
    pair =
      pair.slice(0, 3) +
      "/" +
      pair.slice(3);
  }

  return PAIRS[pair]
    ? pair
    : null;
}

function normalizeTf(value) {
  const tf =
    String(
      value || "M1"
    ).toUpperCase();

  return TF[tf]
    ? tf
    : "M1";
}

function roundPrice(
  pair,
  value
) {
  if (
    !Number.isFinite(
      Number(value)
    )
  ) {
    return null;
  }

  return Number(
    Number(value).toFixed(
      PAIRS[pair] || 5
    )
  );
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

/* =====================================================
   TWELVE DATA REST
===================================================== */

async function refreshPair(
  pair
) {
  if (
    !TWELVE_DATA_API_KEY
  ) {
    throw new Error(
      "TWELVE_DATA_API_KEY missing"
    );
  }

  if(!forexWindowOpen())throw new Error("FOREX SCAN PAUSED OUTSIDE UK HOURS");
  if(!reserveCredit())throw new Error("ADAMS OPTION DAILY API BUDGET REACHED");
  const url =
    new URL(
      "https://api.twelvedata.com/time_series"
    );

  url.searchParams.set(
    "symbol",
    pair
  );

  url.searchParams.set(
    "interval",
    "5min"
  );

  url.searchParams.set(
    "outputsize",
    "180"
  );

  url.searchParams.set(
    "timezone",
    "UTC"
  );

  url.searchParams.set(
    "apikey",
    TWELVE_DATA_API_KEY
  );

  const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
  const json=await response.json();
  if(json.status==="error" && /daily.*limit|credits for the day|daily quota/i.test(String(json.message||""))){
    creditsToday=OPTION_DAILY_CREDIT_LIMIT;
    try{fs.writeFileSync(USAGE_FILE,JSON.stringify({date:creditsDate,credits:creditsToday}));}catch{}
  }

  if (
    !response.ok ||
    json.status === "error" ||
    !Array.isArray(
      json.values
    )
  ) {
    throw new Error(
      json.message ||
      "Twelve Data error"
    );
  }

  const candles = [];

  for (
    const item of
    json.values
  ) {
    const time =
      Date.parse(
        item.datetime
          .replace(
            " ",
            "T"
          ) +
        "Z"
      );

    const open =
      Number(item.open);

    const high =
      Number(item.high);

    const low =
      Number(item.low);

    const close =
      Number(item.close);

    if (
      Number.isFinite(time) &&
      Number.isFinite(open) &&
      Number.isFinite(high) &&
      Number.isFinite(low) &&
      Number.isFinite(close)
    ) {
      candles.push({
        time:
          Math.floor(
            time / 1000
          ),

        open,
        high,
        low,
        close
      });
    }
  }

  candles.sort((a,b)=>a.time-b.time);
  // An unfinished market candle must never trigger an alert.
  const nowSeconds=Math.floor(Date.now()/1000);
  const closed=candles.filter(c=>c.time+300<=nowSeconds);
  candles.length=0;
  candles.push(...closed);

  if (
    candles.length === 0
  ) {
    throw new Error(
      "No market candles"
    );
  }

  const latest =
    candles[
      candles.length - 1
    ];

  marketData.set(
    pair,
    {
      candles,
      price:
        latest.close,

      marketTime:
        latest.time,

      updatedAt:
        Date.now()
    }
  );

  console.log(
    `Updated ${pair} @ ${latest.close}`
  );

  return true;
}

/* =====================================================
   REFRESH ONE PAIR EVERY 8 SECONDS
===================================================== */

async function refreshNextPair() {
  if (refreshBusy) {
    return;
  }

  refreshBusy = true;

  try {
    const pair =
      PAIR_LIST[
        refreshIndex %
        PAIR_LIST.length
      ];

    refreshIndex++;

    try {
      await refreshPair(
        pair
      );
    } catch (e) {
      console.log(
        `Refresh ${pair}:`,
        e.message
      );
    }
  } finally {
    refreshBusy = false;
  }
}

/* =====================================================
   BUILD M1 / M5 / M15
===================================================== */

function getCandles(
  pair,
  timeframe
) {
  const data =
    marketData.get(pair);

  if (
    !data ||
    !Array.isArray(
      data.candles
    )
  ) {
    return [];
  }

  const seconds =
    TF[timeframe];

  const result = [];

  for (
    const candle of
    data.candles
  ) {
    const bucket =
      Math.floor(
        candle.time /
        seconds
      ) *
      seconds;

    const last =
      result[
        result.length - 1
      ];

    if (
      last &&
      last.time === bucket
    ) {
      last.high =
        Math.max(
          last.high,
          candle.high
        );

      last.low =
        Math.min(
          last.low,
          candle.low
        );

      last.close =
        candle.close;
    } else {
      result.push({
        time:
          bucket,

        open:
          candle.open,

        high:
          candle.high,

        low:
          candle.low,

        close:
          candle.close
      });
    }
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  /*
    Analysis uses only
    COMPLETED candles.
  */

  return result.filter(
    candle =>
      candle.time +
      seconds <=
      now
  );
}

/* =====================================================
   EMA
===================================================== */

function ema(
  values,
  period
) {
  if (
    values.length <
    period
  ) {
    return null;
  }

  let result =
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

  const multiplier =
    2 /
    (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      values[i] *
        multiplier +
      result *
        (
          1 -
          multiplier
        );
  }

  return result;
}

/* =====================================================
   RSI
===================================================== */

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

  const slice =
    values.slice(
      -(period + 1)
    );

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i < slice.length;
    i++
  ) {
    const difference =
      slice[i] -
      slice[i - 1];

    if (
      difference > 0
    ) {
      gains +=
        difference;
    } else {
      losses +=
        Math.abs(
          difference
        );
    }
  }

  const averageGain =
    gains / period;

  const averageLoss =
    losses / period;

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
    100 /
    (1 + rs)
  );
}

/* =====================================================
   ATR
===================================================== */

function atr(
  candles,
  period = 14
) {
  if (
    candles.length <
    period + 1
  ) {
    return null;
  }

  const data =
    candles.slice(
      -(period + 1)
    );

  const ranges = [];

  for (
    let i = 1;
    i < data.length;
    i++
  ) {
    const current =
      data[i];

    const previous =
      data[i - 1];

    ranges.push(
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
          previous.close
        ),

        Math.abs(
          current.low -
          previous.close
        )
      )
    );
  }

  return (
    ranges.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    ranges.length
  );
}

/* =====================================================
   ANALYSE ONE TIMEFRAME
===================================================== */

function analyseTimeframe(
  pair,
  timeframe
) {
  const candles =
    getCandles(
      pair,
      timeframe
    );

  if (
    candles.length < 30
  ) {
    return null;
  }

  const closes =
    candles.map(
      candle =>
        candle.close
    );

  const latest =
    candles[
      candles.length - 1
    ];

  const ema5 =
    ema(
      closes,
      5
    );

  const ema13 =
    ema(
      closes,
      13
    );

  const previousEma5 =
    ema(
      closes.slice(
        0,
        -1
      ),
      5
    );

  const previousEma13 =
    ema(
      closes.slice(
        0,
        -1
      ),
      13
    );

  const currentRsi =
    rsi(
      closes,
      14
    );

  const currentAtr =
    atr(
      candles,
      14
    );

  if (
    ![
      ema5,
      ema13,
      previousEma5,
      previousEma13,
      currentRsi,
      currentAtr
    ].every(
      Number.isFinite
    )
  ) {
    return null;
  }

  const direction =
    ema5 >
    ema13
      ? "CALL"
      : "PUT";

  const oldClose =
    closes[
      closes.length - 4
    ];

  const momentum =
    (
      (
        latest.close -
        oldClose
      ) /
      oldClose
    ) *
    100;

  const trendStrength =
    currentAtr > 0
      ? Math.abs(
          ema5 -
          ema13
        ) /
        currentAtr
      : 0;

  let score = 48;

  if (
    direction === "CALL"
  ) {
    score += 8;

    if (
      ema5 >
      previousEma5
    ) {
      score += 7;
    }

    if (
      ema13 >=
      previousEma13
    ) {
      score += 5;
    }

    if (
      currentRsi >= 52 &&
      currentRsi <= 68
    ) {
      score += 8;
    }

    if (
      currentRsi > 75
    ) {
      score -= 10;
    }

    if (
      momentum > 0
    ) {
      score += 7;
    } else {
      score -= 8;
    }

    if (
      latest.close >
      latest.open
    ) {
      score += 4;
    }
  } else {
    score += 8;

    if (
      ema5 <
      previousEma5
    ) {
      score += 7;
    }

    if (
      ema13 <=
      previousEma13
    ) {
      score += 5;
    }

    if (
      currentRsi >= 32 &&
      currentRsi <= 48
    ) {
      score += 8;
    }

    if (
      currentRsi < 25
    ) {
      score -= 10;
    }

    if (
      momentum < 0
    ) {
      score += 7;
    } else {
      score -= 8;
    }

    if (
      latest.close <
      latest.open
    ) {
      score += 4;
    }
  }

  /*
    Sideways market protection.
  */

  if (
    trendStrength >= 0.22
  ) {
    score += 6;
  } else {
    score -= 12;
  }

  return {
    direction,
    score,

    ema5,
    ema13,

    rsi:
      currentRsi,

    atr:
      currentAtr,

    momentum,

    trendStrength,

    price:
      latest.close
  };
}

/* =====================================================
   MARKET FRESHNESS
===================================================== */

function marketIsFresh(
  pair
) {
  const data =
    marketData.get(pair);

  if (!data) {
    return false;
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  /*
    More than 5 minutes old:
    do not generate a signal.
  */

  const closedAt=data.marketTime+300;
  return closedAt<=now && now-closedAt<=360 && Date.now()-data.updatedAt<=180000;
}

/* =====================================================
   FULL MTF ANALYSIS
===================================================== */

async function analyse(
  pairInput,
  timeframeInput
) {
  const pair =
    normalizePair(
      pairInput
    );

  const timeframe =
    normalizeTf(
      timeframeInput
    );

  if (!pair) {
    throw new Error(
      "Unsupported pair"
    );
  }

  const market =
    marketData.get(pair);

  if (
    !market ||
    market.candles.length <
      30
  ) {
    return {
      ok: true,
      pair,
      timeframe,

      side:
        "WAIT",

      direction:
        "WAIT",

      signal:
        "WAIT",

      confidence: 0,

      price:
        market?.price ||
        null,

      reason:
        "MARKET DATA WARMING UP"
    };
  }

  if (
    !marketIsFresh(pair)
  ) {
    return {
      ok: true,
      pair,
      timeframe,

      side:
        "WAIT",

      direction:
        "WAIT",

      signal:
        "WAIT",

      confidence: 0,

      price:
        roundPrice(
          pair,
          market.price
        ),

      reason:
        "MARKET DATA IS STALE"
    };
  }

  const base =
    analyseTimeframe(
      pair,
      timeframe
    );

  if (!base) {
    return {
      ok: true,
      pair,
      timeframe,

      side:
        "WAIT",

      direction:
        "WAIT",

      signal:
        "WAIT",

      confidence: 0,

      price:
        roundPrice(
          pair,
          market.price
        ),

      reason:
        "NOT ENOUGH DATA"
    };
  }

  let confirmationTfs;

  if (
    timeframe === "M1"
  ) {
    confirmationTfs = [
      "M5",
      "M15"
    ];
  } else if (
    timeframe === "M5"
  ) {
    confirmationTfs = [
      "M15"
    ];
  } else {
    confirmationTfs = [
      "M1",
      "M5"
    ];
  }

  let score =
    base.score;

  const confirmations = [];
  const conflicts = [];

  for (
    const confirmTf of
    confirmationTfs
  ) {
    const analysis =
      analyseTimeframe(
        pair,
        confirmTf
      );

    if (!analysis) {
      continue;
    }

    if (
      analysis.direction ===
      base.direction
    ) {
      confirmations.push(
        confirmTf
      );

      score +=
        confirmTf === "M15"
          ? 9
          : 6;
    } else {
      conflicts.push(
        confirmTf
      );

      score -=
        confirmTf === "M15"
          ? 16
          : 10;
    }
  }

  let confidence =
    Math.round(
      clamp(
        score,
        50,
        90
      )
    );

  let side =
    base.direction;

  const extremeRsi =
    (
      side === "CALL" &&
      base.rsi > 76
    ) ||
    (
      side === "PUT" &&
      base.rsi < 24
    );

  /*
    Important:
    M15 conflict => WAIT.
  */

  if (
    base.trendStrength <
      0.18 ||
    extremeRsi ||
    conflicts.includes(
      "M15"
    ) ||
    (timeframe==="M5" && !confirmations.includes("M15")) ||
    confidence <
      MIN_CONFIDENCE
  ) {
    side =
      "WAIT";
  }

  /*
    M1 is stricter:
    M5 and M15 should agree.
  */

  if (
    timeframe === "M1" &&
    (
      !confirmations.includes(
        "M5"
      ) ||
      !confirmations.includes(
        "M15"
      )
    )
  ) {
    side =
      "WAIT";
  }

  if (
    side === "WAIT"
  ) {
    confidence =
      Math.min(
        confidence,
        MIN_CONFIDENCE - 1
      );
  }

  const price =
    roundPrice(
      pair,
      market.price
    );

  const expirySeconds =
    TF[timeframe];

  const expiryMinutes =
    expirySeconds /
    60;

  const expiresAt =
    Date.now() +
    expirySeconds *
      1000;

  return {
    ok: true,

    source:
      "Twelve Data REST",

    pair,
    timeframe,

    side,
    direction:
      side,

    signal:
      side,

    confidence,

    price,
    entry:
      price,

    ema5:
      roundPrice(
        pair,
        base.ema5
      ),

    ema13:
      roundPrice(
        pair,
        base.ema13
      ),

    emaFast:
      roundPrice(
        pair,
        base.ema5
      ),

    emaSlow:
      roundPrice(
        pair,
        base.ema13
      ),

    rsi:
      Number(
        base.rsi
          .toFixed(1)
      ),

    atr:
      roundPrice(
        pair,
        base.atr
      ),

    momentum:
      Number(
        base.momentum
          .toFixed(4)
      ),

    confirmations,
    conflicts,

    expirySeconds,
    expiryMinutes,

    expiresAt,
    expiryAt:
      expiresAt,

    note:
      "Confidence is an internal signal score, not a guaranteed win probability."
  };
}

/* =====================================================
   ONESIGNAL
===================================================== */

async function sendPush(
  title,
  message,
  data = {}
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

  try {
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

              data
            })
        }
      );

    const text =
      await response.text();

    console.log(
      "OneSignal:",
      response.status,
      text
    );

    return {
      ok:
        response.ok,

      status:
        response.status,

      body:
        text
    };
  } catch (e) {
    console.log(
      "Push error:",
      e.message
    );

    return {
      ok: false,
      error:
        e.message
    };
  }
}


/* Telegram is the only automatic notification channel for ADAMS OPTION.
   Never log the bot token or expose it in API responses. */
async function sendTelegram(message){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID){lastTelegramError="Telegram credentials not configured";return {ok:false,skipped:true}}
  try{
    const response=await fetch("https://api.telegram.org/bot"+TELEGRAM_BOT_TOKEN+"/sendMessage",{
      method:"POST",signal:AbortSignal.timeout(8000),headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:message,disable_web_page_preview:true})
    });
    const json=await response.json().catch(()=>({}));
    if(!response.ok||!json.ok)throw new Error("Telegram delivery rejected (HTTP "+response.status+")");
    lastTelegramError=null;return {ok:true};
  }catch(error){lastTelegramError=error.message;console.error("ADAMS OPTION Telegram:",error.message);return {ok:false,error:error.message}}
}

/* =====================================================
   TRADE VALIDATION
===================================================== */

function canOpenTrade(
  signal
) {
  if (!storageReady) return false;

  if (
    ![
      "CALL",
      "PUT"
    ].includes(
      signal.side
    )
  ) {
    return false;
  }

  if (
    signal.confidence <
    MIN_CONFIDENCE
  ) {
    return false;
  }

  if (
    db.openTrades.length >=
    MAX_OPEN_TRADES
  ) {
    return false;
  }

  /*
    Do not open duplicate
    pair + timeframe trade.
  */

  const duplicate =
    db.openTrades.some(
      trade =>
        trade.pair ===
          signal.pair &&
        trade.timeframe ===
          signal.timeframe
    );

  if (duplicate) {
    return false;
  }

  const key =
    `${signal.pair}|${signal.timeframe}|${signal.side}`;

  const last =
    lastSignal.get(key) ||
    0;

  const cooldown =
    COOLDOWN[
      signal.timeframe
    ];

  if (
    Date.now() -
      last <
    cooldown
  ) {
    return false;
  }

  return true;
}

/* =====================================================
   OPEN DEMO TRADE
===================================================== */

async function openTrade(
  signal,
  origin = "manual"
) {
  if (
    !canOpenTrade(
      signal
    )
  ) {
    return null;
  }

  const now =
    Date.now();

  const expiresAt =
    now +
    signal.expirySeconds *
      1000;

  const trade = {
    id:
      `${now}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

    pair:
      signal.pair,

    timeframe:
      signal.timeframe,

    side:
      signal.side,

    direction:
      signal.side,

    confidence:
      signal.confidence,

    entry:
      signal.price,

    openedAt:
      now,

    createdAt:
      now,

    expiresAt,
    expiryAt:
      expiresAt,

    status:
      "OPEN",

    result:
      "OPEN",

    origin
  };

  // Persist before notifying Telegram so alerts always have a recorded trade.
  db.openTrades.unshift(trade);
  const cooldownKey = `${signal.pair}|${signal.timeframe}|${signal.side}`;
  try {
    await saveHistory();
  } catch (error) {
    db.openTrades = db.openTrades.filter(item=>item.id!==trade.id);
    console.error("Refusing unrecorded demo signal:",error.message);
    return null;
  }
  lastSignal.set(cooldownKey,now);

  await sendTelegram(
    (trade.direction==="CALL"?"🟢":"🔴")+" ADAMS OPTION • "+trade.direction+
    "\nPAIR: "+trade.pair+" (regular Forex, NOT OTC)"+
    "\nTIMEFRAME: M5"+
    "\nENTRY: "+trade.entry+
    "\nEXPIRY: 5 minutes"+
    "\nQUALITY SCORE: "+trade.confidence+"/100 (not win probability)"+
    "\nMODE: SIGNAL + DEMO RESULT, no automatic Pocket Option trade"+
    "\nID: "+trade.id
  );

  return trade;
}

/* =====================================================
   SETTLE TRADE
===================================================== */

async function settleTrade(
  trade
) {
  const market =
    marketData.get(
      trade.pair
    );

  if (
    !market ||
    !Number.isFinite(
      Number(
        market.price
      )
    )
  ) {
    return false;
  }

  /*
    Don't settle using stale
    market prices.
  */

  if (
    !marketIsFresh(
      trade.pair
    )
  ) {
    return false;
  }

  // Use the first complete M5 candle that closed at or after expiry,
  // rather than a later quote when this pair is scanned again.
  const expirySeconds=Number(trade.expiresAt||trade.expiryAt)/1000;
  const nowSeconds=Math.floor(Date.now()/1000);
  const exitCandle=market.candles.find(c=>c.time+300>=expirySeconds&&c.time+300<=nowSeconds);
  if(!exitCandle)return false;
  const exit=roundPrice(trade.pair,exitCandle.close);

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
    } else if (
      exit <
      trade.entry
    ) {
      result =
        "LOST";
    }
  } else {
    if (
      exit <
      trade.entry
    ) {
      result =
        "WIN";
    } else if (
      exit >
      trade.entry
    ) {
      result =
        "LOST";
    }
  }

  const finished = {
    ...trade,

    exit,

    closedAt:
      Date.now(),

    status:
      result,

    result
  };

  db.openTrades =
    db.openTrades.filter(
      item =>
        item.id !==
        trade.id
    );

  db.history.unshift(
    finished
  );

  db.history =
    db.history.slice(
      0,
      1000
    );

  try {
    await saveHistory();
  } catch (error) {
    // Keep the expired trade pending if its result cannot be stored safely.
    db.openTrades.unshift(trade);
    db.history = db.history.filter(item=>item.id!==trade.id);
    console.error("Settlement persistence failed:",error.message);
    return false;
  }

  const stats=getStats();
  await sendTelegram(
    (result==="WIN"?"🏆":result==="LOST"?"⛔":"➖")+" ADAMS OPTION DEMO • "+result+
    "\nPAIR: "+finished.pair+
    "\nDIRECTION: "+finished.direction+
    "\nTIMEFRAME: M5 • EXPIRY: 5m"+
    "\nENTRY: "+finished.entry+" → EXIT: "+finished.exit+
    "\nTOTAL WIN: "+stats.wins+" • LOST: "+stats.losses+" • DRAW: "+stats.draws+
    "\nDEMO WIN RATE: "+stats.winRate+"%"+
    "\nSOURCE: Twelve Data, NOT Pocket Option fill"+
    "\nID: "+finished.id
  );

  return true;
}

/* =====================================================
   CHECK EXPIRY
===================================================== */

const settlingTrades = new Set();
async function checkExpiredTrades() {
  const now = Date.now();
  for (const trade of [...db.openTrades]) {
    const expiry = Number(trade.expiresAt || trade.expiryAt || 0);
    if (!expiry || expiry > now || settlingTrades.has(trade.id)) continue;
    settlingTrades.add(trade.id);
    try { await settleTrade(trade); }
    catch (error) { console.error("Demo settlement:",error.message); }
    finally { settlingTrades.delete(trade.id); }
  }
}

/* =====================================================
   STATS
===================================================== */

function getStats() {
  const wins =
    db.history.filter(
      trade =>
        trade.result ===
        "WIN"
    ).length;

  const losses =
    db.history.filter(
      trade =>
        trade.result ===
          "LOST" ||
        trade.result ===
          "LOSS"
    ).length;

  const draws =
    db.history.filter(
      trade =>
        trade.result ===
        "DRAW"
    ).length;

  const decided =
    wins +
    losses;

  const winRate =
    decided > 0
      ? Number(
          (
            wins /
            decided *
            100
          ).toFixed(1)
        )
      : 0;

  return {
    wins,
    losses,
    draws,
    winRate,

    openTrades:
      db.openTrades.length,

    totalHistory:
      db.history.length
  };
}

/* =====================================================
   SCAN ALL 8 PAIRS
===================================================== */

async function scanAll(
  timeframe = "M5",
  openBest = true
) {
  const results = [];

  for (
    const pair of
    PAIR_LIST
  ) {
    try {
      const result =
        await analyse(
          pair,
          timeframe
        );

      results.push(
        result
      );
    } catch (e) {
      results.push({
        ok: false,

        pair,
        timeframe,

        side:
          "WAIT",

        direction:
          "WAIT",

        confidence: 0,

        error:
          e.message
      });
    }
  }

  const sorted =
    [...results]
      .sort(
        (a, b) =>
          (
            b.confidence ||
            0
          ) -
          (
            a.confidence ||
            0
          )
      );

  const best =
    sorted.find(
      result =>
        [
          "CALL",
          "PUT"
        ].includes(
          result.side
        )
    );

  if (!best) {
    const first =
      sorted[0];

    return {
      ok: true,

      pair:
        first?.pair ||
        null,

      timeframe,

      side:
        "WAIT",

      direction:
        "WAIT",

      signal:
        "WAIT",

      confidence:
        first?.confidence ||
        0,

      price:
        first?.price ||
        null,

      reason:
        "NO CONFIRMED SIGNAL",

      trade:
        null,

      results
    };
  }

  let trade = null;

  if (openBest) {
    trade =
      await openTrade(
        best,
        "scan"
      );
  }

  lastAuto =
    best;

  return {
    ...best,
    trade,
    results
  };
}

/* =====================================================
   BACKGROUND AUTO SCAN
===================================================== */

async function autoCycle() {
  if (
    !autoEnabled ||
    autoBusy
  ) {
    return;
  }

  autoBusy = true;

  try {
    const signals = [];

    for (
      const timeframe of
      [
        "M1",
        "M5",
        "M15"
      ]
    ) {
      for (
        const pair of
        PAIR_LIST
      ) {
        try {
          const signal =
            await analyse(
              pair,
              timeframe
            );

          if (
            [
              "CALL",
              "PUT"
            ].includes(
              signal.side
            )
          ) {
            signals.push(
              signal
            );
          }
        } catch {}
      }
    }

    signals.sort(
      (a, b) =>
        b.confidence -
        a.confidence
    );

    const usedPairs =
      new Set();

    for (
      const signal of
      signals
    ) {
      if (
        db.openTrades.length >=
        MAX_OPEN_TRADES
      ) {
        break;
      }

      if (
        usedPairs.has(
          signal.pair
        )
      ) {
        continue;
      }

      const trade =
        await openTrade(
          signal,
          "auto"
        );

      if (trade) {
        usedPairs.add(
          signal.pair
        );

        lastAuto =
          signal;
      }
    }
  } finally {
    autoBusy = false;
  }
}

/* =====================================================
   ROOT
===================================================== */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,

      name:
        "ADAMS OPTION SERVER",

      mode:
        "FOREX REAL DATA • REST MODE • DEMO",

      dataMode:
        "Twelve Data REST",

      autoEnabled,

      pairs:
        PAIR_LIST.length
    });
  }
);

/* =====================================================
   HEALTH
===================================================== */

function healthData() {
  const readyPairs =
    PAIR_LIST.filter(
      pair =>
        marketData.has(pair)
    ).length;

  return {
    ok: true,

    status:
      "online",

    server:
      "online",

    dataMode:
      "REST",

    autoEnabled,

    readyPairs,

    totalPairs:
      PAIR_LIST.length,

    pushConfigured:Boolean(ONESIGNAL_APP_ID&&ONESIGNAL_API_KEY),
    telegramConfigured:Boolean(TELEGRAM_BOT_TOKEN&&TELEGRAM_CHAT_ID),
    telegramDeliveryError:lastTelegramError,
    timeframe:"M5",autoScanEveryMinutes:5,forexOpen:forexWindowOpen(),
    requestsToday:creditsToday,requestBudget:OPTION_DAILY_CREDIT_LIMIT,
    historyStorage: {mode:STORAGE_MODE,ready:storageReady,
      durable:STORAGE_MODE!=="ephemeral"&&storageReady,error:storageError},
    pendingSettlements:db.openTrades.filter(t=>Number(t.expiresAt||t.expiryAt||0)<=Date.now()).length,
    lastM5CycleAt
  };
}

app.get(
  "/health",
  (req, res) => {
    res.json(
      healthData()
    );
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.json(
      healthData()
    );
  }
);

/* =====================================================
   ANALYSE SELECTED
===================================================== */

async function analyseRoute(
  req,
  res
) {
  try {
    const pair =
      req.body?.pair ||
      req.query?.pair;

    const timeframe =
      "M5";

    const signal =
      await analyse(
        pair,
        timeframe
      );

    let trade = null;

    if (
      [
        "CALL",
        "PUT"
      ].includes(
        signal.side
      )
    ) {
      trade =
        await openTrade(
          signal,
          "manual"
        );
    }

    res.json({
      ...signal,
      trade
    });
  } catch (e) {
    res
      .status(400)
      .json({
        ok: false,

        side:
          "WAIT",

        direction:
          "WAIT",

        signal:
          "WAIT",

        confidence: 0,

        error:
          e.message
      });
  }
}

app.get(
  "/api/analyse",
  analyseRoute
);

app.post(
  "/api/analyse",
  analyseRoute
);

app.get(
  "/api/analyze",
  analyseRoute
);

app.post(
  "/api/analyze",
  analyseRoute
);

/* =====================================================
   AUTO SCAN BUTTON
===================================================== */

async function scanRoute(
  req,
  res
) {
  try {
    const timeframe =
      "M5";

    const result =
      await scanAll(
        timeframe,
        true
      );

    res.json(
      result
    );
  } catch (e) {
    res
      .status(500)
      .json({
        ok: false,
        error:
          e.message
      });
  }
}

app.get(
  "/api/auto-scan",
  scanRoute
);

app.post(
  "/api/auto-scan",
  scanRoute
);

app.get(
  "/api/scan-all",
  scanRoute
);

app.post(
  "/api/scan-all",
  scanRoute
);

/* =====================================================
   OPEN TRADES
===================================================== */

app.get(
  "/api/open-trades",
  (req, res) => {
    res.json(
      db.openTrades
    );
  }
);

/* =====================================================
   HISTORY
===================================================== */

app.get(
  "/api/history",
  (req, res) => {
    const limit =
      clamp(
        Number(
          req.query.limit ||
          200
        ),
        1,
        1000
      );

    res.json({
      history:
        db.history.slice(
          0,
          limit
        )
    });
  }
);

/* =====================================================
   STATS
===================================================== */

app.get(
  "/api/stats",
  (req, res) => {
    res.json(
      getStats()
    );
  }
);

/* =====================================================
   STATE
===================================================== */

app.get(
  "/api/state",
  (req, res) => {
    res.json({
      ok: true,

      running:
        autoEnabled,

      autoScanEnabled:
        autoEnabled,

      scanning:
        autoBusy,

      minConfidence:
        MIN_CONFIDENCE,

      maxOpenTrades:
        MAX_OPEN_TRADES,

      best:
        lastAuto,

      stats:
        getStats(),

      openTrades:
        db.openTrades,

      readyPairs:
        PAIR_LIST.filter(
          pair =>
            marketData.has(
              pair
            )
        ).length
    });
  }
);

/* =====================================================
   START / STOP
===================================================== */

app.post(
  "/api/start",
  (req, res) => {
    autoEnabled =
      true;

    m5Cycle().catch(error=>console.error("Start M5:",error.message));

    res.json({
      ok: true,
      running: true,
      timeframe:"M5",
      demoOnly:true
    });
  }
);

app.post(
  "/api/stop",
  (req, res) => {
    autoEnabled =
      false;

    res.json({
      ok: true,
      running: false
    });
  }
);

/* =====================================================
   TEST NOTIFICATION
===================================================== */

async function testPushRoute(
  req,
  res
) {
  const result =
    await sendPush(
      "ADAMS OPTION",

      "Notifications are working ✅",

      {
        type:
          "test"
      }
    );

  res.json(
    result
  );
}

app.get(
  "/api/test-notification",
  testPushRoute
);

app.post(
  "/api/test-notification",
  testPushRoute
);

/* =====================================================
   M5 BACKGROUND BOT • 1 API credit per 5 min, weekdays 08–20 UK
   Eight regular Forex pairs rotate, one at a time; no OTC quotes.
===================================================== */
async function m5Cycle(){
  if(!autoEnabled||!storageReady||m5CycleBusy||!forexWindowOpen()||creditsToday>=OPTION_DAILY_CREDIT_LIMIT)return;
  m5CycleBusy=true;
  try{
    for(let index=0;index<FOREX_CALLS_PER_CYCLE;index++){
      // Prioritize due results so an expiring M5 trade is not left waiting
      // through an entire eight-pair rotation. One data call per cycle stays.
      const due=db.openTrades.filter(t=>Number(t.expiresAt||t.expiryAt||0)<=Date.now())
        .sort((a,b)=>Number(a.expiresAt||a.expiryAt)-Number(b.expiresAt||b.expiryAt))[0];
      const pair=due?.pair || PAIR_LIST[refreshIndex++ % PAIR_LIST.length];
      try{
        await refreshPair(pair);
        // Also close previous demo trades using their actual expiry M5 candle.
        await checkExpiredTrades();
        const signal=await analyse(pair,"M5");
        if(["CALL","PUT"].includes(signal.side)){
          const trade=await openTrade(signal,"telegram-m5-auto");
          if(trade)lastAuto=signal;
        }
      }catch(error){console.warn("M5 "+pair+":",error.message)}
    }
    lastM5CycleAt=new Date().toISOString();
  }finally{m5CycleBusy=false}
}
setInterval(()=>{m5Cycle().catch(e=>console.error("M5 bot:",e.message))},SCAN_SECONDS*1000);
setInterval(()=>{checkExpiredTrades().catch(()=>{})},30000);

/* =====================================================
   START
===================================================== */

async function startServer() {
  await initStorage();
  app.listen(PORT, () => {
    console.log(`ADAMS OPTION running on port ${PORT} (history: ${STORAGE_MODE})`);
    console.log("REST market data mode");
    if (forexWindowOpen()) m5Cycle().catch(e=>console.error("Initial M5:",e.message));
  });
  // Recover from a temporary database outage without needing a redeploy.
  if (DATABASE_URL) setInterval(()=>{
    if (!storageReady) initStorage().catch(e=>console.error("Storage retry:",e.message));
  },60000);
}
startServer().catch(error=>{ console.error("Startup:",error.message); process.exitCode=1; });
