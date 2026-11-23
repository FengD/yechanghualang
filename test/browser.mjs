import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {withContainer} from './docker.js';

const createKey = 'qa-room-owner';
const browser = await chromium.launch({executablePath: process.env.CHROME_BIN});
const issues = [];
const screenshotDir = process.env.SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, {recursive: true});
const screenshot = (page, file) => screenshotDir ? page.screenshot({path: join(screenshotDir, file), fullPage: true}) : undefined;

try {
  await withContainer(async ({base, restart}) => {
    async function newPage(mobile = false) {
      const context = await browser.newContext({viewport: mobile ? {width: 390, height: 844} : {width: 1280, height: 900}});
      const page = await context.newPage();
      page.on('pageerror', error => issues.push(error.message));
      page.on('response', response => {
        if (response.url().startsWith(base) && response.status() >= 400) issues.push(response.status() + ' ' + response.url());
      });
      return page;
    }
    const host = await newPage();
    const member = name => host.locator('#seats').getByText(name, {exact: false});
    await host.goto(base);
    await host.getByRole('heading', {name: '创建拍卖厅'}).waitFor();
    await screenshot(host, 'entry.png');
    await host.getByLabel('你的昵称').fill('馆长');
    await host.getByLabel('房间名称').fill('周末画廊');
    await host.getByLabel('建房密钥').fill(createKey);
    await host.getByLabel('参赛席位').selectOption('3');
    await host.getByLabel('展期数量').selectOption('2');
    await host.getByLabel('策展限时').selectOption('15');
    await host.getByLabel('竞价限时').selectOption('15');
    await host.getByRole('button', {name: '创建房间'}).click();
    await host.getByRole('heading', {name: '周末画廊'}).waitFor();
    await host.getByText('修改房间设置').click();
    await host.locator('#settings-form').getByLabel('初始现金').selectOption('80');
    await host.getByRole('button', {name: '保存设置'}).click();
    await host.getByText('初始 80 点').waitFor();
    const invite = await host.getByLabel('邀请链接').inputValue();

    async function joinRoom(name, role, mobile = false) {
      const page = await newPage(mobile);
      await page.goto(invite);
      await page.getByLabel('你的昵称').fill(name);
      await page.getByLabel('入场方式').selectOption(role);
      await page.getByRole('button', {name: '进入拍卖厅'}).click();
      await page.getByRole('heading', {name: '周末画廊'}).waitFor();
      await member(name).waitFor();
      return page;
    }

    const second = await joinRoom('买手甲', 'play');
    const third = await joinRoom('买手乙', 'play');
    let observer = await joinRoom('看展', 'watch', true);
    await observer.getByRole('button', {name: '席位恢复码'}).click();
    const recovery = await observer.getByLabel('复制下方恢复码').inputValue();
    assert.match(recovery, /^[A-Za-z0-9_-]{32}$/);
    const fresh = await newPage(true);
    await fresh.goto(base);
    await fresh.getByText('使用席位恢复码').click();
    await fresh.getByLabel('席位恢复码', {exact: true}).fill(recovery);
    await fresh.getByRole('button', {name: '恢复席位'}).click();
    await fresh.getByRole('heading', {name: '周末画廊'}).waitFor();
    await observer.getByText('这个席位已在另一个页面连接。').waitFor();
    await observer.context().close();
    observer = fresh;

    await observer.getByRole('button', {name: '规则手册'}).click();
    await observer.getByRole('heading', {name: '最终排名'}).waitFor();
    await observer.getByRole('button', {name: '关闭'}).click();

    const players = [host, second, third];
    const pages = [...players, observer];
    await host.getByRole('button', {name: '开始游戏'}).click();
    await observer.getByRole('heading', {name: '拍品 01 · 选拍品'}).waitFor();
    await restart();
    for (const page of pages) await page.getByText('已连接', {exact: true}).waitFor();

    for (let i = 1; i <= 6; i++) {
      const lot = String(i).padStart(2, '0');
      await Promise.all(pages.map(page => page.getByRole('heading', {name: '拍品 ' + lot + ' · 选拍品'}).waitFor()));
      assert.equal(await observer.locator('#hand').isVisible(), false);
      const curating = await Promise.all(players.map(page => page.getByRole('button', {name: '送拍'}).first().isVisible()));
      const curator = players[curating.indexOf(true)];
      assert.equal(curating.filter(Boolean).length, 1);
      const bidders = players.filter(page => page !== curator);
      await curator.getByRole('button', {name: '送拍'}).first().click();
      const title = '拍品 ' + lot + ' · ' + (i % 2 ? '公开竞价' : '密封报价');
      await Promise.all(pages.map(page => page.getByRole('heading', {name: title}).waitFor()));
      assert.equal(await observer.locator('#bid-form').isVisible(), false);
      assert.equal(await curator.locator('#bid-form').isVisible(), false);

      if (i === 1) {
        await observer.locator('#stage .art-preview').click();
        await observer.locator('#art-dialog img').evaluate(img => img.decode());
        assert.equal(await observer.locator('#art-dialog').isVisible(), true);
        await observer.getByRole('button', {name: '关闭'}).click();
        assert.ok(await observer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await screenshot(observer, 'watch-mobile.png');
        await screenshot(bidders[0], 'auction.png');
        await bidders[0].getByRole('button', {name: '出价', exact: true}).click();
        await observer.getByText('当前最高', {exact: true}).waitFor();
        await bidders[1].getByRole('button', {name: '出价', exact: true}).click();
        await bidders[1].getByText('你的出价暂时领先。').waitFor();
      }
      if (i % 2 === 0) {
        await bidders[0].getByRole('button', {name: '提交密封报价'}).click();
        await observer.getByText('已响应 1 / 2').waitFor();
        await bidders[0].getByText(/你的密封报价/).waitFor();
        if (i === 2) {
          await bidders[0].reload();
          await bidders[0].getByText(/你的密封报价/).waitFor();
        }
        await bidders[1].getByRole('button', {name: '弃权'}).click();
      }
    }
    for (const page of pages) await page.getByRole('heading', {name: '资产排名'}).waitFor();
    assert.equal(await host.locator('#stage tbody tr').count(), 3);
    assert.equal(await observer.locator('#sales tbody tr').count(), 6);
    await screenshot(host, 'scores.png');
    await host.getByRole('button', {name: '返回大厅'}).click();
    await observer.getByRole('heading', {name: '拍卖尚未开始'}).waitFor();
    assert.deepEqual(issues, []);
    console.log('Browser: 3 players, mobile spectator, recovery code, container restart, six auctions, ranking, and lobby reset passed.');
  }, {createKey});
} finally {
  await browser.close();
}
