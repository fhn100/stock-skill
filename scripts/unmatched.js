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
 *   --strategy <算法>    未匹配判定口径：lifo|fifo|psf|all（默认 lifo，与 profit.js 一致；all=任一算法配过即视为已匹配）
 *   --all                包含不参与配对的流水（逆回购/派息/缴税/转入转出等）
 *   --db <path>          覆盖数据库路径（= STOCK_DB_OVERRIDE，仅测试用）
 *
 * 注意：--all（流水口径）与 --strategy all（算法口径）是两回事，互不影响。
 */

import { withDb, extractDbFlag } from "./db.js";
import { TABLE, OP, opLabel } from "./constants.js";
import { notMatchedJoin, MATCHABLE_COND } from "./sql-match.js";
import { maskAccountName, fmtDate, getDefaultDateRange, renderTable } from "./utils.js";

// ============================ 参数解析 ============================

function parseArgs() {
  const args = extractDbFlag(process.argv.slice(2));
  const opts = { code: null, name: null, op: null, start: null, end: null, account: null, all: false, strategy: "lifo" };

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
      case "--strategy": opts.strategy = take("--strategy").toLowerCase(); break;
      case "--all": opts.all = true; break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
    }
  }
  return opts;
}

/** 与 match.js / profit.js 保持一致的策略集合（all = 不限定 match_type，即三算法并集口径） */
const STRATEGIES = ["lifo", "fifo", "psf", "all"];
const STRATEGY_LABEL = {
  lifo: "LIFO 后入先出（与 profit.js 默认口径一致）",
  fifo: "FIFO 先入先出",
  psf: "PSF 价差最小优先",
  all: "三种算法并集（被任一算法配对即视为已匹配）",
};

function printUsage() {
  console.log(`用法: node unmatched.js [options]

选项:
  --code <股票代码>    按股票代码过滤
  --name <股票名称>    按股票名称过滤（模糊匹配）
  --op <buy|sell>      按买入(buy)/卖出(sell)过滤
  --start <YYYYMMDD|YYYY-MM-DD>   开始日期（默认当月1号）
  --end <YYYYMMDD|YYYY-MM-DD>     结束日期（默认当天）
  --account <账户名>   按账户名称过滤（模糊匹配）
  --strategy <算法>    未匹配判定口径，取值 lifo|fifo|psf|all，默认 lifo
                       指定算法时「未匹配」= 未被该算法配对；all = 未被任何算法配对
  --all                包含不参与配对的流水（逆回购/派息/缴税/转入转出等）
  --db <path>          覆盖数据库路径（等价于 STOCK_DB_OVERRIDE，仅测试用）
  -h, --help           显示帮助

默认只列出可配对记录（op=1/2 且数量>0，即现货买卖），并按 LIFO 判定未匹配，
与 profit.js 的收益口径一致；要看三种算法的并集用 --strategy all。

示例:
  node unmatched.js                          # 当月 LIFO 口径的未匹配记录
  node unmatched.js --code 601012            # 隆基绿能未匹配记录
  node unmatched.js --name 隆基 --op sell    # 隆基绿能卖出未匹配记录
  node unmatched.js --strategy fifo          # 改用 FIFO 口径查看
  node unmatched.js --strategy all           # 三种算法都配不上的「真」未匹配
  node unmatched.js --all                    # 含逆回购/派息等全部未配对流水
  node unmatched.js --start 20260101 --end 20260630  # 指定时间范围`);
}

// ============================ 主逻辑 ============================

/** 交易记录中未被指定算法（matchType 为空 = 任一算法）匹配的记录 */
async function queryUnmatched(db, { filters, params, cond, fields, matchType }) {
  return await db.all(`
    SELECT ${fields}
    FROM ${TABLE.TRADE_RECORD} t
    ${notMatchedJoin(matchType)}
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
  if (!STRATEGIES.includes(opts.strategy)) {
    console.error(`错误: --strategy 参数必须是 ${STRATEGIES.join(" / ")}`);
    process.exit(1);
  }

  // matchType=undefined 时 notMatchedJoin 不限定算法，即三算法并集口径
  const matchType = opts.strategy === "all" ? undefined : opts.strategy;

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

  const cond = opts.all ? "TRUE" : MATCHABLE_COND;

  /** 指定算法口径下的未匹配记录数（口径对照用，避免把单算法未匹配误读为全部未匹配） */
  const countUnmatched = (db, type) => db.all(`
      SELECT count(*) AS n
      FROM ${TABLE.TRADE_RECORD} t
      ${notMatchedJoin(type)}
        AND ${cond.replace(/\n\s*/g, " ")}
        ${filters}
    `, params).then((r) => Number(r[0]?.n ?? 0));

  const results = await withDb(async (db) => {
    const rows = await queryUnmatched(db, { filters, params, fields, cond, matchType });
    // 默认视图下顺带统计被配对口径过滤掉的流水，避免用户误判"没有未匹配"
    const hidden = opts.all
      ? 0
      : Number((await db.all(`
          SELECT count(*) AS n
          FROM ${TABLE.TRADE_RECORD} t
          ${notMatchedJoin(matchType)}
            AND NOT (${MATCHABLE_COND.replace(/\n\s*/g, " ")})
            ${filters}
        `, params))[0]?.n ?? 0);
    // 非并集口径时补算并集未匹配数，作为「换口径能少多少」的对照
    const union = matchType ? await countUnmatched(db, undefined) : null;
    return { rows, hidden, union };
  });

  const scopeNote = `口径：${STRATEGY_LABEL[opts.strategy]}`;

  if (results.rows.length === 0) {
    console.log(`无未匹配的${opts.all ? "交易记录" : "可配对记录"}（${scopeNote}）`
      + (results.hidden > 0 ? `；另有 ${results.hidden} 条逆回购/派息等非买卖流水，加 --all 查看` : ""));
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

  console.log(`\n📋 未匹配交易记录（${start} ~ ${end}，${scopeNote}）：`);
  console.log(table);
  console.log(`共 ${results.rows.length} 条未匹配记录（买入 ${buyCount} 条，卖出 ${sellCount} 条）`
    + (buyCount + sellCount < results.rows.length ? `，非买卖流水 ${results.rows.length - buyCount - sellCount} 条` : ""));
  if (results.union !== null) {
    console.log(`对比：同筛选条件下三种算法都配不上的记录 ${results.union} 条（本口径为单算法未配对，profit.js 默认按 LIFO 计收益）`);
  }
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
