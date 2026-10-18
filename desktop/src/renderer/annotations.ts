/**
 * 右栏批注的纯逻辑：一份文档里的"选中文字 + 备注"，以及把它们拼成一条用户消息。
 *
 * 只做合成，不碰 DOM、不读文件。界面负责收集，harness 收到的是一条和手打完全一样的消息；
 * 备注不直接改文件，改仍走正常的写入口。
 */

export interface Annotation {
  /** 同一份文档内唯一，用于删除；不进消息 */
  id: number;
  /** 渲染后正文里块级元素的序号，用于排序与挂标记；不进消息 */
  block: number;
  /** 用户选中的文字，保留换行，只去首尾空白 */
  quote: string;
  /** 用户写的修改意见 */
  text: string;
}

/**
 * 拼成交给模型的那条用户消息。
 *
 * 顺序按正文位置，不按添加顺序——模型是从前往后读的。不带行号或段号：右栏没有行号，
 * 段号是界面自己数的，引用文字才是可靠锚点。也不加"只改这几处"之类的范围话术，交给模型判断。
 */
export function composeAnnotationMessage(
  docName: string,
  path: string,
  notes: readonly Annotation[],
): string {
  const ordered = [...notes].sort((a, b) => a.block - b.block || a.id - b.id);
  if (ordered.length === 0) return "";
  const items = ordered.map(
    (n, i) => `${i + 1}. 原文：${n.quote}\n   备注：${n.text}`,
  );
  return `${docName}里我标了 ${ordered.length} 处，帮我改一下。\n文档：${path}\n\n${items.join("\n\n")}`;
}
