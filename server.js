import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import WebSocket from "ws";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT =
  Number(process.env.PORT || 10000);

const TD_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const OS_APP =
  process.env.ONESIGNAL_APP_ID || "";

const OS_KEY =
  process.env.ONESIGNAL_REST_API_KEY ||
  process.env.ONESIGNAL_API_KEY ||
  "";

const MIN_CONF =
  Number(process.env.MIN_CONFIDENCE || 72);

const MAX_OPEN =
  Number(process.env.MAX_OPEN_TRADES || 2);

const SCAN_SEC =
  Math.max(
    60,
    Number(process.env.SCAN_SECONDS || 60)
  );

const FILE = "./history.json";


/* =====================================================
   FOREX PAIRS
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


const TF = {

  M1: 60,
  M5: 300,
  M15: 900

};


const COOLDOWN = {

  M1: 180000,
  M5: 600000,
  M15: 1200000

};


const prices = new Map();

const m1 = new Map();

const seeded = new Map();

const lastSignal = new Map();


let wsConnected = false;

let autoEnabled = true;

let autoBusy = false;

let lastAuto = null;


/* =====================================================
   HISTORY
===================================================== */

function load() {

  try {

    if (!fs.existsSync(FILE)) {

      return {
        openTrades: [],
        history: []
      };

    }

    const x =
      JSON.parse(
        fs.readFileSync(
          FILE,
          "utf8"
        )
      );


    if (Array.isArray(x)) {

      return {
        openTrades: [],
        history: x
      };

    }


    return {

      openTrades:
        x.openTrades || [],

      history:
        x.history || []

    };

  }

  catch {

    return {
      openTrades: [],
      history: []
    };

  }

}


let db = load();


function save() {

  try {

    fs.writeFileSync(
      FILE,
      JSON.stringify(
        db,
        null,
        2
      )
    );

  }

  catch {}

}


/* =====================================================
   HELPERS
===================================================== */

const wait =
  ms =>
    new Promise(
      r =>
        setTimeout(
          r,
          ms
        )
    );


const clamp =
  (n, a, b) =>
    Math.max(
      a,
      Math.min(
        b,
        n
      )
    );


function normTf(x) {

  const tf =
    String(
      x || "M1"
    ).toUpperCase();

  return TF[tf]
    ? tf
    : "M1";

}


function normPair(x) {

  let p =
    String(
      x || ""
    )
      .toUpperCase()
      .replace(
        /\s/g,
        ""
      );


  if (
    !p.includes("/") &&
    p.length === 6
  ) {

    p =
      p.slice(0, 3) +
      "/" +
      p.slice(3);

  }


  return PAIRS[p]
    ? p
    : null;

}


function rnd(
  pair,
  number
) {

  return Number(
    Number(number)
      .toFixed(
        PAIRS[pair] || 5
      )
  );

}


/* =====================================================
   LIVE PRICE → M1 CANDLES
===================================================== */

function putTick(
  pair,
  price,
  ts =
    Math.floor(
      Date.now() / 1000
    )
) {

  if (
    !Number.isFinite(price)
  ) {

    return;

  }


  prices.set(
    pair,
    {
      price,
      ts
    }
  );


  const bucket =
    Math.floor(
      ts / 60
    ) * 60;


  const a =
    m1.get(pair) || [];


  const last =
    a[a.length - 1];


  if (
    last &&
    last.time === bucket
  ) {

    last.high =
      Math.max(
        last.high,
        price
      );

    last.low =
      Math.min(
        last.low,
        price
      );

    last.close =
      price;

  }

  else if (
    !last ||
    bucket > last.time
  ) {

    a.push({

      time: bucket,

      open: price,

      high: price,

      low: price,

      close: price

    });

  }


  if (
    a.length > 1200
  ) {

    a.splice(
      0,
      a.length - 1200
    );

  }


  m1.set(
    pair,
    a
  );

}


