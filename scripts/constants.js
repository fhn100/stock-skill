/**
 * 常量定义
 * 避免循环依赖
 */

// ============================ 表名 ============================

export const TABLE = {
  DICT: "t_dict",
  TRADE_RECORD: "t_trade_record",
  TRADE_MATCHED: "t_trade_matched_record",
};

// ============================ API ============================

export const API_BASE = "https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb";

export const API_PATH = {
  ACCOUNT_LIST: "/caishen_fund/pc/account/v1/account_list",
  PASS_QUOTES: "/caishen_fund/invest/v1/pass_quotes",
  STOCK_POSITION: "/caishen_fund/pc/asset/v1/stock_position",
  STOCK_CARD: "/caishen_fund/pc/account/v1/stock_card",
};

// ============================ HTTP Headers ============================

export const HTTP_HEADERS = {
  USER_AGENT: "Mozilla/5.0 (X11; Linux x86_84) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  CONTENT_TYPE: "application/x-www-form-urlencoded; charset=UTF-8",
  ORIGIN: "https://tzzb.10jqka.com.cn",
  REFERER: "https://tzzb.10jqka.com.cn/pc/index.html",
};

// ============================ API 默认参数 ============================

export const API_DEFAULTS = {
  TERMINAL: "1",
  VERSION: "0.0.0",
};

// ============================ 交易操作类型 ============================

export const OP = { BUY: "1", SELL: "2" };

// ============================ Cookie 校验 ============================

export const COOKIE_REQUIRED_FIELDS = ["userid", "ticket", "sess_tk", "v"];

// ============================ 网络请求 ============================

export const FETCH_TIMEOUT_MS = 10000;

/** 两次请求之间的最小间隔（ms），避免瞬时突发触发风控 */
export const REQUEST_MIN_INTERVAL_MS = 1500;

/** 命中 403（Nginx 风控）时的退避序列（ms） */
export const THROTTLE_BACKOFF_MS = [5000, 15000, 30000, 60000];

/** 403 最大重试次数 */
export const THROTTLE_MAX_RETRIES = 4;