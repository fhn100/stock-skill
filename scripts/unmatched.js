#!/usr/bin/env node

/**
 * 查询未匹配的交易记录
 * 用法: node unmatched.js [options]
 *   --code <股票代码>    按股票代码过滤
 *   --name <股票名称>    按股票名称过滤（模糊匹配）
 *   --op <buy|sell>      按买入/卖出过滤
 *   --start <YYYYMMDD>   开始日期
 *   --end <YYYYMMDD>     结束日期
 *   --account <账户名>   按账户名称过滤
 *   --all                包含不参与配对的流水（逆回购/派息/缴税/转入转出等）
 *   --db <path>          覆盖数据库路径（= STOCK_DB_OVERRIDE，仅测试用）
 */

import { withDb, extractDbFlag } from "./db.js";
import { TABLE, OP, opLabel } from "./constants.js";
import { NOT_MATCHED_JOIN, MATCHABLE_COND } from "./sql-match.js";
import { maskAccountName, fmtDate, getDefaultDateRange, renderTable } from "./utils.js";

// ============================ 参数解析 ============================

function parseArgs() {
  const args = extractDbFlag(process.argv.slice(2));
  const opts = { code: null, name: null, op: null, start: null, end: null, account: null, all: false };

  const take = (flag) => {
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) {
      console.error(`错误: ${flag} 缺少参数值`);
      process.exit(1);
    }
    return value;
  };

  let i = -1;
  while (i < args.length - 1) {
    switch (args[++i]) {
      case "--code": opts.code = take("--code"); break;
      case "--name": opts.name = take("--name"); break;
      case "--op": opts.op = take("--op").toLowerCase(); break;
      case "--start": opts.start = take("--start"); break;
      case "--end": opts.end = take("--end"); break;
      case "--account": opts.account = take("--account"); break;
      case "--all": opts.all = true; break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
    }
  }
  return opts;
}

function printUsage() {
  console.log(`用法: node unmatched.js [options]

选项:
  --code <股票代码>    按股票代码过滤
  --name <股票名称>    按股票名称过滤（模糊匹配）
  --op <buy|sell>      按买入(buy)/卖出(sell)过滤
  --start <YYYYMMDD|YYYY-MM-DD>   开始日期（默认当月1号）
  --end <YYYYMMDD|YYYY-MM-DD>     结束日期（默认当天）
  --account <账户名>   按账户名称过滤（模糊匹配）
  --all                包含不参与配对的流水（逆回购/派息/缴税/转入转出等）
  --db <path>          覆盖数据库路径（等价于 STOCK_DB_OVERRIDE，仅测试用）
  -h, --help           显示帮助

默认只列出可配对记录（op=1/2 且数量>0，即现货买卖），与 match.js 的配对口径一致。

示例:
  node unmatched.js                          # 当月所有可配对的未匹配记录
  node unmatched.js --code 601012            # 隆基绿能未匹配记录
  node unmatched.js --name 隆基 --op sell    # 隆基绿能卖出未匹配记录
  node unmatched.js --all                    # 含逆回购/派息等全部未配对流水
  node unmatched.js --start 20260101 --end 20260630  # 指定时间范围`);
}

// ============================ 主逻辑 ============================

/** 交易记录中未出现在匹配表中的记录 */
async function queryUnmatched(db, { filters, params, cond, fields }) {
  return await db.all(`
    SELECT ${fields}
    FROM ${TABLE.TRADE_RECORD} t
    ${NOT_MATCHED_JOIN}
      AND ${cond}
      ${filters}
    ORDER BY t.entry_date DESC, t.entry_time DESC
  `, params);
}

async function main() {
  const opts = parseArgs();
  const defaults = getDefaultDateRange();
  const start = opts.start || defaults.startDate;
  const end = opts.end || defaults.endDate;

  if (opts.op && !["buy", "sell"].includes(opts.op)) {
    console.error("错误: --op 参数必须是 buy 或 sell");
    process.exit(1);
  }

  // 用户过滤条件（日期范围 + code/name/op/account）
  const clauses = ["t.entry_date >= ?", "t.entry_date <= ?"];
  const params = [fmtDate(start), fmtDate(end)];
  if (opts.code) { clauses.push("t.code = ?"); params.push(opts.code); }
  if (opts.name) { clauses.push("t.name LIKE ?"); params.push(`%${opts.name}%`); }
  if (opts.op) { clauses.push("t.op = ?"); params.push(opts.op === "buy" ? OP.BUY : OP.SELL); }
  if (opts.account) { clauses.push("t.account_name LIKE ?"); params.push(`%${opts.account}%`); }
  const filters = `AND ${clauses.join(" AND ")}`;

  const fields = `
      t.account_name, t.code, t.name, t.op,
      t.entry_price, t.entry_count, t.entry_money,
      t.entry_date, t.entry_time`;

  const results = await withDb(async (db) => {
    const rows = await queryUnmatched(db, {
      filters, params, fields,
      cond: opts.all ? "TRUE" : MATCHABLE_COND,
    });
    // 默认视图下顺带统计被配对口径过滤掉的流水，避免用户误判"没有未匹配"
    const hidden = opts.all
      ? 0
      : Number((await db.all(`
          SELECT count(*) AS n
          FROM ${TABLE.TRADE_RECORD} t
          ${NOT_MATCHED_JOIN}
            AND NOT (${MATCHABLE_COND.replace(/\n\s*/g, " ")})
            ${filters}
        `, params))[0]?.n ?? 0);
    return { rows, hidden };
  });

  if (results.rows.length === 0) {
    console.log(opts.all
      ? "无未匹配的交易记录"
      : `无未匹配的可配对记录${results.hidden > 0 ? `（另有 ${results.hidden} 条逆回购/派息等非买卖流水，加 --all 查看）` : ""}`);
    return;
  }

  let buyCount = 0;
  let sellCount = 0;
  for (const row of results.rows) {
    if (row.op === OP.BUY) buyCount++;
    else if (row.op === OP.SELL) sellCount++;
  }

  const table = renderTable(
    ["账户", "股票代码", "股票名称", "方向", "价格", "数量", "金额", "日期"],
    results.rows.map((row) => [
      maskAccountName(row.account_name || ""),
      row.code || "",
      row.name || "",
      opLabel(row.op),
      Number(row.entry_price || 0).toFixed(2),
      row.entry_count ?? "",
      Number(row.entry_money || 0).toFixed(2),
      row.entry_date || "",
    ]),
  );

  console.log(`\n📋 未匹配交易记录（${start} ~ ${end}）：`);
  console.log(table);
  console.log(`共 ${results.rows.length} 条未匹配记录（买入 ${buyCount} 条，卖出 ${sellCount} 条）`
    + (buyCount + sellCount < results.rows.length ? `，非买卖流水 ${results.rows.length - buyCount - sellCount} 条` : ""));
  if (!opts.all && results.hidden > 0) {
    console.log(`另有 ${results.hidden} 条不参与配对的流水（逆回购/派息/缴税/转入转出等），加 --all 查看`);
  }
}

try {
  await main();
} catch (e) {
  console.error("查询未匹配记录失败:", e.message);
  process.exit(1);
}
