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

// ============================ 数值 / 补零 ============================

/** 两位零填充：5 → "05" */
export const pad2 = (n) => String(n).padStart(2, "0");

/** 保留 4 位小数（金额用），避免浮点尾差 */
export const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;

// ============================ 日期工具 ============================

/**
 * 获取当前月份字符串 YYYY-MM
 * @returns {string} 当前月份，格式 YYYY-MM
 */
export function getCurrentMonth() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = pad2(now.getMonth() + 1);
  return `${yyyy}-${mm}`;
}

/**
 * 获取当月日期范围（默认同步范围）
 * @returns {{ startDate: string, endDate: string }} 开始和结束日期，格式 YYYYMMDD
 */
export function getDefaultDateRange() {
  const now = new Date();
  const ym = `${now.getFullYear()}${pad2(now.getMonth() + 1)}`;
  return { startDate: `${ym}01`, endDate: `${ym}${lastDayOfMonth(ym)}` };
}

/**
 * 某月最后一天
 * @param {string} ym - YYYY-MM 或 YYYYMM
 * @returns {string} 补零的日，如 "31"
 */
export function lastDayOfMonth(ym) {
  const s = String(ym).replace("-", "");
  const mm = Number(s.slice(4, 6));
  if (mm < 1 || mm > 12) throw new Error(`月份非法: ${ym}`);
  return pad2(new Date(Number(s.slice(0, 4)), mm, 0).getDate());
}

/**
 * 起止月份展开为月份数组（含端点）
 * @param {string} start - YYYY-MM
 * @param {string} end - YYYY-MM
 * @returns {string[]} YYYY-MM 列表；start 晚于 end 时为空数组
 */
export function monthRange(start, end) {
  const months = [];
  let [y, m] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  for (let i = 0; i < 1200 && (y < ey || (y === ey && m <= em)); i++) {
    months.push(`${y}-${pad2(m)}`);
    if (++m > 12) { m = 1; y += 1; }
  }
  return months;
}

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

// ============================ 文本表格 ============================

/** CJK / 全角字符占 2 列显示宽度 */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/**
 * 字符串终端显示宽度（按显示列数，非字符数）
 * @param {string} s
 * @returns {number}
 */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += WIDE_CHAR.test(ch) ? 2 : 1;
  return w;
}

/**
 * 渲染纯文本表格：列宽按内容最大显示宽度对齐，末列不补尾随空格
 * @param {string[]} headers - 表头
 * @param {Array<string[]>} rows - 数据行（单元格均为字符串）
 * @returns {string} 含上下分隔线的表格
 */
export function renderTable(headers, rows) {
  const cell = (v) => (v === null || v === undefined ? "" : String(v));
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(cell(r[i])))),
  );
  const rule = "─".repeat(widths.reduce((sum, w) => sum + w + 2, -2));
  const line = (cells) =>
    cells
      .map((c, i) => {
        const text = cell(c);
        const pad = i === cells.length - 1 ? 0 : widths[i] - displayWidth(text);
        return text + " ".repeat(Math.max(0, pad));
      })
      .join("  ");

  return [rule, line(headers), rule, ...rows.map(line), rule].join("\n");
}

// ============================ 匹配结果渲染 ============================

/**
 * 将 tradeMatch 返回的统计对象渲染为纯文本行（业务层不打印，展示集中在此）
 * @param {{matched:number, unmatchedBuy:number, unmatchedSell:number,
 *   summary:{sellNoBuy:number, sellNoProfit:number, buyNoSell:number, buyNoProfit:number}}} s
 * @returns {string}
 */
export function renderMatchStats(s) {
  const m = s.summary || {};
  const lines = [
    `匹配完成：新增 ${s.matched} 对`,
    `未匹配买入：${s.unmatchedBuy}，未匹配卖出：${s.unmatchedSell}`,
  ];
  if (m.sellNoBuy > 0) lines.push(`  卖出无同数量买入可配：${m.sellNoBuy}（可能需数量拆分）`);
  if (m.sellNoProfit > 0) lines.push(`  卖出无盈利买入可配：${m.sellNoProfit}`);
  if (m.buyNoSell > 0) lines.push(`  买入无同数量卖出可配：${m.buyNoSell}`);
  if (m.buyNoProfit > 0) lines.push(`  买入无盈利卖出可配：${m.buyNoProfit}`);
  return lines.join("\n");
}
