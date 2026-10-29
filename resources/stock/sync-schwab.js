/**
 * opencli stock sync-schwab —— 同步嘉信证券(Schwab)美股交易记录。
 * 从浏览器会话取 Bearer token 后同源调用 ausgateway 交易接口，买卖按 1 股拆分入库。
 * 建表/连接等共用逻辑在 sync-common.js，同花顺同步见 sync-tzzb.js。
 */
import { cli, Strategy } from "@jackwener/opencli/registry";
import { AuthRequiredError, ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
import { log } from "@jackwener/opencli/logger";
import { createHash } from "node:crypto";
import {
  DB_PATH, TABLE, REQUEST_MIN_INTERVAL_MS, sleep,
  resolveDateRange, openDb, initSchema, insertTrades, toTradeValues,
} from "./sync-common.js";

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

// ============================ 嘉信（Schwab）交易记录 ============================

const pad2 = (n) => String(n).padStart(2, "0");
/**
 * 接口的「今天」按美东日期判定：北京早上时美东仍在前一天，
 * 直接给本机日期（北京）会被服务端判成未来日期而 400。
 */
const schwabToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
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
/**
 * 接口日期 "MM/DD/YYYY" → "YYYY-MM-DD"。
 * MoneyLink 转账等流水带后缀："10/03/2025 as of 10/02/2025"，取前面那个交易日。
 */
function parseSchwabDate(raw) {
  const m = String(raw ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+as of\s+.*)?$/i);
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

/** 已知的现金流水动作（无订单号、不参与配对）：照常入库，但不报「未知交易类型」 */
const SCHWAB_KNOWN_CASH_ACTION = /^(moneylink transfer|margin interest|credit interest|service fee|foreign\s?tax)/i;

/**
 * 回退用稳定 history_id（`CSV|` 前缀是历史包袱，源自早先的嘉信 CSV 导入）。
 * 成交记录的主键已改用券商订单号 schwabOrderId，这个哈希公式只服务**无订单号**的
 * 现金流水（出入金/利息等，schwabOrderId 为 0）—— 同样不要改公式：改了会为同一批
 * 流水生成新主键，与旧记录并存，而且本技能没有删除能力，只能靠手工清库挽救。
 */
function stableHistoryId(account, entryDateTime, code, op, qty, price) {
  const raw = `CSV|${account}|${entryDateTime}|${code}|${op}|${qty}|${round4(price)}`;
  return createHash("sha1").update(raw).digest("hex").slice(0, 24);
}

/**
 * 主键取值：成交记录优先用接口 schwabOrderId（逐笔订单号，跨重跑天然幂等）。
 * 不要用 itemIssueId：实测它跟证券绑定（同一只 TSLA 的所有成交共用 1948561409），
 * 拿它当主键会让同股全部成交挤在一个 base 键上、靠顺序分配的 x02 区分，
 * 新增成交即整体错位覆盖。
 * schwabOrderId 为 0/缺失的记录（老交易、现金流水）回退哈希公式。
 */
function schwabHistoryId(item, ctx, entryDateTime, code, op, qty, price) {
  const orderId = String(item.schwabOrderId ?? "").trim();
  return orderId && orderId !== "0"
    ? orderId
    : stableHistoryId(ctx.accountName, entryDateTime, code, op, qty, price);
}

/** 同主键重复（现金流水可能同日同参数；订单号理论唯一）：追加出现序号，避免互相覆盖 */
function dedupeHistoryIds(records) {
  const seen = new Map();
  for (const r of records) {
    const n = (seen.get(r.history_id) || 0) + 1;
    seen.set(r.history_id, n);
    if (n > 1) {
      // 拆股键形如 <主键>_3：后缀是股权序号，截断会把它吃掉，只在末尾追加去重标记
      const split = /^(.*_\d+)$/.exec(r.history_id);
      r.history_id = split
        ? `${split[1]}x${pad2(n)}`
        : `${r.history_id.slice(0, 22)}x${pad2(n)}`;
    }
  }
  return records;
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
  // 现金类流水（出入金/利息/手续费）没有 symbol：code 记空串照样入库，
  // op 为 6/18/19/99 本就不参与买卖配对，仅作账户流水留痕
  const symbol = String(item.symbol || "").trim().toUpperCase();

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

  // 交易费用口径（用户已定）：commission/fee_total 记接口 feesAndCommission。
  // 注意接口 amount 已是扣费后净额，profit 的 netMoneyOf 会再减一次 commission
  // （卖单合计约 0.65），属已知且接受的口径。
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
      history_id: schwabHistoryId(item, ctx, entryDateTime, symbol, op, qty, price),
      manual_id: ctx.selectedAccountId,
      market_code: MARKET_US,
      name: String(item.description || "").trim() || symbol || action, // 现金流水无代码时记动作名
      oid: 0,
      op,
      op_name: action || op,
      transfer_fee: 0, // 美股无过户费
    },
    warning: op === OP_US.OTHER && !SCHWAB_KNOWN_CASH_ACTION.test(action)
      ? `未知交易类型 "${action}"（按不参与配对的流水入库）`
      : null,
    date,
  };
}

