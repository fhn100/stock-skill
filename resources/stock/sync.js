import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
import { log } from "@jackwener/opencli/logger";
import { DuckDBInstance } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import fs from "fs";
import { join } from "path";

// ============================ 常量 ============================

const SITE = "tzzb.10jqka.com.cn";
const PAGE_URL = `https://${SITE}/pc/index.html`;
const API_BASE = `https://${SITE}/caishen_httpserver/tzzb`;
const API_PATH = {
  ACCOUNT_LIST: "/caishen_fund/pc/account/v1/account_list",
  TRADE_HISTORY: "/caishen_fund/pc/account/v2/get_money_history",
};

const DATA_DIR = join(process.env.HOME, ".duckdb", "stock");
const DB_PATH = join(DATA_DIR, "stock.db");

const TABLE = {
  DICT: "t_dict",
  TRADE_RECORD: "t_trade_record",
  TRADE_MATCHED: "t_trade_matched_record",
};

/** 表列顺序 = 插入列顺序，行构造按列名取值 */
const TRADE_COLUMNS = [
  "account_id", "account_name", "account_type", "code", "commission",
  "entry_cost", "entry_count", "entry_date", "entry_money", "entry_price",
  "entry_time", "entry_date_time", "fee_total", "history_id", "manual_id",
  "market_code", "name", "oid", "op", "op_name", "transfer_fee",
];

const FUND_KEY_TYPE = "fund_key";
const PAGE_SIZE = 1000;
const INSERT_BATCH_SIZE = 500;
const FETCH_TIMEOUT_MS = 15000;
const REQUEST_MIN_INTERVAL_MS = 800;

// ---- 嘉信证券（Schwab，美股）----

const SCHWAB_SITE = "client.schwab.com";
const SCHWAB_SUMMARY_URL = `https://${SCHWAB_SITE}/app/accounts/summary`;
const SCHWAB_LOGIN_PATH = /\/Areas\/Access\/Login/i;
const SCHWAB_API_HOST = "ausgateway.schwab.com";
const SCHWAB_API_BASE = `https://${SCHWAB_API_HOST}/api`;
const SCHWAB_TX_URL = `${SCHWAB_API_BASE}/is.TransactionHistoryWeb/TransactionHistoryInterface/TransactionHistory/brokerage/transactions`;
/**
 * 交易接口只接受**同源**调用：在 client.schwab.com 页面里 fetch 它会被 CORS 拦掉
 * （OPTIONS 预检 200，真实请求不发）。这个 preferences 端点无需鉴权即可返回一份
 * ausgateway 源的文档，用它把标签页换到 API 同源，之后的 POST 就是同源请求（实测 200）。
 */
const SCHWAB_ORIGIN_URL = `${SCHWAB_API_BASE}/is.ClientSummaryExpWeb/V1/api/preferences`;
const SCHWAB_APP_ID = "AD00008376";
const SCHWAB_TX_TYPES = [
  "Adjustments", "AtmActivity", "BillPay", "CorporateActions", "Checks",
  "Deposits", "DividendsAndCapitalGains", "ElectronicTransfers", "Fees",
  "Interest", "Misc", "SecurityTransfers", "Taxes", "Trades",
  "VisaDebitCard", "Withdrawals",
];
/** 接口每页约 200 条；上限是保险丝，正常全量（4 年 ≈ 290 条流水 / 2 页）远达不到 */
const SCHWAB_PAGE_LIMIT = 60;
const SCHWAB_TOKEN_POLL_ROUNDS = 8;
const SCHWAB_TOKEN_POLL_INTERVAL_S = 1.5;
const SCHWAB_REQUEST_TIMEOUT_MS = 30000;
const SCHWAB_DEFAULT_ACCOUNT_NAME = "嘉信-冯";
const SCHWAB_DEFAULT_ACCOUNT_ID = "10301685";
/** 接口响应里没有任何成交时间，统一用美股收盘价时刻，保证同日顺序确定 */
const SCHWAB_ENTRY_TIME = "16:00:00";

const MARKET_US = "US";
/** op 码与同花顺共用同一套语义（1 买入 / 2 卖出，其余流水不参与配对） */
const OP_US = { BUY: "1", SELL: "2", DIVIDEND: "6", TRANSFER_IN: "18", TRANSFER_OUT: "19", OTHER: "99" };

// ============================ 日期参数 ============================

/** YYYYMMDD / YYYY-MM-DD → YYYYMMDD */
function normalizeDate(value, label) {
  const digits = String(value).replace(/-/g, "");
  if (!/^\d{8}$/.test(digits)) {
    throw new ArgumentError(`${label} 日期格式应为 YYYYMMDD，当前为 "${value}"`);
  }
  return digits;
}

