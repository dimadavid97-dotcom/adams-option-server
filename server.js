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

const MAX_OPEN_TRADES =
  Number(process.env.MAX_OPEN_TRADES || 2);

const AUTO_SCAN_ENABLED =
  String(
    process.env.AUTO_SCAN_ENABLED || "true"
  ).toLowerCase() === "true";

const AUTO_SCAN_MINUTES =
  Math.max(
    5,
    Number(
      process.env.AUTO_SCAN_MINUTES || 20
    )
  );

const AUTO_SCAN_TIMEFRAME =
  String(
    process.env.AUTO_SCAN_TIMEFRAME || "ALL"
  ).toUpperCase();

const SIGNAL_EXPIRY_WARNING_SECONDS = 10;


// =====================================================
// PAIRS
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


// =====================================================
// FILES
// =====================================================

const HISTORY_FILE =
  "./history.json";

const OPEN_TRADES_FILE =
  "./open-trades.json";

const MAX_HISTORY = 500;


// =====================================================
// CACHE
// =====================================================

const PAIR_CACHE_MS =
  60 * 1000;

const SCAN_CACHE_MS =
  60 * 1000;


// =====================================================
// API URLS
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

const tradeTimers =
  new Map();

let scanCache = {
  timestamp: 0,
  data: null
};

let lastBackgroundScanAt = 0;

let backgroundScanRunning = false;

let backgroundLastResult = null;


// =====================================================
// HELPERS
// =====================================================

function nowIso(){

  return new Date()
    .toISOString();
}


function round(
  value,
  digits = 5
){

  if(
    !Number.isFinite(value)
  ){
    return null;
  }

  return Number(
    value.toFixed(digits)
  );
}


function digitsForPair(pair){

  return pair.includes("JPY")
    ? 3
    : 5;
}


function formatPrice(
  pair,
  value
){

  return round(
    Number(value),
    digitsForPair(pair)
  );
}


function tradeKey(
  pair,
  timeframe
){

  return `${pair}|${timeframe}`;
}


function expiryMs(timeframe){

  if(timeframe === "M15"){

    return 15 * 60 * 1000;
  }

  if(timeframe === "M5"){

    return 5 * 60 * 1000;
  }

  return 60 * 1000;
}


function expiryLabel(timeframe){

  if(timeframe === "M15"){
    return "15:00";
  }

  if(timeframe === "M5"){
    return "05:00";
  }

  return "01:00";
}


function cooldownMs(timeframe){

  if(timeframe === "M15"){

    return 30 * 60 * 1000;
  }

  if(timeframe === "M5"){

    return 15 * 60 * 1000;
  }

  return 10 * 60 * 1000;
}


// =====================================================
// HISTORY
// =====================================================

