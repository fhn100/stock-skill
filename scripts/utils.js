import fs from "fs";
import { join } from "path";

// ============================ 路径 & 配置 ============================

/**
 * 获取数据目录（自动创建）
 * @returns {string} 数据目录路径
 */
export function getDataDir() {
  // 数据目录移至 ~/.duckdb/stock/
  const dir = join(process.env.HOME, ".duckdb", "stock");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ============================ 日期工具 ============================

/**
 * 获取当前月份字符串 YYYY-MM
 * @returns {string} 当前月份，格式 YYYY-MM
 */
export function getCurrentMonth() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

/**
 * 获取当月日期范围（默认同步范围）
 * @returns {{ startDate: string, endDate: string }} 开始和结束日期，格式 YYYYMMDD
 */
export function getDefaultDateRange() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(yyyy, now.getMonth() + 1, 0).getDate();
  const dd = String(lastDay).padStart(2, "0");
  return { startDate: `${yyyy}${mm}01`, endDate: `${yyyy}${mm}${dd}` };
}

// ============================ 脱敏工具 ============================

/**
 * 账户名称脱敏（保留姓，名替换为 *）
 * @param {string} accountName - 原始账户名称，如 "国泰-冯海年"
 * @returns {string} 脱敏后的账户名称，如 "国泰-冯*"
 */
export function maskAccountName(accountName) {
  if (!accountName || !accountName.includes("-")) {
    return accountName || "未知账户";
  }
  const idx = accountName.indexOf("-");
  const prefix = accountName.substring(0, idx + 1);
  const namePart = accountName.substring(idx + 1);
  if (namePart.length > 1) {
    return prefix + namePart.charAt(0) + "*".repeat(namePart.length - 1);
  }
  return accountName;
}

// ============================ 日期格式化 ============================

/**
 * 日期格式化：YYYYMMDD 或 YYYY-MM-DD → YYYY-MM-DD
 * @param {string} [d] - 日期字符串
 * @returns {string|null} YYYY-MM-DD 格式，空入参返回 null
 */
export function fmtDate(d) {
  if (!d) return null;
  if (d.includes("-")) return d;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
