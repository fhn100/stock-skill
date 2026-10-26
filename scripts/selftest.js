#!/usr/bin/env node

/**
 * 纯函数自测（不碰数据库）
 * 用法: node --test selftest.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { greedyMatch, netMoneyOf, matchMoneyOf } from "./business.js";
import { OP } from "./constants.js";
import { TRADE_COLUMNS, TRADE_RECORD_DDL, TRADE_MATCHED_DDL } from "./schema.js";
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

test("同时间戳买卖可配对：history_id 不影响跨类型可用性", () => {
  const buys = [trade(OP.BUY, "zzz", "2026-01-10 10:00:00", 900)];
  const sells = [trade(OP.SELL, "aaa", "2026-01-10 10:00:00", 1000)];
  const pairs = greedyMatch(buys, sells);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].buy.history_id, "zzz");
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

// ============================ 美股（嘉信）同步：纯函数守卫 ============================

/**
 * 美股交易记录唯一的写入路径是 opencli stock sync-schwab，被测逻辑就在插件脚本
 * resources/stock/sync.js 里（导出的 schwabPure）。插件依赖未安装时跳过，不拖累其它用例。
 */
const schwab = await import(new URL("../resources/stock/sync.js", import.meta.url).href)
  .then((m) => m.schwabPure)
  .catch(() => null);
const schwabSkip = schwab ? false : "未能加载 resources/stock/sync.js（先在 resources/stock 下 npm install）";

// 2026-10-21 TSLA 卖出 1 股 @390：真实库里的既有主键，公式一改就会生成新键、
// 与旧记录并存导致收益翻倍，所以这几个值是回归红线，不是随手写的样例。
const GOLDEN_SELL_1_390 = "c89fb934437da3f7da870c4a";

test("history_id 与 account_id 公式未漂移（与库中既有美股记录同一主键）", { skip: schwabSkip }, () => {
  assert.equal(schwab.stableHistoryId("嘉信-冯", "2026-10-21 16:00:00", "TSLA", OP.SELL, 1, 390), GOLDEN_SELL_1_390);
  assert.equal(schwab.stableHistoryId("嘉信-冯", "2026-10-21 16:00:00", "TSLA", OP.SELL, 1, "390.00"), GOLDEN_SELL_1_390);
  // 数量或价格不同必须是不同主键
  assert.notEqual(schwab.stableHistoryId("嘉信-冯", "2026-10-21 16:00:00", "TSLA", OP.SELL, 2, 390), GOLDEN_SELL_1_390);
  assert.equal(schwab.schwabAccountId("嘉信-冯"), "US-c0e4a175de");
});

test("parseSchwabMoney 处理 $千分位、负号、括号；parseSchwabDate 只认美式日期", { skip: schwabSkip }, () => {
  assert.equal(schwab.parseSchwabMoney("$1,234.56"), 1234.56);
  assert.equal(schwab.parseSchwabMoney("-$370.00"), -370);
  assert.equal(schwab.parseSchwabMoney("(1,234.56)"), -1234.56);
  assert.ok(Number.isNaN(schwab.parseSchwabMoney("")));
  assert.equal(schwab.parseSchwabDate("10/23/2026"), "2026-10-23");
  assert.equal(schwab.parseSchwabDate("2026-10-23"), null);
});

test("mapSchwabAction：买卖→1/2，派息→6，出入金→18/19，其它→99", { skip: schwabSkip }, () => {
  assert.equal(schwab.mapSchwabAction("Buy, Limit Price"), OP.BUY);
  assert.equal(schwab.mapSchwabAction("Sell, Stop"), OP.SELL);
  assert.equal(schwab.mapSchwabAction("Dividend Cash"), "6");
  assert.equal(schwab.mapSchwabAction("Journal In"), "18");
  assert.equal(schwab.mapSchwabAction("Transfer Out"), "19");
  assert.equal(schwab.mapSchwabAction("Margin Interest"), "99");
  assert.equal(schwab.mapSchwabAction(""), null);
});

test("normalizeSchwabTrade：卖出净额入 entry_money、美股无过户费、现金流水跳过", { skip: schwabSkip }, () => {
  const ctx = { accountId: "US-c0e4a175de", accountName: "嘉信-冯", selectedAccountId: "10301685" };
  const { record, warning } = schwab.normalizeSchwabTrade({
    transactionDate: "10/22/2026", action: "Sell", symbol: "tsla", description: "TESLA INC",
    shareQuantity: "1", executionPrice: "$387.00", feesAndCommission: "$0.01", amount: "$386.99",
  }, ctx);
  assert.equal(warning, null);
  assert.equal(record.op, OP.SELL);
  assert.equal(record.code, "TSLA");
  assert.equal(record.entry_date_time, "2026-10-22 16:00:00"); // 接口无成交时间，统一按收盘时间
  assert.equal(record.entry_money, 386.99); // amount 已是扣费后净额
  assert.equal(record.transfer_fee, 0);
  assert.equal(record.market_code, "US");
  assert.equal(record.account_id, "US-c0e4a175de");

  const cash = schwab.normalizeSchwabTrade(
    { transactionDate: "09/29/2026", action: "Margin Interest", symbol: "", amount: "-$15.93" }, ctx);
  assert.equal(cash.record, null);
  assert.match(cash.warning, /无证券代码/);
});

test("splitToShares：qty=3 → 3 条 1 股，共用 base 主键、金额守恒；qty=1 原样", { skip: schwabSkip }, () => {
  const r = { account_name: "嘉信-冯", entry_date_time: "2026-10-21 16:00:00", code: "TSLA", op: OP.SELL,
    entry_count: 3, entry_price: 390, entry_money: 779.98, entry_cost: 779.98, commission: 0 };
  const out = schwab.splitToShares(r);
  assert.equal(out.length, 3);
  assert.ok(out.every((x) => x.entry_count === 1 && x.entry_price === 390));
  assert.equal(new Set(out.map((x) => x.history_id)).size, 1);
  assert.equal(out[0].history_id, GOLDEN_SELL_1_390);
  assert.ok(Math.abs(out.reduce((s, x) => s + x.entry_money, 0) - 779.98) < 0.005);
  assert.deepEqual(schwab.splitToShares({ ...r, entry_count: 1 }), [{ ...r, entry_count: 1 }]);
});

test("dedupeHistoryIds：同键重复 → base + x02，不多不少", { skip: schwabSkip }, () => {
  const id = "aaaa1111bbbb2222cccc3333";
  const recs = [{ history_id: id }, { history_id: id }, { history_id: "distinct000000000000" }];
  schwab.dedupeHistoryIds(recs);
  const ids = recs.map((x) => x.history_id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.includes(id));
  assert.ok(ids.some((x) => x.endsWith("x02")));
});
