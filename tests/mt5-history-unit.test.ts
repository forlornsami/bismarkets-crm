import { describe, expect, it } from "vitest";
import { dealTimeUtc } from "../src/server/mt5/deals";
import { averagePrice, closedTrades, ENTRY, historyQuery, presentClientTrade, tradeIdSuffixes, type TradeDeal, type TradeRow } from "../src/server/mt5/trades";

let ticket = 0;
/** One trade deal; times are minutes after a fixed start. */
const deal = (d: Partial<TradeDeal> & { action: number; entry: number; minute: number }): TradeDeal => ({
  ticket: d.ticket ?? ++ticket,
  action: d.action,
  entry: d.entry,
  symbol: d.symbol ?? "EURUSD",
  volume: d.volume ?? 10_000,
  price: d.price ?? "1.10000",
  profitCents: d.profitCents ?? 0,
  commissionCents: d.commissionCents ?? 0,
  swapCents: d.swapCents ?? 0,
  feeCents: d.feeCents ?? 0,
  timeUtc: new Date(Date.UTC(2026, 5, 1, 12, d.minute)),
});
const at = (minute: number) => new Date(Date.UTC(2026, 5, 1, 12, minute));
/** A stored trade, as the history reads it. */
const row: TradeRow = {
  mt5_account_id: 1, position_id: 880011, segment: 0, client_id: 2, login: 500123, symbol: "XAUUSD", side: 1, volume: 2_500, open_price: "2350.15", close_price: "2340.05",
  open_time_utc: new Date("2026-06-01T08:00:00.250Z"), close_time_utc: new Date("2026-06-01T09:30:00.000Z"),
  profit_cents: 252_50, commission_cents: -175, swap_cents: -33, fee_cents: -5,
};

