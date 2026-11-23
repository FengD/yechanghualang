import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {webkit} from 'playwright';
import {withContainer} from './docker.js';

const phone = {isMobile: true, hasTouch: true, deviceScaleFactor: 3, viewport: {width: 402, height: 874}};
const tablet = {isMobile: true, hasTouch: true, deviceScaleFactor: 2, viewport: {width: 820, height: 1180}};
const screens = [
  ['iPhone-17-and-18-Pro', 402, 874],
  ['iPhone-18-Pro-Max', 440, 956],
  ['iPad', 820, 1180],
  ['iPad-mini-A17', 744, 1133],
  ['iPad-mini-A20', 756, 1158]
];
const screenshotDir = process.env.SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, {recursive: true});
const shot = (page, name) => screenshotDir ? page.screenshot({path: join(screenshotDir, name + '.png')}) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'night-gallery-webkit-profile-'));
const issues = [];
const browser = await webkit.launch();
const tap = (page, name) => page.getByRole('button', {name, exact: true}).tap();
const connected = page => page.locator('#connection').getByText('已连接', {exact: true}).waitFor();
const lot = (page, number, phase, options) =>
  page.getByRole('heading', {name: `拍品 ${number} · ${phase}`, exact: true}).waitFor(options);
const paused = page => page.getByRole('status').getByText('房主已暂停游戏。倒计时冻结，继续后可操作。').waitFor();

function monitor(page) {
  page.on('pageerror', error => issues.push(error.message));
  page.setDefaultTimeout(8000);
  return page;
}

async function visibilityReturn(page, dropReply = false) {
  await page.evaluate(dropReply => {
    if (dropReply) {
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (JSON.parse(data).type === 'sync') {
          WebSocket.prototype.send = original;
          return;
        }
        original.call(this, data);
      };
    }
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
    Object.defineProperty(document, 'hidden', {configurable: true, value: true});
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    return document.querySelector('#connection').textContent;
  }, dropReply).then(label => assert.equal(label, '同步中'));
  await connected(page);
}

async function fit(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'page overflows horizontally');
}

