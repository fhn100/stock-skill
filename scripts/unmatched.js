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
 */

import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { withDb } from "./db.js";
import { TABLE, OP } from "./constants.js";
import { maskAccountName } from "./utils.js";

// ============================ 参数解析 ============================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { code: null, name: null, op: null, start: null, end: null, account: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--code":
        opts.code = args[++i];
        break;
      case "--name":
        opts.name = args[++i];
        break;
      case "--op":
        opts.op = args[++i]?.toLowerCase();
        break;
      case "--start":
        opts.start = args[++i];
        break;
      case "--end":
        opts.end = args[++i];
        break;
      case "--account":
        opts.account = args[++i];
        break;
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
  -h, --help           显示帮助

示例:
  node unmatched.js                          # 当月所有未匹配记录
  node unmatched.js --code 601012            # 隆基绿能未匹配记录
  node unmatched.js --name 隆基 --op sell    # 隆基绿能卖出未匹配记录
  node unmatched.js --start 20260101 --end 20260630  # 指定时间范围`);
}

// ============================ 日期工具 ============================

/** YYYYMMDD → YYYY-MM-DD */
function fmtDate(d) {
  if (!d) return null;
  if (d.includes("-")) return d;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function getDefaultDateRange() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(yyyy, now.getMonth() + 1, 0).getDate();
  const dd = String(lastDay).padStart(2, "0");
  return {
    start: `${yyyy}${mm}01`,
    end: `${yyyy}${mm}${dd}`,
  };
}

// ============================ 主逻辑 ============================

async function main() {
  const opts = parseArgs();
  const defaults = getDefaultDateRange();
  const start = opts.start || defaults.start;
  const end = opts.end || defaults.end;

  // 校验 op 参数
  if (opts.op && !["buy", "sell"].includes(opts.op)) {
    console.error("错误: --op 参数必须是 buy 或 sell");
    process.exit(1);
  }

  // 构建查询：交易记录中未出现在匹配表中的记录
  let sql = `
    SELECT
      t.account_name,
      t.code,
      t.name,
      CASE WHEN t.op = '${OP.BUY}' THEN '买入' ELSE '卖出' END AS op_label,
      t.entry_price,
      t.entry_count,
      t.entry_money,
      t.transfer_fee,
      t.entry_date,
      t.entry_time,
      t.entry_date_time,
      t.history_id
    FROM ${TABLE.TRADE_RECORD} t
    LEFT JOIN ${TABLE.TRADE_MATCHED} m1 ON t.history_id = m1.sell_history_id
    LEFT JOIN ${TABLE.TRADE_MATCHED} m2 ON t.history_id = m2.buy_history_id
    WHERE m1.sell_history_id IS NULL
      AND m2.buy_history_id IS NULL
      AND t.entry_date >= ?
      AND t.entry_date <= ?
  `;

  const params = [fmtDate(start), fmtDate(end)];

  // 过滤：股票代码
  if (opts.code) {
    sql += ` AND t.code = ?`;
    params.push(opts.code);
  }

  // 过滤：股票名称（模糊）
  if (opts.name) {
    sql += ` AND t.name LIKE ?`;
    params.push(`%${opts.name}%`);
  }

  // 过滤：买入/卖出
  if (opts.op) {
    sql += ` AND t.op = ?`;
    params.push(opts.op === "buy" ? OP.BUY : OP.SELL);
  }

  // 过滤：账户名（模糊）
  if (opts.account) {
    sql += ` AND t.account_name LIKE ?`;
    params.push(`%${opts.account}%`);
  }

  // 排除国债逆回购
  sql += ` AND t.code != '204001'`;

  sql += ` ORDER BY t.entry_date DESC, t.entry_time DESC`;

  const results = await withDb(async (db) => {
    return await db.all(sql, params);
  });

  // 输出
  if (!results || results.length === 0) {
    console.log("无未匹配的交易记录");
    return;
  }

  console.log(`\n📋 未匹配交易记录（${start} ~ ${end}）：`);
  console.log("─".repeat(90));
  console.log(
    "账户".padEnd(12) +
    "股票代码".padEnd(10) +
    "股票名称".padEnd(12) +
    "方向".padEnd(6) +
    "价格".padEnd(10) +
    "数量".padEnd(8) +
    "金额".padEnd(12) +
    "日期"
  );
  console.log("─".repeat(90));

  let buyCount = 0;
  let sellCount = 0;

  for (const row of results) {
    const account = maskAccountName(row.account_name || "");
    const code = row.code || "";
    const name = (row.name || "").padEnd(12);
    const opLabel = row.op_label || "";
    const price = Number(row.entry_price || 0).toFixed(2);
    const count = row.entry_count || "";
    const money = Number(row.entry_money || 0).toFixed(2);
    const date = row.entry_date || "";

    if (row.op_label === "买入") buyCount++;
    else sellCount++;

    console.log(
      account.padEnd(12) +
      code.padEnd(10) +
      name +
      opLabel.padEnd(6) +
      price.padEnd(10) +
      String(count).padEnd(8) +
      money.padEnd(12) +
      date
    );
  }

  console.log("─".repeat(90));
  console.log(`共 ${results.length} 条未匹配记录（买入 ${buyCount} 条，卖出 ${sellCount} 条）`);
}

try {
  await main();
} catch (e) {
  console.error("查询未匹配记录失败:", e.message);
  process.exit(1);
}