describe("closed trades from deals", () => {
  it("is one row per position: side and opening from the IN deal, close from the last closing deal, money summed", () => {
    const t = closedTrades([
      deal({ action: 1, entry: ENTRY.out, minute: 30, volume: 10_000, price: "1.10250", profitCents: -2_500, swapCents: -40, commissionCents: -350 }),
      deal({ action: 0, entry: ENTRY.in, minute: 0, volume: 10_000, price: "1.10500", commissionCents: -350, feeCents: -10 }),
    ]);
    expect(t).toEqual([
      {
        segment: 0, symbol: "EURUSD", side: 0, volume: 10_000, openPrice: "1.10500", closePrice: "1.10250", openTimeUtc: at(0), closeTimeUtc: at(30),
        profitCents: -2_500, commissionCents: -700, swapCents: -40, feeCents: -10,
      },
    ]);
  });

  it("waits for a partly closed position to close in full, then shows it once with its opening volume", () => {
    const open = deal({ action: 1, entry: ENTRY.in, minute: 0, volume: 20_000, price: "150.120" });
    const first = deal({ action: 0, entry: ENTRY.out, minute: 5, volume: 5_000, price: "150.000", profitCents: 400 });
    expect(closedTrades([open, first])).toEqual([]);
    const second = deal({ action: 0, entry: ENTRY.out, minute: 9, volume: 15_000, price: "149.900", profitCents: 2_200 });
    expect(closedTrades([open, first, second])).toEqual([
      expect.objectContaining({ segment: 0, side: 1, volume: 20_000, openPrice: "150.120", closePrice: "149.900", closeTimeUtc: at(9), profitCents: 2_600 }),
    ]);
    // Closed by an opposite position (OUT_BY) counts as closing too.
    expect(closedTrades([open, deal({ action: 0, entry: ENTRY.outBy, minute: 7, volume: 20_000, price: "150.010", profitCents: 900 })])).toEqual([
      expect.objectContaining({ volume: 20_000, closePrice: "150.010" }),
    ]);
  });

  // Netting: bought 1.5 lots in two deals, then sold two lots (ticket 103), which closed the 1.5 and opened half a lot sold.
  const netted = () => [
    deal({ ticket: 101, action: 0, entry: ENTRY.in, minute: 0, volume: 10_000, price: "1.10000", commissionCents: -35 }),
    // Adding to the position averages its opening price.
    deal({ ticket: 102, action: 0, entry: ENTRY.in, minute: 1, volume: 5_000, price: "1.10030", commissionCents: -18 }),
    deal({ ticket: 103, action: 1, entry: ENTRY.inOut, minute: 10, volume: 20_000, price: "1.10200", profitCents: 2_850, commissionCents: -70, swapCents: -12, feeCents: -4 }),
  ];
  /** The part the reversal closed: it ends at the INOUT deal and has all of that deal's money. */
  const closedPart = {
    segment: 0, symbol: "EURUSD", side: 0, volume: 15_000, openPrice: "1.10010", closePrice: "1.10200", openTimeUtc: at(0), closeTimeUtc: at(10),
    profitCents: 2_850, commissionCents: -123, swapCents: -12, feeCents: -4,
  };

  it("shows a reversal whose remainder is still open as the part it closed, ending at the INOUT deal with all of that deal's money", () => {
    expect(closedTrades(netted())).toEqual([closedPart]);
    // The remainder adds to itself and is partly closed: still open, so still not a row, and the closed part stays as it was.
    expect(
      closedTrades([
        ...netted(),
        deal({ action: 1, entry: ENTRY.in, minute: 11, volume: 5_000, price: "1.10250", commissionCents: -18 }),
        deal({ action: 0, entry: ENTRY.out, minute: 15, volume: 5_000, price: "1.10150", profitCents: 500 }),
      ]),
    ).toEqual([closedPart]);
  });

  it("makes the remainder of a reversal a trade of its own once it is closed: the other side, opened at the INOUT deal's price and time", () => {
    const close = deal({ ticket: 104, action: 0, entry: ENTRY.out, minute: 20, volume: 5_000, price: "1.10100", profitCents: 500, commissionCents: -18, swapCents: -3 });
    expect(closedTrades([...netted(), close])).toEqual([
      closedPart,
      {
        segment: 103, symbol: "EURUSD", side: 1, volume: 5_000, openPrice: "1.10200", closePrice: "1.10100", openTimeUtc: at(10), closeTimeUtc: at(20),
        profitCents: 500, commissionCents: -18, swapCents: -3, feeCents: 0,
      },
    ]);
    // Added to before it closed: the remainder's volume and open price take the IN deal in, as any netting position's do.
    expect(
      closedTrades([
        ...netted(),
        deal({ action: 1, entry: ENTRY.in, minute: 11, volume: 5_000, price: "1.10250", commissionCents: -18 }),
        deal({ action: 0, entry: ENTRY.out, minute: 20, volume: 10_000, price: "1.10100", profitCents: 1_250, commissionCents: -35 }),
      ])[1],
    ).toEqual({
      segment: 103, symbol: "EURUSD", side: 1, volume: 10_000, openPrice: "1.10225", closePrice: "1.10100", openTimeUtc: at(10), closeTimeUtc: at(20),
      profitCents: 1_250, commissionCents: -53, swapCents: 0, feeCents: 0,
    });
    // A 1-lot buy reversed by a 3-lot sell at a loss, the 2 lots sold then bought back at a gain: a losing buy and a winning sell,
    // never one buy from 1.10 to 1.08 that made money.
    expect(
      closedTrades([
        deal({ ticket: 201, action: 0, entry: ENTRY.in, minute: 0, volume: 10_000, price: "1.10000" }),
        deal({ ticket: 202, action: 1, entry: ENTRY.inOut, minute: 5, volume: 30_000, price: "1.09000", profitCents: -10_000 }),
        deal({ ticket: 203, action: 0, entry: ENTRY.out, minute: 9, volume: 20_000, price: "1.08000", profitCents: 20_000 }),
      ]),
    ).toEqual([
      { segment: 0, symbol: "EURUSD", side: 0, volume: 10_000, openPrice: "1.10000", closePrice: "1.09000", openTimeUtc: at(0), closeTimeUtc: at(5), profitCents: -10_000, commissionCents: 0, swapCents: 0, feeCents: 0 },
      { segment: 202, symbol: "EURUSD", side: 1, volume: 20_000, openPrice: "1.09000", closePrice: "1.08000", openTimeUtc: at(5), closeTimeUtc: at(9), profitCents: 20_000, commissionCents: 0, swapCents: 0, feeCents: 0 },
    ]);
    // A reversal whose opening deal is not in the cache cannot be shown, and its remainder is not shown either: how much it
    // opened depends on how much it closed.
    expect(closedTrades([netted()[2]!, deal({ action: 0, entry: ENTRY.out, minute: 20, volume: 5_000, price: "1.10100", profitCents: 500 })])).toEqual([]);
  });

  it("closes the remainder only once its partial closes reach what the reversal opened, in exact lots", () => {
    // 0.03 lots bought, then 0.1 sold: 0.07 opened the other way (never 0.1 - 0.03 in floating point).
    const deals = [
      deal({ ticket: 301, action: 0, entry: ENTRY.in, minute: 0, volume: 300, price: "1.25000" }),
      deal({ ticket: 302, action: 1, entry: ENTRY.inOut, minute: 4, volume: 1_000, price: "1.24900", profitCents: -30 }),
      deal({ ticket: 303, action: 0, entry: ENTRY.out, minute: 6, volume: 100, price: "1.24800", profitCents: 10 }),
      deal({ ticket: 304, action: 0, entry: ENTRY.out, minute: 7, volume: 200, price: "1.24850", profitCents: 10 }),
      deal({ ticket: 305, action: 0, entry: ENTRY.outBy, minute: 8, volume: 400, price: "1.24700", profitCents: 80, swapCents: -1 }),
    ];
    for (const n of [2, 3, 4]) expect(closedTrades(deals.slice(0, n)).map((t) => t.segment)).toEqual([0]);
    const [first, rest] = closedTrades(deals);
    expect(first).toMatchObject({ segment: 0, side: 0, volume: 300, closePrice: "1.24900", profitCents: -30 });
    expect(rest).toEqual({
      segment: 302, symbol: "EURUSD", side: 1, volume: 700, openPrice: "1.24900", closePrice: "1.24700", openTimeUtc: at(4), closeTimeUtc: at(8),
      profitCents: 100, commissionCents: 0, swapCents: -1, feeCents: 0,
    });
    expect(presentClientTrade({ ...row, position_id: 77, segment: rest!.segment, volume: rest!.volume }, { currency: "USD" }, "").volume).toBe(0.07);
  });

  /** Bought a lot, reversed by selling 3 (ticket 402), reversed again by buying 5 (ticket 403), then 3 sold to close. */
  const twice = () => [
    deal({ ticket: 401, action: 0, entry: ENTRY.in, minute: 0, volume: 10_000, price: "1.10000", commissionCents: -35 }),
    deal({ ticket: 402, action: 1, entry: ENTRY.inOut, minute: 5, volume: 30_000, price: "1.09000", profitCents: -10_000, commissionCents: -105 }),
    deal({ ticket: 403, action: 0, entry: ENTRY.inOut, minute: 9, volume: 50_000, price: "1.08000", profitCents: 20_000, commissionCents: -175, swapCents: -60 }),
    deal({ ticket: 404, action: 1, entry: ENTRY.out, minute: 15, volume: 30_000, price: "1.08500", profitCents: 15_000, commissionCents: -105 }),
  ];

  it("makes each part between two reversals in a row a trade of its own", () => {
    const parts = [
      { segment: 0, symbol: "EURUSD", side: 0, volume: 10_000, openPrice: "1.10000", closePrice: "1.09000", openTimeUtc: at(0), closeTimeUtc: at(5), profitCents: -10_000, commissionCents: -140, swapCents: 0, feeCents: 0 },
      // Opened by the first reversal and closed by the second, which also opened 3 lots bought.
      { segment: 402, symbol: "EURUSD", side: 1, volume: 20_000, openPrice: "1.09000", closePrice: "1.08000", openTimeUtc: at(5), closeTimeUtc: at(9), profitCents: 20_000, commissionCents: -175, swapCents: -60, feeCents: 0 },
      { segment: 403, symbol: "EURUSD", side: 0, volume: 30_000, openPrice: "1.08000", closePrice: "1.08500", openTimeUtc: at(9), closeTimeUtc: at(15), profitCents: 15_000, commissionCents: -105, swapCents: 0, feeCents: 0 },
    ];
    expect(closedTrades(twice().slice(0, 3))).toEqual(parts.slice(0, 2));
    expect(closedTrades(twice())).toEqual(parts);
    // Every cent of the position's deals is in exactly one row.
    const all = twice();
    for (const k of ["profitCents", "commissionCents", "swapCents", "feeCents"] as const) expect(parts.reduce((n, p) => n + p[k], 0)).toBe(all.reduce((n, d) => n + d[k], 0));
  });

  it("builds the same rows from the same deals however they are read: again over the overlap, in any order, or as later deals arrive", () => {
    const all = twice();
    const built = closedTrades(all);
    // A sync reads the last two days again: the cache still has each deal once, and the position is built from all of them.
    expect(closedTrades([...all])).toEqual(built);
    expect(closedTrades([...all].reverse())).toEqual(built);
    expect(closedTrades([all[2]!, all[0]!, all[3]!, all[1]!])).toEqual(built);
    // Page by page: a row, once built, keeps its key and its values as the position's later deals come in.
    for (let n = 1; n <= all.length; n++) {
      const sofar = closedTrades(all.slice(0, n));
      expect(sofar).toEqual(built.slice(0, sofar.length));
    }
    // MT5 cancels the first reversal (SELL_CANCELED): the buy is open again as far as the cache can tell, and nothing after it is guessed at.
    expect(closedTrades(all.map((d) => (d.ticket === 402 ? { ...d, action: 14 } : d)))).toEqual([]);
  });

  it("never makes a trade of balance or credit deals, an open position, or one whose opening deal is missing", () => {
    expect(closedTrades([deal({ action: 2, entry: ENTRY.in, minute: 0 }), deal({ action: 3, entry: ENTRY.out, minute: 1 })])).toEqual([]);
    expect(closedTrades([deal({ action: 0, entry: ENTRY.in, minute: 0 })])).toEqual([]);
    expect(closedTrades([deal({ action: 1, entry: ENTRY.out, minute: 1 })])).toEqual([]);
    expect(closedTrades([])).toEqual([]);
  });

  it("orders deals of the same moment by ticket", () => {
    const t = closedTrades([
      deal({ ticket: 12, action: 1, entry: ENTRY.out, minute: 5, volume: 5_000, price: "2.0" }),
      deal({ ticket: 11, action: 1, entry: ENTRY.out, minute: 5, volume: 5_000, price: "1.0" }),
      deal({ ticket: 10, action: 0, entry: ENTRY.in, minute: 0, volume: 10_000 }),
    ]);
    expect(t[0]?.closePrice).toBe("2.0");
  });

  it("averages prices exactly, rounding half away from zero", () => {
    expect(averagePrice([{ price: "1.10000", volume: 10_000 }])).toBe("1.10000");
    expect(averagePrice([{ price: "1.1", volume: 1 }, { price: "1.2", volume: 2 }])).toBe("1.2"); // 1.1666… → 1.2
    expect(averagePrice([{ price: "1.10", volume: 1 }, { price: "1.105", volume: 1 }])).toBe("1.103"); // 1.1025 → 1.103
    expect(averagePrice([{ price: "0.00001", volume: 1 }, { price: "0.00002", volume: 1 }])).toBe("0.00002");
    expect(averagePrice([{ price: "-1.5", volume: 1 }, { price: "-2.5", volume: 1 }])).toBe("-2.0");
    expect(averagePrice([{ price: "65000.5", volume: 3 }, { price: "64000", volume: 1 }])).toBe("64750.4"); // 64750.375
    expect(averagePrice([{ price: "1.1", volume: 0 }, { price: "1.2", volume: 0 }])).toBe("1.1");
  });
});