/**
 * 买卖成交按 1 股拆成多条（配对脚本按 1 股粒度匹配，整笔 qty>1 无法与单股成交配对）：
 * - 金额 / 费用按股均摊，除不尽的尾差落在最后一条，保证拆分前后合计不变
 * - 主键 = 原主键（订单号或哈希）+ "_" + 股序号（1 起）；qty=1 保持原主键不加后缀
 * - 现金流水（op=6/18/19/99）不拆
 */
function splitSchwabShares(r) {
  const n = r.entry_count;
  if (!(n > 1) || (r.op !== OP_US.BUY && r.op !== OP_US.SELL)) return [r];
  const perMoney = round4(r.entry_money / n);
  const perFee = round4(r.commission / n);
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const last = i === n;
    const money = last ? round4(r.entry_money - perMoney * (n - 1)) : perMoney;
    const fee = last ? round4(r.commission - perFee * (n - 1)) : perFee;
    out.push({
      ...r,
      entry_count: 1,
      entry_money: money,
      entry_cost: money,
      commission: fee,
      fee_total: fee,
      history_id: `${r.history_id}_${i}`,
    });
  }
  return out;
}

/**
 * 订单号键（拆股后形如 `1007298688974_2`）；哈希键是 24 位十六进制（拆股后同样带 `_序号`）。
 * 仅用于区分「这笔成交用的是哪种主键」，不参与主键生成。
 */
const isSchwabOrderKey = (id) => /^\d+(_\d+)?$/.test(String(id));

/** 成交内容签名：同一笔成交无论接口是否给 schwabOrderId，这些字段都一致 */
const schwabTradeSignature = (r) =>
  [r.entry_date_time, r.code, r.op, Number(r.entry_count), round4(r.entry_price), round4(r.entry_money)].join("|");

/**
 * 嘉信接口的 schwabOrderId 偶发时有时无（实测 2026-10-27：2026-02-10 TSLA 卖出 1 股 @425
 * 第一次返回 `1005383223451`、随后几次返回 `"0"`），同一笔成交会分别生成订单号键与哈希键。
 * 按内容签名去重：同一签名下若只有另一种键，说明是同一笔的另一种表示，跳过本次写入；
 * 同一种键的重复内容照常保留（如同日同价的多笔独立委托）。
 * @param {object[]} records 归一化并拆股后的记录
 * @param {object[]} existingRows 库中同账户的买卖记录（history_id + 内容字段）
 * @returns {{records: object[], skipped: number}}
 */
function dropShadowSchwabTrades(records, existingRows = []) {
  const classesOf = (rows, get) => {
    const m = new Map();
    for (const row of rows) {
      const r = get(row);
      if (r.op !== OP_US.BUY && r.op !== OP_US.SELL) continue;
      const sig = schwabTradeSignature(r);
      const set = m.get(sig) || new Set();
      set.add(isSchwabOrderKey(r.history_id) ? "order" : "hash");
      m.set(sig, set);
    }
    return m;
  };

  const existing = classesOf(existingRows, (row) => row);
  const seen = new Map();
  let skipped = 0;
  const kept = [];
  // 同一批里订单号键优先，避免与哈希键并存时保留错的那条
  const ordered = [...records].sort(
    (a, b) => Number(isSchwabOrderKey(b.history_id)) - Number(isSchwabOrderKey(a.history_id)),
  );
  for (const r of ordered) {
    if (r.op !== OP_US.BUY && r.op !== OP_US.SELL) {
      kept.push(r);
      continue;
    }
    const sig = schwabTradeSignature(r);
    const cls = isSchwabOrderKey(r.history_id) ? "order" : "hash";
    const before = new Set([...(existing.get(sig) || []), ...(seen.get(sig) || [])]);
    if (before.size > 0 && !before.has(cls)) {
      skipped += 1;
      continue;
    }
    const set = seen.get(sig) || new Set();
    set.add(cls);
    seen.set(sig, set);
    kept.push(r);
  }
  return { records: kept, skipped };
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
    throw new AuthRequiredError(SCHWAB_SITE, "浏览器未登录嘉信账户", "请先执行 opencli stock login-schwab，再重试 opencli stock sync-schwab");
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
    "请重新执行 opencli stock login-schwab 后重试",
  );
}

