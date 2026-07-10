/**
 * SQL 同步相关定义
 * 使用 Node.js fetch 发起 HTTP 请求，纯 SQL 用于数据插入
 */

import { TABLE, DICT_TYPE } from "./constants.js";

/**
 * 插入账户信息 SQL
 */
export const INSERT_ACCOUNT = `
  INSERT OR REPLACE INTO ${TABLE.DICT}(key, type, value)
  VALUES (?, '${DICT_TYPE.FUND_KEY}', ?)`;

/**
 * 插入交易记录 SQL
 */
export const INSERT_TRADE = `
  INSERT OR REPLACE INTO ${TABLE.TRADE_RECORD}
    (account_id, account_name, account_type, code, commission, entry_cost, entry_count,
     entry_date, entry_money, entry_price, entry_time, entry_date_time, fee_total,
     history_id, manual_id, market_code, name, oid, op, op_name, transfer_fee)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