describe("trade history parameters", () => {
  it("clamps per_page to 1..500, defaults to 100 and page 1, and ignores what is malformed", () => {
    expect(historyQuery({})).toMatchObject({ page: 1, perPage: 100, login: null, from: null, to: null, filters: { from_date: null, to_date: null, account_id: null } });
    expect(historyQuery({ per_page: "500" }).perPage).toBe(500);
    expect(historyQuery({ per_page: "501" }).perPage).toBe(500);
    expect(historyQuery({ per_page: "0", page: "0" })).toMatchObject({ perPage: 1, page: 1 });
    expect(historyQuery({ per_page: "-4", page: "-2" })).toMatchObject({ perPage: 1, page: 1 });
    expect(historyQuery({ per_page: "lots", page: "x" })).toMatchObject({ perPage: 100, page: 1 });
    expect(historyQuery({ per_page: ["50", "60"], page: ["2"] })).toMatchObject({ perPage: 100, page: 1 });
    expect(historyQuery({ page: " 7 " }).page).toBe(7);
  });

  it("reads days as whole UTC days and the account as a login", () => {
    const q = historyQuery({ from_date: "2026-06-04", to_date: "2026-09-04", account_id: "2491" });
    expect(q.from?.toISOString()).toBe("2026-06-04T00:00:00.000Z");
    expect(q.to?.toISOString()).toBe("2026-09-04T23:59:59.999Z");
    expect(q.filters).toEqual({ from_date: "2026-06-04", to_date: "2026-09-04", account_id: "2491" });
    expect(q.login).toBe(2491);
    for (const bad of ["2026-02-30", "2026-13-01", "04/06/2026", "2026-6-4", "", "null"]) expect(historyQuery({ from_date: bad, to_date: bad }).filters).toMatchObject({ from_date: null, to_date: null });
    for (const bad of ["null", "0", "-5", "12a", "1".repeat(16), ""]) expect(historyQuery({ account_id: bad }).login).toBeNull();
    expect(historyQuery({ account_id: "2026-01" }).filters.account_id).toBeNull();
  });
});