/**
 * 在 ausgateway 同源页面内 POST 一页交易记录。
 * 日期区间交给服务端过滤：timeFrame=SpecifyDateRange + fromDate/toDate（YYYY-MM-DD），
 * 与嘉信页面「导出 CSV」发出的请求体一致；服务端只返回区间内记录，月同步约一页。
 */
async function fetchSchwabTxPage(page, { auth, accountId, bookmark, startDate, endDate }) {
  const body = {
    accountNickname: "Individual",
    exportType: "Csv",
    fromDate: startDate,
    includeOptionsInSearch: false,
    isSpsLinkedUkAccount: false,
    selectedAccountId: String(accountId),
    selectedTransactionTypes: SCHWAB_TX_TYPES,
    sortColumn: "Date",
    sortDirection: "Descending",
    symbol: "",
    timeFrame: "SpecifyDateRange",
    toDate: endDate,
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
      `请确认浏览器可访问 ${SCHWAB_SUMMARY_URL}，且已 opencli stock login-schwab`,
    );
  }
  if (payload.status === 401 || payload.status === 403) {
    throw new AuthRequiredError(SCHWAB_SITE, `嘉信接口拒绝请求（HTTP ${payload.status}）`, "请重新执行 opencli stock login-schwab 后重试");
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
 * 分页拉取嘉信交易记录（降序返回）
 * 日期区间由服务端过滤（fromDate/toDate），本地仍按 [startDate, endDate] 兜一层：
 * 服务端若忽略区间或边界多返回几条，也不会污染库或白拉更多页。
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
    const data = await fetchSchwabTxPage(page, { auth, accountId: selectedAccountId, bookmark, startDate, endDate });
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
      records.push(...splitSchwabShares(record));
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
    log.warn(`已达分页上限 ${SCHWAB_PAGE_LIMIT}，可能有更早记录未同步（可显式传入 start/end 区间分段拉取）`);
  }

  return { records: dedupeHistoryIds(records), warnings, pages, fetched };
}

/** sync-schwab 主流程 */
async function syncSchwab(page, kwargs) {
  const accountName = String(kwargs.account || SCHWAB_DEFAULT_ACCOUNT_NAME).trim() || SCHWAB_DEFAULT_ACCOUNT_NAME;
  const selectedAccountId = String(kwargs["account-id"] || SCHWAB_DEFAULT_ACCOUNT_ID).trim() || SCHWAB_DEFAULT_ACCOUNT_ID;
  const dryRun = Boolean(kwargs["dry-run"]);
  const accountId = schwabAccountId(accountName);

  // 默认只同步当月（与 sync-tzzb 一致）；区间下发给接口（fromDate/toDate + SpecifyDateRange），
  // 由服务端过滤，月同步只需一页左右。回补历史时显式传入 start/end，
  // 例如 opencli stock sync-schwab 20240101 20261031。
  const { startDate: s, endDate: e } = resolveDateRange(kwargs);
  const startDate = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  let endDate = `${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}`;
  // 接口拒绝未来日期（400 "ToDate cannot be a date in the future"）。默认当月月末通常还在未来，
  // 必须夹到美东的今天，否则每月中旬前同步必然失败。
  const today = schwabToday();
  if (endDate > today) {
    log.info(`结束日期 ${endDate} 晚于今天，接口不允许未来日期，按 ${today} 同步`);
    endDate = today;
  }
  if (startDate > endDate) {
    throw new ArgumentError(`同步区间 ${startDate} ~ ${endDate} 无效：开始日期晚于美东今天（${today}）`);
  }
  log.info(`嘉信账户 ${accountName}（${selectedAccountId}）同步范围：${startDate} ~ ${endDate}`);

  const auth = await fetchSchwabBearer(page);
  log.success(`已复用浏览器会话取得嘉信接口凭证（${auth.length} 字节，仅内存使用）`);

  const { records, warnings, pages, fetched } = await fetchSchwabRecords(page, {
    auth, selectedAccountId, accountName, startDate, endDate,
  });

  if (warnings.length > 0) {
    log.warn(`跳过/提示 ${warnings.length} 条：${warnings.slice(0, 5).join("；")}${warnings.length > 5 ? " …" : ""}`);
  }

  const parsed = records.length;
  await page.goto(SCHWAB_SUMMARY_URL).catch(() => {});

  if (dryRun) {
    log.success(`[dry-run] 接口返回 ${fetched} 条（${pages} 页），解析 ${parsed} 条待写入，未写库`);
    return [{ account: accountName, fundKey: accountId, written: 0, pages, error: "dry-run" }];
  }
  if (parsed === 0) {
    log.warn("区间内没有可写入的交易记录（接口按 fromDate/toDate 返回 0 条，或全部被日期过滤）");
    return [{ account: accountName, fundKey: accountId, written: 0, pages, error: "" }];
  }

  const db = await openDb();
  let written = 0;
  try {
    await initSchema(db);
    // 接口偶尔同一笔成交给/不给 schwabOrderId，两种主键并存会重复计收益，写入前按内容签名去重
    const existing = await db.all(
      `SELECT history_id, entry_date_time, code, op, entry_count, entry_price, entry_money
         FROM ${TABLE.TRADE_RECORD}
        WHERE market_code = ? AND account_id = ? AND op IN (?, ?)`,
      [MARKET_US, accountId, OP_US.BUY, OP_US.SELL],
    );
    const { records: fresh, skipped } = dropShadowSchwabTrades(records, existing);
    if (skipped > 0) {
      log.warn(`跳过 ${skipped} 条与库中成交内容重复的流水（接口 schwabOrderId 时有时无，同一笔只保留一种键）`);
    }
    const rows = fresh.map(toTradeValues);
    await insertTrades(db, rows);
    written = rows.length;
    log.success(`嘉信交易记录同步成功：拉取 ${fetched} 条（${pages} 页）→ 写入 ${written} 条（history_id 相同则覆盖，重跑不重复）→ ${DB_PATH}`);
  } finally {
    db.close();
  }

  return [{ account: accountName, fundKey: accountId, written, pages, error: "" }];
}

