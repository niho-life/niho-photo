import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 固定の座席（root の clone の隣の worktree `<root>-1`〜`<root>-8`）。数を増やすのは owner の判断（AGENTS.md）。
export const SEAT_COUNT = 8;

const TOPIC = /^[a-z0-9][a-z0-9-]{1,59}$/;

export function seatPath(rootDir, seat) {
  return `${rootDir}-${seat}`;
}

export function parseSeat(value) {
  const seat = Number(value);
  return Number.isInteger(seat) && seat >= 1 && seat <= SEAT_COUNT ? seat : null;
}

export function validTopic(value) {
  return typeof value === "string" && TOPIC.test(value);
}

// branch が無く（origin/main に detach）、変更も無い座席だけが空き。
export function isFree({ branch, dirty }) {
  return !branch && !dirty;
}

// 空けてよいのは、変更が無く、push していない commit が無いときだけ。`ahead` は upstream があればそれ、無ければ origin/main より先の数。
export function releaseBlocker({ branch, dirty, upstream, tracked, ahead }) {
  if (dirty) return "変更が残っています。commit して push してから空けてください。";
  if (branch && !upstream && tracked) {
    return `${branch} の push 先が消えています。PR が merge 済みか確かめてから \`git switch --detach origin/main\` で空けてください。`;
  }
  if (branch && !upstream && ahead > 0) return `${branch} が push されていません（commit ${ahead} 件）。`;
  if (branch && ahead > 0) return `${branch} に push していない commit が ${ahead} 件あります。`;
  return null;
}

function git(cwd, args, options = {}) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function rootDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(resolve(here, git(here, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
}

function readSeat(path) {
  const branch = git(path, ["branch", "--show-current"]);
  const dirty = git(path, ["status", "--porcelain"]).length > 0;
  const upstream = branch ? tryGit(path, ["rev-parse", "--abbrev-ref", "@{upstream}"]) : null;
  const tracked = branch ? tryGit(path, ["config", `branch.${branch}.merge`]) !== null : false;
  const ahead = branch ? Number(git(path, ["rev-list", "--count", `${upstream ? "@{upstream}" : "origin/main"}..HEAD`])) : 0;
  return { branch, dirty, upstream, tracked, ahead };
}

function fail(message, code = 1) {
  console.error(`[seat] ${message}`);
  process.exitCode = code;
}

function status(root) {
  for (let seat = 1; seat <= SEAT_COUNT; seat += 1) {
    const path = seatPath(root, seat);
    if (!existsSync(path)) {
      console.log(`${seat}  なし    （作り直しは owner に相談）`);
      continue;
    }
    const state = readSeat(path);
    const label = isFree(state) ? "空き  " : "使用中";
    const detail = [state.branch || "（branch なし）", state.dirty ? "変更あり" : ""].filter(Boolean).join("  ");
    console.log(`${seat}  ${label}  ${detail}`);
  }
}

function start(root, seat, topic) {
  const path = seatPath(root, seat);
  if (!existsSync(path)) return fail(`座席 ${seat} がありません。新しく作らず owner に相談してください。`);
  const state = readSeat(path);
  if (!isFree(state)) return fail(`座席 ${seat} は使用中です（${state.branch || "変更あり"}）。status で空きを探してください。`);
  git(path, ["fetch", "--quiet", "origin"]);
  // upstream は最初の `git push -u` で付く（origin/main を追跡させない）
  git(path, ["switch", "--quiet", "--no-track", "-c", `feature/${topic}`, "origin/main"]);
  console.log(`座席 ${seat}（${path}）で feature/${topic} を origin/main から切りました。`);
}

function release(root, seat) {
  const path = seatPath(root, seat);
  if (!existsSync(path)) return fail(`座席 ${seat} がありません。`);
  const blocker = releaseBlocker(readSeat(path));
  if (blocker) return fail(`座席 ${seat} を空けられません: ${blocker}`);
  git(path, ["fetch", "--quiet", "origin"]);
  git(path, ["switch", "--quiet", "--detach", "origin/main"]);
  console.log(`座席 ${seat} を空けました（origin/main に detach）。branch は消していません。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, seatArg, topic] = process.argv.slice(2);
  const usage = "使用法: node scripts/seat.mjs status | start <1-8> <topic> | release <1-8>";
  try {
    const root = rootDir();
    if (command === "status") status(root);
    else if (command === "start" && parseSeat(seatArg) && validTopic(topic)) start(root, parseSeat(seatArg), topic);
    else if (command === "release" && parseSeat(seatArg)) release(root, parseSeat(seatArg));
    else fail(usage, 2);
  } catch (error) {
    fail(`git の操作に失敗しました: ${error.stderr?.toString().trim() || error.message}`);
  }
}