function loadHistory(){

  try{

    if(
      !fs.existsSync(
        HISTORY_FILE
      )
    ){
      return;
    }

    const data =
      JSON.parse(
        fs.readFileSync(
          HISTORY_FILE,
          "utf8"
        )
      );

    if(
      Array.isArray(data)
    ){

      history =
        data.slice(
          0,
          MAX_HISTORY
        );
    }

  }catch(error){

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


function saveHistory(){

  try{

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

  }catch(error){

    console.log(
      "History save warning:",
      error.message
    );
  }
}


function addHistory(trade){

  history.unshift(trade);

  history =
    history.slice(
      0,
      MAX_HISTORY
    );


  if(
    trade.result === "WIN"
  ){
    wins += 1;
  }


  if(
    trade.result === "LOST"
  ){
    losses += 1;
  }


  if(
    trade.result === "DRAW"
  ){
    draws += 1;
  }


  saveHistory();
}


// =====================================================
// OPEN TRADES SAVE
// =====================================================

function saveOpenTrades(){

  try{

    fs.writeFileSync(

      OPEN_TRADES_FILE,

      JSON.stringify(
        Array.from(
          openTrades.values()
        ),
        null,
        2
      ),

      "utf8"
    );

  }catch(error){

    console.log(
      "Open trades save warning:",
      error.message
    );
  }
}


function loadOpenTrades(){

  try{

    if(
      !fs.existsSync(
        OPEN_TRADES_FILE
      )
    ){
      return;
    }


    const data =
      JSON.parse(
        fs.readFileSync(
          OPEN_TRADES_FILE,
          "utf8"
        )
      );


    if(
      !Array.isArray(data)
    ){
      return;
    }


    for(
      const trade
      of data
    ){

      if(
        !trade?.pair ||
        !trade?.timeframe ||
        !trade?.id
      ){
        continue;
      }


      const key =
        tradeKey(
          trade.pair,
          trade.timeframe
        );


      openTrades.set(
        key,
        trade
      );


      const openedAtMs =
        new Date(
          trade.openedAt || 0
        ).getTime();


      if(
        Number.isFinite(
          openedAtMs
        )
      ){

        lastTradeTime.set(
          key,
          openedAtMs
        );
      }
    }

  }catch(error){

    console.log(
      "Open trades load warning:",
      error.message
    );
  }
}


// =====================================================
// EMA
// =====================================================

function ema(
  values,
  period
){

  if(
    !values ||
    values.length < period
  ){

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
        (sum,value) =>
          sum + value,
        0
      ) /
    period;


  for(
    let i = period;
    i < values.length;
    i++
  ){

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
  period = 14
){

  if(
    !values ||
    values.length <
      period + 1
  ){

    return null;
  }


  let gains = 0;

  let lossesLocal = 0;


  const start =
    values.length -
    period -
    1;


  for(
    let i =
      start + 1;
    i < values.length;
    i++
  ){

    const diff =
      values[i] -
      values[i - 1];


    if(
      diff > 0
    ){

      gains += diff;

    }else{

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


  if(
    avgLoss === 0
  ){

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


// =====================================================
// MOMENTUM
// =====================================================

function momentum(
  values,
  period = 3
){

  if(
    !values ||
    values.length <= period
  ){

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

function parseDate(value){

  if(!value){
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


function parseCandles(values){

  if(
    !Array.isArray(values)
  ){

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
      (a,b) =>
        a.start -
        b.start
    );
}


function aggregateCandles(
  source,
  intervalSec
){

  const groups =
    new Map();


  for(
    const candle
    of source
  ){

    const bucket =
      Math.floor(
        candle.start /
        intervalSec
      ) *
      intervalSec;


    if(
      !groups.has(
        bucket
      )
    ){

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

    }else{

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


  return Array
    .from(
      groups.values()
    )
    .sort(
      (a,b) =>
        a.start -
        b.start
    );
}


// =====================================================
// SIGNAL ENGINE
// =====================================================

function rawSignal(
  pair,
  timeframe,
  candles
){

  if(
    !candles ||
    candles.length < 15
  ){

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
        candles?.length || 0,

      updatedAt:
        nowIso()
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


  if(
    !Number.isFinite(fast) ||
    !Number.isFinite(slow) ||
    !Number.isFinite(currentRsi)
  ){

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
        recent.length,

      updatedAt:
        nowIso()
    };
  }


  let score = 0;


  if(
    fast > slow
  ){
    score += 3;
  }


  if(
    fast < slow
  ){
    score -= 3;
  }


  if(
    last.close > fast
  ){
    score += 1;
  }


  if(
    last.close < fast
  ){
    score -= 1;
  }


  if(
    currentRsi >= 54 &&
    currentRsi <= 72
  ){

    score += 2;
  }


  if(
    currentRsi <= 46 &&
    currentRsi >= 28
  ){

    score -= 2;
  }


  if(
    mom > 0
  ){
    score += 1;
  }


  if(
    mom < 0
  ){
    score -= 1;
  }


  if(
    last.close >
    last.open
  ){
    score += 1;
  }


  if(
    last.close <
    last.open
  ){
    score -= 1;
  }


  let side =
    "WAIT";


  if(
    score >= 6
  ){
    side =
      "CALL";
  }


  if(
    score <= -6
  ){
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


  if(
    side === "WAIT"
  ){

    confidence =
      Math.min(
        MIN_CONFIDENCE - 1,
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
// MULTI TIMEFRAME
// =====================================================

function analysePairCandles(
  pair,
  m1
){

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


  // M1 confirmed by M5

  if(
    result.M1.side !==
    "WAIT"
  ){

    if(
      result.M5.side ===
      result.M1.side
    ){

      result.M1.confidence +=
        6;

    }else if(
      result.M5.side !==
      "WAIT"
    ){

      result.M1.confidence -=
        8;
    }
  }


  // M5 confirmed by M15

  if(
    result.M5.side !==
    "WAIT"
  ){

    if(
      result.M15.side ===
      result.M5.side
    ){

      result.M5.confidence +=
        6;

    }else if(
      result.M15.side !==
      "WAIT"
    ){

      result.M5.confidence -=
        8;
    }
  }


  // M15 confirmed by M5

  if(
    result.M15.side !==
      "WAIT" &&
    result.M5.side ===
      result.M15.side
  ){

    result.M15.confidence +=
      4;
  }


  for(
    const tf
    of TIMEFRAMES
  ){

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


    if(
      result[tf].side !==
        "WAIT" &&
      result[tf]
        .confidence <
        MIN_CONFIDENCE
    ){

      result[tf].side =
        "WAIT";
    }
  }


  return result;
}


// =====================================================
// FETCH ONE PAIR
// =====================================================

async function fetchOnePair(pair){

  const cached =
    pairCache.get(pair);


  if(
    cached &&
    Date.now() -
      cached.timestamp <
      PAIR_CACHE_MS
  ){

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


  if(
    !response.ok ||
    data.status ===
      "error"
  ){

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
// BATCH HELPERS
// =====================================================

function extractBatchPayload(
  data,
  pair
){

  if(
    data?.[pair]
  ){
    return data[pair];
  }


  if(
    data?.data?.[pair]
  ){
    return data.data[pair];
  }


  const clean =
    pair.replace(
      "/",
      ""
    );


  if(
    data?.[clean]
  ){
    return data[clean];
  }


  if(
    data?.data?.[clean]
  ){
    return data.data[clean];
  }


  return null;
}


// =====================================================
// AUTO SCAN ALL PAIRS
// =====================================================

async function fetchAllPairs(){

  if(
    scanCache.data &&
    Date.now() -
      scanCache.timestamp <
      SCAN_CACHE_MS
  ){

    return {

      ...scanCache.data,

      cached:
        true
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


  if(
    !response.ok
  ){

    throw new Error(
      data.message ||
      "Twelve Data error"
    );
  }


  const result = {};


  for(
    const pair
    of PAIRS
  ){

    const payload =
      extractBatchPayload(
        data,
        pair
      );


    if(
      !payload ||
      payload.status ===
        "error"
    ){

      result[pair] = {

        M1:{
          pair,
          timeframe:"M1",
          side:"WAIT",
          confidence:0,
          reason:
            payload?.message ||
            "NO_DATA"
        },

        M5:{
          pair,
          timeframe:"M5",
          side:"WAIT",
          confidence:0,
          reason:
            payload?.message ||
            "NO_DATA"
        },

        M15:{
          pair,
          timeframe:"M15",
          side:"WAIT",
          confidence:0,
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
  timeframe = "ALL"
){

  const candidates = [];


  for(
    const pair
    of PAIRS
  ){

    const timeframes =
      timeframe === "ALL"
        ? TIMEFRAMES
        : [timeframe];


    for(
      const tf
      of timeframes
    ){

      const signal =
        scan?.pairs?.[pair]?.[tf];


      if(
        !signal ||
        signal.side ===
          "WAIT" ||
        signal.confidence <
          MIN_CONFIDENCE
      ){

        continue;
      }


      candidates.push(
        signal
      );
    }
  }


  candidates.sort(
    (a,b) =>
      b.confidence -
      a.confidence
  );


  return (
    candidates[0] ||
    null
  );
}


// =====================================================
// CURRENT PRICE
// =====================================================

async function fetchPrices(pairs){

  const uniquePairs =
    [
      ...new Set(
        pairs
      )
    ];


  if(
    uniquePairs.length ===
    0
  ){

    return {};
  }


  const params =
    new URLSearchParams({

      symbol:
        uniquePairs.join(","),

      apikey:
        TWELVE_DATA_API_KEY
    });


  const response =
    await fetch(
      `${TD_PRICE}?${params.toString()}`
    );


  const data =
    await response.json();


  if(
    !response.ok
  ){

    throw new Error(
      data.message ||
      "Price fetch error"
    );
  }


  const result = {};


  if(
    uniquePairs.length === 1 &&
    data?.price !== undefined
  ){

    result[
      uniquePairs[0]
    ] =
      Number(
        data.price
      );


    return result;
  }


  for(
    const pair
    of uniquePairs
  ){

    const clean =
      pair.replace(
        "/",
        ""
      );


    const item =
      data?.[pair] ||
      data?.data?.[pair] ||
      data?.[clean] ||
      data?.data?.[clean];


    const value =
      Number(
        item?.price
      );


    if(
      Number.isFinite(
        value
      )
    ){

      result[pair] =
        value;
    }
  }


  return result;
}


// =====================================================
// ONESIGNAL
// =====================================================

async function sendPush(
  title,
  message,
  extra = {}
){

  if(
    !ONESIGNAL_APP_ID ||
    !ONESIGNAL_REST_API_KEY
  ){

    console.log(
      "OneSignal not configured"
    );

    return false;
  }


  try{

    const response =
      await fetch(
        ONESIGNAL_URL,
        {

          method:
            "POST",

          headers:{

            "Content-Type":
              "application/json",

            "Authorization":
              `Key ${ONESIGNAL_REST_API_KEY}`
          },

          body:
            JSON.stringify({

              app_id:
                ONESIGNAL_APP_ID,

              included_segments:[
                "Subscribed Users"
              ],

              headings:{
                en:
                  title
              },

              contents:{
                en:
                  message
              },

              data:
                extra
            })
        }
      );


    const result =
      await response
        .json()
        .catch(
          () => ({})
        );


    if(
      !response.ok
    ){

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


  }catch(error){

    console.log(
      "OneSignal send error:",
      error.message
    );


    return false;
  }
}


// =====================================================
// CAN OPEN TRADE
// =====================================================

function canOpenTrade(
  pair,
  timeframe
){

  if(
    openTrades.size >=
    MAX_OPEN_TRADES
  ){

    return false;
  }


  const key =
    tradeKey(
      pair,
      timeframe
    );


  if(
    openTrades.has(
      key
    )
  ){

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


// =====================================================
// TIMERS
// =====================================================

function clearTradeTimers(
  tradeId
){

  const timers =
    tradeTimers.get(
      tradeId
    );


  if(!timers){
    return;
  }


  if(
    timers.warning
  ){

    clearTimeout(
      timers.warning
    );
  }


  if(
    timers.settle
  ){

    clearTimeout(
      timers.settle
    );
  }


  tradeTimers.delete(
    tradeId
  );
}


// =====================================================
// SCHEDULE EXPIRY
// =====================================================

function scheduleTradeTimers(
  trade
){

  clearTradeTimers(
    trade.id
  );


  const expiresAtMs =
    new Date(
      trade.expiresAt
    ).getTime();


  const warningAtMs =
    expiresAtMs -
    SIGNAL_EXPIRY_WARNING_SECONDS *
      1000;


  const warningDelay =
    warningAtMs -
    Date.now();


  const settleDelay =
    expiresAtMs -
    Date.now() +
    1500;


  const timers = {

    warning:
      null,

    settle:
      null
  };


  if(
    warningDelay > 0
  ){

    timers.warning =
      setTimeout(

        async () => {

          await sendPush(

            `⏳ EXPIRY SOON — ${trade.pair}`,

            `${trade.direction} ${trade.timeframe} | ${SIGNAL_EXPIRY_WARNING_SECONDS}s remaining`,

            {

              event:
                "EXPIRY_SOON",

              trade
            }
          );

        },

        warningDelay
      );
  }


  timers.settle =
    setTimeout(

      async () => {

        try{

          await settleOneTrade(
            trade.id
          );

        }catch(error){

          console.log(
            "Settle timer error:",
            error.message
          );
        }

      },

      Math.max(
        1000,
        settleDelay
      )
    );


  tradeTimers.set(
    trade.id,
    timers
  );
}


// =====================================================
// OPEN DEMO TRADE
// =====================================================

async function openDemoTrade(
  signal,
  source = "MANUAL"
){

  if(
    !signal ||
    signal.side ===
      "WAIT" ||
    signal.confidence <
      MIN_CONFIDENCE
  ){

    return null;
  }


  if(
    !canOpenTrade(
      signal.pair,
      signal.timeframe
    )
  ){

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

    source,

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


  saveOpenTrades();


  scheduleTradeTimers(
    trade
  );


  await sendPush(

    `${
      trade.direction === "CALL"
        ? "🟢"
        : "🔴"
    } ${trade.direction} — ${trade.pair}`,

    `${trade.timeframe} | Expiry ${expiryLabel(
      trade.timeframe
    )} | Entry ${trade.entry} | Confidence ${trade.confidence}%`,

    {

      event:
        "NEW_SIGNAL",

      trade
    }
  );


  console.log(

    "NEW SIGNAL:",

    trade.pair,

    trade.timeframe,

    trade.direction,

    trade.confidence + "%",

    source
  );


  return trade;
}


// =====================================================
// CALCULATE RESULT
// =====================================================

function settleTrade(
  trade,
  currentPrice
){

  const exit =
    formatPrice(
      trade.pair,
      currentPrice
    );


  let result =
    "DRAW";


  if(
    trade.direction ===
    "CALL"
  ){

    if(
      exit >
      trade.entry
    ){

      result =
        "WIN";
    }


    if(
      exit <
      trade.entry
    ){

      result =
        "LOST";
    }
  }


  if(
    trade.direction ===
    "PUT"
  ){

    if(
      exit <
      trade.entry
    ){

      result =
        "WIN";
    }


    if(
      exit >
      trade.entry
    ){

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
// FIND TRADE
// =====================================================

function findTradeById(
  tradeId
){

  for(
    const [
      key,
      trade
    ]
    of openTrades.entries()
  ){

    if(
      trade.id ===
      tradeId
    ){

      return {

        key,

        trade
      };
    }
  }


  return null;
}


// =====================================================
// SETTLE ONE TRADE
// =====================================================

async function settleOneTrade(
  tradeId
){

  const found =
    findTradeById(
      tradeId
    );


  if(
    !found
  ){

    return null;
  }


  const {
    key,
    trade
  } = found;


  const prices =
    await fetchPrices([
      trade.pair
    ]);


  const currentPrice =
    prices[
      trade.pair
    ];


  if(
    !Number.isFinite(
      currentPrice
    )
  ){

    throw new Error(
      `No expiry price for ${trade.pair}`
    );
  }


  const finalTrade =
    settleTrade(
      trade,
      currentPrice
    );


  openTrades.delete(
    key
  );


  clearTradeTimers(
    trade.id
  );


  saveOpenTrades();


  addHistory(
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

    `${icon} ${finalTrade.pair} — ${finalTrade.result}`,

    `${finalTrade.direction} ${finalTrade.timeframe} | ${finalTrade.entry} → ${finalTrade.exit}`,

    {

      event:
        finalTrade.result,

      trade:
        finalTrade
    }
  );


  console.log(

    "RESULT:",

    finalTrade.pair,

    finalTrade.timeframe,

    finalTrade.result,

    finalTrade.entry,

    "->",

    finalTrade.exit
  );


  return finalTrade;
}


// =====================================================
// SETTLE ALL EXPIRED
// =====================================================

async function settleExpiredTradesNow(){

  const expired =
    Array
      .from(
        openTrades.values()
      )
      .filter(
        trade =>
          Date.now() >=
          new Date(
            trade.expiresAt
          ).getTime()
      );


  if(
    expired.length ===
    0
  ){

    return [];
  }


  const prices =
    await fetchPrices(

      expired.map(
        trade =>
          trade.pair
      )
    );


  const closed = [];


  for(
    const trade
    of expired
  ){

    const currentPrice =
      prices[
        trade.pair
      ];


    if(
      !Number.isFinite(
        currentPrice
      )
    ){

      continue;
    }


    const finalTrade =
      settleTrade(
        trade,
        currentPrice
      );


    openTrades.delete(

      tradeKey(
        trade.pair,
        trade.timeframe
      )
    );


    clearTradeTimers(
      trade.id
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

      `${icon} ${finalTrade.pair} — ${finalTrade.result}`,

      `${finalTrade.direction} ${finalTrade.timeframe} | ${finalTrade.entry} → ${finalTrade.exit}`,

      {

        event:
          finalTrade.result,

        trade:
          finalTrade
      }
    );
  }


  saveOpenTrades();


  return closed;
}


// =====================================================
// BACKGROUND AUTO SCAN
// =====================================================

function backgroundScanIsDue(){

  return (
    Date.now() -
    lastBackgroundScanAt >=
    AUTO_SCAN_MINUTES *
    60 *
    1000
  );
}


async function runBackgroundScan(
  force = false
){

  if(
    !AUTO_SCAN_ENABLED
  ){

    return {

      skipped:
        true,

      reason:
        "AUTO_SCAN_DISABLED"
    };
  }


  if(
    backgroundScanRunning
  ){

    return {

      skipped:
        true,

      reason:
        "SCAN_ALREADY_RUNNING"
    };
  }


  if(
    !force &&
    !backgroundScanIsDue()
  ){

    return {

      skipped:
        true,

      reason:
        "NOT_DUE",

      nextScanAt:
        new Date(
          lastBackgroundScanAt +
          AUTO_SCAN_MINUTES *
          60 *
          1000
        ).toISOString()
    };
  }


  backgroundScanRunning =
    true;


  try{

    const closed =
      await settleExpiredTradesNow();


    const scan =
      await fetchAllPairs();


    const best =
      bestSignalFromScan(
        scan,
        AUTO_SCAN_TIMEFRAME
      );


    lastBackgroundScanAt =
      Date.now();


    let trade =
      null;


    if(
      best
    ){

      trade =
        await openDemoTrade(
          best,
          "BACKGROUND"
        );
    }


    backgroundLastResult = {

      at:
        nowIso(),

      best:
        best || null,

      trade:
        trade || null,

      closed,

      cached:
        scan.cached,

      creditsUsed:
        scan.creditsUsed,

      creditsLeft:
        scan.creditsLeft
    };


    if(
      !best
    ){

      console.log(
        "BACKGROUND SCAN: no confirmed signal"
      );
    }


    return {

      ok:
        true,

      ...backgroundLastResult
    };


  }finally{

    backgroundScanRunning =
      false;
  }
}


// =====================================================
// BACKGROUND TICK
// =====================================================

async function backgroundTick(){

  try{

    await settleExpiredTradesNow();


    if(
      AUTO_SCAN_ENABLED &&
      backgroundScanIsDue()
    ){

      await runBackgroundScan();
    }


  }catch(error){

    console.log(
      "Background tick error:",
      error.message
    );
  }
}


// =====================================================
// STATS
// =====================================================

function getStats(){

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
  (req,res) => {

    res.json({

      app:
        "ADAMS OPTION SERVER",

      version:
        "POCKET MODE 4.0",

      mode:
        "AUTO SIGNALS + PUSH + EXPIRY",

      pairs:
        PAIRS,

      timeframes:
        TIMEFRAMES,

      minConfidence:
        MIN_CONFIDENCE,

      autoScan:{

        enabled:
          AUTO_SCAN_ENABLED,

        everyMinutes:
          AUTO_SCAN_MINUTES,

        timeframe:
          AUTO_SCAN_TIMEFRAME,

        lastScanAt:
          lastBackgroundScanAt

            ? new Date(
                lastBackgroundScanAt
              ).toISOString()

            : null,

        lastResult:
          backgroundLastResult
      },

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
  (req,res) => {

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

      autoScanEnabled:
        AUTO_SCAN_ENABLED,

      autoScanEveryMinutes:
        AUTO_SCAN_MINUTES,

      autoScanTimeframe:
        AUTO_SCAN_TIMEFRAME,

      openTrades:
        openTrades.size,

      timestamp:
        nowIso()
    });
  }
);


// =====================================================
// ANALYSE ONE PAIR
// =====================================================

app.get(
  "/api/analyse",

  async (req,res) => {

    try{

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


      if(
        !PAIRS.includes(
          pair
        )
      ){

        return res
          .status(400)
          .json({

            error:
              "Invalid pair"
          });
      }


      if(
        !TIMEFRAMES.includes(
          timeframe
        )
      ){

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


      const trade =
        signal.side !==
          "WAIT"

          ? await openDemoTrade(
              signal,
              "MANUAL_ANALYSE"
            )

          : null;


      res.json({

        ...signal,

        trade
      });


    }catch(error){

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
// MANUAL AUTO SCAN
// =====================================================

app.get(
  "/api/auto-scan",

  async (req,res) => {

    try{

      const timeframe =
        String(
          req.query.timeframe ||
          "M1"
        ).toUpperCase();


      if(
        !TIMEFRAMES.includes(
          timeframe
        )
      ){

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


      if(
        !best
      ){

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
          best,
          "MANUAL_AUTO_SCAN"
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


    }catch(error){

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
// BACKGROUND STATUS
// =====================================================

app.get(
  "/api/background-status",

  (req,res) => {

    res.json({

      enabled:
        AUTO_SCAN_ENABLED,

      running:
        backgroundScanRunning,

      everyMinutes:
        AUTO_SCAN_MINUTES,

      timeframe:
        AUTO_SCAN_TIMEFRAME,

      lastScanAt:
        lastBackgroundScanAt

          ? new Date(
              lastBackgroundScanAt
            ).toISOString()

          : null,

      nextScanAt:
        lastBackgroundScanAt

          ? new Date(
              lastBackgroundScanAt +
              AUTO_SCAN_MINUTES *
              60 *
              1000
            ).toISOString()

          : nowIso(),

      lastResult:
        backgroundLastResult,

      openTrades:
        Array.from(
          openTrades.values()
        )
    });
  }
);


// =====================================================
// CRON TICK
// =====================================================

app.get(
  "/api/cron-tick",

  async (req,res) => {

    try{

      const closed =
        await settleExpiredTradesNow();


      let scan = {

        skipped:
          true,

        reason:
          "NOT_DUE"
      };


      if(
        AUTO_SCAN_ENABLED &&
        backgroundScanIsDue()
      ){

        scan =
          await runBackgroundScan();
      }


      res.json({

        ok:
          true,

        closed,

        scan,

        timestamp:
          nowIso()
      });


    }catch(error){

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
// CHECK TRADES
// =====================================================

app.get(
  "/api/check-trades",

  async (req,res) => {

    try{

      const closed =
        await settleExpiredTradesNow();


      res.json({

        checked:
          closed.length,

        closed,

        open:
          Array.from(
            openTrades.values()
          )
      });


    }catch(error){

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

  (req,res) => {

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

  (req,res) => {

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

  (req,res) => {

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
){

  const success =
    await sendPush(

      "ADAMS OPTION ✅",

      "Push notifications are working."
    );


  res.json({

    success
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

    loadOpenTrades();


    for(
      const trade
      of openTrades.values()
    ){

      scheduleTradeTimers(
        trade
      );
    }


    console.log(
      "========================================"
    );


    console.log(
      `ADAMS OPTION running on port ${PORT}`
    );


    console.log(
      "POCKET MODE 4.0"
    );


    console.log(
      "AUTO SIGNAL + PUSH + EXPIRY TIMER"
    );


    console.log(
      "AUTO SCAN:",

      AUTO_SCAN_ENABLED

        ? `ON / every ${AUTO_SCAN_MINUTES} min / ${AUTO_SCAN_TIMEFRAME}`

        : "OFF"
    );


    console.log(
      "MIN CONFIDENCE:",
      MIN_CONFIDENCE + "%"
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


    // First check shortly after start

    setTimeout(

      () => {

        backgroundTick();
      },

      5000
    );


    // Background check every minute.
    // Market scan only happens when AUTO_SCAN_MINUTES is due.

    setInterval(

      backgroundTick,

      60 * 1000
    );
  }
);
