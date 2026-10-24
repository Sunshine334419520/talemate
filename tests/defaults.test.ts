/** 默认值的守卫：用户没配过任何东西时，新会话应该落在「工作区内修改」。 */
import { describe, test, expect } from "bun:test";
import { DEFAULT_PERMISSION_MODE } from "../desktop/src/shared/api";

describe("默认权限", () => {
  test("新会话默认是 accept-edits（工作区内修改）", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("accept-edits");
  });
});
