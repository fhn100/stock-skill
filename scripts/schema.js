/**
 * 表结构单一来源（scripts 树）
 *
 * scripts 树内各脚本建表统一从这里取，避免各处内联 DDL 漂移。
 * 注意：opencli 插件 resources/stock/sync.js 是独立安装、自带 node_modules 的插件，
 * 不宜跨树 import 本模块（会把插件耦合到技能绝对路径、破坏其自包含 cp -r 安装），
 * 故插件保留自身一份 DDL，由 selftest.js 的「列名与 sync.js 一致」parity 测试守卫两侧同步。
 */

import { TABLE } from "./constants.js";

/** 交易记录表列顺序 = 插入列顺序 */
export const TRADE_COLUMNS = [
  "account_id", "account_name", "account_type", "code", "commission",
  "entry_cost", "entry_count", "entry_date", "entry_money", "entry_price",
  "entry_time", "entry_date_time", "fee_total", "history_id", "manual_id",
  "market_code", "name", "oid", "op", "op_name", "transfer_fee",
];

export const TRADE_RECORD_DDL = `CREATE TABLE IF NOT EXISTS ${TABLE.TRADE_RECORD} (
    account_id VARCHAR, account_name VARCHAR, account_type VARCHAR, code VARCHAR,
    commission DECIMAL(10,4), entry_cost DECIMAL(10,4), entry_count INTEGER,
    entry_date VARCHAR, entry_money DECIMAL(10,4), entry_price DECIMAL(10,4),
    entry_time VARCHAR, entry_date_time VARCHAR, fee_total DECIMAL(10,4),
    history_id VARCHAR PRIMARY KEY, manual_id VARCHAR, market_code VARCHAR,
    name VARCHAR, oid INTEGER, op VARCHAR, op_name VARCHAR, transfer_fee DECIMAL(10,4))`;

export const TRADE_MATCHED_DDL = `CREATE TABLE IF NOT EXISTS ${TABLE.TRADE_MATCHED}(
    account_id VARCHAR, account_name VARCHAR, trans_year VARCHAR, trans_month VARCHAR,
    code VARCHAR, "name" VARCHAR, sell_entry_price DECIMAL(10,4), buy_entry_price DECIMAL(10,4),
    sell_entry_count INTEGER, buy_entry_count INTEGER, sell_entry_money DECIMAL(10,4),
    buy_entry_money DECIMAL(10,4), sell_transfer_fee DECIMAL(10,4), buy_transfer_fee DECIMAL(10,4),
    profit DECIMAL(12,4), sell_time TIMESTAMP, buy_time TIMESTAMP,
    sell_history_id VARCHAR, buy_history_id VARCHAR, match_type VARCHAR,
    PRIMARY KEY(sell_history_id, buy_history_id, match_type))`;

export const TRADE_INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS idx_trade_op_date ON ${TABLE.TRADE_RECORD}(op, entry_date)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_code ON ${TABLE.TRADE_RECORD}(code)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_date_time ON ${TABLE.TRADE_RECORD}(entry_date_time)`,
];

export const MATCHED_INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS idx_matched_sell_history ON ${TABLE.TRADE_MATCHED}(sell_history_id)`,
  `CREATE INDEX IF NOT EXISTS idx_matched_buy_history ON ${TABLE.TRADE_MATCHED}(buy_history_id)`,
  `CREATE INDEX IF NOT EXISTS idx_matched_sell_time ON ${TABLE.TRADE_MATCHED}(sell_time)`,
  `CREATE INDEX IF NOT EXISTS idx_matched_code ON ${TABLE.TRADE_MATCHED}(code)`,
];

/** 建表 + 建索引（幂等），与 opencli stock init-db 等价（不含字典表） */
export async function ensureSchema(db) {
  await db.run(TRADE_RECORD_DDL);
  await db.run(TRADE_MATCHED_DDL);
  for (const sql of [...TRADE_INDEX_DDL, ...MATCHED_INDEX_DDL]) await db.run(sql);
}