describe("trade rows", () => {
  it("give each account after the first with the same login its own id suffix, oldest first", () => {
    const s = tradeIdSuffixes([{ id: 9, login: 500 }, { id: 3, login: 500 }, { id: 4, login: 777 }, { id: 5, login: null }, { id: 12, login: 500 }]);
    expect([...s]).toEqual([[3, ""], [4, ""], [9, "-2"], [12, "-3"]]);
  });

  it("are in the shape both clients parse: numbers, lots, dollars, ISO times, closed", () => {
    expect(presentClientTrade(row, { currency: "USD" }, "")).toEqual({
      id: "500123-880011", ticket: 880011, symbol: "XAUUSD", side: 1, type: "sell", volume: 0.25, open_price: 2350.15, close_price: 2340.05,
      pnl: 252.5, profit: 252.5, commission: -1.75, swap: -0.33, currency: "USD", account: "500123", login: "500123", status: "closed",
      opened_at: "2026-06-01T08:00:00.250Z", closed_at: "2026-06-01T09:30:00.000Z",
    });
  });

  it("give each part of a reversed position its own id, from the reversal that opened it, and keep the position as the ticket", () => {
    const ids = (suffix: string) => [0, 7_000_123, 7_000_456].map((segment) => presentClientTrade({ ...row, segment }, { currency: "USD" }, suffix));
    expect(ids("").map((t) => [t.id, t.ticket])).toEqual([["500123-880011", 880011], ["500123-880011-r7000123", 880011], ["500123-880011-r7000456", 880011]]);
    // The second account with the same login: its suffix last, so no id of one account can be another's.
    expect(ids("-2").map((t) => t.id)).toEqual(["500123-880011-2", "500123-880011-r7000123-2", "500123-880011-r7000456-2"]);
  });
});

describe("deal times", () => {
  it("take the gateway's UTC second and MT5's milliseconds, whatever the server's own clock says", () => {
    // A server three hours ahead of UTC: `time` is its clock, timeUtc already turned into UTC by the gateway.
    const utc = Date.UTC(2026, 2, 1, 22, 30, 15);
    const time = utc / 1000 + 3 * 3600;
    expect(dealTimeUtc({ time, timeMsc: time * 1000 + 417, timeUtc: new Date(utc).toISOString() })?.toISOString()).toBe("2026-03-01T22:30:15.417Z");
    // Milliseconds that do not belong to `time` are not used.
    expect(dealTimeUtc({ time, timeMsc: 5, timeUtc: new Date(utc).toISOString() })?.toISOString()).toBe("2026-03-01T22:30:15.000Z");
    expect(dealTimeUtc({ time, timeMsc: time * 1000, timeUtc: "not a time" })).toBeNull();
  });
});
