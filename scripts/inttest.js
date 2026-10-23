#!/usr/bin/env node

/**
 * 钱路集成测试（临时 DuckDB 库，不碰正式库、不联网）
 * 用法: node --test inttest.js
 *
 * 覆盖纯函数自测到不了的 SQL/DB 段：tradeMatch 落库 + gridProfit 三层聚合，
 * 校验网格收益金额、分组、币种派生，以及 GRID_PROFIT 位置参数的绑定正确性。
 * 通过 STOCK_DB_OVERRIDE 指向 tmp 文件实现隔离，跑完删除。
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ⚠️ 必须在导入任何触发建连的模块前设置，确保单例连到临时库而非正式库
const TMP_DB = path.join(os.tmpdir(), `stock_inttest_${process.pid}.db`);
process.env.STOCK_DB_OVERRIDE = TMP_DB;

const { withDb } = await import("./db.js");
const { ensureSchema } = await import("./schema.js");
const { tradeMatch, gridProfit } = await import("./business.js");
const { TABLE, OP, MARKET } = await import("./constants.js");

const num = (v) => Number(v);

/** 直接插一条交易记录（只填 tradeMatch/gridProfit 会用到的列） */
async function insertTrade(db, t) {
  await db.run(
    `INSERT OR REPLACE INTO ${TABLE.TRADE_RECORD}
       (history_id, account_id, account_name, code, name, op,
        entry_price, entry_count, entry_money, commission, transfer_fee,
        entry_date_time, market_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t.history_id, t.account_id, t.account_name, t.code, t.name, t.op,
      t.entry_price, t.entry_count, t.entry_money, t.commission ?? 0, t.transfer_fee ?? 0,
      t.entry_date_time, t.market_code,
    ],
  );
}

let rows;
before(async () => {
  await withDb(async (db) => {
    await ensureSchema(db);

    // A 股账户：600000 买 100 股 1000(过户费5) → 净成本 1005；卖 100 股 1200(过户费5) → 净所得 1195；盈利 190
    await insertTrade(db, { history_id: "cn_b1", account_id: "CN1", account_name: "国泰-测试", code: "600000", name: "测试A股", op: OP.BUY, entry_price: 10, entry_count: 100, entry_money: 1000, transfer_fee: 5, entry_date_time: "2026-05-10 10:00:00", market_code: "CN" });
    await insertTrade(db, { history_id: "cn_s1", account_id: "CN1", account_name: "国泰-测试", code: "600000", name: "测试A股", op: OP.SELL, entry_price: 12, entry_count: 100, entry_money: 1200, transfer_fee: 5, entry_date_time: "2026-05-20 10:00:00", market_code: "CN" });

    // 美股账户：TSLA 买 1 股 100（无过户费）→ 100；卖 1 股 150 → 150；盈利 50，币种应为 USD
    await insertTrade(db, { history_id: "us_b1", account_id: "US1", account_name: "嘉信-测试", code: "TSLA", name: "TESLA", op: OP.BUY, entry_price: 100, entry_count: 1, entry_money: 100, market_code: MARKET.US, entry_date_time: "2026-05-11 10:00:00" });
    await insertTrade(db, { history_id: "us_s1", account_id: "US1", account_name: "嘉信-测试", code: "TSLA", name: "TESLA", op: OP.SELL, entry_price: 150, entry_count: 1, entry_money: 150, market_code: MARKET.US, entry_date_time: "2026-05-21 10:00:00" });

    // 亏损配对：买贵卖便宜，不应被配对（仅盈利才配）
    await insertTrade(db, { history_id: "cn_b2", account_id: "CN1", account_name: "国泰-测试", code: "000001", name: "测试亏损", op: OP.BUY, entry_price: 20, entry_count: 100, entry_money: 2000, transfer_fee: 0, entry_date_time: "2026-05-12 10:00:00", market_code: "CN" });
    await insertTrade(db, { history_id: "cn_s2", account_id: "CN1", account_name: "国泰-测试", code: "000001", name: "测试亏损", op: OP.SELL, entry_price: 15, entry_count: 100, entry_money: 1500, transfer_fee: 0, entry_date_time: "2026-05-22 10:00:00", market_code: "CN" });
  });

  const stats = await tradeMatch();
  assert.equal(stats.matched, 2, "应只配对两笔盈利对，亏损对不配");
  rows = await gridProfit("2026-05", "2026-05");
});

const stockRows = () => rows.filter((r) => r["股票名称"] && r["股票代码"]);
const findStock = (code) => stockRows().find((r) => r["股票代码"] === code);

test("盈利配对入库：亏损对不参与网格收益", () => {
  assert.ok(!findStock("000001"), "亏损的 000001 不应出现在个股收益里");
});

test("A 股网格收益按净额口径 = 190（含过户费）", () => {
  const r = findStock("600000");
  assert.ok(r, "缺少 600000 收益行");
  assert.equal(num(r["总收益"]).toFixed(2), "190.00");
  assert.equal(r["币种"], "CNY");
  assert.equal(num(r["交易次数"]), 1);
});

test("美股网格收益 = 50 且币种派生为 USD", () => {
  const r = findStock("TSLA");
  assert.ok(r, "缺少 TSLA 收益行");
  assert.equal(num(r["总收益"]).toFixed(2), "50.00");
  assert.equal(r["币种"], "USD");
});

test("月收益 = 个股汇总：CNY 190、USD 50 分别成行（不跨币种加总）", () => {
  const months = rows.filter((r) => r["股票名称"] === "月收益");
  const byCur = Object.fromEntries(months.map((m) => [m["币种"], num(m["总收益"]).toFixed(2)]));
  assert.equal(byCur.CNY, "190.00");
  assert.equal(byCur.USD, "50.00");
});

test("年收益 = 年初至截止月累计，与当月单月一致", () => {
  const years = rows.filter((r) => r["股票名称"] === "年收益");
  const byCur = Object.fromEntries(years.map((m) => [m["币种"], num(m["总收益"]).toFixed(2)]));
  assert.equal(byCur.CNY, "190.00");
  assert.equal(byCur.USD, "50.00");
});

// 跑完删除临时库（含 DuckDB WAL/临时文件）
after(() => {
  for (const f of fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith(`stock_inttest_${process.pid}`))) {
    try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch { /* noop */ }
  }
});
