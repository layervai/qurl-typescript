import { expect, it } from "vitest";
import { consumeCookieChallenge } from "./nhp-cookie.js";

const cookie = Buffer.alloc(32, 11).toString("base64");
it.each([7n, 18446744073709551615n])(
  "correlates the exact transaction %s and wipes the challenge",
  (counter) => {
    const body = Buffer.from(`{"trxId":${counter},"cookie":"${cookie}"}`);
    expect(consumeCookieChallenge(body, counter)).toEqual(Buffer.alloc(32, 11));
    expect(body.every((value) => value === 0)).toBe(true);
  },
);
it.each([
  `{"trxId":8,"cookie":"${cookie}"}`,
  `{"trxId":"7","cookie":"${cookie}"}`,
  `{"trxId":7,"cookie":"${cookie}","cookie":"${cookie}"}`,
  `{"trxId":7,"cookie":"${cookie}","extra":true}`,
  `{"trxId":7,"cookie":"${cookie.slice(0, -1)}"}`,
  `{"trxId":7,"cookie":"${Buffer.alloc(31).toString("base64")}"}`,
  `{"trxId":7,"cookie":"\\u0043${cookie.slice(1)}"}`,
  `{"trxId":7,"cookie":"${cookie}"} {}`,
  "x".repeat(4097),
])("rejects an invalid challenge without retaining it", (input) => {
  const body = Buffer.from(input);
  expect(() => consumeCookieChallenge(body, 7n)).toThrow();
  expect(body.every((value) => value === 0)).toBe(true);
});
