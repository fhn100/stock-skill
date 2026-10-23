#!/usr/bin/env node

/**
 * 嘉信(Schwab)美股交易记录 CSV 导入脚本（纯本地，不联网）
 *
 * 用法:
 *   node import-csv.js <file.csv> [--account 嘉信-冯] [--dry-run] [--db <path>] [--verbose]
 *
 * - 幂等：history_id 由「账户|日期时间|代码|方向|数量|价格」生成，
 *   同一 CSV 重跑按 INSERT OR REPLACE 覆盖，不产生重复记录。
 * - 只写入 t_trade_record；配对仍由 `node match.js` 完成，收益由 `node profit.js` 统计。
 * - 兼容嘉信网页导出的 Trades / Transactions CSV（英文表头），同时支持常见中文表头。
 */

import fs from "fs";
import { createHash } from "crypto";
import { withDb, extractDbFlag } from "./db.js";
import { TABLE, OP, opLabel, INSERT_BATCH_SIZE, MARKET } from "./constants.js";
import { TRADE_COLUMNS, ensureSchema } from "./schema.js";
import { pad2, round4 } from "./utils.js";

// ============================ 参数解析 ============================

function parseArgs(argv) {
  const opts = { file: null, account: "嘉信-冯", dryRun: false, verbose: false, split: true, replace: false };
  // --db 由 extractDbFlag 统一处理（写入 STOCK_DB_OVERRIDE），此处只解析其余选项
  argv = extractDbFlag(argv);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account" || a === "-a") opts.account = argv[++i];
    else if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--no-split") opts.split = false;
    else if (a === "--replace") opts.replace = true;
    else if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
    else if (!a.startsWith("-") && !opts.file) opts.file = a;
    else { console.error(`未知参数: ${a}`); console.log(USAGE); process.exit(1); }
  }
  return opts;
}

const USAGE = `用法: node import-csv.js <file.csv> [--account 嘉信-冯] [--no-split] [--replace] [--dry-run] [--db <path>] [--verbose]

  --account   账户名（默认 嘉信-冯），写入 account_name，account_id 由其派生保证稳定
  --no-split  关闭按 1 股拆分（默认开启：买入/卖出按成交数量拆成多条 1 股记录，便于配对）
  --replace   导入前先清除本账户的旧交易与配对记录（整表重导；切换拆分口径或重新导出时用，作用域仅限本 CSV 账户）
  --dry-run   只解析与预览，不写库
  --db        覆盖数据库路径（等价于 STOCK_DB_OVERRIDE 环境变量；默认 ~/.duckdb/stock/stock.db，仅测试用）
  --verbose   打印每行解析结果`;

// ============================ CSV 解析 ============================

/**
 * RFC4180 手写解析：处理引号、内嵌逗号/换行、BOM、CRLF
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

// ============================ 表头映射 ============================

/** 列名别名（小写、去空格后匹配）；覆盖嘉信 Trades/Transactions 导出 + 中文常见写法 */
const COLUMN_ALIASES = {
  date: ["transactionsdate", "tradedate", "date", "trade date", "executiondate", "日期", "成交日期", "交易日期"],
  time: ["tradetime", "time", "executiontime", "transactiontime", "时间", "成交时间"],
  type: ["tradetype", "action", "type", "transactiontype", "交易类型", "类型", "操作", "方向"],
  symbol: ["symbol", "ticker", "security", "代码", "证券代码", "股票代码"],
  name: ["description", "name", "securitydescription", "名称", "证券名称", "股票名称", "描述"],
  quantity: ["quantity", "qty", "shares", "数量", "成交数量", "股数"],
  price: ["price", "pricepershare", "executionprice", "averageprice", "价格", "成交价", "单价"],
  fees: ["fees&commisions", "fees&commissions", "commission", "fees", "commissions", "feescommissions", "佣金", "手续费", "费用"],
  amount: ["amount", "netcash", "netcashamount", "total", "netamount", "金额", "成交金额", "发生金额"],
};

