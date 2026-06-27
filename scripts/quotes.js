#!/usr/bin/env node

/**
 * 独立行情查询脚本 - 不依赖 opencli
 * 用法: node quotes.js [accountName]
 * accountName: 账户名称关键词（可选）
 */

import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 导入核心模块
import { getQuotes } from "./quotes-api.js";

// 解析命令行参数
const args = process.argv.slice(2);
const accountFilter = args[0] || undefined;

try {
  console.log("正在获取持仓行情...");
  const results = await getQuotes(accountFilter);

  if (results && results.length > 0) {
    console.log("\n📈 持仓行情：");
    console.log("─".repeat(80));
    console.log(
      "账户名称".padEnd(12) +
      "代码".padEnd(10) +
      "名称".padEnd(12) +
      "当日盈亏".padEnd(12) +
      "当日盈亏率".padEnd(12) +
      "持有金额"
    );
    console.log("─".repeat(80));

    for (const row of results) {
      const accountName = row["账户名称"] || "";
      const code = row["代码"] || "";
      const name = row["名称"] || "";
      const dailyProfit = row["当日盈亏"] || "0.00";
      const dailyProfitRate = row["当日盈亏率"] || "0.00%";
      const holdingValue = row["持有金额"] || "0.00";

      console.log(
        accountName.padEnd(12) +
        code.padEnd(10) +
        name.padEnd(12) +
        dailyProfit.padEnd(12) +
        dailyProfitRate.padEnd(12) +
        holdingValue
      );
    }
    console.log("─".repeat(80));
  } else {
    console.log("暂无持仓数据");
  }
} catch (e) {
  console.error("获取行情失败:", e.message);
  if (e.code === "NETWORK_ERROR") {
    console.error("提示: 请检查网络连接");
  } else if (e.code === "API_ERROR" || e.code === "COOKIE_EXPIRED") {
    console.error("提示: Cookie 可能已过期，请重新配置");
  }
  process.exit(1);
}
