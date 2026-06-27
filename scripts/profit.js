#!/usr/bin/env node

/**
 * 独立收益查询脚本 - 不依赖 opencli
 * 用法: node profit.js [startMonth] [endMonth]
 * 月份格式: YYYY-MM，默认当月
 */

import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 导入核心模块
import { syncTrade, tradeMatch, gridProfit } from "./business.js";
import { getCurrentMonth, getDefaultDateRange } from "./utils.js";

// 解析命令行参数
const args = process.argv.slice(2);
const start = args[0] || getCurrentMonth();
const end = args[1] || start;

try {
  // 同步当月交易记录
  const { startDate, endDate } = getDefaultDateRange();
  console.log(`同步范围：${startDate} ~ ${endDate}`);
  await syncTrade(startDate, endDate);

  // 匹配交易记录
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
      "时间".padEnd(10) +
      "股票代码".padEnd(10) +
      "股票名称".padEnd(12) +
      "交易次数".padEnd(8) +
      "总收益"
    );
    console.log("─".repeat(70));

    for (const row of results) {
      const account = row["账户"] || "";
      const time = row["时间"] || "";
      const code = row["股票代码"] || "";
      const name = row["股票名称"] || "";
      const count = row["交易次数"] || "";
      const profit = row["总收益"] || 0;

      console.log(
        account.padEnd(12) +
        time.padEnd(10) +
        code.padEnd(10) +
        name.padEnd(12) +
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
