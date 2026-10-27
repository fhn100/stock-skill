#!/usr/bin/env node

/**
 * 独立收益查询脚本 - 不依赖 opencli
 * 用法: node profit.js [startMonth] [endMonth] [--db <path>] [--strategy lifo|fifo|psf]
 * 月份格式: YYYY-MM，默认当月；--db 为 STOCK_DB_OVERRIDE 的命令行糖（隔离测试用）
 * --strategy 匹配策略：lifo=后入先出（默认），fifo=先入先出，psf=价差最小优先
 */

import { tradeMatch, gridProfit } from "./business.js";
import { getCurrentMonth, monthRange, lastDayOfMonth, renderTable, renderMatchStats } from "./utils.js";
import { withDb, extractDbFlag } from "./db.js";
import { TABLE, MARKET } from "./constants.js";

// 解析命令行参数（先剥离 --db，其余为位置参数）
const rawArgs = process.argv.slice(2);
const args = extractDbFlag(rawArgs);

// 解析 --strategy 参数
let strategy = 'lifo';
const strategyIdx = args.indexOf('--strategy');
if (strategyIdx !== -1 && args[strategyIdx + 1]) {
  strategy = args[strategyIdx + 1];
  if (!['lifo', 'fifo', 'psf'].includes(strategy)) {
    console.error(`错误: --strategy 必须是 lifo/fifo/psf，当前: ${strategy}`);
    process.exit(1);
  }
  // 从位置参数中移除 --strategy 及其值
  args.splice(strategyIdx, 2);
}

const start = args[0] || getCurrentMonth();
const end = args[1] || start;

/**
 * 美股账户判定（market_code='US'）：过户费天然为 0，不属于「0 过户费脏数据」，
 * 必须排除在清理与提示范围外，否则每次跑 profit 都会误删嘉信配对记录并重配。
 */
const NOT_US_ACCOUNT = `account_id IS NULL OR account_id NOT IN (SELECT account_id FROM ${TABLE.TRADE_RECORD} WHERE market_code = '${MARKET.US}')`;

/**
 * 清理脏数据（过户费=0 的旧快照）：
 * - 匹配记录：清理【查询月份范围】内的记录 → tradeMatch 会用交易表的最新费用重新配对（安全）
 * - 交易记录：本脚本不再同步数据，删除后无法重拉，只统计并提示用 `opencli stock sync` 修复
 * - 美股账户（sync-schwab 同步）过户费恒为 0，已排除，不做清理也不计入口径提示
 * @param {string} start - 查询起始月 YYYY-MM
 * @param {string} end - 查询结束月 YYYY-MM
 */
async function cleanDirtyFees(start, end) {
  const months = monthRange(start, end);
  if (months.length === 0) return;
  const placeholders = months.map(() => "?").join(",");
  const range = `${months[0]}~${months[months.length - 1]}`;

  await withDb(async (db) => {
    // 1) 匹配记录：清理后由 tradeMatch 用交易表最新费用重新配对
    const matchedWhere = `${NOT_US_ACCOUNT}
       AND (sell_transfer_fee = 0 OR buy_transfer_fee = 0)
       AND strftime(sell_time, '%Y-%m') IN (${placeholders})`;
    const matchedCount = Number((await db.all(
      `SELECT count(*) AS n FROM ${TABLE.TRADE_MATCHED} WHERE ${matchedWhere}`, months,
    ))[0]?.n ?? 0);
    if (matchedCount > 0) {
      await db.run(`DELETE FROM ${TABLE.TRADE_MATCHED} WHERE ${matchedWhere}`, months);
      console.log(`已清理查询范围匹配记录（过户费=0）[${range}]: ${matchedCount} 条`);
    }

    // 2) 交易记录：只提示不删（需 opencli stock sync 重拉才能修复费用）
    const tradeCount = Number((await db.all(
      `SELECT count(*) AS n FROM ${TABLE.TRADE_RECORD}
        WHERE transfer_fee = 0 AND market_code IS DISTINCT FROM '${MARKET.US}'
        AND substr(entry_date, 1, 7) IN (${placeholders})`, months,
    ))[0]?.n ?? 0);
    if (tradeCount > 0) {
      const lastMonth = months[months.length - 1];
      console.log(`⚠️  查询范围内 ${tradeCount} 条交易记录过户费=0（未自动清理）；如需修复费用，执行: `
        + `opencli stock sync ${months[0].replace("-", "")}01 `
        + `${lastMonth.replace("-", "")}${lastDayOfMonth(lastMonth)} 后重跑本脚本`);
    }
  });
}

function printProfit(results) {
  if (!results || results.length === 0) {
    console.log("暂无收益数据");
    return;
  }
  const rows = results.map((row) => [
    row["账户"] || "",
    row["币种"] || "",
    row["股票代码"] || "",
    row["股票名称"] || "",
    row["时间"] || "",
    row["交易次数"] ?? "",
    Number(row["总收益"] || 0).toFixed(2),
  ]);
  console.log("\n📊 收益统计结果：");
  console.log(renderTable(
    ["账户", "币种", "股票代码", "股票名称", "时间", "交易次数", "总收益"],
    rows,
  ));
}

try {
  // 清理脏数据的 DELETE 与随后重配必须在同一事务，避免"删了配对但未重算"的不一致
  await withDb(async (db) => db.run("BEGIN TRANSACTION"));
  let matchStats;
  try {
    await cleanDirtyFees(start, end);
    // 匹配交易记录（对全库未匹配记录重算）
    matchStats = await tradeMatch({ strategy });
    await withDb(async (db) => db.run("COMMIT"));
  } catch (e) {
    await withDb(async (db) => db.run("ROLLBACK")).catch(() => {});
    throw e;
  }

  console.log(`查询范围：${start} ~ ${end}`);
  console.log(renderMatchStats(matchStats));
  printProfit(await gridProfit(start, end, strategy));
} catch (e) {
  console.error("查询网格收益失败:", e.message);
  process.exit(1);
}
