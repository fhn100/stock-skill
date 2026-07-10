import { getCookie, getUserId, checkCookieValid } from "./utils.js";
import { TABLE, PAGE_SIZE, API_BASE, API_PATH, HTTP_HEADERS, API_DEFAULTS, DICT_TYPE, SYNC_CONCURRENCY, MATCH_MAX_ITERATIONS } from "./constants.js";
import { SQL, withDb } from "./db.js";
import { INSERT_ACCOUNT, INSERT_TRADE } from "./sql-sync.js";

// ============================ HTTP 请求工具 ============================

/**
 * 发起 POST 请求
 * @param {string} url - 请求 URL
 * @param {Object} params - 表单参数
 * @param {string} cookie - Cookie
 * @returns {Promise<Object>} JSON 响应
 */
async function postForm(url, params, cookie) {
  const formData = new URLSearchParams(params);
  const headers = {
    ...HTTP_HEADERS,
    cookie,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

// ============================ 数据库初始化 ============================

/** 初始化数据库表结构 */
export async function initDb() {
  await withDb(async (conn) => {
    for (const [name, sql] of Object.entries({
      "字典表": SQL.CREATE_DICT,
      "交易记录表": SQL.CREATE_TRADE_RECORD,
      "交易匹配表": SQL.CREATE_TRADE_MATCHED,
    })) {
      await conn.run(sql);
      console.log(`${name}初始化成功`);
    }
  });
}

// ============================ 账户同步 ============================

/** 同步账户信息到字典表 */
export async function initAccount() {
  checkCookieValid();
  const cookie = getCookie();
  const userId = getUserId();

  // 调用 API 获取账户列表
  const url = `${API_BASE}${API_PATH.ACCOUNT_LIST}`;
  const params = {
    userid: userId,
    user_id: userId,
    terminal: API_DEFAULTS.TERMINAL,
    version: API_DEFAULTS.VERSION,
  };

  const data = await postForm(url, params, cookie);

  // 解析响应并插入数据库
  const common = data?.ex_data?.common || [];
  await withDb(async (conn) => {
    for (const item of common) {
      const fundKey = item.fund_key;
      const manualName = item.manualname;
      if (fundKey) {
        await conn.run(INSERT_ACCOUNT, [fundKey, manualName]);
      }
    }
  });

  console.log("同步账户成功, 共同步", common.length, "条记录");
}

// ============================ 交易记录同步 ============================

/**
 * 按基金KEY同步交易记录（自动分页，带重试）
 * @param {string} fundKey - 基金KEY
 * @param {string} startDate - 开始日期 YYYYMMDD
 * @param {string} endDate - 结束日期 YYYYMMDD
 * @param {number} [page=1] - 页码
 * @param {number} [retryCount=3] - 剩余重试次数
 * @returns {Promise<number>} 同步的记录数
 */
export async function syncTradeByFundKey(fundKey, startDate, endDate, page = 1, retryCount = 3) {
  try {
    checkCookieValid();
    const cookie = getCookie();
    const userId = getUserId();

    // 调用 API 获取交易记录
    const url = `${API_BASE}${API_PATH.SYNC_TRADE}`;
    const params = {
      userid: userId,
      user_id: userId,
      fund_key: fundKey,
      stock_code: '',
      stock_account: '',
      start_date: startDate,
      end_date: endDate,
      page: page.toString(),
      count: PAGE_SIZE.toString(),
      sort_type: '',
      sort_order: '1',
    };

    const data = await postForm(url, params, cookie);
    const exData = data?.ex_data || {};
    const maxPage = exData.max_page || 1;
    const list = exData.list || [];

    // 获取账户名称
    let accountName = '';
    await withDb(async (conn) => {
      const rows = await conn.all(
        `SELECT value FROM ${TABLE.DICT} WHERE key = ? AND type = '${DICT_TYPE.FUND_KEY}'`,
        [fundKey]
      );
      accountName = rows[0]?.value || '';
    });

    // 解析响应并批量插入数据库
    const rows = list.map(item => {
      const entryDateTime = `${item.entry_date} ${item.entry_time}`;
      const entryEpoch = Math.floor(new Date(entryDateTime).getTime() / 1000);
      const historyId = `${item.account_id}${entryEpoch}${item.code}${item.op}${item.entry_count}`;

      return [
        item.account_id,
        accountName,
        item.account_type,
        item.code,
        parseFloat(item.commission) || 0,
        parseFloat(item.entry_cost) || 0,
        item.entry_count,
        item.entry_date,
        parseFloat(item.entry_money) || 0,
        parseFloat(item.entry_price) || 0,
        item.entry_time,
        entryDateTime,
        parseFloat(item.fee_total) || 0,
        historyId,
        item.manual_id,
        item.market_code,
        item.name,
        parseInt(item.oid) || 0,
        item.op,
        item.op_name,
        parseFloat(item.transfer_fee) || 0,
      ];
    });

    await withDb(async (conn) => {
      for (const row of rows) {
        await conn.run(INSERT_TRADE, row);
      }
    });

    const n = list.length;
    console.log(`同步交易记录成功, 账户: ${fundKey}, 页: ${page}/${maxPage}, 记录数: ${n}`);

    if (page < maxPage) {
      await syncTradeByFundKey(fundKey, startDate, endDate, page + 1, retryCount);
    }

    return n;
  } catch (error) {
    if (retryCount > 1) {
      console.warn(`同步交易记录失败, 账户: ${fundKey}, 页: ${page}, 重试中... (${retryCount - 1}/${3})`);
      await new Promise(r => setTimeout(r, 1000));
      return await syncTradeByFundKey(fundKey, startDate, endDate, page, retryCount - 1);
    }
    throw error;
  }
}

/**
 * 同步单个账户（带错误捕获）
 * @param {string} fundKey - 基金 KEY
 * @param {string} startDate - 开始日期
 * @param {string} endDate - 结束日期
 * @returns {Promise<{fundKey: string, success: boolean, error?: string}>} 结果对象
 */
async function syncSingleAccount(fundKey, startDate, endDate) {
  try {
    await syncTradeByFundKey(fundKey, startDate, endDate);
    return { fundKey, success: true };
  } catch (error) {
    console.error(`账户 ${fundKey} 同步失败:`, error.message);
    return { fundKey, success: false, error: error.message };
  }
}

/**
 * 同步一批账户（并行处理）
 * @param {string[]} fundKeys - 基金 KEY 列表
 * @param {string} startDate - 开始日期
 * @param {string} endDate - 结束日期
 * @returns {Promise<{successCount: number, failCount: number}>} 本批次统计
 */
async function syncBatch(fundKeys, startDate, endDate) {
  const results = await Promise.all(
    fundKeys.map((fk) => syncSingleAccount(fk, startDate, endDate))
  );

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  if (failCount > 0) {
    console.warn(`本批次 ${fundKeys.length} 个账户: ${successCount} 成功, ${failCount} 失败`);
  }

  return { successCount, failCount };
}

/**
 * 同步所有账户的交易记录（并行分批处理）
 * @param {string} startDate - 开始日期 YYYYMMDD
 * @param {string} endDate - 结束日期 YYYYMMDD
 * @param {number} [concurrency=3] - 并发数
 */
export async function syncTrade(startDate, endDate, concurrency = SYNC_CONCURRENCY) {
  const fundKeys = await withDb(async (conn) => {
    const rows = await conn.all(`SELECT key FROM ${TABLE.DICT} WHERE type = '${DICT_TYPE.FUND_KEY}'`);
    return rows.map((row) => row.key);
  });

  console.log(`开始同步 ${fundKeys.length} 个账户，并发数: ${concurrency}`);

  for (let i = 0; i < fundKeys.length; i += concurrency) {
    await syncBatch(fundKeys.slice(i, i + concurrency), startDate, endDate);
  }

  console.log("所有账户交易记录同步完成");
}

// ============================ 交易匹配 ============================

/** 匹配交易记录（循环直到无可匹配记录） */
export async function tradeMatch() {
  await withDb(async (conn) => {
    let total = 0;
    let count = -1;
    let iterations = 0;
    while (count !== 0 && iterations < MATCH_MAX_ITERATIONS) {
      const rows = await conn.all(SQL.TRADE_MATCH);
      count = Number(rows[0]?.Count) || 0;
      total += count;
      iterations++;
      if (count > 0) console.log(`匹配交易记录成功, 本轮匹配 ${count} 条`);
    }
    if (iterations >= MATCH_MAX_ITERATIONS && count !== 0) {
      console.warn(`匹配达到安全上限 ${MATCH_MAX_ITERATIONS} 次，可能存在异常数据`);
    }
    console.log(`匹配交易记录完成，本次共新增 ${total} 条匹配`);
  });
}

// ============================ 收益查询 ============================

/**
 * 查询网格收益
 * @param {string} startMonth - 开始月份 YYYY-MM
 * @param {string} endMonth - 结束月份 YYYY-MM
 * @returns {Promise<Array>} 收益数据数组
 */
export async function gridProfit(startMonth, endMonth) {
  return await withDb(async (_conn, stmt) => {
    return await stmt.all(endMonth, startMonth, endMonth, startMonth);
  }, SQL.GRID_PROFIT);
}
