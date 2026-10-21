/**
 * SQL 交易匹配相关定义
 * 匹配算法在 business.js tradeMatch 中实现（时间差最小贪心，JS 侧）
 * 此文件提供：未匹配判定的共用 SQL 片段、加载未匹配交易、匹配结果列定义
 */

import { TABLE, OP, MATCHABLE_OPS } from "./constants.js";

/** 未匹配判定：LEFT JOIN 替代 NOT IN，避免 NULL 值陷阱且性能更好 */
export const NOT_MATCHED_JOIN = `
  LEFT JOIN ${TABLE.TRADE_MATCHED} m1 ON t.history_id = m1.sell_history_id
  LEFT JOIN ${TABLE.TRADE_MATCHED} m2 ON t.history_id = m2.buy_history_id
  WHERE m1.sell_history_id IS NULL
    AND m2.buy_history_id IS NULL
`;

/** 可配对条件：仅现货买卖且数量 > 0（逆回购/派息/缴税等不参与配对） */
export const MATCHABLE_COND = `
  t.op IN (${MATCHABLE_OPS.map((o) => `'${o}'`).join(", ")})
    AND CAST(t.entry_count AS INTEGER) > 0
`;

/**
 * 加载未匹配交易记录（排除已匹配）
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
    CAST(t.entry_date_time AS TIMESTAMP WITH TIME ZONE) AS entry_ts
  FROM ${TABLE.TRADE_RECORD} t
  ${NOT_MATCHED_JOIN}
    AND ${MATCHABLE_COND}
`;

/**
 * 匹配结果插入列定义（批量 INSERT 使用，列顺序即绑定参数顺序）
 * profit = 卖出净额 - 买入净额（净额含佣金与过户费）
 */
export const MATCHED_COLUMNS = [
  "account_id", "account_name", "trans_year", "trans_month", "code", "name",
  "sell_entry_price", "buy_entry_price", "sell_entry_count", "buy_entry_count",
  "sell_entry_money", "buy_entry_money", "sell_transfer_fee", "buy_transfer_fee",
  "profit", "sell_time", "buy_time", "sell_history_id", "buy_history_id",
];
