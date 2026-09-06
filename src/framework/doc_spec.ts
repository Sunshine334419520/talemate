/**
 * doc-spec：每层"结构规范"（该层目标文档该有哪些小节 + 成稿/补缺做法）。
 *
 * 设计（2026-09-06）：
 * - 懒建：目标文档平时不存在，用户要完善某层时才由 editor 调 doc-spec 拿形状，再成稿落盘。
 * - 成稿：不逐格盘问；让用户先用自己话讲 → 按小节整理一版草稿（缺的写（待定））→ 确认后整层落盘；
 *   之后只更新仍（待定）/要改的那一小节（edit-doc），补细节时给建议/选项。
 * - 结构与内容分离：这里只定义"长什么样"；文档文件一旦建立即内容与真相。
 */
import { DOC_KINDS, type DocId } from "./dockind";

export interface DocSection {
  heading: string;
  hint?: string;
}

export interface DocSpec {
  id: DocId;
  file: string;
  title: string;
  sections: DocSection[];
  guide: string; // 成稿/补缺做法（给模型看的工作法）
}

const WORK_METHOD = [
  "工作法：",
  "1) 先让用户用自己的话讲（他往往会给一整段，别逐格盘问）；",
  "2) 把他的话按上面小节整理成一版草稿，没讲到的写（待定），保留用户原话里的细节与味道；",
  "3) 整篇写进该文件前先经用户确认（write-doc 会请你确认）；",
  "4) 之后只更新仍（待定）/要改的那一小节（edit-doc 按小节标题改），补细节时给建议或选项、一次可答多个；",
  "5) 文档文件一旦建立，后续以文件当前内容为准（先 read-doc 再动）。",
].join("\n");

export const DOC_SPECS: Record<DocId, DocSpec> = {
  core: {
    id: "core",
    file: "core.md",
    title: "核心层（卖点与设定内核）",
    sections: [
      { heading: "一句话卖点", hint: "能被读者一句话复述" },
      { heading: "题材 · 频道", hint: "男频/女频/双频；题材定位" },
      { heading: "主角", hint: "谁（名字/身份/进场状态）；副节：想要什么 / 最怕什么 / 为什么是他" },
      { heading: "金手指 / 真实约束", hint: "能力或真实约束；副节：边界与代价（写手据此不越界）" },
      { heading: "爽感承诺", hint: "读者每章期待被兑现什么" },
      { heading: "目标读者", hint: "" },
    ],
    guide: WORK_METHOD,
  },
  world: {
    id: "world",
    file: "world.md",
    title: "世界层（舞台与秩序）",
    sections: [
      { heading: "世界观一句话", hint: "" },
      { heading: "空间与舞台", hint: "主要地点、时代感、流动逻辑" },
      { heading: "规则与秩序", hint: "力量体系/社会规则/资源约束" },
      { heading: "势力与人物群像", hint: "阵营/机构/群体，各自要什么" },
      { heading: "历史痕迹与秘密", hint: "过去的遗留、未解之谜（别一次掀完底）" },
      { heading: "术语表", hint: "" },
    ],
    guide: WORK_METHOD,
  },
  characters: {
    id: "characters",
    file: "characters.md",
    title: "人物层（角色总表 + 角色卡）",
    sections: [
      { heading: "角色总表", hint: "每行一位：名字 | 一句话定位" },
    ],
    guide: [
      "工作法：",
      "1) 加角色用 add-character（自动生成规范卡：一句话定位/想要·最怕/说话方式(给声音范例原文)/习惯动作/在故事中的功能，缺格会提示补）；",
      "2) 想了解/完善某角色先 read-doc 看当前卡，update-character 只改你传的格；",
      "3) 每个角色一张 `## 角色：〈名字〉` 卡；总表由工具自动同步，不用手改。",
    ].join("\n"),
  },
  outline: {
    id: "outline",
    file: "outline.md",
    title: "情节层（主线到章节）",
    sections: [
      { heading: "一句话主线", hint: "从开场到结局要完成什么、代价是什么" },
      { heading: "开篇钩子（前 3 章）", hint: "每章一个钩子" },
      { heading: "分卷方向", hint: "每卷：目标/冲突升级/卷末" },
      { heading: "结局方向", hint: "止于什么；可暂留余地" },
      { heading: "伏笔与回收登记", hint: "埋点 | 章节 | 状态：埋/已回收/放弃" },
    ],
    guide: WORK_METHOD,
  },
};

/** 渲染成给模型的规范文本（doc-spec 工具返回用）。 */
export function renderDocSpec(id: DocId): string {
  const spec = DOC_SPECS[id];
  const head = spec.sections.map((s) => `  ## ${s.heading}${s.hint ? `（${s.hint}）` : ""}`).join("\n");
  return [
    `【${spec.title} · 目标文档 docs/${spec.file}】`,
    "该层文档应含以下小节（每个 ## 即一格，后续可单独 edit-doc 那一格）：",
    head,
    "",
    spec.guide,
  ].join("\n");
}

export { DOC_KINDS };
