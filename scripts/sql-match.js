/**
 * SQL 交易匹配相关定义
 * 匹配算法在 business.js tradeMatch 中实现（最大覆盖贪心，JS 侧）
 * 此文件仅提供：加载未匹配交易、插入匹配结果
 */

import { TABLE, OP } from "./constants.js";

/**
 * 加载未匹配交易记录（排除已匹配）
 * 返回全部未匹配买卖，供 JS 侧按 (account_id, code, entry_count) 分组贪心匹配
 */
export const LOAD_UNMATCHED_TRADES = `
  SELECT
    t.history_id,
    t.account_id, t.account_name,
    t.code, t.name,
    t.op,
    CAST(t.entry_price AS DOUBLE) AS entry_price,
    CAST(t.entry_count AS INTEGER) AS entry_count,
    CAST(t.entry_money AS DOUBLE) AS entry_money,
    CAST(t.commission AS DOUBLE) AS commission,
    CAST(t.transfer_fee AS DOUBLE) AS transfer_fee,
    CAST(t.entry_date_time AS TIMESTAMP) AS entry_ts
  FROM ${TABLE.TRADE_RECORD} t
  WHERE t.op IN ('${OP.BUY}', '${OP.SELL}')
    AND CAST(t.entry_count AS INTEGER) > 0
    AND t.history_id NOT IN (
      SELECT sell_history_id FROM ${TABLE.TRADE_MATCHED}
      UNION ALL
      SELECT buy_history_id FROM ${TABLE.TRADE_MATCHED}
    )`;

/**
 * 插入匹配结果
 * profit = 卖出净额 - 买入净额（净额含佣金与过户费）
 */
export const INSERT_MATCHED = `
  INSERT INTO ${TABLE.TRADE_MATCHED}
    (account_id, account_name, trans_year, trans_month, code, name,
     sell_entry_price, buy_entry_price, sell_entry_count, buy_entry_count,
     sell_entry_money, buy_entry_money, sell_transfer_fee, buy_transfer_fee,
     profit, sell_time, buy_time, sell_history_id, buy_history_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
