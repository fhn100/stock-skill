/**
 * 常量定义
 */

// ============================ 表名 ============================

export const TABLE = {
  TRADE_RECORD: "t_trade_record",
  TRADE_MATCHED: "t_trade_matched_record",
};

// ============================ 交易操作类型 ============================

export const OP = { BUY: "1", SELL: "2" };

/**
 * 市场码。`market_code = 'US'` 是「美股账户」的判定依据，串起三条不变量：
 * `opencli stock sync-schwab` 写入、profit 的「0 过户费」清理排除、GRID_PROFIT 的币种派生（US→USD）。
 * 集中定义，避免三处 'US' 字面量各自漂移。
 */
export const MARKET = { US: "US" };

/**
 * 参与买卖配对的流水类型。
 * 同花顺只在现货买卖时下发 op=1/2；国债逆回购用 op=5/35（代码 131810、204001 等），
 * 派息 op=6、缴税 op=95、转入转出 op=18/19/86/87、入账 op=222 等均不参与配对，
 * 因此网格收益不含逆回购收益与现金分红。
 */
export const MATCHABLE_OPS = [OP.BUY, OP.SELL];

/**
 * 全量流水方向的展示标签（仅 unmatched.js --all 使用）。
 * 依据本地库实测 op 码；op_name 字段不可靠，故不使用。
 */
export const OP_LABEL = {
  [OP.BUY]: "买入",
  [OP.SELL]: "卖出",
  "5": "回购买入",
  "35": "回购卖出",
  "6": "派息",
  "95": "缴税",
  "18": "转入",
  "19": "转出",
  "86": "转入",
  "87": "转出",
  "222": "入账",
  "235": "其他买入",
  "236": "其他卖出",
  "99": "其他流水",
};

/** 未知 op 码的兜底标签 */
export const opLabel = (op) => OP_LABEL[op] || `流水(${op})`;

// ============================ 数据写入 ============================

/** 批量 INSERT 每批行数 */
export const INSERT_BATCH_SIZE = 500;
