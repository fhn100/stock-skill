import fs from "fs";
import { join } from "path";
import { COOKIE_REQUIRED_FIELDS, COOKIE_EXPIRY_SECONDS } from "./constants.js";

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

/**
 * 获取配置文件路径（自动创建空文件）
 * @returns {string} 配置文件路径
 */
export function getConfigPath() {
  const path = join(getDataDir(), "config");
  if (!fs.existsSync(path)) fs.writeFileSync(path, "", "utf8");
  return path;
}

/**
 * 写入配置文件
 * @param {string} config - 配置内容
 */
export function writeConfig(config) {
  const path = getConfigPath();
  fs.writeFileSync(path, config, 'utf8');
}

/**
 * 读取 Cookie（未配置时抛异常）
 * @returns {string} Cookie 字符串
 * @throws {Error} 配置文件为空时抛出
 */
export function getCookie() {
  const path = getConfigPath();
  const cookie = fs.readFileSync(path, "utf8").trim();
  if (!cookie) throw new Error(`请先在配置文件中配置cookie, 路径: ${path}`);
  return cookie;
}

/**
 * 从 Cookie 提取用户 ID
 * @returns {string} 用户 ID
 * @throws {Error} Cookie 格式不正确时抛出
 */
export function getUserId() {
  const cookie = getCookie();
  const match = cookie.match(/(?:^|;)\s*userid=(\d+)/);
  if (!match?.[1]) throw new Error("配置文件中的cookie格式不正确，无法提取userid");
  return match[1].trim();
}

/**
 * 检查 Cookie 是否可能过期（前置检查）
 * 通过检查 Cookie 中是否包含必要字段来判断有效性
 * @throws {AppError} Cookie 过期或无效时抛出
 */
export function checkCookieValid() {
  const cookie = getCookie();

  const requiredFields = COOKIE_REQUIRED_FIELDS;
  for (const field of requiredFields) {
    if (!cookie.includes(`${field}=`)) {
      throw new AppError(
        `Cookie 可能已过期，缺少字段 "${field}"。请运行 opencli stock init 重新获取`,
        "COOKIE_EXPIRED",
      );
    }
  }

  const vMatch = cookie.match(/v=([^;]+)/);
  if (vMatch?.[1]) {
    const timestamp = parseInt(vMatch[1], 10);
    if (timestamp > 0 && Date.now() / 1000 > timestamp + COOKIE_EXPIRY_SECONDS) {
      throw new AppError(
        "Cookie 已过期（超过24小时）。请运行 opencli stock init 重新获取",
        "COOKIE_EXPIRED",
      );
    }
  }
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

/**
 * 获取今日日期字符串
 * @returns {string} 今日日期，格式 YYYYMMDD
 */
export function getTodayDate() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
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

// ============================ 参数解析 ============================

/**
 * 从 CLI kwargs 解析日期范围
 * 支持 start/end 参数，缺省时使用当月范围
 * @param {object} kwargs - CLI 参数
 * @param {string} [kwargs.start] - 开始日期 YYYYMMDD
 * @param {string} [kwargs.end] - 结束日期 YYYYMMDD
 * @returns {{ startDate: string, endDate: string }} 日期范围
 */
export function resolveDateRange(kwargs) {
  if (kwargs?.start) {
    const start = kwargs.start;
    const end = kwargs?.end || lastDayOfMonth(start);
    return { startDate: start, endDate: end };
  }
  return getDefaultDateRange();
}

/** 计算某月最后一天，格式 YYYYMMDD */
function lastDayOfMonth(yyyymmdd) {
  const yyyy = parseInt(yyyymmdd.substring(0, 4), 10);
  const mm = parseInt(yyyymmdd.substring(4, 6), 10) - 1;
  const lastDay = new Date(yyyy, mm + 1, 0).getDate();
  return `${yyyy}${String(mm + 1).padStart(2, "0")}${String(lastDay).padStart(2, "0")}`;
}

// ============================ 错误处理 ============================

/**
 * 自定义应用错误类
 */
export class AppError extends Error {
  /**
   * @param {string} message - 错误信息
   * @param {string} code - 错误代码
   * @param {number} [httpStatus] - HTTP 状态码（可选）
   */
  constructor(message, code, httpStatus) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * 重试执行函数
 * @param {Function} fn - 要执行的异步函数
 * @param {number} maxAttempts - 最大尝试次数
 * @param {number} delayMs - 重试间隔（毫秒）
 * @returns {Promise<*>} 函数执行结果
 */
export async function retry(fn, maxAttempts = 3, delayMs = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
}