/** 嘉信导出可能在真实表头前有几行元信息，探测表头行 */
export function findHeaderRow(rows) {
  const normalizedAliases = Object.values(COLUMN_ALIASES).flat();
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map((c) => c.trim().toLowerCase().replace(/\s+/g, ""));
    const score = cells.filter((c) => normalizedAliases.includes(c)).length;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best === -1 || bestScore < 2) {
    throw new Error("无法识别 CSV 表头（至少需匹配日期、代码等 2 个已知列），请用 --verbose 检查文件内容或补充 COLUMN_ALIASES");
  }
  return best;
}

/** @returns {Map<string, number>} 逻辑列名 → 列下标 */
export function buildColumnMap(headerCells) {
  const cells = headerCells.map((c) => c.trim().toLowerCase().replace(/\s+/g, ""));
  const map = new Map();
  for (const [logical, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = cells.indexOf(alias.replace(/\s+/g, ""));
      if (idx !== -1) { map.set(logical, idx); break; }
    }
  }
  const missing = [];
  for (const req of ["date", "symbol", "quantity", "price"]) {
    if (!map.has(req)) missing.push(req);
  }
  if (missing.length > 0) {
    throw new Error(`CSV 缺少必需列: ${missing.join(", ")}（表头: ${headerCells.join(" | ")}）`);
  }
  return map;
}

// ============================ 值解析 ============================

/** 嘉信导出金额可能形如 "$1,234.56" / "(1,234.56)"（负数） */
export function parseMoney(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  if (s === "" || s === "--") return NaN;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const n = parseFloat(s.replace(/[()$,]/g, ""));
  if (Number.isNaN(n)) return NaN;
  return neg ? -Math.abs(n) : n;
}

/**
 * 日期解析：支持 M/D/YYYY、MM/DD/YYYY、YYYY-MM-DD、YYYYMMDD，可带时间与 AM/PM、"ET"/"EST"/"EDT" 后缀。
 * 时间按 CSV 原文（美股东部时间）保留为 naive 时间，不做时区换算——
 * 配对只比较同账户内时间的先后，naive 时间足以保证确定性且跨机器稳定。
 * @returns {{date: string, time: string|null}|null}
 */