/* =====================================================
   INITIAL HISTORY FROM TWELVE DATA
===================================================== */

async function seed(pair) {

  if (
    (m1.get(pair) || [])
      .length >= 250
  ) {

    return true;

  }


  if (
    seeded.has(pair)
  ) {

    return seeded.get(pair);

  }


  const job =
    (async () => {

      if (!TD_KEY) {

        throw new Error(
          "TWELVE_DATA_API_KEY missing"
        );

      }


      const u =
        new URL(
          "https://api.twelvedata.com/time_series"
        );


      u.searchParams.set(
        "symbol",
        pair
      );

      u.searchParams.set(
        "interval",
        "1min"
      );

      u.searchParams.set(
        "outputsize",
        "600"
      );

      u.searchParams.set(
        "apikey",
        TD_KEY
      );


      const r =
        await fetch(u);


      const j =
        await r.json();


      if (
        !r.ok ||
        j.status === "error" ||
        !Array.isArray(j.values)
      ) {

        throw new Error(
          j.message ||
          "Twelve Data error"
        );

      }


      const old =
        m1.get(pair) || [];


      const map =
        new Map();


      for (
        const v of
        j.values.reverse()
      ) {

        const t =
          Math.floor(
            Date.parse(
              v.datetime
                .replace(
                  " ",
                  "T"
                ) +
              "Z"
            ) / 1000
          );


        const c = {

          time: t,

          open:
            Number(v.open),

          high:
            Number(v.high),

          low:
            Number(v.low),

          close:
            Number(v.close)

        };


        if (
          t &&
          Object
            .values(c)
            .every(
              Number.isFinite
            )
        ) {

          map.set(
            t,
            c
          );

        }

      }


      for (
        const c of old
      ) {

        map.set(
          c.time,
          c
        );

      }


      const arr =
        [...map.values()]
          .sort(
            (a, b) =>
              a.time -
              b.time
          )
          .slice(-1200);


      m1.set(
        pair,
        arr
      );


      if (
        arr.length
      ) {

        prices.set(
          pair,
          {

            price:
              arr[
                arr.length - 1
              ].close,

            ts:
              arr[
                arr.length - 1
              ].time

          }
        );

      }


      return true;

    })()

      .catch(
        e => {

          console.log(
            "seed",
            pair,
            e.message
          );

          return false;

        }
      )

      .finally(
        () =>
          seeded.delete(pair)
      );


  seeded.set(
    pair,
    job
  );


  return job;

}


/* =====================================================
   CREATE M1 / M5 / M15
===================================================== */

function candles(
  pair,
  timeframe
) {

  const sec =
    TF[timeframe];


  const out = [];


  for (
    const c of
    m1.get(pair) || []
  ) {

    const t =
      Math.floor(
        c.time / sec
      ) * sec;


    const z =
      out[
        out.length - 1
      ];


    if (
      z &&
      z.time === t
    ) {

      z.high =
        Math.max(
          z.high,
          c.high
        );

      z.low =
        Math.min(
          z.low,
          c.low
        );

      z.close =
        c.close;

    }

    else {

      out.push({

        time: t,

        open:
          c.open,

        high:
          c.high,

        low:
          c.low,

        close:
          c.close

      });

    }

  }


  const now =
    Math.floor(
      Date.now() / 1000
    );


  /*
    IMPORTANT:
    only CLOSED candles
  */

  return out.filter(
    c =>
      c.time +
      sec <=
      now
  );

}


