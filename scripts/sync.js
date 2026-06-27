#!/usr/bin/env node

/**
 * 独立同步脚本 - 不依赖 opencli
 * 用法: node sync.js [startDate] [endDate]
 * 日期格式: YYYYMMDD，默认当月
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 导入核心模块
import { syncTrade } from "./business.js";
import { getDefaultDateRange, resolveDateRange } from "./utils.js";

// 解析命令行参数
const args = process.argv.slice(2);
const kwargs = {
  start: args[0] || undefined,
  end: args[1] || undefined,
};

try {
  const { startDate, endDate } = resolveDateRange(kwargs);
  console.log(`同步范围：${startDate} ~ ${endDate}`);
  await syncTrade(startDate, endDate);
  console.log("同步完成");
} catch (e) {
  console.error("同步数据失败:", e.message);
  process.exit(1);
}