export function parseDateTime(raw) {
  if (!raw) return null;
  let s = String(raw).trim()
    .replace(/\s*(ET|EST5EDT|EST|EDT|US\/Eastern)\s*$/i, "")
    .replace(/([AP]M)\b/gi, (_mm, amPm) => " " + amPm.toUpperCase());
  const m = s.match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{8})(?:[ T]+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?))?/i);
  if (!m) return null;
  let datePart = m[1];
  let y, mo, d;
  if (/^\d{8}$/.test(datePart)) { y = +datePart.slice(0, 4); mo = +datePart.slice(4, 6); d = +datePart.slice(6, 8); }
  else if (/^\d{4}[-/]/.test(datePart)) { [y, mo, d] = datePart.split(/[-/]/).map(Number); }
  else { const p = datePart.split("/").map(Number); y = p[2]; mo = p[0]; d = p[1]; }
  if (!(y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  let time = m[2] ? normalizeTime(m[2]) : null;
  return { date: `${y}-${pad2(mo)}-${pad2(d)}`, time };
}

export function normalizeTime(t) {
  let s = String(t ?? "").trim().toUpperCase();
  if (s === "" || s === "-") return null;
  let hourOffset = 0;
  if (s.endsWith("AM")) { s = s.slice(0, -2).trim(); hourOffset = s.startsWith("12") ? -12 : 0; }
  else if (s.endsWith("PM")) { s = s.slice(0, -2).trim(); hourOffset = s.startsWith("12") ? 0 : 12; }
  const parts = s.split(":").map(Number);
  if (parts[0] === undefined || Number.isNaN(parts[0])) return null;
  const h = pad2((parts[0] + hourOffset) % 24);
  const mi = pad2(parts[1] ?? 0);
  const sec = pad2(parts[2] ?? 0);
  return `${h}:${mi}:${sec}`;
}

/** 交易类型 → op 码。现货买卖参与配对（1/2），其余流水只入库不配对。 */
const TYPE_TO_OP = [
  [/^(buy|long)/i, OP.BUY], // Buy / Buy, Limited Price / Buy To Cover / Long
  [/^(sell|short)/i, OP.SELL], // Sell / Sell, Short
  [/dividend|派息|分红/i, "6"],
  [/^(journal|transfer\s?in|转入)/i, "18"],
  [/^(transfer\s?out|转出)/i, "19"],
];

export function mapOp(typeRaw) {
  // 嘉信类型可能带后缀（"Buy, Limited Price"），取逗号前的主干再判定
  const head = String(typeRaw ?? "").trim().split(/[,;]/)[0].trim();
  if (!head) return null;
  for (const [re, op] of TYPE_TO_OP) if (re.test(head)) return op;
  // 其它流水（Cash Management、Account Transfer 等）：方向未知，按不参与配对入库
  return "99";
}

// ============================ 行标准化 ============================

/**
 * CSV 一行 → t_trade_record 记录对象（列顺序见 TRADE_COLUMNS）
 * @param {string[]} cells
 * @param {Map<string, number>} col
 * @param {object} opts
 * @returns {{record: object, warning: string|null}}
 */
export function normalizeRow(cells, col, opts) {
  const get = (logical) => (col.has(logical) ? String(cells[col.get(logical)] ?? "").trim() : "");

  const dt = parseDateTime(get("date") + (/\d$/.test(get("date")) && get("time") ? " " + get("time") : ""));
  if (!dt) return { record: null, warning: `日期无法解析: "${get("date")}"` };
  const time = dt.time || normalizeTime(get("time")) || "16:00:00"; // 收盘近似值，保持同日内时间确定
  const entryDate = dt.date;
  const entryDateTime = `${entryDate} ${time}`;

  const symbol = (get("symbol") || "").toUpperCase();
  if (!symbol) return { record: null, warning: "缺少代码，跳过" };

  const op = mapOp(get("type"));
  if (!op) return { record: null, warning: "缺少交易类型，跳过" };

  const qty = Math.abs(parseMoney(get("quantity")));
  const price = Math.abs(parseMoney(get("price")));
  let amount = parseMoney(get("amount"));
  if (Number.isNaN(amount)) amount = (Number.isNaN(qty) ? 0 : qty) * (Number.isNaN(price) ? 0 : price);
  amount = Math.abs(amount);

  if (Number.isNaN(qty) && Number.isNaN(price)) {
    // 嘉信派息/入金类流水 Quantity、Price 列为 "-"：金额可用则按数量 0 入库（不参与配对）
    if (op === OP.BUY || op === OP.SELL) {
      return { record: null, warning: `${symbol} ${entryDate}: 买卖流水缺少数量与价格，跳过` };
    }
    if (amount > 0) {
      return {
        record: buildRecord({ opts, entryDate, entryDateTime, time, op, symbol, name: get("name") || symbol, typeRaw: get("type"), qty: 0, price: 0, amount, fees: 0 }),
        warning: null,
      };
    }
    return { record: null, warning: `${symbol} ${entryDate}: 数量、价格与金额均为空，跳过` };
  }

  // 缺项互推：保证 entry_price / entry_count / entry_money 三者自洽
  const finalPrice = Number.isNaN(price) ? (qty > 0 ? round4(amount / qty) : 0) : price;
  const finalQty = Number.isNaN(qty) ? (finalPrice > 0 ? Math.round(amount / finalPrice) : 0) : Math.round(qty);
  const finalAmount = Number.isNaN(parseMoney(get("amount"))) && !Number.isNaN(price) && !Number.isNaN(qty)
    ? round4(finalPrice * finalQty)
    : round4(amount);

  let fees = parseMoney(get("fees"));
  if (Number.isNaN(fees)) fees = 0;
  fees = Math.abs(fees);

  return {
    record: buildRecord({
      opts, entryDate, entryDateTime, time, op, symbol,
      name: get("name") || symbol, typeRaw: get("type"),
      qty: finalQty, price: finalPrice, amount: finalAmount, fees,
    }),
    warning: op === "99" ? `未知交易类型 "${get("type")}"（按不参与配对的流水入库）` : null,
  };
}

/** 组装 t_trade_record 记录（列顺序与 TRADE_COLUMNS 一致） */
function buildRecord({ opts, entryDate, entryDateTime, time, op, symbol, name, typeRaw, qty, price, amount, fees }) {
  return {
    account_id: opts.accountId,
    account_name: opts.account,
    account_type: MARKET.US,
    code: symbol,
    commission: round4(fees),
    entry_cost: round4(amount),
    entry_count: qty,
    entry_date: entryDate,
    entry_money: round4(amount),
    entry_price: round4(price),
    entry_time: time,
    entry_date_time: entryDateTime,
    fee_total: round4(fees),
    // history_id 与同花顺 sync 生成规则区别开（CSV 前缀 + 哈希），避免跨源碰撞
    history_id: stableHistoryId(opts.account, entryDateTime, symbol, op, qty, price),
    manual_id: opts.accountId,
    market_code: MARKET.US,
    name,
    oid: 0,
    op,
    op_name: typeRaw || op,
    transfer_fee: 0, // 美股无过户费；配对净额口径按 0 费用处理
  };
}

/** 稳定 history_id：账户|时间|代码|方向|数量|价格 → sha1 前 24 位，跨机器幂等 */
export function stableHistoryId(account, entryDateTime, code, op, qty, price) {
  const raw = `CSV|${account}|${entryDateTime}|${code}|${op}|${qty}|${round4(price)}`;
  return createHash("sha1").update(raw).digest("hex").slice(0, 24);
}

/** 同日同参数重复成交：追加出现序号，避免主键互相覆盖 */
export function dedupeHistoryIds(records) {
  const seen = new Map();
  for (const r of records) {
    const n = (seen.get(r.history_id) || 0) + 1;
    seen.set(r.history_id, n);
    if (n > 1) r.history_id = `${r.history_id.slice(0, 22)}x${pad2(n)}`;
  }
  return records;
}

/**
 * 将一条成交按 1 股拆成多条记录（仅买入/卖出且数量>1 时）。
 * 拆分后每条形同一个 1 股成交：entry_count=1，entry_money 均分（round4），
 * history_id 以数量 1 重新派生，交由 dedupeHistoryIds 对完全相同的兄弟记录加序号，保证唯一且幂等。
 * 金额均分可能与原 Amount 有 ≤0.0005/股 的舍入差，网格收益按配对求和时误差可忽略。
 * @param {object} r - buildRecord 产出的记录
 * @returns {object[]}
 */
export function splitToShares(r) {
  const n = r.entry_count;
  if (!(n > 1)) return [r];
  const perShare = round4(r.entry_money / n);
  const base = stableHistoryId(r.account_name, r.entry_date_time, r.code, r.op, 1, r.entry_price);
  const out = [];
  for (let k = 0; k < n; k++) out.push({ ...r, entry_count: 1, entry_money: perShare, entry_cost: perShare, history_id: base });
  return out;
}

// ============================ 入库 ============================

const toValues = (r) => TRADE_COLUMNS.map((c) => r[c]);

async function upsertTrades(db, records) {
  let written = 0;
  for (let i = 0; i < records.length; i += INSERT_BATCH_SIZE) {
    const batch = records.slice(i, i + INSERT_BATCH_SIZE).map(toValues);
    const placeholders = batch.map(() => `(${TRADE_COLUMNS.map(() => "?").join(",")})`).join(",");
    await db.run(
      `INSERT OR REPLACE INTO ${TABLE.TRADE_RECORD} (${TRADE_COLUMNS.join(",")}) VALUES ${placeholders}`,
      batch.flat(),
    );
    written += batch.length;
  }
  return written;
}

// ============================ 主流程 ============================

export async function importCsv(filePath, opts = {}) {
  const options = { account: "嘉信-冯", dryRun: false, verbose: false, split: true, ...opts };
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);

  // 账户 id 由账户名派生，保证多次导入/多机器稳定
  options.accountId = "US-" + createHash("sha1").update(options.account).digest("hex").slice(0, 10);

  const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
  if (rows.length < 2) throw new Error("CSV 内容为空或只有表头");

  const headerIdx = findHeaderRow(rows);
  const col = buildColumnMap(rows[headerIdx]);
  const dataRows = rows.slice(headerIdx + 1);

  const records = [];
  const warnings = [];
  let skipped = 0;
  for (let i = 0; i < dataRows.length; i++) {
    const { record, warning } = normalizeRow(dataRows[i], col, options);
    if (warning) warnings.push(`第 ${i + 1} 行: ${warning}`);
    if (record) {
      if (options.split && (record.op === OP.BUY || record.op === OP.SELL) && record.entry_count > 1) {
        records.push(...splitToShares(record));
      } else {
        records.push(record);
      }
    } else skipped += 1;
  }
  dedupeHistoryIds(records);

  const byOp = {};
  for (const r of records) byOp[r.op] = (byOp[r.op] || 0) + 1;

  return {
    account: options.account,
    accountId: options.accountId,
    totalDataRows: dataRows.length,
    parsed: records.length,
    skipped,
    byOp,
    warnings,
    records,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file) { console.log(USAGE); process.exit(1); }

  const result = await importCsv(opts.file, { account: opts.account, verbose: opts.verbose, split: opts.split });

  console.log(`账户: ${result.account} (${result.accountId})`);
  console.log(`识别数据行: ${result.totalDataRows}，成功解析: ${result.parsed}，跳过: ${result.skipped}`);
  console.log(`方向分布: ${Object.entries(result.byOp).map(([k, v]) => `${opLabel(k)} ${v}`).join("、") || "无"}`);
  if (result.warnings.length > 0) {
    console.log(`警告 ${result.warnings.length} 条:`);
    for (const w of result.warnings.slice(0, 20)) console.log(`  - ${w}`);
    if (result.warnings.length > 20) console.log(`  ... 其余 ${result.warnings.length - 20} 条`);
  }
  if (opts.verbose) {
    for (const r of result.records) {
      console.log(`  ${r.entry_date_time} ${opLabel(r.op)} ${r.code} x${r.entry_count} @${r.entry_price} 金额${r.entry_money} 佣金${r.commission} id=${r.history_id}`);
    }
  }

  if (opts.dryRun) {
    console.log("\n[dry-run] 未写入数据库");
    return;
  }
  if (result.parsed === 0) {
    console.log("没有可写入的记录");
    return;
  }

  await withDb(async (db) => {
    await ensureSchema(db);
    await db.run("BEGIN TRANSACTION");
    try {
      if (opts.replace) {
        await db.run(`DELETE FROM ${TABLE.TRADE_MATCHED} WHERE account_id = ?`, [result.accountId]);
        const before = Number((await db.all(
          `SELECT count(*) AS n FROM ${TABLE.TRADE_RECORD} WHERE account_id = ?`, [result.accountId],
        ))[0]?.n ?? 0);
        await db.run(`DELETE FROM ${TABLE.TRADE_RECORD} WHERE account_id = ?`, [result.accountId]);
        console.log(`\n[replace] 已清除账户 ${result.account} 旧记录 ${before} 条及其配对（作用域仅此账户）`);
      }
      const written = await upsertTrades(db, result.records);
      await db.run("COMMIT");
      console.log(`已写入 ${written} 条到 ${TABLE.TRADE_RECORD}（INSERT OR REPLACE 幂等覆盖）`);
    } catch (e) {
      await db.run("ROLLBACK").catch(() => {});
      throw e;
    }
  });
  console.log("下一步: node match.js 进行买卖配对，再 node profit.js 统计收益");
}

// 直接执行时进入主流程（被 import 时不执行）
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (e) {
    console.error("导入失败:", e.message);
    process.exit(1);
  }
}
