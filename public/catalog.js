export const SERIES = [
  {name: '赤岩', color: '#fa784d', works: ['断层日轮', '火山阶地']},
  {name: '深蓝', color: '#80a8ff', works: ['静湾回声', '渡口的光']},
  {name: '植域', color: '#bed976', works: ['叶的剖面', '种子的轨迹']},
  {name: '霓城', color: '#e3a7df', works: ['斜向街区', '咖啡馆的窗']}
];

export const CARD_COUNT = 48;

export function artwork(id) {
  const work = Math.floor(id / 6);
  const series = Math.floor(work / 2);
  const edition = id % 6 + 1;
  const premium = (edition - 1) * 2;
  return {work, series, edition, premium, reserve: 4 + premium, title: SERIES[series].works[work % 2]};
}