/* =====================================================
   INDICATORS
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


  let e =
    values
      .slice(
        0,
        period
      )
      .reduce(
        (a, b) =>
          a + b,
        0
      ) /
    period;


  const k =
    2 /
    (period + 1);


  for (
    let i = period;
    i < values.length;
    i++
  ) {

    e =
      values[i] *
        k +
      e *
        (1 - k);

  }


  return e;

}


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


  let gains = 0;

  let losses = 0;


  const s =
    values.slice(
      -(period + 1)
    );


  for (
    let i = 1;
    i < s.length;
    i++
  ) {

    const d =
      s[i] -
      s[i - 1];


    if (
      d > 0
    ) {

      gains += d;

    }

    else {

      losses +=
        Math.abs(d);

    }

  }


  if (
    losses === 0
  ) {

    return 100;

  }


  const rs =
    (gains / period) /
    (losses / period);


  return (
    100 -
    100 /
    (1 + rs)
  );

}


function atr(
  c,
  period = 14
) {

  if (
    c.length <
    period + 1
  ) {

    return null;

  }


  const a =
    c.slice(
      -(period + 1)
    );


  const tr = [];


  for (
    let i = 1;
    i < a.length;
    i++
  ) {

    tr.push(

      Math.max(

        a[i].high -
        a[i].low,

        Math.abs(
          a[i].high -
          a[i - 1].close
        ),

        Math.abs(
          a[i].low -
          a[i - 1].close
        )

      )

    );

  }


  return (
    tr.reduce(
      (x, y) =>
        x + y,
      0
    ) /
    tr.length
  );

}


/* =====================================================
   ANALYSE ONE TIMEFRAME
===================================================== */

function oneTf(
  pair,
  timeframe
) {

  const c =
    candles(
      pair,
      timeframe
    );


  if (
    c.length < 25
  ) {

    return null;

  }


  const values =
    c.map(
      x =>
        x.close
    );


  const last =
    c[
      c.length - 1
    ];


  const fast =
    ema(
      values,
      5
    );


  const slow =
    ema(
      values,
      13
    );


  const fastPrev =
    ema(
      values.slice(
        0,
        -1
      ),
      5
    );


  const slowPrev =
    ema(
      values.slice(
        0,
        -1
      ),
      13
    );


  const RSI =
    rsi(
      values
    );


  const ATR =
    atr(
      c
    );


  if (
    ![
      fast,
      slow,
      fastPrev,
      slowPrev,
      RSI,
      ATR
    ].every(
      Number.isFinite
    )
  ) {

    return null;

  }


  const direction =
    fast >= slow
      ? "CALL"
      : "PUT";


  const old =
    values[
      values.length - 4
    ];


  const momentum =
    (
      (
        last.close -
        old
      ) /
      old
    ) *
    100;


  const gap =
    ATR
      ? Math.abs(
          fast -
          slow
        ) /
        ATR
      : 0;


  let score = 50;


  /* =========================
     CALL
  ========================= */

  if (
    direction === "CALL"
  ) {

    score += 12;


    if (
      fast -
        fastPrev >
        0 &&
      slow -
        slowPrev >=
        0
    ) {

      score += 8;

    }


    if (
      RSI >= 52 &&
      RSI <= 70
    ) {

      score += 9;

    }

    else if (
      RSI > 76 ||
      RSI < 48
    ) {

      score -= 9;

    }


    score +=
      momentum > 0
        ? 8
        : -7;


    score +=
      last.close >
      last.open
        ? 5
        : -3;

  }


  /* =========================
     PUT
  ========================= */

  else {

    score += 12;


    if (
      fast -
        fastPrev <
        0 &&
      slow -
        slowPrev <=
        0
    ) {

      score += 8;

    }


    if (
      RSI >= 30 &&
      RSI <= 48
    ) {

      score += 9;

    }

    else if (
      RSI < 24 ||
      RSI > 52
    ) {

      score -= 9;

    }


    score +=
      momentum < 0
        ? 8
        : -7;


    score +=
      last.close <
      last.open
        ? 5
        : -3;

  }


  /*
    SIDEWAYS PROTECTION
  */

  score +=
    gap >= 0.22
      ? 6
      : -12;


  return {

    direction,

    score,

    price:
      last.close,

    emaFast:
      fast,

    emaSlow:
      slow,

    rsi:
      RSI,

    atr:
      ATR,

    momentum,

    gap

  };

}


/* =====================================================
   MULTI TIMEFRAME SIGNAL
===================================================== */

