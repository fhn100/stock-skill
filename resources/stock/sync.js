import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
import { log } from "@jackwener/opencli/logger";
import { DuckDBInstance } from "@duckdb/node-api";
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
  description: "复用浏览器登录态初始化 DuckDB，并同步同花顺账户与交易记录",
  example: "opencli stock sync [startYYYYMMDD] [endYYYYMMDD]",
  domain: SITE,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: PAGE_URL,
  args: [
    { name: "start", type: "string", positional: true, help: "开始日期 YYYYMMDD，默认当月 1 日" },
    { name: "end", type: "string", positional: true, help: "结束日期 YYYYMMDD，默认当月最后一天" },
  ],
  columns: ["account", "fundKey", "written", "pages", "error"],
  func: async (page, kwargs) => {
    const { startDate, endDate } = resolveDateRange(kwargs);
    // 先确认浏览器登录态，避免建好库、拉到一半才因鉴权失败中断
    const userId = await getSessionUserId(page);

    log.info(`同步范围：${startDate} ~ ${endDate}`);

    const db = await openDb();
    try {
      await initSchema(db);
      log.success(`数据库初始化成功：${DB_PATH}`);

      const accounts = await fetchAccounts(page, userId);
      if (accounts.length === 0) {
        throw new EmptyResultError("opencli stock sync", "接口未返回任何资金账户，请确认浏览器登录的账号");
      }
      await saveAccounts(db, accounts);
      log.success(`账户同步成功：${accounts.length} 个（${accounts.map((a) => a.manualname || a.fund_key).join("、")}）`);

      const results = [];
      let writtenTotal = 0;
      for (const account of accounts) {
        const { fund_key: fundKey, manualname: accountName } = account;
        try {
          const { rows, pages } = await fetchTradeRows(page, fundKey, startDate, endDate, accountName, userId);
          await insertTrades(db, rows);
          writtenTotal += rows.length;
          results.push({ account: accountName || "未知账户", fundKey, written: rows.length, pages, error: "" });
          log.status(`  ${accountName || fundKey}: 写入 ${rows.length} 条`);
        } catch (e) {
          if (e instanceof AuthRequiredError) throw e;
          log.error(`  ${accountName || fundKey} 同步失败: ${e.message}`);
          results.push({ account: accountName || "未知账户", fundKey, written: 0, pages: 0, error: e.message });
        }
      }

      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        log.error(`交易记录同步失败：${failed.length}/${results.length} 个账户出错，其余账户已写入 ${writtenTotal} 条 → ${DB_PATH}`);
        throw new CommandExecutionError(
          `${failed.length}/${results.length} 个账户同步失败（其余已成功写入）`,
          failed.map((r) => `${r.account}: ${r.error}`).join("; "),
        );
      }
      log.success(`交易记录同步成功：共写入 ${writtenTotal} 条（已存在的记录按 history_id 覆盖更新）→ ${DB_PATH}`);
      return results;
    } finally {
      db.close();
    }
  },
});
