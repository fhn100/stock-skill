/**
 * opencli stock sync-tzzb —— 同步同花顺（A 股/港股）账户与交易记录。
 * 复用浏览器登录态，接口在浏览器上下文内发起；幂等写入（同主键覆盖）。
 * 建表/连接等共用逻辑在 sync-common.js，美股同步见 sync-schwab.js。
 */
import { cli, Strategy } from "@jackwener/opencli/registry";
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
import { log } from "@jackwener/opencli/logger";
import {
  DB_PATH, TABLE, SCHEMA_GROUPS, REQUEST_MIN_INTERVAL_MS, sleep,
  resolveDateRange, openDb, initSchema, countRows, insertTrades, toTradeValues,
} from "./sync-common.js";

// ============================ 常量 ============================

const SITE = "tzzb.10jqka.com.cn";
const PAGE_URL = `https://${SITE}/pc/index.html`;
const API_BASE = `https://${SITE}/caishen_httpserver/tzzb`;
const API_PATH = {
  ACCOUNT_LIST: "/caishen_fund/pc/account/v1/account_list",
  TRADE_HISTORY: "/caishen_fund/pc/account/v2/get_money_history",
};

const FUND_KEY_TYPE = "fund_key";
const PAGE_SIZE = 1000;
const FETCH_TIMEOUT_MS = 15000;

// ============================ API 请求 ============================

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

// ============================ 账户字典 ============================

async function saveAccounts(db, accounts) {
  for (const item of accounts) {
    await db.conn.run(
      `INSERT OR REPLACE INTO ${TABLE.DICT}(key, type, value) VALUES(?, ?, ?)`,
      [item.fund_key, FUND_KEY_TYPE, item.manualname ?? ""],
    );
  }
}

// ============================ 命令 ============================

cli({
  site: "stock",
  name: "init-db",
  access: "write",
  description: "单独初始化本地 DuckDB 表结构（sync-tzzb 启动时也会自动执行）",
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
  name: "sync-tzzb",
  access: "write",
  description: "复用浏览器登录态初始化 DuckDB，并同步同花顺账户与交易记录（美股请用 opencli stock sync-schwab）",
  example:
    "opencli stock sync-tzzb                               # 当月\nopencli stock sync-tzzb 20250101 20260627             # 指定区间\nopencli stock sync-tzzb 20261001 20261031 --dry-run   # 只解析不写库",
  domain: SITE,
  strategy: Strategy.COOKIE,
  browser: true,
  // 持久会话：write + persistent 会拿到 site:stock 的会话租约，
  // 避免多个同步命令并发抢同一个 DuckDB 单写者锁。
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
        throw new EmptyResultError("opencli stock sync-tzzb", "接口未返回任何资金账户，请确认浏览器登录的账号");
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

