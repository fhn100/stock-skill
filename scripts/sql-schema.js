/**
 * SQL 表结构定义
 * 包含所有数据库表的 CREATE 语句
 */

import { TABLE } from "./constants.js";

/**
 * 字典表创建语句
 * 存储账户信息、配置等键值对
 */
export const CREATE_DICT = `
  CREATE TABLE IF NOT EXISTS ${TABLE.DICT}(
    key VARCHAR DEFAULT '' PRIMARY KEY,
    type VARCHAR DEFAULT '',
    value VARCHAR DEFAULT ''
  );`;

/**
 * 交易记录表创建语句
 * 存储所有交易记录（买入/卖出）
 */
export const CREATE_TRADE_RECORD = `
  CREATE TABLE IF NOT EXISTS ${TABLE.TRADE_RECORD} (
    account_id VARCHAR,
    account_name VARCHAR,
    account_type VARCHAR,
    code VARCHAR,
    commission DECIMAL(10,4),
    entry_cost DECIMAL(10,4),
    entry_count VARCHAR,
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
    transfer_fee DECIMAL(10,4)
  );`;

/**
 * 交易匹配表创建语句
 * 存储匹配后的买入/卖出记录对
 */
export const CREATE_TRADE_MATCHED = `
  CREATE TABLE IF NOT EXISTS ${TABLE.TRADE_MATCHED}(
    account_id VARCHAR,
    account_name VARCHAR,
    trans_year VARCHAR,
    trans_month VARCHAR,
    code VARCHAR,
    "name" VARCHAR,
    sell_entry_price DECIMAL(10,4),
    buy_entry_price DECIMAL(10,4),
    sell_entry_count VARCHAR,
    buy_entry_count VARCHAR,
    sell_entry_money DECIMAL(10,4),
    buy_entry_money DECIMAL(10,4),
    sell_transfer_fee DECIMAL(10,4),
    buy_transfer_fee DECIMAL(10,4),
    profit DECIMAL(12,4),
    sell_time TIMESTAMP,
    buy_time TIMESTAMP,
    sell_history_id VARCHAR,
    buy_history_id VARCHAR,
    PRIMARY KEY(sell_history_id, buy_history_id)
  );`;