/** 纯函数导出，供 scripts/selftest.js 做主键与金额口径回归（导入即注册命令，但不写库、不联网） */
export const schwabPure = {
  round4, parseSchwabMoney, parseSchwabDate, mapSchwabAction,
  stableHistoryId, schwabHistoryId, dedupeHistoryIds, splitSchwabShares, dropShadowSchwabTrades,
  normalizeSchwabTrade, schwabAccountId,
};

cli({
  site: "stock",
  name: "sync-schwab",
  access: "write",
  description: "同步嘉信证券(Schwab)美股交易记录到本地 DuckDB（默认当月，可给日期区间回补；复用 opencli stock login-schwab 的浏览器会话）",
  example:
    "opencli stock login-schwab                          # 先登录，浏览器会话保持嘉信登录态\nopencli stock sync-schwab                           # 当月（默认）\nopencli stock sync-schwab 20261001 20261031         # 指定区间\nopencli stock sync-schwab 20240101 20261031         # 回补更早的历史区间\nopencli stock sync-schwab 20261001 20261031 --dry-run",
  domain: SCHWAB_SITE,
  strategy: Strategy.UI,
  browser: true,
  // 持久会话：与 opencli stock login-schwab 共用 site:stock 的已登录标签页，
  // 否则每次都要重新走一遍嘉信登录跳转；write + persistent 还会拿到会话租约，
  // 避免多个同步命令并发抢同一个 DuckDB 单写者锁。
  siteSession: "persistent",
  // 预导航交给 func：fetchSchwabBearer 会先 goto 账户总览页触发接口请求，
  // 从浏览器请求头里取 Bearer token，再导航到 ausgateway 源下同源调用交易接口。
  navigateBefore: false,
  args: [
    { name: "start", type: "string", positional: true, help: "开始日期 YYYYMMDD，默认当月 1 日" },
    { name: "end", type: "string", positional: true, help: "结束日期 YYYYMMDD，默认 start 所在月月末（不给 start 时为当月月末）；晚于今天时按今天处理（接口拒绝未来日期）" },
    { name: "account", type: "string", default: SCHWAB_DEFAULT_ACCOUNT_NAME, help: "账户名（写入 account_name，account_id 由其派生；改名等于另起一套记录，会重复计收益）" },
    { name: "account-id", type: "string", default: SCHWAB_DEFAULT_ACCOUNT_ID, help: "嘉信账号 selectedAccountId（同时写入 manual_id）" },
    { name: "dry-run", type: "bool", default: false, help: "只拉取与解析，不写库" },
    // 声明 timeout 后框架按此值下发整条命令 deadline；默认 60s 不够「导航取 token + 多页拉取」。
    { name: "timeout", type: "int", default: 300, help: "整条命令超时秒数（默认 300）" },
  ],
  columns: ["account", "fundKey", "written", "pages", "error"],
  func: async (page, kwargs) => syncSchwab(page, kwargs),
});

