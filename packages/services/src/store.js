// Tiny JSON-file store. Production uses Postgres (seller console) and Redis (nonces).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

export function jsonStore(name, initial) {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, `${name}.json`);
  let data = initial;
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      data = initial;
    }
  }
  let timer;
  return {
    get data() {
      return data;
    },
    set(v) {
      data = v;
      this.save();
    },
    save() {
      clearTimeout(timer);
      timer = setTimeout(() => writeFileSync(file, JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v))), 200);
    },
  };
}

export const json = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
