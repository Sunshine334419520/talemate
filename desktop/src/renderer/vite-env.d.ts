/**
 * 样式是副作用导入（`import "./styles.css"`），TS 不认，得给它一句话。
 *
 * 这个文件不能有 import/export——一旦有，它就成了模块，里面的 `declare module "*.css"` 也不再是
 * 全局的通配声明（`global.d.ts` 结尾有 `export {}`，就是因此放不住这份声明）。
 */
declare module "*.css";
