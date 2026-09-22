/**
 * bom：字节序标记（U+FEFF）的摘与装。
 *
 * 为什么值得单开一个模块：它是**文件自己的属性**，不是内容的一部分。
 * - 读的时候它会作为一个不可见字符挂在文本开头——模型看到的、diff 里显示的、模型回填的 find
 *   里都可能多一个看不见的字符，而人从渲染结果上完全看不出来。
 * - 写的时候若照模型给的字节原样落盘，文件原有的 BOM 就被抹掉了，git 把整份文件报成改动。
 *
 * 规矩（照 opencode）：**沿用文件原有的 BOM**；文件本来没有、而模型显式带了一个，才采用它。
 * 反过来不成立——模型没带不代表要去掉文件原有的。
 */

const BOM_CODE = 0xfeff;
const BOM = String.fromCharCode(BOM_CODE);

export function splitBom(text: string): { bom: boolean; text: string } {
  if (text.charCodeAt(0) !== BOM_CODE) return { bom: false, text };
  return { bom: true, text: text.slice(1) };
}

/**
 * 装上 BOM。**先摘再装**：模型给的 content 自己带了一个 BOM 时，直接前置会产生两个。
 * （`charCodeAt` 对空串返回 `NaN`，不等于 BOM_CODE，所以空串走安全分支。）
 */
export function joinBom(text: string, bom: boolean): string {
  const stripped = splitBom(text).text;
  return bom ? BOM + stripped : stripped;
}
