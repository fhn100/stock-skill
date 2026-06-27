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

// ============================ 分页 ============================

export const PAGE_SIZE = 1000;

// ============================ API ============================

export const API_BASE = "https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb";

export const API_PATH = {
  ACCOUNT_LIST: "/caishen_fund/pc/account/v1/account_list",
  PASS_QUOTES: "/caishen_fund/invest/v1/pass_quotes",
  STOCK_POSITION: "/caishen_fund/pc/asset/v1/stock_position",
  SYNC_TRADE: "/caishen_fund/pc/account/v2/get_money_history",
};

// ============================ HTTP Headers ============================

export const HTTP_HEADERS = {
  USER_AGENT: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  CONTENT_TYPE: "application/x-www-form-urlencoded; charset=UTF-8",
  ORIGIN: "https://tzzb.10jqka.com.cn",
  REFERER: "https://tzzb.10jqka.com.cn/pc/index.html",
};

// ============================ API 默认参数 ============================

export const API_DEFAULTS = {
  TERMINAL: "1",
  VERSION: "0.0.0",
};

// ============================ 初始化 ============================

export const INIT_URL = "https://s.hexin.cn/";
export const INIT_WAIT_MS = 1500;
export const COOKIE_DOMAIN = ".10jqka.com.cn";

// ============================ 交易操作类型 ============================

export const OP = { BUY: "1", SELL: "2" };

// ============================ 字典类型 ============================

export const DICT_TYPE = { FUND_KEY: "fund_key" };

// ============================ Cookie 校验 ============================

export const COOKIE_REQUIRED_FIELDS = ["userid", "v"];
export const COOKIE_EXPIRY_SECONDS = 86400;

// ============================ 同步与匹配 ============================

export const SYNC_CONCURRENCY = 3;
export const MATCH_MAX_ITERATIONS = 100;

// ============================ 网络请求 ============================

export const FETCH_TIMEOUT_MS = 10000;