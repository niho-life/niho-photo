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

// dirty な作業差分がなく、branch のない detached commit もなければ再利用できる。
// clean な topic branch は参照を残したまま別の作業へ切り替えてよい。
export function isFree({ branch, dirty, ahead = 0 }) {
  return !dirty && (Boolean(branch) || !(ahead > 0));
}

// branch は削除せず detach するため、clean な branch に未 push commit があっても保持できる。
// branch のない（detach した）座席だけは remote 未到達 commit の喪失を防ぐ。
export function releaseBlocker({ branch, dirty, ahead }) {
  if (dirty) return "変更が残っています。内容を commit してから切り替えてください。";
  if (!branch && ahead > 0) {
    return `branch の無い commit が ${ahead} 件あり、どこにも push されていません。branch を作って push してから空けてください。`;
  }
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
  const ahead = Number(
    branch
      ? git(path, ["rev-list", "--count", `${upstream ? "@{upstream}" : "origin/main"}..HEAD`])
      : git(path, ["rev-list", "--count", "HEAD", "--not", "--remotes"]),
  );
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
    const label = state.dirty ? "使用中" : state.branch ? "再利用可" : isFree(state) ? "空き" : "要確認";
    const unpushed = state.branch && state.ahead > 0 ? `branch に commit ${state.ahead} 件` : "";
    const detachedCommit = !state.branch && state.ahead > 0 ? `branch のない commit ${state.ahead} 件` : "";
    const detail = [state.branch || "（branch なし）", state.dirty ? "変更あり" : "", unpushed || detachedCommit].filter(Boolean).join("  ");
    console.log(`${seat}  ${label}  ${detail}`);
  }
}

function start(root, seat, topic) {
  const path = seatPath(root, seat);
  if (!existsSync(path)) return fail(`座席 ${seat} がありません。新しく作らず owner に相談してください。`);
  const state = readSeat(path);
  if (!isFree(state)) {
    const reason = state.dirty ? "変更あり" : `branch のない commit ${state.ahead} 件`;
    return fail(`座席 ${seat} は使用中です（${reason}）。status で空きを探してください。`);
  }
  git(path, ["fetch", "--quiet", "origin"]);
  // upstream は最初の `git push -u` で付く（origin/main を追跡させない）
  git(path, ["switch", "--quiet", "--no-track", "-c", `feature/${topic}`, "origin/main"]);
  console.log(`座席 ${seat}（${path}）で feature/${topic} を origin/main から切りました。`);
}

function release(root, seat) {
  const path = seatPath(root, seat);
  if (!existsSync(path)) return fail(`座席 ${seat} がありません。`);
  const state = readSeat(path);
  const blocker = releaseBlocker(state);
  if (blocker) return fail(`座席 ${seat} を空けられません: ${blocker}`);
  git(path, ["fetch", "--quiet", "origin"]);
  git(path, ["switch", "--quiet", "--detach", "origin/main"]);
  console.log(`座席 ${seat} を origin/main に戻しました。既存 branch は削除していません。`);
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