let savedContext;
try {
  await withContainer(async ({base, restart}) => {
    const host = monitor(await (await browser.newContext(tablet)).newPage());
    await host.goto(base);
    await fit(host);
    await host.getByLabel('你的昵称').fill('房主');
    await host.getByLabel('房间名称').fill('移动端测试画廊');
    await host.getByLabel('参赛席位').selectOption('3');
    await host.getByLabel('展期数量').selectOption('2');
    await host.getByLabel('策展限时').selectOption('15');
    await host.getByLabel('竞价限时').selectOption('15');
    await tap(host, '创建房间');
    await connected(host);
    await tap(host, '开始指引');
    for (let step = 1; step <= 5; step++) {
      assert.equal(await host.locator('#guide-progress').textContent(), `第 ${step} 步 / 共 5 步`);
      if (step === 3) {
        await tap(host, '上一步');
        assert.equal(await host.locator('#guide-title').textContent(), '选一件作品送拍');
        await tap(host, '下一步');
      }
      await tap(host, step === 5 ? '完成指引' : '下一步');
    }
    assert.equal(await host.locator('#guide-invite').isVisible(), false);
    const invite = await host.getByLabel('邀请链接').inputValue();

    async function enter(context, name, role = 'play') {
      const page = monitor(await context.newPage());
      await page.goto(invite);
      const field = page.getByLabel('你的昵称');
      await field.waitFor();
      const rect = await field.boundingBox();
      assert.ok(rect.y + rect.height <= page.viewportSize().height, name + ' entry field requires scrolling');
      await field.fill(name);
      if (role === 'watch') await page.getByLabel('入场方式').selectOption('watch');
      await tap(page, '进入拍卖厅');
      await connected(page);
      return {name, page};
    }

    savedContext = await webkit.launchPersistentContext(profile, phone);
    const mobile = await enter(savedContext, '手机买家');
    const second = await enter(await browser.newContext({...phone, viewport: {width: 440, height: 956}}), '大屏买家');
    const watcher = await enter(await browser.newContext(tablet), '平板观众', 'watch');

    await tap(mobile.page, '跳过');
    await mobile.page.reload();
    await connected(mobile.page);
    assert.equal(await mobile.page.locator('#guide-invite').isVisible(), false);
    await tap(mobile.page, '新手指引');
    await tap(mobile.page, '关闭指引');
    await tap(second.page, '跳过');
    await tap(watcher.page, '开始指引');
    assert.equal(await watcher.page.locator('#guide-title').textContent(), '查看拍卖桌');
    await tap(watcher.page, '跳过指引');

    await tap(host, '开始游戏');
    await lot(host, '01', '选拍品');
    await tap(host, '暂停游戏');
    await paused(watcher.page);
    const frozen = await watcher.page.locator('#timer').textContent();
    for (const [name, width, height] of [...screens, ['narrow', 320, 640], ['iPad-split', 375, 1158]]) {
      for (const viewport of [{width, height}, {width: height, height: width}]) {
        await watcher.page.setViewportSize(viewport);
        await fit(watcher.page);
        assert.ok(await watcher.page.getByRole('button', {name: '新手指引'}).evaluate(button => button.getBoundingClientRect().height >= 44));
        assert.ok(await watcher.page.locator('#timer').isVisible());
      }
      if (name === 'iPad-mini-A20') await shot(watcher.page, 'ipad-mini-landscape');
    }
    await watcher.page.setViewportSize(tablet.viewport);
    assert.equal(await watcher.page.locator('#timer').textContent(), frozen);
    const players = [{name: '房主', page: host}, mobile, second];

    async function nominate(number) {
      await Promise.all(players.map(({page}) => lot(page, number, '选拍品')));
      const canCurate = await Promise.all(players.map(({page}) => page.getByRole('button', {name: '送拍'}).first().isVisible()));
      assert.equal(canCurate.filter(Boolean).length, 1);
      const index = canCurate.indexOf(true);
      await players[index].page.getByRole('button', {name: '送拍'}).first().tap();
      return players.filter((_, i) => i !== index);
    }

    await tap(host, '继续游戏');
    const bidders = await nominate('01');
    // On a compact touch viewport, a rival bid must leave the focused field and draft intact.
    const editing = bidders.find(bidder => bidder === mobile) ?? bidders.find(bidder => bidder === second);
    const rival = bidders.find(bidder => bidder !== editing);
    const editPage = editing.page;
    await editPage.setViewportSize(phone.viewport);
    await lot(editPage, '01', '公开竞价');
    const amount = editPage.locator('#bid-amount');
    await amount.fill('42');
    await amount.evaluate(input => { window.draftField = input; });
    assert.equal(await amount.evaluate(input => getComputedStyle(input).fontSize), '16px');
    assert.ok(await editPage.locator('#submit-bid').evaluate(button => button.getBoundingClientRect().height >= 44));
    await tap(rival.page, '出价');
    await editPage.getByText('当前最高', {exact: true}).waitFor();
    assert.equal(await amount.inputValue(), '42');
    assert.ok(await amount.evaluate(input => input === window.draftField && input === document.activeElement));
    for (const [name, width, height] of screens) {
      await editPage.setViewportSize({width, height});
      await fit(editPage);
      if (name === 'iPhone-17-and-18-Pro') await shot(editPage, 'iphone-auction');
    }

    await tap(host, '暂停游戏');
    await paused(editPage);
    assert.equal(await editPage.locator('#submit-bid').isDisabled(), true);
    await visibilityReturn(editPage);
    await visibilityReturn(editPage, true);
    assert.equal(await amount.inputValue(), '42');
    assert.equal(await editPage.locator('#submit-bid').isDisabled(), true);
    await tap(host, '继续游戏');
    await editPage.locator('#submit-bid:not([disabled])').waitFor();
    await tap(editPage, '出价');

    await lot(host, '02', '选拍品', {timeout: 22_000});
    const sealed = await nominate('02');
    const bidder = sealed.find(player => player === mobile) ?? sealed.find(player => player === second);
    const sealPage = bidder.page;
    await tap(sealPage, '提交密封报价');
    await sealPage.getByText(/你的密封报价/).waitFor();
    const offer = await sealPage.getByText(/你的密封报价/).textContent();
    await tap(host, '暂停游戏');
    await paused(sealPage);
    const sealedTime = await sealPage.locator('#timer').textContent();
    await savedContext.close();
    if (bidder !== mobile) {
      const context = sealPage.context();
      await sealPage.close();
      bidder.page = monitor(await context.newPage());
    }
    await restart();
    savedContext = await webkit.launchPersistentContext(profile, phone);
    mobile.page = monitor(await savedContext.newPage());
    const reopened = bidder === mobile ? [mobile.page] : [mobile.page, bidder.page];
    await Promise.all(reopened.map(page => page.goto(base)));
    await Promise.all(reopened.map(connected));
    assert.equal(await mobile.page.locator('#hand [data-art]').count(), 3);
    await paused(bidder.page);
    assert.equal(await bidder.page.getByText(/你的密封报价/).textContent(), offer);
    assert.equal(await bidder.page.locator('#timer').textContent(), sealedTime);
    assert.equal(await watcher.page.getByText(/你的密封报价/).count(), 0);
    await wait(1200);
    assert.equal(await bidder.page.locator('#timer').textContent(), sealedTime);
    await connected(host);
    await tap(host, '继续游戏');
    const other = sealed.find(player => player !== bidder);
    await tap(other.page, '弃权');
    await lot(host, '03', '选拍品');
    assert.ok(await watcher.page.locator('#sales tbody tr').count() >= 1);
    assert.deepEqual(issues, []);
    console.log('Mobile WebKit: viewports, touch, tutorial, pause/resume, foreground sync, stale socket recovery, browser reopen, and Docker restart passed.');
  });
} finally {
  await savedContext?.close();
  await browser.close();
  await rm(profile, {recursive: true, force: true});
}