async function analyse(
  pairInput,
  tfInput
) {

  const pair =
    normPair(
      pairInput
    );


  const timeframe =
    normTf(
      tfInput
    );


  if (!pair) {

    throw new Error(
      "Unsupported pair"
    );

  }


  await seed(pair);


  const base =
    oneTf(
      pair,
      timeframe
    );


  if (!base) {

    return {

      ok: true,

      pair,

      timeframe,

      side: "WAIT",

      direction: "WAIT",

      confidence: 0,

      price:
        prices.get(pair)
          ?.price ||
        null

    };

  }


  /*
    M1 requires M5 + M15 confirmation

    M5 requires M1 + M15

    M15 requires M1 + M5
  */

  const checks =

    timeframe === "M1"

      ? [
          "M5",
          "M15"
        ]

      : timeframe === "M5"

        ? [
            "M1",
            "M15"
          ]

        : [
            "M1",
            "M5"
          ];


  let score =
    base.score;


  const conflicts = [];


  for (
    const x of checks
  ) {

    const z =
      oneTf(
        pair,
        x
      );


    if (!z) {

      continue;

    }


    if (
      z.direction ===
      base.direction
    ) {

      score +=
        x === "M15"
          ? 8
          : 6;

    }

    else {

      score -=
        x === "M15"
          ? 14
          : 10;


      conflicts.push(x);

    }

  }


  /*
    Confidence is capped at 90.

    It is NOT a true guaranteed
    win probability.
  */

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


  const extreme =
    base.direction ===
    "CALL"

      ? base.rsi > 78

      : base.rsi < 22;


  /*
    WAIT CONDITIONS
  */

  if (

    base.gap < 0.18 ||

    extreme ||

    conflicts.includes(
      "M15"
    ) ||

    confidence <
      MIN_CONF

  ) {

    side = "WAIT";

  }


  if (
    side === "WAIT"
  ) {

    confidence =
      Math.min(
        confidence,
        MIN_CONF - 1
      );

  }


  const price =
    rnd(
      pair,
      prices.get(pair)
        ?.price ??
      base.price
    );


  const expirySeconds =
    TF[timeframe];


  const expiresAt =
    Date.now() +
    expirySeconds *
      1000;


  return {

    ok: true,

    source:
      "Twelve Data",

    pair,

    timeframe,

    side,

    direction: side,

    signal: side,

    confidence,

    price,

    entry: price,

    emaFast:
      rnd(
        pair,
        base.emaFast
      ),

    emaSlow:
      rnd(
        pair,
        base.emaSlow
      ),

    ema5:
      rnd(
        pair,
        base.emaFast
      ),

    ema13:
      rnd(
        pair,
        base.emaSlow
      ),

    rsi:
      Number(
        base.rsi
          .toFixed(1)
      ),

    atr:
      Number(
        base.atr
          .toFixed(
            PAIRS[pair]
          )
      ),

    momentum:
      Number(
        base.momentum
          .toFixed(4)
      ),

    expirySeconds,

    expiryMinutes:
      expirySeconds / 60,

    expiresAt,

    expiryAt:
      expiresAt,

    note:
      "Confidence is an internal signal score, not a guaranteed win probability."

  };

}


/* =====================================================
   ONESIGNAL PUSH
===================================================== */

async function push(
  title,
  message,
  data = {}
) {

  if (
    !OS_APP ||
    !OS_KEY
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

    const r =
      await fetch(

        "https://api.onesignal.com/notifications",

        {

          method:
            "POST",

          headers: {

            "Content-Type":
              "application/json",

            Authorization:
              `Key ${OS_KEY}`

          },

          body:
            JSON.stringify({

              app_id:
                OS_APP,

              included_segments: [
                "Subscribed Users"
              ],

              headings: {
                en: title
              },

              contents: {
                en: message
              },

              data

            })

        }

      );


    return {

      ok:
        r.ok,

      status:
        r.status,

      body:
        await r.text()

    };

  }

  catch (e) {

    return {

      ok: false,

      error:
        e.message

    };

  }

}


