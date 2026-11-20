import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import express, { RequestHandler } from "express";

import { atomicWrite } from "../storage/files";

const same = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function token(dir: string) {
  const file = path.join(dir, "token");
  try {
    fs.writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw e;
    }
  }
  return fs.readFileSync(file, "utf8").trim();
}

function accounts(dir: string): Record<string, { salt: string; hash: string }> {
  const file = path.join(dir, "users.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export function userAction(dir: string, action: string, name: string, password = "") {
  const users = accounts(dir);
  if (action === "list") {
    return Object.keys(users);
  }
  if (
    !/^[a-zA-Z0-9_-]{1,40}$/.test(name) ||
    ["__proto__", "constructor", "prototype"].includes(name)
  ) {
    throw Error("无效用户名");
  }
  if (action === "add" || action === "passwd") {
    if ((action === "add" && users[name]) || (action === "passwd" && !users[name])) {
      throw Error("用户状态不匹配");
    }
    if (password.length < 8) {
      throw Error("密码至少 8 位");
    }
    const salt = randomBytes(16).toString("hex");
    users[name] = { salt, hash: scryptSync(password, salt, 32).toString("hex") };
  } else if (action === "remove") {
    if (!users[name]) {
      throw Error("用户不存在");
    }
    delete users[name];
  } else {
    throw Error("未知用户命令");
  }
  atomicWrite(path.join(dir, "users.json"), JSON.stringify(users));
  return action;
}

export function standaloneAuth(dir: string, host: string, login: boolean) {
  const bearer = token(dir);
  const sessions = new Map<string, { expires: number; user?: string; hash?: string }>();
  const failures = new Map<string, number[]>();
  const localBind = ["localhost", "127.0.0.1", "::1"].includes(host);
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: "4kb" }));
  router.get("/login.css", (_request, response) =>
    response.sendFile(path.join(__dirname, "../../web/login.css")),
  );
  router.get("/login", (_request, response) => {
    response.sendFile(path.join(__dirname, "../../web/login.html"));
  });
  router.post("/login", (req, res) => {
    if (
      !login ||
      req.get("sec-fetch-site") === "cross-site" ||
      (req.headers.origin && new URL(req.headers.origin).host !== req.get("host"))
    ) {
      res.sendStatus(403);
      return;
    }
    const now = Date.now();
    const name = String(req.body.name || "");
    for (const [key, times] of failures) {
      const active = times.filter((t) => now - t < 600000);
      if (active.length) {
        failures.set(key, active);
      } else {
        failures.delete(key);
      }
    }
    if ((failures.get(name)?.length || 0) >= 5 || [...failures.values()].flat().length >= 20) {
      res.sendStatus(429);
      return;
    }
    const user = accounts(dir)[name];
    const pass = String(req.body.password || "");
    if (!user?.salt || !same(scryptSync(pass, user.salt, 32).toString("hex"), user.hash)) {
      failures.set(name, [...(failures.get(name) || []), now]);
      res.sendStatus(401);
      return;
    }
    const key = randomBytes(32).toString("hex");
    sessions.set(key, { expires: now + 7 * 86400000, user: name, hash: user.hash });
    res.cookie("sa_session", key, { httpOnly: true, sameSite: "strict", maxAge: 7 * 86400000 });
    res.redirect("./");
  });
  const authorize: RequestHandler = (req, res, next) => {
    const trustedSocket = !req.socket.remoteAddress;
    if (trustedSocket) {
      return next();
    }
    if (localBind && !["127.0.0.1", "localhost", "[::1]"].includes(req.hostname)) {
      res.sendStatus(403);
      return;
    }
    if (req.get("sec-fetch-site") === "cross-site") {
      res.sendStatus(403);
      return;
    }
    const key = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("sa_session="))
      ?.slice(11);
    const session = key && sessions.get(key);
    if (
      session &&
      session.expires > Date.now() &&
      (!session.user || accounts(dir)[session.user]?.hash === session.hash)
    ) {
      return next();
    }
    if (!login) {
      if (
        req.method === "GET" &&
        typeof req.query.token === "string" &&
        same(req.query.token, bearer)
      ) {
        const value = randomBytes(32).toString("hex");
        sessions.set(value, { expires: Date.now() + 30 * 86400000 });
        res.cookie("sa_session", value, {
          httpOnly: true,
          sameSite: "strict",
          maxAge: 30 * 86400000,
        });
        res.redirect("./");
        return;
      }
      if (localBind || same(req.get("authorization") || "", "Bearer " + bearer)) {
        return next();
      }
    }
    if (login && req.path === "/") {
      res.redirect("login");
    } else {
      res.status(401).json({ error: "需要认证" });
    }
  };
  return { router, authorize };
}
