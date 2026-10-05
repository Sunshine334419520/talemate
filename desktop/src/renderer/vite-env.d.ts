/**
 * 样式是副作用导入（`import "./styles.css"`），TS 不认，得给它一句话。
 *
 * 这个文件**不能有 import/export**——一旦有，它就成了模块，里面的 `declare module "*.css"` 就不再是
 * 全局的通配声明（`global.d.ts` 里那份就是因此不生效的）。
 */
declare module "*.css";
