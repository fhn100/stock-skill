#!/usr/bin/env node

/**
 * 纯函数自测（不碰数据库）
 * 用法: node --test selftest.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import { greedyMatch, netMoneyOf, matchMoneyOf } from "./business.js";
import { OP } from "./constants.js";
import { monthRange, lastDayOfMonth, displayWidth, renderTable, maskAccountName } from "./utils.js";

/** 构造一条流水：time 为 "YYYY-MM-DD HH:MM:SS" */
const trade = (op, id, time, money, { count = 100, code = "600000", account = "A", fee = 0, commission = 0 } = {}) => ({
  op,
  history_id: id,
  account_id: account,
  code,
  entry_count: count,
  entry_money: money,
  transfer_fee: fee,
  commission,
  entry_ts: new Date(time.replace(" ", "T") + "Z"),
  netMoney: netMoneyOf({ op, entry_money: money, transfer_fee: fee, commission }),
  matchMoney: matchMoneyOf({ op, entry_money: money, transfer_fee: fee, commission }, true),
});

// ============================ 匹配算法 ============================

test("最短持有优先：同一卖出取时间最新且盈利的买入", () => {
  const buys = [
    trade(OP.BUY, "b1", "2026-01-01 10:00:00", 900),
    trade(OP.BUY, "b2", "2026-01-05 10:00:00", 950),
  ];
  const sells = [trade(OP.SELL, "s1", "2026-01-10 10:00:00", 1000)];
  const pairs = greedyMatch(buys, sells);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].buy.history_id, "b2");
});

test("无盈利不配对", () => {
  const buys = [trade(OP.BUY, "b1", "2026-01-01 10:00:00", 1100)];
  const sells = [trade(OP.SELL, "s1", "2026-01-10 10:00:00", 1000)];
  assert.equal(greedyMatch(buys, sells).length, 0);
});

test("先卖后买不配对", () => {
  const buys = [trade(OP.BUY, "b1", "2026-02-01 10:00:00", 900)];
  const sells = [trade(OP.SELL, "s1", "2026-01-10 10:00:00", 1000)];
  assert.equal(greedyMatch(buys, sells).length, 0);
});

test("分组隔离：代码/数量/账户不同均不互配", () => {
  const buys = [
    trade(OP.BUY, "b1", "2026-01-01 10:00:00", 900, { code: "000001" }),
    trade(OP.BUY, "b2", "2026-01-01 10:00:00", 900, { count: 200 }),
    trade(OP.BUY, "b3", "2026-01-01 10:00:00", 900, { account: "B" }),
  ];
  const sells = [trade(OP.SELL, "s1", "2026-01-10 10:00:00", 1000)];
  assert.equal(greedyMatch(buys, sells).length, 0);
});

test("一笔买入只配一笔卖出", () => {
  const buys = [trade(OP.BUY, "b1", "2026-01-01 10:00:00", 900)];
  const sells = [
    trade(OP.SELL, "s1", "2026-01-10 10:00:00", 1000),
    trade(OP.SELL, "s2", "2026-01-11 10:00:00", 1000),
  ];
  const pairs = greedyMatch(buys, sells);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].sell.history_id, "s1");
});

// ============================ 净额口径 ============================

test("净额：买入加费、卖出减费", () => {
  assert.equal(netMoneyOf(trade(OP.BUY, "b", "2026-01-01 00:00:00", 1000, { fee: 1, commission: 5 })), 1006);
  assert.equal(netMoneyOf(trade(OP.SELL, "s", "2026-01-01 00:00:00", 1000, { fee: 1, commission: 5 })), 994);
});

test("过户费等于成交额视为脏数据，按 0 费用处理", () => {
  assert.equal(netMoneyOf({ op: OP.SELL, entry_money: 1000, transfer_fee: 1000, commission: 5 }), 995);
});

test("毛额口径忽略费用", () => {
  const t = { op: OP.BUY, entry_money: 1000, transfer_fee: 1, commission: 5 };
  assert.equal(matchMoneyOf(t, false), 1000);
  assert.equal(matchMoneyOf(t, true), 1006);
});

// ============================ 日期工具 ============================

test("monthRange 含端点并可跨年", () => {
  assert.deepEqual(monthRange("2026-01", "2026-03"), ["2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(monthRange("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(monthRange("2026-05", "2026-01"), []);
});

test("lastDayOfMonth 处理闰年与两种入参", () => {
  assert.equal(lastDayOfMonth("2028-02"), "29");
  assert.equal(lastDayOfMonth("2026-02"), "28");
  assert.equal(lastDayOfMonth("202611"), "30");
  assert.throws(() => lastDayOfMonth("2026-13"), /月份非法/);
});

// ============================ 表格与脱敏 ============================

test("renderTable 前列对齐、末列不补尾随空格（CJK 按 2 列计算）", () => {
  const rows = [
    ["国泰-冯*", "药明生物", "5020.87"],
    ["建投-陈*", "有色金属ETF南方", "403.26"],
  ];
  const out = renderTable(["账户", "股票名称", "总收益"], rows);
  const lines = out.split("\n");

  // 每行末列之前的显示宽度必须一致 = 前列已按最大宽度补齐
  const offsetOf = (line, lastCell) => displayWidth(line.slice(0, line.length - lastCell.length));
  const offsets = rows.map((r) => offsetOf(lines.find((l) => l.endsWith(r[2])), r[2]));
  offsets.push(offsetOf(lines[1], "总收益"));
  assert.equal(new Set(offsets).size, 1, `前列未对齐: ${offsets}`);

  assert.ok(!out.split("\n").some((l) => l !== l.trimEnd()), "不应有尾随空格");
  assert.equal(displayWidth(lines[0]), Math.max(...lines.map(displayWidth)));
});

test("maskAccountName 只保留姓", () => {
  assert.equal(maskAccountName("国泰-冯海年"), "国泰-冯**");
  assert.equal(maskAccountName(""), "未知账户");
});