function lastDayOfMonth(yyyymmdd) {
  const yyyy = Number(yyyymmdd.slice(0, 4));
  const mm = Number(yyyymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) throw new ArgumentError(`月份非法: ${yyyymmdd}`);
  return `${yyyymmdd.slice(0, 4)}${String(mm).padStart(2, "0")}${String(new Date(yyyy, mm, 0).getDate()).padStart(2, "0")}`;
}

/** 默认同步当月；只给 start 时补齐到该月月末 */
function resolveDateRange(kwargs) {
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

// ============================ API 请求 ============================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 前置 Nginx 对单 IP 有限流，串行 + 最小间隔即可，不要并发拉取。
let lastRequestAt = 0;

/**
 * 判断 401/403 是否为登录态失效（重试无用，只有重新登录才能恢复）：
 * - 403 且 body 含 "Nginx forbidden" = 网关校验 v 字段失败
 * - 401 = sess_tk/cuc 过期
 */
function isLoginRejected(status, body) {
  return status === 401 || /nginx forbidden/i.test(body);
}

/**
 * 通用 POST：请求在浏览器上下文内发起，Cookie / UA / 网关签名都由浏览器登录态提供，
 * 本地不落任何凭证，也就不会遇到「Cookie 文件里的凭证被服务端轮换」的问题。
 * @returns {Promise<object>} ex_data
 */
async function apiPost(page, path, params, userId) {
  const wait = lastRequestAt + REQUEST_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const body = new URLSearchParams({
    userid: userId,
    user_id: userId,
    TERMINAL: "1",
    VERSION: "0.0.0",
    ...params,
  }).toString();

  // 注意：不能用 page.fetchJson —— 它会把 body 做 JSON.stringify，
  // 而该接口要的是 form-urlencoded，会返回「服务器繁忙」。
  const payload = await page.evaluate(async (req) => {
    try {
      const res = await fetch(req.url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: req.body,
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return { fetchError: String((e && e.message) || e) };
    }
  }, { url: `${API_BASE}${path}`, body, timeoutMs: FETCH_TIMEOUT_MS });

  if (!payload || typeof payload.status !== "number") {
    throw new CommandExecutionError(
      `浏览器请求失败: ${payload?.fetchError || "无响应"}`,
      `请确认浏览器可访问 ${PAGE_URL}`,
    );
  }

  const { status, text } = payload;
  if (status === 401 || status === 403) {
    if (isLoginRejected(status, text)) {
      throw new AuthRequiredError(SITE, `浏览器登录态已失效（HTTP ${status}）`, `请在浏览器重新登录 ${PAGE_URL} 后重试`);
    }
    throw new CommandExecutionError(`HTTP ${status}: 触发服务端风控限流`, "请稍后重试，或缩小同步区间");
  }
  if (status < 200 || status >= 300) {
    throw new CommandExecutionError(`HTTP ${status}: ${text.slice(0, 120)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CommandExecutionError(`响应不是合法 JSON: ${text.slice(0, 120)}`, `请确认浏览器已登录 ${PAGE_URL}`);
  }
  if (json.error_code !== "0") {
    throw new CommandExecutionError(`接口返回错误: ${json.error_msg || json.error_code || "未知错误"}`);
  }
  return json.ex_data || {};
}

/** 浏览器 Cookie 里有 userid == 已登录；顺带作为接口必填参数 */
async function getSessionUserId(page) {
  const cookies = await page.getCookies({ url: PAGE_URL });
  const userId = String(cookies.find((c) => c.name === "userid")?.value || "");
  if (!/^\d+$/.test(userId)) {
    throw new AuthRequiredError(SITE, "浏览器未登录同花顺投资决策账号", `请在浏览器打开 ${PAGE_URL} 登录后重试`);
  }
  return userId;
}

async function fetchAccounts(page, userId) {
  const data = await apiPost(page, API_PATH.ACCOUNT_LIST, {}, userId);
  return (data.common || []).filter((item) => item.fund_key);
}

// ============================ 行构造 ============================

const num = (value) => parseFloat(value) || 0;
const int = (value) => parseInt(value) || 0;

/** 接口字段 -> 表字段；键名即列名，插入顺序由 TRADE_COLUMNS 决定，不再依赖人工对齐 */
function normalizeTrade(item, accountName) {
  const entryDateTime = `${item.entry_date} ${item.entry_time}`;
  // 接口给的是北京时间，必须显式带时区解析：用本地时区解析会让 history_id 随机器漂移，
  // 同一笔交易在另一台机器上就变成了「新记录」，覆盖写入退化成重复插入。
  const entryEpoch = Math.floor(Date.parse(`${item.entry_date}T${item.entry_time}+08:00`) / 1000);
  if (!Number.isFinite(entryEpoch)) {
    throw new CommandExecutionError(
      `交易时间无法解析: account_id=${item.account_id} "${entryDateTime}"`,
      "请确认接口返回的 entry_date/entry_time 格式",
    );
  }
  const entryCount = int(item.entry_count);
  return {
    account_id: item.account_id,
    account_name: accountName,
    account_type: item.account_type,
    code: item.code,
    commission: num(item.commission),
    entry_cost: num(item.entry_cost),
    entry_count: entryCount,
    entry_date: item.entry_date,
    entry_money: num(item.entry_money),
    entry_price: num(item.entry_price),
    entry_time: item.entry_time,
    entry_date_time: entryDateTime,
    fee_total: num(item.fee_total),
    // history_id 与既有库保持一致：账户 + 时间戳 + 代码 + 方向 + 数量
    history_id: `${item.account_id}${entryEpoch}${item.code}${item.op}${entryCount}`,
    manual_id: item.manual_id,
    market_code: item.market_code,
    name: item.name,
    oid: int(item.oid),
    op: item.op,
    op_name: item.op_name,
    transfer_fee: num(item.transfer_fee),
  };
}

const toTradeValues = (record) => TRADE_COLUMNS.map((column) => record[column]);

/**
 * 分页拉取单账户交易记录并转为插入行
 * @returns {Promise<{rows: Array<Array>, pages: number}>}
 */
async function fetchTradeRows(page, fundKey, startDate, endDate, accountName, userId) {
  const rows = [];
  let pageNum = 1;
  let maxPage = 1;
  let pages = 0;

  while (pageNum <= maxPage) {
    const data = await apiPost(page, API_PATH.TRADE_HISTORY, {
      fund_key: fundKey,
      stock_code: "",
      stock_account: "",
      start_date: startDate,
      end_date: endDate,
      page: String(pageNum),
      count: String(PAGE_SIZE),
      sort_type: "",
      sort_order: "1",
    }, userId);

    maxPage = Number(data.max_page) || 1;
    const list = data.list || [];
    pages = pageNum;

    rows.push(...list.map((item) => toTradeValues(normalizeTrade(item, accountName))));

    log.status(`  ${accountName || fundKey}: 第 ${pageNum}/${maxPage} 页，${list.length} 条`);
    if (list.length === 0) break;
    pageNum += 1;
  }

  return { rows, pages };
}

// ============================ DuckDB ============================

const SCHEMA_GROUPS = [
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
         PRIMARY KEY(sell_history_id, buy_history_id))`,
      `CREATE INDEX IF NOT EXISTS idx_matched_sell_history ON ${TABLE.TRADE_MATCHED}(sell_history_id)`,
      `CREATE INDEX IF NOT EXISTS idx_matched_buy_history ON ${TABLE.TRADE_MATCHED}(buy_history_id)`,
      `CREATE INDEX IF NOT EXISTS idx_matched_sell_time ON ${TABLE.TRADE_MATCHED}(sell_time)`,
      `CREATE INDEX IF NOT EXISTS idx_matched_code ON ${TABLE.TRADE_MATCHED}(code)`,
    ],
  },
];

async function openDb() {
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
async function initSchema(db) {
  for (const group of SCHEMA_GROUPS) {
    for (const sql of group.statements) await db.conn.run(sql);
  }
}

/** 一批写入要么全成要么全无，避免中途失败留下半张表 */
async function withTransaction(db, fn) {
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

async function countRows(db, table) {
  const rows = await db.all(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(String(rows[0]?.n ?? 0));
}

async function saveAccounts(db, accounts) {
  for (const item of accounts) {
    await db.conn.run(
      `INSERT OR REPLACE INTO ${TABLE.DICT}(key, type, value) VALUES(?, ?, ?)`,
      [item.fund_key, FUND_KEY_TYPE, item.manualname ?? ""],
    );
  }
}

async function insertTrades(db, rows) {
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

// ============================ 嘉信（Schwab）交易记录 ============================

const pad2 = (n) => String(n).padStart(2, "0");
/** 与 scripts/utils.js 逐字一致：金额舍入口径决定 history_id，两边必须同一实现 */
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;

/** "$1,234.56" / "(1,234.56)" / "-$370.00" / "" → Number（空串与非数字返回 NaN） */
function parseSchwabMoney(value) {
  const s = String(value ?? "").trim();
  if (s === "" || s === "--") return NaN;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const n = parseFloat(s.replace(/[()$,]/g, ""));
  if (Number.isNaN(n)) return NaN;
  return neg ? -Math.abs(n) : n;
}

/** M/D/YYYY（嘉信）→ YYYY-MM-DD；无法解析返回 null */
function parseSchwabDate(raw) {
  const m = String(raw ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${pad2(Number(mm))}-${pad2(Number(dd))}`;
}

/** 交易类型 → op 码：按动作首词判定，只有现货买卖参与配对，其余作为不参与配对的流水 */
const SCHWAB_ACTION_TO_OP = [
  [/^(buy|long)/i, OP_US.BUY],
  [/^(sell|short)/i, OP_US.SELL],
  [/dividend|派息|分红/i, OP_US.DIVIDEND],
  [/^(journal|transfer\s?in|转入)/i, OP_US.TRANSFER_IN],
  [/^(transfer\s?out|转出)/i, OP_US.TRANSFER_OUT],
];

function mapSchwabAction(actionRaw) {
  const head = String(actionRaw ?? "").trim().split(/[,;]/)[0].trim();
  if (!head) return null;
  for (const [re, op] of SCHWAB_ACTION_TO_OP) if (re.test(head)) return op;
  return OP_US.OTHER;
}

/**
 * 稳定 history_id。`CSV|` 前缀是历史包袱（源自早先的嘉信 CSV 导入），库里全部既有美股
 * 记录都按这个公式生成 —— **不要改公式**：改了会为同一批成交生成新主键，
 * 与旧记录并存、收益翻倍，而且本技能没有删除能力，只能靠手工清库挽救。
 */
function stableHistoryId(account, entryDateTime, code, op, qty, price) {
  const raw = `CSV|${account}|${entryDateTime}|${code}|${op}|${qty}|${round4(price)}`;
  return createHash("sha1").update(raw).digest("hex").slice(0, 24);
}

/** 同日同参数重复成交：追加出现序号，避免主键互相覆盖 */
function dedupeHistoryIds(records) {
  const seen = new Map();
  for (const r of records) {
    const n = (seen.get(r.history_id) || 0) + 1;
    seen.set(r.history_id, n);
    if (n > 1) r.history_id = `${r.history_id.slice(0, 22)}x${pad2(n)}`;
  }
  return records;
}

/** 成交按 1 股拆成多条（配对脚本按 1 股粒度匹配） */
function splitToShares(r) {
  const n = r.entry_count;
  if (!(n > 1)) return [r];
  const perShare = round4(r.entry_money / n);
  const base = stableHistoryId(r.account_name, r.entry_date_time, r.code, r.op, 1, r.entry_price);
  const out = [];
  for (let k = 0; k < n; k += 1) {
    out.push({ ...r, entry_count: 1, entry_money: perShare, entry_cost: perShare, history_id: base });
  }
  return out;
}

/** 账户 id 由账户名派生，跨机器稳定；换账户名等于另起一套记录，勿随意改 --account */
const schwabAccountId = (accountName) => "US-" + createHash("sha1").update(accountName).digest("hex").slice(0, 10);

/**
 * 接口一行 -> t_trade_record 记录（列名即键名，插入顺序由 TRADE_COLUMNS 决定）
 * @returns {{record: object|null, warning: string|null, date: string|null}}
 */
function normalizeSchwabTrade(item, ctx) {
  const date = parseSchwabDate(item.transactionDate);
  if (!date) return { record: null, warning: `日期无法解析: "${item.transactionDate}" ${item.action || ""}`, date: null };

  const action = String(item.action || "").trim();
  const symbol = String(item.symbol || "").trim().toUpperCase();
  // 嘉信的利息/出入金等现金流水没有 symbol，无法进入配对，跳过并告警
  if (!symbol) return { record: null, warning: `${date} ${action || "未知类型"}: 无证券代码（现金类流水），跳过`, date };

  const op = mapSchwabAction(action);
  if (!op) return { record: null, warning: `${date}: 缺少交易类型，跳过`, date };

  const entryDateTime = `${date} ${SCHWAB_ENTRY_TIME}`;
  const rawQty = Math.abs(parseSchwabMoney(item.shareQuantity));
  const rawPrice = Math.abs(parseSchwabMoney(item.executionPrice));
  let amount = Math.abs(parseSchwabMoney(item.amount));
  if (Number.isNaN(amount)) amount = (Number.isNaN(rawQty) ? 0 : rawQty) * (Number.isNaN(rawPrice) ? 0 : rawPrice);

  let qty = rawQty;
  let price = rawPrice;
  if (Number.isNaN(rawQty) && Number.isNaN(rawPrice)) {
    // 派息类流水 Quantity/Price 为空：金额可用则按数量 0 入库（不参与配对）
    if (op === OP_US.BUY || op === OP_US.SELL) {
      return { record: null, warning: `${symbol} ${date}: 买卖流水缺少数量与价格，跳过`, date };
    }
    if (!(amount > 0)) return { record: null, warning: `${symbol} ${date}: 数量、价格与金额均为空，跳过`, date };
    qty = 0;
    price = 0;
  } else {
    // 缺项互推，保证 entry_price / entry_count / entry_money 三者自洽
    if (Number.isNaN(price)) price = rawQty > 0 ? round4(amount / rawQty) : 0;
    if (Number.isNaN(qty)) qty = price > 0 ? Math.round(amount / price) : 0;
    qty = Math.round(qty);
    amount = round4(amount || price * qty);
  }

  let fees = Math.abs(parseSchwabMoney(item.feesAndCommission));
  if (Number.isNaN(fees)) fees = Math.abs(parseSchwabMoney(item.transactionDetail?.commission));
  if (Number.isNaN(fees)) fees = 0;

  return {
    record: {
      account_id: ctx.accountId,
      account_name: ctx.accountName,
      account_type: MARKET_US,
      code: symbol,
      commission: round4(fees),
      entry_cost: round4(amount),
      entry_count: qty,
      entry_date: date,
      entry_money: round4(amount),
      entry_price: round4(price),
      entry_time: SCHWAB_ENTRY_TIME,
      entry_date_time: entryDateTime,
      fee_total: round4(fees),
      history_id: stableHistoryId(ctx.accountName, entryDateTime, symbol, op, qty, price),
      manual_id: ctx.selectedAccountId,
      market_code: MARKET_US,
      name: String(item.description || "").trim() || symbol,
      oid: 0,
      op,
      op_name: action || op,
      transfer_fee: 0, // 美股无过户费
    },
    warning: op === OP_US.OTHER ? `未知交易类型 "${action}"（按不参与配对的流水入库）` : null,
    date,
  };
}

/**
 * 从浏览器会话取 ausgateway 的 Bearer token。
 * token 只存在于本次进程内存，不落盘；页面导航产生的请求头就是唯一的可用来源，
 * 因为嘉信的 access_token 由前端持有并随请求下发。
 */
async function fetchSchwabBearer(page) {
  await page.goto(SCHWAB_SUMMARY_URL);
  await page.sleep(1);
  const url = String(await page.evaluate("location.href").catch(() => ""));
  if (SCHWAB_LOGIN_PATH.test(url)) {
    throw new AuthRequiredError(SCHWAB_SITE, "浏览器未登录嘉信账户", "请先执行 opencli stock login，再重试 opencli stock sync-schwab");
  }

  await page.startNetworkCapture("").catch(() => false);
  // 同一 URL 的第二次 goto 不会真正导航，加时间戳强制页面重新发起 API 请求
  await page.goto(`${SCHWAB_SUMMARY_URL}?probe=${Date.now()}`, { settleMs: 0 }).catch(() => {});

  for (let round = 0; round < SCHWAB_TOKEN_POLL_ROUNDS; round += 1) {
    await page.sleep(SCHWAB_TOKEN_POLL_INTERVAL_S);
    const entries = await page.readNetworkCapture({ retainIncomplete: true }).catch(() => []);
    for (const entry of entries) {
      if (!String(entry.url || "").startsWith(`${SCHWAB_API_BASE}/`)) continue;
      const hit = Object.entries(entry.requestHeaders || {}).find(([k]) => /^authorization$/i.test(k));
      const value = String(hit?.[1] || "").trim();
      if (!value) continue;
      // token 形如 `I0.b2F1dGgy….<payload>@`：字符集不固定（末尾可能带 @），
      // 因此只要求「去掉 Bearer 前缀后无空白且足够长」，不要用白名单把合法 token 判成无效。
      const token = value.replace(/^Bearer\s+/i, "");
      if (token.length >= 20 && !/\s/.test(token)) return `Bearer ${token}`;
    }
  }

  throw new AuthRequiredError(
    SCHWAB_SITE,
    "未能在浏览器请求中捕获到嘉信 API 的 Bearer token（登录态可能已失效）",
    "请重新执行 opencli stock login 后重试",
  );
}

/** 在 ausgateway 同源页面内 POST 一页交易记录 */
async function fetchSchwabTxPage(page, { auth, accountId, bookmark }) {
  const body = {
    accountNickname: "Individual",
    exportType: "Csv",
    includeOptionsInSearch: false,
    isSpsLinkedUkAccount: false,
    selectedAccountId: String(accountId),
    selectedTransactionTypes: SCHWAB_TX_TYPES,
    sortColumn: "Date",
    sortDirection: "Descending",
    symbol: "",
    // 接口只验证过 All：按日期区间取数改由本地过滤完成，避免 timeFrame 取值不确定
    timeFrame: "All",
    bookmark: bookmark ?? null,
    shouldPaginate: true,
  };

  const payload = await page.evaluate(async (req) => {
    try {
      const res = await fetch(req.url, {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: req.auth,
          correlatorid: crypto.randomUUID(),
          "schwab-client-appid": req.appId,
          "schwab-client-channel": "IO",
          "schwab-client-correlid": crypto.randomUUID(),
          "schwab-env": "PROD",
          "schwab-environment": "PROD",
          "schwab-resource-version": "1",
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return { fetchError: String((e && e.message) || e) };
    }
  }, { url: SCHWAB_TX_URL, auth, appId: SCHWAB_APP_ID, timeoutMs: SCHWAB_REQUEST_TIMEOUT_MS, body });

  if (!payload || typeof payload.status !== "number") {
    throw new CommandExecutionError(
      `嘉信接口请求失败: ${payload?.fetchError || "无响应"}`,
      `请确认浏览器可访问 ${SCHWAB_SUMMARY_URL}，且已 opencli stock login`,
    );
  }
  if (payload.status === 401 || payload.status === 403) {
    throw new AuthRequiredError(SCHWAB_SITE, `嘉信接口拒绝请求（HTTP ${payload.status}）`, "请重新执行 opencli stock login 后重试");
  }
  if (payload.status < 200 || payload.status >= 300) {
    throw new CommandExecutionError(`嘉信接口 HTTP ${payload.status}: ${String(payload.text).slice(0, 160)}`);
  }
  try {
    return JSON.parse(payload.text);
  } catch {
    throw new CommandExecutionError(`嘉信接口响应不是合法 JSON: ${String(payload.text).slice(0, 160)}`);
  }
}

/**
 * 分页拉取嘉信交易记录（降序返回，本地按 [startDate, endDate] 过滤）
 * @returns {Promise<{records: object[], warnings: string[], pages: number, fetched: number}>}
 */
async function fetchSchwabRecords(page, { auth, selectedAccountId, accountName, startDate, endDate }) {
  // 换到 API 同源，之后的 fetch 才不受 CORS 限制（文档内容本身是无意义的 unauthorized）
  await page.goto(SCHWAB_ORIGIN_URL, { settleMs: 300 }).catch(() => {});

  const ctx = { accountName, accountId: schwabAccountId(accountName), selectedAccountId };
  const records = [];
  const warnings = [];
  let bookmark = null;
  let pages = 0;
  let fetched = 0;
  let outOfRange = false;

  while (pages < SCHWAB_PAGE_LIMIT && !outOfRange) {
    const data = await fetchSchwabTxPage(page, { auth, accountId: selectedAccountId, bookmark });
    const list = Array.isArray(data.brokerageTransactions) ? data.brokerageTransactions : [];
    pages += 1;
    fetched += list.length;

    for (const item of list) {
      const { record, warning, date } = normalizeSchwabTrade(item, ctx);
      if (warning) warnings.push(warning);
      if (!record) continue;
      if (endDate && date > endDate) continue;
      if (startDate && date < startDate) {
        // 降序返回：一旦早于 start，后面的页只会更早
        outOfRange = true;
        continue;
      }
      if (record.op === OP_US.BUY || record.op === OP_US.SELL) records.push(...splitToShares(record));
      else records.push(record);
    }

    // 末页不再返回游标；游标与本次请求相同则说明没有前进（防死循环）
    const next = data.bookmark;
    const advanced = next && typeof next === "object"
      && JSON.stringify(next) !== JSON.stringify(bookmark);
    log.status(`  ${accountName}: 第 ${pages} 页 ${list.length} 条${outOfRange ? "（已早于起始日期，停止）" : ""}`);
    if (list.length === 0 || outOfRange || !advanced) break;
    bookmark = next;
    await sleep(REQUEST_MIN_INTERVAL_MS);
  }

  if (pages >= SCHWAB_PAGE_LIMIT && !outOfRange) {
    log.warn(`已达分页上限 ${SCHWAB_PAGE_LIMIT}，可能有更早记录未同步（可缩小 --start/--end 区间分段拉取）`);
  }

  return { records: dedupeHistoryIds(records), warnings, pages, fetched };
}

/** sync-schwab 主流程 */
async function syncSchwab(page, kwargs) {
  const accountName = String(kwargs.account || SCHWAB_DEFAULT_ACCOUNT_NAME).trim() || SCHWAB_DEFAULT_ACCOUNT_NAME;
  const selectedAccountId = String(kwargs["account-id"] || SCHWAB_DEFAULT_ACCOUNT_ID).trim() || SCHWAB_DEFAULT_ACCOUNT_ID;
  const dryRun = Boolean(kwargs["dry-run"]);
  const accountId = schwabAccountId(accountName);

  let startDate = "";
  let endDate = "";
  if (kwargs.start || kwargs.end) {
    const { startDate: s, endDate: e } = resolveDateRange(kwargs);
    startDate = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    endDate = `${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}`;
  }
  log.info(`嘉信账户 ${accountName}（${selectedAccountId}）同步范围：${startDate || "不限"} ~ ${endDate || "至今"}`);

  const auth = await fetchSchwabBearer(page);
  log.success(`已复用浏览器会话取得嘉信接口凭证（${auth.length} 字节，仅内存使用）`);

  const { records, warnings, pages, fetched } = await fetchSchwabRecords(page, {
    auth, selectedAccountId, accountName, startDate, endDate,
  });

  if (warnings.length > 0) {
    log.warn(`跳过/提示 ${warnings.length} 条：${warnings.slice(0, 5).join("；")}${warnings.length > 5 ? " …" : ""}`);
  }

  const rows = records.map(toTradeValues);
  await page.goto(SCHWAB_SUMMARY_URL).catch(() => {});

  if (dryRun) {
    log.success(`[dry-run] 接口返回 ${fetched} 条（${pages} 页），解析 ${rows.length} 条待写入，未写库`);
    return [{ account: accountName, fundKey: accountId, written: 0, pages, error: "dry-run" }];
  }
  if (rows.length === 0) {
    log.warn("区间内没有可写入的交易记录（接口已返回 0 条，或全部被日期过滤）");
    return [{ account: accountName, fundKey: accountId, written: 0, pages, error: "" }];
  }

  const db = await openDb();
  try {
    await initSchema(db);
    await insertTrades(db, rows);
    log.success(`嘉信交易记录同步成功：拉取 ${fetched} 条（${pages} 页）→ 写入 ${rows.length} 条（history_id 相同则覆盖，重跑不重复）→ ${DB_PATH}`);
  } finally {
    db.close();
  }

  return [{ account: accountName, fundKey: accountId, written: rows.length, pages, error: "" }];
}

/** 纯函数导出，供 scripts/selftest.js 做主键与金额口径回归（导入即注册命令，但不写库、不联网） */
export const schwabPure = {
  round4, parseSchwabMoney, parseSchwabDate, mapSchwabAction,
  stableHistoryId, dedupeHistoryIds, splitToShares, normalizeSchwabTrade, schwabAccountId,
};

// ============================ 命令 ============================

cli({
  site: "stock",
  name: "init-db",
  access: "write",
  description: "单独初始化本地 DuckDB 表结构（sync 启动时也会自动执行）",
  example: "opencli stock init-db",
  strategy: Strategy.LOCAL,
  browser: false,
  columns: ["table", "label", "rows"],
  func: async () => {
    log.info("数据库路径：" + DB_PATH);

    const db = await openDb();
    try {
      await initSchema(db);
      const rows = [];
      for (const group of SCHEMA_GROUPS) {
        log.success(`${group.label}初始化成功`);
        rows.push({ table: group.table, label: group.label, rows: await countRows(db, group.table) });
      }
      log.success("数据库初始化完成");
      return rows;
    } catch (e) {
      throw new CommandExecutionError(
        `数据库初始化失败: ${e.message || e}`,
        `请检查 ${DB_PATH} 是否可写、是否被其他进程占用`,
      );
    } finally {
      db.close();
    }
  },
});

cli({
  site: "stock",
  name: "sync",
  access: "write",
  description: "复用浏览器登录态初始化 DuckDB，并同步同花顺账户与交易记录（美股请用 opencli stock sync-schwab）",
  example:
    "opencli stock sync                            # 当月\nopencli stock sync 20250101 20260627              # 指定区间\nopencli stock sync 20261001 20261031 --dry-run    # 只解析不写库",
  domain: SITE,
  strategy: Strategy.COOKIE,
  browser: true,
  // 持久会话：write + persistent 会拿到 site:stock 的会话租约，
  // 避免两个 sync 并发抢同一个 DuckDB 单写者锁。
  siteSession: "persistent",
  // 接口要在 tzzb 同源页里 fetch（跨源被 CORS 拦），交给框架预导航；
  // 嘉信那条链路是独立命令 sync-schwab，自己导航到 client.schwab.com，不再被这里拖累。
  navigateBefore: PAGE_URL,
  args: [
    { name: "start", type: "string", positional: true, help: "开始日期 YYYYMMDD，默认当月 1 日" },
    { name: "end", type: "string", positional: true, help: "结束日期 YYYYMMDD，默认当月最后一天" },
    { name: "dry-run", type: "bool", default: false, help: "只拉取与解析，不写库" },
  ],
  columns: ["account", "fundKey", "written", "pages", "error"],
  func: async (page, kwargs) => {
    const dryRun = Boolean(kwargs["dry-run"]);
    const { startDate, endDate } = resolveDateRange(kwargs);
    // 先确认浏览器登录态，避免建好库、拉到一半才因鉴权失败中断
    const userId = await getSessionUserId(page);

    log.info(`同步范围：${startDate} ~ ${endDate}${dryRun ? "（dry-run，不写库）" : ""}`);

    const db = await openDb();
    try {
      await initSchema(db);
      log.success(`数据库初始化成功：${DB_PATH}`);

      const accounts = await fetchAccounts(page, userId);
      if (accounts.length === 0) {
        throw new EmptyResultError("opencli stock sync", "接口未返回任何资金账户，请确认浏览器登录的账号");
      }
      if (!dryRun) await saveAccounts(db, accounts);
      log.success(`账户同步成功：${accounts.length} 个（${accounts.map((a) => a.manualname || a.fund_key).join("、")}）`);

      const results = [];
      let writtenTotal = 0;
      for (const account of accounts) {
        const { fund_key: fundKey, manualname: accountName } = account;
        try {
          const { rows, pages } = await fetchTradeRows(page, fundKey, startDate, endDate, accountName, userId);
          if (!dryRun) await insertTrades(db, rows);
          writtenTotal += rows.length;
          results.push({ account: accountName || "未知账户", fundKey, written: dryRun ? 0 : rows.length, pages, error: dryRun ? "dry-run" : "" });
          log.status(`  ${accountName || fundKey}: ${dryRun ? "解析" : "写入"} ${rows.length} 条`);
        } catch (e) {
          if (e instanceof AuthRequiredError) throw e;
          log.error(`  ${accountName || fundKey} 同步失败: ${e.message}`);
          results.push({ account: accountName || "未知账户", fundKey, written: 0, pages: 0, error: e.message });
        }
      }

      const failed = results.filter((r) => r.error && r.error !== "dry-run");
      if (failed.length > 0) {
        log.error(`交易记录同步失败：${failed.length}/${results.length} 个账户出错，其余账户已写入 ${writtenTotal} 条 → ${DB_PATH}`);
        throw new CommandExecutionError(
          `${failed.length}/${results.length} 个账户同步失败（其余已成功写入）`,
          failed.map((r) => `${r.account}: ${r.error}`).join("; "),
        );
      }
      log.success(dryRun
        ? `交易记录解析完成：共 ${writtenTotal} 条，未写库`
        : `交易记录同步成功：共写入 ${writtenTotal} 条（已存在的记录按 history_id 覆盖更新）→ ${DB_PATH}`);
      return results;
    } finally {
      db.close();
    }
  },
});

cli({
  site: "stock",
  name: "sync-schwab",
  access: "write",
  description: "同步嘉信证券(Schwab)美股交易记录到本地 DuckDB（复用 opencli stock login 的浏览器会话）",
  example:
    "opencli stock login                             # 先登录，浏览器会话保持嘉信登录态\nopencli stock sync-schwab                           # 全量（接口 timeFrame=All，本地不过滤）\nopencli stock sync-schwab 20261001 20261031         # 指定区间\nopencli stock sync-schwab 20261001 20261031 --dry-run",
  domain: SCHWAB_SITE,
  strategy: Strategy.UI,
  browser: true,
  // 持久会话：与 opencli stock login 共用 site:stock 的已登录标签页，
  // 否则每次都要重新走一遍嘉信登录跳转；write + persistent 还会拿到会话租约，
  // 避免两个 sync 并发抢同一个 DuckDB 单写者锁。
  siteSession: "persistent",
  // 预导航交给 func：fetchSchwabBearer 会先 goto 账户总览页触发接口请求，
  // 从浏览器请求头里取 Bearer token，再导航到 ausgateway 源下同源调用交易接口。
  navigateBefore: false,
  args: [
    { name: "start", type: "string", positional: true, help: "开始日期 YYYYMMDD，不给=不限（接口只支持全量拉取，区间靠本地过滤）" },
    { name: "end", type: "string", positional: true, help: "结束日期 YYYYMMDD，不给=至今" },
    { name: "account", type: "string", default: SCHWAB_DEFAULT_ACCOUNT_NAME, help: "账户名（写入 account_name，account_id 由其派生；改名等于另起一套记录，会重复计收益）" },
    { name: "account-id", type: "string", default: SCHWAB_DEFAULT_ACCOUNT_ID, help: "嘉信账号 selectedAccountId（同时写入 manual_id）" },
    { name: "dry-run", type: "bool", default: false, help: "只拉取与解析，不写库" },
    // 声明 timeout 后框架按此值下发整条命令 deadline；默认 60s 不够「导航取 token + 多页拉取」。
    { name: "timeout", type: "int", default: 300, help: "整条命令超时秒数（默认 300）" },
  ],
  columns: ["account", "fundKey", "written", "pages", "error"],
  func: async (page, kwargs) => syncSchwab(page, kwargs),
});
