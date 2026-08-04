import { withDb } from './db.js';

async function getYaoMingBiDetails() {
  return await withDb(async (conn) => {
    const rows = await conn.all(`SELECT * FROM t_trade_matched_record WHERE code = '02269' ORDER BY sell_time DESC LIMIT 5`);
    return rows;
  });
}

getYaoMingBiDetails().then(rows => {
  rows.forEach((r, i) => {
    const sellEntryPrice = parseFloat(r.sell_entry_price.toString());
    const buyEntryPrice = parseFloat(r.buy_entry_price.toString());
    const sellEntryCount = parseInt(r.sell_entry_count || 0);
    const profit = parseFloat(r.profit.toString());
    
    console.log('第' + (i+1) + '笔:');
    console.log('  卖出价: ' + sellEntryPrice.toFixed(4) + ', 买入价: ' + buyEntryPrice.toFixed(4));
    console.log('  数量: ' + sellEntryCount);
    console.log('  计算收益: ' + ((sellEntryPrice - buyEntryPrice) * sellEntryCount).toFixed(2));
    console.log('  记录收益: ' + profit.toFixed(2));
    console.log('');
  });
}).catch(e => console.error(e));