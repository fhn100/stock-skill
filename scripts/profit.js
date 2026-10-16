#!/usr/bin/env node

/**
 * 独立收益查询脚本 - 不依赖 opencli
 * 用法: node profit.js [startMonth] [endMonth]
 * 月份格式: YYYY-MM，默认当月
 */

import { syncTrade, tradeMatch, gridProfit } from "./business.js";
import { getCurrentMonth, getDefaultDateRange } from "./utils.js";
import { withDb } from "./db.js";
import { TABLE } from "./constants.js";

// 解析命令行参数
const args = process.argv.slice(2);
const start = args[0] || getCurrentMonth();
const end = args[1] || start;

/**
 * 清理脏数据（过户费=0 的旧快照）：
 * - 匹配记录：清理【查询月份范围】内的记录 → tradeMatch 会用交易表的最新费用重新配对（安全）
 * - 交易记录：仅清理【同步窗口（当月）】内的记录 → syncTrade 立即重拉补回；
 *   查询范围内其他月份不删（无法重拉，避免丢失数据），仅提示
 * @param {string} start - 查询起始月 YYYY-MM
 * @param {string} end - 查询结束月 YYYY-MM
 * @param {string} syncStartDate - 同步窗口起始日 YYYYMMDD
 */
async function cleanDirtyFees(start, end, syncStartDate) {
  const ym = `${syncStartDate.substring(0, 4)}-${syncStartDate.substring(4, 6)}`;
  const months = [];
  {
    let [y, m] = start.split("-").map(Number);
    const [ey, em] = end.split("-").map(Number);
    for (let i = 0; i < 1200 && (y < ey || (y === ey && m <= em)); i++) {
      months.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
  const monthList = months.map((x) => `'${x}'`).join(",");
  await withDb(async (db) => {
    const delZeroFee = async (table, where, label) => {
      const rows = await db.all(`SELECT count(*) AS n FROM ${table} WHERE ${where}`);
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) {
        await db.run(`DELETE FROM ${table} WHERE ${where}`);
        console.log(`已清理${label}（过户费=0）: ${n} 条`);
      }
    };
    // 1) 匹配记录：查询月份范围（重配后自动带上交易表最新费用）
    await delZeroFee(
      TABLE.TRADE_MATCHED,
      `(sell_transfer_fee = 0 OR buy_transfer_fee = 0) AND strftime(sell_time, '%Y-%m') IN (${monthList})`,
      `查询范围匹配记录 [${months[0]}~${months[months.length - 1]}]`,
    );
    // 2) 交易记录：仅同步窗口（当月，syncTrade 重拉补回）
    await delZeroFee(
      TABLE.TRADE_RECORD,
      `transfer_fee = 0 AND substr(entry_date, 1, 7) = '${ym}'`,
      "当月交易记录",
    );
    // 3) 查询范围内其他月份的 0 过户费交易记录：只提示不删
    const others = months.filter((x) => x !== ym);
    if (others.length > 0) {
      const rows = await db.all(
        `SELECT count(*) AS n FROM ${TABLE.TRADE_RECORD} WHERE transfer_fee = 0 AND substr(entry_date, 1, 7) IN (${others.map((x) => `'${x}'`).join(",")})`,
      );
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) {
        const lastMonth = others[others.length - 1];
        const lastDay = new Date(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5, 7)), 0).getDate();
        console.log(`⚠️  查询范围内另有 ${n} 条历史月份交易记录过户费=0（未自动清理）；如需修复费用，执行: node sync.js ${others[0].replace("-", "")}01 ${lastMonth.replace("-", "")}${lastDay} 后再重查`);
      }
    }
  });
}

try {
  // 同步当月交易记录
  const { startDate, endDate } = getDefaultDateRange();
  console.log(`同步范围：${startDate} ~ ${endDate}`);

  await cleanDirtyFees(start, end, startDate);

  await syncTrade(startDate, endDate);

  // 匹配交易记录（先买后卖，仅盈利）
  await tradeMatch();

  // 查询收益
  console.log(`查询范围：${start} ~ ${end}`);
  const results = await gridProfit(start, end);

  // 格式化输出
  if (results && results.length > 0) {
    console.log("\n📊 收益统计结果：");
    console.log("─".repeat(70));
    console.log(
      "账户".padEnd(12) +
      "股票代码".padEnd(10) +
      "股票名称".padEnd(12) +
      "时间".padEnd(10) +
      "交易次数".padEnd(8) +
      "总收益"
    );
    console.log("─".repeat(70));

    let prevAccount = "";

    for (const row of results) {
      const account = row["账户"] || "";
      const time = row["时间"] || "";
      const code = row["股票代码"] || "";
      const name = row["股票名称"] || "";
      const count = row["交易次数"] || "";
      const profit = row["总收益"] || 0;

      console.log(
        account.padEnd(12) +
        code.padEnd(10) +
        name.padEnd(12) +
        time.padEnd(10) +
        String(count).padEnd(8) +
        profit.toFixed(2)
      );
    }
    console.log("─".repeat(70));
  } else {
    console.log("暂无收益数据");
  }
} catch (e) {
  console.error("查询网格收益失败:", e.message);
  process.exit(1);
}