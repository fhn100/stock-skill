/**
 * opencli stock 插件共用层（不注册命令，只被 sync-tzzb.js / sync-schwab.js 引用）：
 * DuckDB 路径、表结构（列定义单一来源）、连接/事务/批量写入，以及日期区间解析。
 */
import { ArgumentError } from "@jackwener/opencli/errors";
import { log } from "@jackwener/opencli/logger";
import { DuckDBInstance } from "@duckdb/node-api";
import fs from "fs";
import { join } from "path";

// ============================ 数据库路径与表 ============================

export const DATA_DIR = join(process.env.HOME, ".duckdb", "stock");
export const DB_PATH = join(DATA_DIR, "stock.db");

export const TABLE = {
  DICT: "t_dict",
  TRADE_RECORD: "t_trade_record",
  TRADE_MATCHED: "t_trade_matched_record",
};

/** 表列顺序 = 插入列顺序，行构造按列名取值 */
export const TRADE_COLUMNS = [
  "account_id", "account_name", "account_type", "code", "commission",
  "entry_cost", "entry_count", "entry_date", "entry_money", "entry_price",
  "entry_time", "entry_date_time", "fee_total", "history_id", "manual_id",
  "market_code", "name", "oid", "op", "op_name", "transfer_fee",
];

export const INSERT_BATCH_SIZE = 500;
export const REQUEST_MIN_INTERVAL_MS = 800;

// 接口前置 Nginx 限流：串行请求的最小间隔（同花顺/嘉信分页共用）
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================ 日期参数 ============================

/** YYYYMMDD / YYYY-MM-DD → YYYYMMDD */
export function normalizeDate(value, label) {
  const digits = String(value).replace(/-/g, "");
  if (!/^\d{8}$/.test(digits)) {
    throw new ArgumentError(`${label} 日期格式应为 YYYYMMDD，当前为 "${value}"`);
  }
  return digits;
}

export function lastDayOfMonth(yyyymmdd) {
  const yyyy = Number(yyyymmdd.slice(0, 4));
  const mm = Number(yyyymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) throw new ArgumentError(`月份非法: ${yyyymmdd}`);
  return `${yyyymmdd.slice(0, 4)}${String(mm).padStart(2, "0")}${String(new Date(yyyy, mm, 0).getDate()).padStart(2, "0")}`;
}

/** 默认同步当月；只给 start 时补齐到该月月末 */
export function resolveDateRange(kwargs) {
  if (kwargs.start) {
    const startDate = normalizeDate(kwargs.start, "start");
    const endDate = kwargs.end ? normalizeDate(kwargs.end, "end") : lastDayOfMonth(startDate);
    if (endDate < startDate) throw new ArgumentError(`end(${endDate}) 早于 start(${startDate})`);
    return { startDate, endDate };
  }
  if (kwargs.end) throw new ArgumentError("只指定 end 时无法确定起始日期，请同时指定 start");
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return { startDate: `${ym}01`, endDate: lastDayOfMonth(ym) };
}

// ============================ 行工具 ============================

export const toTradeValues = (record) => TRADE_COLUMNS.map((column) => record[column]);

// ============================ DuckDB ============================

