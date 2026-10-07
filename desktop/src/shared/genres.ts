/**
 * 频道与题材的默认选项——创建一本书时就能定下来的那两件事。
 *
 * 取市面上通行的切法，只到"大类"这一层（男频都市 / 女频古言），再往下是设定对话里的事，不该在
 * 起名这一步逼着人选。这是一份产品数据、只有这一份：界面按它画选项、按它筛选，将来别处要用
 * （比如让模型知道这本书的赛道）也从这里取——手抄一份就会两处说两套话。
 */

/** 频道。用户口中的"双频"写成了"不限"——书架上给人看的分类，"不限"比"双频"更像话。 */
export const CHANNELS = ["男频", "女频", "不限"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Genre {
  name: string;
  /** 哪些频道有这一大类。 */
  channels: readonly ("男频" | "女频")[];
}

export const GENRES: readonly Genre[] = [
  { name: "都市", channels: ["男频"] },
  { name: "玄幻", channels: ["男频"] },
  { name: "仙侠", channels: ["男频"] },
  { name: "奇幻", channels: ["男频"] },
  { name: "历史", channels: ["男频"] },
  { name: "古言", channels: ["女频"] },
  { name: "现言", channels: ["女频"] },
  { name: "幻言", channels: ["女频"] },
  { name: "年代", channels: ["女频"] },
  { name: "种田", channels: ["女频"] },
  { name: "快穿", channels: ["女频"] },
  // 两频共用
  { name: "科幻", channels: ["男频", "女频"] },
  { name: "悬疑", channels: ["男频", "女频"] },
  { name: "游戏", channels: ["男频", "女频"] },
  { name: "衍生", channels: ["男频", "女频"] },
];

/** 这个频道下可选的题材。选"不限"= 两频都算，所以全都列出来。 */
export function genresFor(channel: string | undefined): readonly Genre[] {
  if (channel !== "男频" && channel !== "女频") return GENRES;
  return GENRES.filter((g) => g.channels.includes(channel));
}
