import { withDb } from './db.js';

async function getYaoMingBiAll() {
  return await withDb(async (conn) => {
    const rows = await conn.all("SELECT * FROM t_trade_matched_record WHERE code = '02269' ORDER BY sell_time DESC LIMIT 5");
    return rows;
  });
}

getYaoMingBiAll().then(rows => {
  if (!rows || rows.length === 0) { console.log('No data'); return; }

  console.log('=== 药明生物 (02269) 最近5笔网格交易对比 ===\n');
  console.log('┌────┬─────────────────┬──────────┬──────────┬────┬────────────┬────────────┐');
  console.log('│ #  │ 卖出时间        │ 卖出价   │ 买入价   │ 量 │ 理论收益   │ 实际收益   │');
  console.log('├────┼─────────────────┼──────────┼──────────┼────┼────────────┼────────────┤');

  rows.forEach((row, i) => {
    const sellTime = new Date(Number(row.sell_time.micros) / 1000);
    const sellPrice = parseFloat(row.sell_entry_price.toString());
    const buyPrice = parseFloat(row.buy_entry_price.toString());
    const count = parseInt(row.sell_entry_count);
    const actualProfit = parseFloat(row.profit.toString());
    const theoreticalProfit = (sellPrice - buyPrice) * count;

    const timeStr = sellTime.toLocaleTimeString();
    const dateStr = sellTime.toISOString().split('T')[0];

    console.log('│ ' + (i+1).toString().padEnd(2) + ' │ ' + dateStr + ' ' + timeStr.padEnd(15) + ' │ ' +
      sellPrice.toFixed(4).padEnd(8) + ' │ ' + buyPrice.toFixed(4).padEnd(8) + ' │ ' +
      count.toString().padStart(2) + ' │ ' + theoreticalProfit.toFixed(2).padEnd(12) + ' │ ' +
      actualProfit.toFixed(2).padEnd(12) + ' │');
  });

  console.log('└────┴─────────────────┴──────────┴──────────┴────┴────────────┴────────────┘\n');
  console.log('说明：理论收益 = (卖出价 - 买入价) × 数量（仅股价差价，未考虑手续费）');
  console.log('      实际收益 = 系统记录的网格盈利（已扣除买卖双向手续费净额）');
}).catch(e => console.error(e));