export const SCHEMA_GROUPS = [
  {
    label: "字典表",
    table: TABLE.DICT,
    statements: [
      `CREATE TABLE IF NOT EXISTS ${TABLE.DICT}(
         key VARCHAR DEFAULT '' PRIMARY KEY,
         type VARCHAR DEFAULT '',
         value VARCHAR DEFAULT '')`,
      `CREATE INDEX IF NOT EXISTS idx_dict_type ON ${TABLE.DICT}(type)`,
    ],
  },
  {
    label: "交易记录表",
    table: TABLE.TRADE_RECORD,
    statements: [
      `CREATE TABLE IF NOT EXISTS ${TABLE.TRADE_RECORD} (
         account_id VARCHAR,
         account_name VARCHAR,
         account_type VARCHAR,
         code VARCHAR,
         commission DECIMAL(10,4),
         entry_cost DECIMAL(10,4),
         entry_count INTEGER,
         entry_date VARCHAR,
         entry_money DECIMAL(10,4),
         entry_price DECIMAL(10,4),
         entry_time VARCHAR,
         entry_date_time VARCHAR,
         fee_total DECIMAL(10,4),
         history_id VARCHAR PRIMARY KEY,
         manual_id VARCHAR,
         market_code VARCHAR,
         name VARCHAR,
         oid INTEGER,
         op VARCHAR,
         op_name VARCHAR,
         transfer_fee DECIMAL(10,4))`,
      `CREATE INDEX IF NOT EXISTS idx_trade_op_date ON ${TABLE.TRADE_RECORD}(op, entry_date)`,
      `CREATE INDEX IF NOT EXISTS idx_trade_code ON ${TABLE.TRADE_RECORD}(code)`,
      `CREATE INDEX IF NOT EXISTS idx_trade_date_time ON ${TABLE.TRADE_RECORD}(entry_date_time)`,
    ],
  },
  {
    label: "交易匹配表",
    table: TABLE.TRADE_MATCHED,
    statements: [
      `CREATE TABLE IF NOT EXISTS ${TABLE.TRADE_MATCHED}(
         account_id VARCHAR,
         account_name VARCHAR,
         trans_year VARCHAR,
         trans_month VARCHAR,
         code VARCHAR,
         "name" VARCHAR,
         sell_entry_price DECIMAL(10,4),
         buy_entry_price DECIMAL(10,4),
         sell_entry_count INTEGER,
         buy_entry_count INTEGER,
         sell_entry_money DECIMAL(10,4),
         buy_entry_money DECIMAL(10,4),
         sell_transfer_fee DECIMAL(10,4),
         buy_transfer_fee DECIMAL(10,4),
         profit DECIMAL(12,4),
         sell_time TIMESTAMP,
         buy_time TIMESTAMP,
         sell_history_id VARCHAR,
         buy_history_id VARCHAR,
         match_type VARCHAR,
         PRIMARY KEY(sell_history_id, buy_history_id, match_type))`,
      `CREATE INDEX IF NOT EXISTS idx_matched_sell_history ON ${TABLE.TRADE_MATCHED}(sell_history_id)`,
      `CREATE INDEX IF NOT EXISTS idx_matched_buy_history ON ${TABLE.TRADE_MATCHED}(buy_history_id)`,
      `CREATE INDEX IF NOT EXISTS idx_matched_sell_time ON ${TABLE.TRADE_MATCHED}(sell_time)`,
      `CREATE INDEX IF NOT EXISTS idx_matched_code ON ${TABLE.TRADE_MATCHED}(code)`,
    ],
  },
];

export async function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const instance = await DuckDBInstance.create(DB_PATH);
  const conn = await instance.connect();
  return {
    conn,
    all: async (sql, params = []) => (await conn.runAndReadAll(sql, params)).getRowObjects(),
    close: () => {
      // 必须显式关闭，否则 stock.db 的锁与 WAL 不会落盘
      try {
        conn.closeSync();
      } catch (e) {
        log.warn(`关闭数据库连接失败: ${e.message}`);
      }
      try {
        instance.closeSync();
      } catch (e) {
        log.warn(`关闭数据库实例失败: ${e.message}`);
      }
    },
  };
}

/** 建表 + 建索引（幂等） */
export async function initSchema(db) {
  for (const group of SCHEMA_GROUPS) {
    for (const sql of group.statements) await db.conn.run(sql);
  }
}

/** 一批写入要么全成要么全无，避免中途失败留下半张表 */
export async function withTransaction(db, fn) {
  await db.conn.run("BEGIN TRANSACTION");
  try {
    await fn();
    await db.conn.run("COMMIT");
  } catch (e) {
    // 回滚再失败通常意味着连接已失效，此时必须保留原始错误
    try {
      await db.conn.run("ROLLBACK");
    } catch {
      /* noop */
    }
    throw e;
  }
}

export async function countRows(db, table) {
  const rows = await db.all(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(String(rows[0]?.n ?? 0));
}

export async function insertTrades(db, rows) {
  await withTransaction(db, async () => {
    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
      const placeholders = batch.map(() => `(${TRADE_COLUMNS.map(() => "?").join(",")})`).join(",");
      await db.conn.run(
        `INSERT OR REPLACE INTO ${TABLE.TRADE_RECORD} (${TRADE_COLUMNS.join(",")}) VALUES ${placeholders}`,
        batch.flat(),
      );
    }
  });
}

