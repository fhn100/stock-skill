#!/usr/bin/env node

/**
 * 纯函数自测（不碰数据库）
 * 用法: node --test selftest.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { greedyMatch, netMoneyOf, matchMoneyOf } from "./business.js";
import { OP } from "./constants.js";
import { TRADE_COLUMNS, TRADE_RECORD_DDL, TRADE_MATCHED_DDL } from "./schema.js";
import { monthRange, lastDayOfMonth, displayWidth, renderTable, maskAccountName } from "./utils.js";
import {
  parseCsv, findHeaderRow, buildColumnMap, parseMoney, parseDateTime, mapOp,
  normalizeRow, stableHistoryId, dedupeHistoryIds, splitToShares, importCsv,
} from "./import-csv.js";

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

// ============================ Schema 漂移守卫 ============================

/**
 * 从 CREATE TABLE DDL 提取列名集合（跳过 PRIMARY/UNIQUE/FOREIGN/CHECK/CONSTRAINT 约束项）
 * @param {string} ddl 从 "CREATE TABLE" 起的片段
 */
function parseColumnNames(ddl) {
  const start = ddl.indexOf("(");
  if (start < 0) return null;
  let depth = 0, end = -1;
  for (let i = start; i < ddl.length; i++) {
    if (ddl[i] === "(") depth++;
    else if (ddl[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const body = ddl.slice(start + 1, end);
  const pieces = [];
  let cur = "", d = 0;
  for (const ch of body) {
    if (ch === "(") d++;
    if (ch === ")") d--;
    if (ch === "," && d === 0) { pieces.push(cur); cur = ""; }
    else cur += ch;
  }
  pieces.push(cur);
  return pieces
    .map((p) => p.trim())
    .filter((p) => p && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(p))
    .map((p) => p.split(/\s+/)[0].replace(/^"(.*)"$/, "$1"));
}

/** 提取 sync.js 源码里各 CREATE TABLE 的列名，按占位符 TABLE.XXX 归类 */
function parseSyncTables(src) {
  const out = {};
  for (const idx of [...src.matchAll(/CREATE TABLE IF NOT EXISTS/g)].map((m) => m.index)) {
    const header = src.slice(idx, src.indexOf("(", idx));
    const key = /TABLE\.(\w+)/.exec(header)?.[1];
    if (key) out[key] = parseColumnNames(src.slice(idx));
  }
  return out;
}

const sorted = (arr) => [...arr].sort();
const sameSet = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

test("schema.js 与 sync.js 建表列集合一致（漂移守卫）", () => {
  const syncPath = path.join(import.meta.dirname, "..", "resources", "stock", "sync.js");
  const syncTables = parseSyncTables(fs.readFileSync(syncPath, "utf8"));

  const schemaTrade = parseColumnNames(TRADE_RECORD_DDL);
  const schemaMatched = parseColumnNames(TRADE_MATCHED_DDL);
  assert.ok(schemaTrade && syncTables.TRADE_RECORD, "未能解析出 t_trade_record DDL");
  assert.ok(schemaMatched && syncTables.TRADE_MATCHED, "未能解析出 t_trade_matched_record DDL");

  assert.ok(sameSet(schemaTrade, syncTables.TRADE_RECORD),
    `t_trade_record 列漂移:\n schema=${sorted(schemaTrade)}\n sync=${sorted(syncTables.TRADE_RECORD)}`);
  assert.ok(sameSet(schemaMatched, syncTables.TRADE_MATCHED),
    `t_trade_matched_record 列漂移:\n schema=${sorted(schemaMatched)}\n sync=${sorted(syncTables.TRADE_MATCHED)}`);
});

test("schema.js TRADE_COLUMNS 与建表列集合一致", () => {
  assert.ok(sameSet(TRADE_COLUMNS, parseColumnNames(TRADE_RECORD_DDL)));
});

// ============================ CSV 导入：解析 ============================

test("parseCsv 处理引号内逗号、CRLF 与 BOM", () => {
  const rows = parseCsv("﻿\"Date\",\"Desc\",\"Amount\"\r\n\"01/01/2026\",\"a,b\",\"-1.5\"\r\n");
  assert.deepEqual(rows[0], ["Date", "Desc", "Amount"]);
  assert.deepEqual(rows[1], ["01/01/2026", "a,b", "-1.5"]);
});

test("parseMoney 处理 $千分位、括号负数、空值", () => {
  assert.equal(parseMoney("$1,234.56"), 1234.56);
  assert.equal(parseMoney("(1,234.56)"), -1234.56);
  assert.ok(Number.isNaN(parseMoney("")));
});

test("parseDateTime 支持美式/ISO/AM-PM/ET/多后缀串", () => {
  assert.deepEqual(parseDateTime("10/23/2026"), { date: "2026-10-23", time: null });
  assert.deepEqual(parseDateTime("2026-01-05"), { date: "2026-01-05", time: null });
  assert.deepEqual(parseDateTime("2026-01-05 14:30:00"), { date: "2026-01-05", time: "14:30:00" });
  assert.equal(parseDateTime("04/29/2026 09:30 AM").time, "09:30:00");
  assert.equal(parseDateTime("04/29/2026 01:30 PM").time, "13:30:00");
  assert.equal(parseDateTime("10/03/2025 as of 10/02/2025").date, "2025-10-03");
  assert.equal(parseDateTime("04/29/2026 ET").date, "2026-04-29");
  assert.equal(parseDateTime("09:30 AM"), null); // 无日期，拒绝
});

test("mapOp：买卖→1/2，派息→6，journal→18，其它→99", () => {
  assert.equal(mapOp("Buy, Limited Price"), OP.BUY);
  assert.equal(mapOp("Sell Short"), OP.SELL);
  assert.equal(mapOp("Dividend Cash"), "6");
  assert.equal(mapOp("Journal In"), "18");
  assert.equal(mapOp("Margin Interest"), "99");
});

// ============================ CSV 导入：行标准化 ============================

const SCHWAB_HEADER = ["Date", "Action", "Symbol", "Description", "Quantity", "Price", "Fees & Comm", "Amount"];
const colOf = () => buildColumnMap(SCHWAB_HEADER);
const normOpts = { account: "嘉信-冯", accountId: "US-test" };

test("normalizeRow：卖出净额入 entry_money，commission 恒 0（防重复扣费）", () => {
  const cells = ["10/22/2026", "Sell", "TSLA", "TESLA INC", "1", "$387.00", "$0.01", "$386.99"];
  const { record, warning } = normalizeRow(cells, colOf(), normOpts);
  assert.equal(warning, null);
  assert.equal(record.op, OP.SELL);
  assert.equal(record.entry_count, 1);
  assert.equal(record.entry_money, 386.99); // 已含费的净额
  assert.equal(record.commission, 0);
  assert.equal(record.market_code, "US");
});

test("normalizeRow：无 Symbol 的非交易流水被跳过", () => {
  const cells = ["09/29/2026", "Margin Interest", "", "INTEREST", "", "", "", "-$15.93"];
  const { record, warning } = normalizeRow(cells, colOf(), normOpts);
  assert.equal(record, null);
  assert.match(warning, /缺少代码/);
});

// ============================ CSV 导入：按 1 股拆分 ============================

test("splitToShares：qty=3 → 3 条 1 股，金额守恒、价与费保留", () => {
  const r = { account_name: "嘉信-冯", entry_date_time: "2026-10-21 16:00:00", code: "TSLA", op: OP.SELL,
    entry_count: 3, entry_price: 390, entry_money: 779.98, entry_cost: 779.98, commission: 0 };
  const out = splitToShares(r);
  assert.equal(out.length, 3);
  assert.ok(out.every((x) => x.entry_count === 1 && x.entry_price === 390 && x.commission === 0));
  assert.ok(Math.abs(out.reduce((s, x) => s + x.entry_money, 0) - 779.98) < 0.005);
});

test("splitToShares：qty=1 原样返回；fractional 金额误差在容差内", () => {
  const one = { entry_count: 1, entry_money: 370, entry_price: 370, account_name: "A", entry_date_time: "t", code: "X", op: OP.BUY };
  assert.deepEqual(splitToShares(one), [one]);
  const r = { ...one, entry_count: 3, entry_money: 100.01 };
  const sum = splitToShares(r).reduce((s, x) => s + x.entry_money, 0);
  assert.ok(Math.abs(sum - 100.01) < 0.005);
});

// ============================ CSV 导入：history_id 幂等 ============================

test("stableHistoryId 确定性；qty/价格不同则不同", () => {
  const a = stableHistoryId("嘉信-冯", "2026-10-21 16:00:00", "TSLA", OP.SELL, 1, 390);
  assert.equal(a, stableHistoryId("嘉信-冯", "2026-10-21 16:00:00", "TSLA", OP.SELL, 1, 390));
  assert.notEqual(a, stableHistoryId("嘉信-冯", "2026-10-21 16:00:00", "TSLA", OP.SELL, 2, 390));
});

test("dedupeHistoryIds：两条完全相同 → base + x02，不多不少", () => {
  const id = "aaaa1111bbbb2222cccc3333";
  const recs = [{ history_id: id }, { history_id: id }, { history_id: "distinct000000000000" }];
  dedupeHistoryIds(recs);
  const ids = recs.map((r) => r.history_id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.some((x) => x === id));
  assert.ok(ids.some((x) => x.endsWith("x02")));
});

// ============================ CSV 导入：端到端（importCsv 不写库） ============================

test("importCsv：拆分后条数增加、买卖金额守恒、重跑幂等", async () => {
  const tmp = path.join(os.tmpdir(), `selftest_schwab_${process.pid}.csv`);
  fs.writeFileSync(tmp, [
    SCHWAB_HEADER.join(","),
    '"10/21/2026","Sell","TSLA","TESLA INC","2","$390.00","$0.02","$779.98"',
    '"10/20/2026","Buy","TSLA","TESLA INC","1","$368.07","","-$368.07"',
    '"09/29/2026","Margin Interest","","INTEREST","","","","-$15.93"',
  ].join("\n"), "utf8");

  const r1 = await importCsv(tmp, { split: true });
  const r2 = await importCsv(tmp, { split: true });
  fs.unlinkSync(tmp);

  // 1 笔 qty=2 卖出 → 2 条；1 笔 qty=1 买入 → 1 条；Margin Interest 跳过
  assert.equal(r1.parsed, 3);
  assert.equal(r1.byOp[OP.SELL], 2);
  assert.equal(r1.byOp[OP.BUY], 1);
  // 金额守恒：卖出净额 = 779.98
  const sellSum = r1.records.filter((x) => x.op === OP.SELL).reduce((s, x) => s + x.entry_money, 0);
  assert.ok(Math.abs(sellSum - 779.98) < 0.005);
  // 幂等：重跑 history_id 集合一致
  const ids = (r) => r.records.map((x) => x.history_id).sort().join(",");
  assert.equal(ids(r1), ids(r2));
});