/* =====================================================
   OPEN DEMO TRADE
===================================================== */

function canOpen(
  signal
) {

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
    MIN_CONF
  ) {

    return false;

  }


  if (
    db.openTrades.length >=
    MAX_OPEN
  ) {

    return false;

  }


  /*
    No duplicate open trade
    for same pair + timeframe
  */

  if (
    db.openTrades.some(
      t =>
        t.pair ===
          signal.pair &&
        t.timeframe ===
          signal.timeframe
    )
  ) {

    return false;

  }


  const key =
    `${signal.pair}|${signal.timeframe}|${signal.side}`;


  const last =
    lastSignal.get(key) ||
    0;


  return (
    Date.now() -
      last >=
    COOLDOWN[
      signal.timeframe
    ]
  );

}


async function openTrade(
  signal,
  origin = "manual"
) {

  if (
    !canOpen(signal)
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
        .slice(2, 7)}`,

    pair:
      signal.pair,

    timeframe:
      signal.timeframe,

    direction:
      signal.side,

    side:
      signal.side,

    confidence:
      signal.confidence,

    entry:
      rnd(
        signal.pair,
        signal.price
      ),

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


  db.openTrades.unshift(
    trade
  );


  lastSignal.set(

    `${signal.pair}|${signal.timeframe}|${signal.side}`,

    now

  );


  save();


  /*
    CALL / PUT NOTIFICATION
  */

  await push(

    "ADAMS OPTION • SIGNAL",

    `${trade.pair} • ${trade.timeframe} • ${trade.direction} • Score ${trade.confidence}% • Expiry ${signal.expiryMinutes}m`,

    {

      type:
        "signal",

      trade

    }

  );


  return trade;

}


/* =====================================================
   CLOSE / WIN / LOST / DRAW
===================================================== */

async function settle(
  trade
) {

  const live =
    prices.get(
      trade.pair
    )?.price ??
    m1.get(
      trade.pair
    )?.[
      (
        m1.get(
          trade.pair
        ) || []
      ).length - 1
    ]?.close;


  if (
    !Number.isFinite(
      Number(live)
    )
  ) {

    return;

  }


  const exit =
    rnd(
      trade.pair,
      live
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

    else if (
      exit <
      trade.entry
    ) {

      result =
        "LOST";

    }

  }


  else {

    if (
      exit <
      trade.entry
    ) {

      result =
        "WIN";

    }

    else if (
      exit >
      trade.entry
    ) {

      result =
        "LOST";

    }

  }


  const historyTrade = {

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
      x =>
        x.id !==
        trade.id
    );


  db.history.unshift(
    historyTrade
  );


  db.history =
    db.history.slice(
      0,
      1000
    );


  save();


  /*
    WIN / LOST / DRAW NOTIFICATION
  */

  await push(

    `ADAMS OPTION • ${result}`,

    `${historyTrade.pair} • ${historyTrade.timeframe} • ${historyTrade.direction} • ${historyTrade.entry} → ${historyTrade.exit}`,

    {

      type:
        "result",

      trade:
        historyTrade

    }

  );

}


/* =====================================================
   CHECK EXPIRY
===================================================== */

async function checkExpiry() {

  const now =
    Date.now();


  for (
    const trade of
    [...db.openTrades]
  ) {

    const expiry =
      Number(
        trade.expiresAt ??
        trade.expiryAt
      );


    if (
      expiry <= now
    ) {

      await settle(
        trade
      );

    }

  }

}


/* =====================================================
   STATS
===================================================== */

function stats() {

  const h =
    db.history;


  const wins =
    h.filter(
      x =>
        x.result ===
        "WIN"
    ).length;


  const losses =
    h.filter(
      x =>
        [
          "LOST",
          "LOSS"
        ].includes(
          x.result
        )
    ).length;


  const draws =
    h.filter(
      x =>
        x.result ===
        "DRAW"
    ).length;


  const decided =
    wins +
    losses;


  return {

    wins,

    losses,

    draws,

    winRate:
      decided

        ? Number(
            (
              wins /
              decided *
              100
            ).toFixed(1)
          )

        : 0,

    openTrades:
      db.openTrades.length,

    totalHistory:
      h.length

  };

}


/* =====================================================
   MANUAL AUTO SCAN BUTTON
===================================================== */

async function scanAll(
  timeframe = "M1"
) {

  const results = [];


  for (
    const pair of
    Object.keys(PAIRS)
  ) {

    try {

      results.push(
        await analyse(
          pair,
          timeframe
        )
      );

    }

    catch (e) {

      results.push({

        ok: false,

        pair,

        timeframe,

        side:
          "WAIT",

        direction:
          "WAIT",

        confidence:
          0,

        error:
          e.message

      });

    }

  }


  const ordered =
    results
      .slice()
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
    ordered.find(
      x =>
        [
          "CALL",
          "PUT"
        ].includes(
          x.side
        )
    ) ||
    ordered[0];


  const trade =
    best
      ? await openTrade(
          best,
          "scan"
        )
      : null;


  lastAuto =
    best || null;


  if (!best) {

    return {

      ok: true,

      pair: null,

      timeframe,

      side:
        "WAIT",

      direction:
        "WAIT",

      confidence:
        0,

      trade: null,

      results

    };

  }


  /*
    Important:
    best signal is returned at TOP LEVEL
    for current frontend compatibility.
  */

  return {

    ...best,

    trade,

    results

  };

}


/* =====================================================
   AUTOMATIC BACKGROUND SCAN
===================================================== */

async function autoCycle() {

  if (
    !autoEnabled ||
    autoBusy
  ) {

    return;

  }


  autoBusy =
    true;


  try {

    const all = [];


    /*
      Scan all 8 pairs
      on M1 / M5 / M15
    */

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
        Object.keys(PAIRS)
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

            all.push(
              signal
            );

          }

        }

        catch {}

      }

    }


    /*
      Strongest signals first
    */

    all.sort(
      (a, b) =>
        b.confidence -
        a.confidence
    );


    const usedPairs =
      new Set();


    for (
      const signal of all
    ) {

      if (
        db.openTrades.length >=
        MAX_OPEN
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


      if (
        trade
      ) {

        usedPairs.add(
          signal.pair
        );


        lastAuto =
          signal;

      }

    }

  }

  finally {

    autoBusy =
      false;

  }

}


/* =====================================================
   TWELVE DATA WEBSOCKET
===================================================== */

function connectWS() {

  if (!TD_KEY) {

    console.log(
      "TWELVE_DATA_API_KEY missing"
    );

    return;

  }


  const ws =
    new WebSocket(

      `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(TD_KEY)}`

    );


  ws.on(
    "open",
    () => {

      wsConnected =
        true;


      console.log(
        "Twelve Data WebSocket connected"
      );


      ws.send(
        JSON.stringify({

          action:
            "subscribe",

          params: {

            symbols:
              Object
                .keys(PAIRS)
                .join(",")

          }

        })
      );

    }
  );


  ws.on(
    "message",
    raw => {

      try {

        const j =
          JSON.parse(
            raw.toString()
          );


        const pair =
          normPair(
            j.symbol
          );


        const price =
          Number(
            j.price
          );


        if (
          !pair ||
          !Number.isFinite(
            price
          )
        ) {

          return;

        }


        putTick(

          pair,

          price,

          Number(
            j.timestamp
          ) ||
          Math.floor(
            Date.now() /
            1000
          )

        );

      }

      catch {}

    }
  );


  ws.on(
    "close",
    () => {

      wsConnected =
        false;


      console.log(
        "WebSocket reconnect..."
      );


      setTimeout(
        connectWS,
        5000
      );

    }
  );


  ws.on(
    "error",
    () => {

      wsConnected =
        false;


      try {

        ws.close();

      }

      catch {}

    }
  );

}


/* =====================================================
   ROUTES
===================================================== */

app.get(
  "/",
  (req, res) => {

    res.json({

      ok: true,

      name:
        "ADAMS OPTION SERVER",

      mode:
        "FOREX REAL DATA • POCKET MODE • DEMO",

      wsConnected,

      autoEnabled

    });

  }
);


app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      status:
        "online",

      server:
        "online",

      wsConnected,

      autoEnabled,

      pushConfigured:
        Boolean(
          OS_APP &&
          OS_KEY
        )

    });

  }
);


/* =====================================================
   ANALYSE SELECTED PAIR
===================================================== */

async function analyseRoute(
  req,
  res
) {

  try {

    const signal =
      await analyse(

        req.body?.pair ||
        req.query.pair,

        req.body?.timeframe ||
        req.query.timeframe ||
        "M1"

      );


    const trade =
      await openTrade(
        signal,
        "manual"
      );


    res.json({

      ...signal,

      trade

    });

  }

  catch (e) {

    res
      .status(400)
      .json({

        ok: false,

        side:
          "WAIT",

        direction:
          "WAIT",

        confidence:
          0,

        error:
          e.message

      });

  }

}


app.post(
  "/api/analyse",
  analyseRoute
);


app.post(
  "/api/analyze",
  analyseRoute
);


app.get(
  "/api/analyse",
  analyseRoute
);


/* =====================================================
   AUTO SCAN 8 PAIRS BUTTON
===================================================== */

async function scanRoute(
  req,
  res
) {

  try {

    const timeframe =
      normTf(

        req.body?.timeframe ||
        req.query.timeframe ||
        "M1"

      );


    res.json(
      await scanAll(
        timeframe
      )
    );

  }

  catch (e) {

    res
      .status(500)
      .json({

        ok: false,

        error:
          e.message

      });

  }

}


app.post(
  "/api/auto-scan",
  scanRoute
);


app.post(
  "/api/scan-all",
  scanRoute
);


app.post(
  "/api/scan",
  scanRoute
);


/* =====================================================
   OPEN TRADES
   FRONTEND EXPECTS ARRAY
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
      stats()
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
        MIN_CONF,

      maxOpenTrades:
        MAX_OPEN,

      best:
        lastAuto,

      openTrades:
        db.openTrades,

      stats:
        stats(),

      wsConnected

    });

  }
);


/* =====================================================
   START / STOP AUTO MODE
===================================================== */

app.post(
  "/api/start",
  (req, res) => {

    autoEnabled =
      true;


    autoCycle();


    res.json({

      ok: true,

      running:
        true

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

      running:
        false

    });

  }
);


/* =====================================================
   TEST NOTIFICATION
===================================================== */

app.get(
  "/api/test-notification",
  async (
    req,
    res
  ) => {

    const result =
      await push(

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
);


app.post(
  "/api/test-notification",
  async (
    req,
    res
  ) => {

    const result =
      await push(

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
);


/* =====================================================
   TIMERS
===================================================== */

setInterval(
  () => {

    checkExpiry()
      .catch(
        () => {}
      );

  },
  1000
);


setInterval(
  () => {

    autoCycle()
      .catch(
        () => {}
      );

  },
  SCAN_SEC *
  1000
);


/* =====================================================
   START SERVER
===================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      `ADAMS OPTION running on port ${PORT}`
    );


    connectWS();


    /*
      Load history for all 8 pairs.
      Approximately 8 Twelve Data requests.
    */

    (
      async () => {

        for (
          const pair of
          Object.keys(PAIRS)
        ) {

          await seed(
            pair
          );


          await wait(
            900
          );

        }


        console.log(
          "Market data ready"
        );


        if (
          autoEnabled
        ) {

          autoCycle();

        }

      }
    )();

  }
);
