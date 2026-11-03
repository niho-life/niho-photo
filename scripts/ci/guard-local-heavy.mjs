import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scopes = new Set([
  "typecheck",
  "test",
  "verify",
  "photo-editing/typecheck",
  "photo-editing/test",
  "sdk:build-engine-runtime",
  "candidate:build",
  "camera:e2e:photo-picker",
]);

// Tailscale の端末名を優先し、停止中だけ既知の macOS hostname に戻す。
export function isMacMiniDevice({ deviceName, hostName }) {
  return deviceName ? deviceName === "takuya-mac-mini" : hostName === "takuya-macmini";
}

function tailscaleDeviceName() {
  for (const command of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const output = execFileSync(command, ["status", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      });
      const name = JSON.parse(output)?.Self?.HostName;
      if (typeof name === "string" && name) return name;
    } catch {
      // CLI がない、または Tailscale が停止中なら次の経路を試す。
    }
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scope = process.argv[2];
  if (!scopes.has(scope)) {
    console.error("[photo-heavy-guard] 不明な検証コマンドです。");
    process.exitCode = 2;
  } else if (isMacMiniDevice({ deviceName: tailscaleDeviceName(), hostName: hostname() })) {
    console.error(
      `[photo-heavy-guard] Mac mini では ${scope} を開始しません（exit 97）。\n` +
        "GitHub Actions の Photo editing / Photo Mac candidate proof を利用してください。\n" +
        "Studio で先行確認する場合は、commit と push 済みの clean HEAD から次の入口を使います。\n" +
        "  ~/.codex/skills/ssh-personal-macs/scripts/studio-exec.sh doctor\n" +
        "  ~/.codex/skills/ssh-personal-macs/scripts/studio-exec.sh run --class heavy --name photo-editing -- <検証コマンド>\n" +
        "具体的なコマンド: docs/ci/public-ci.md の「Mac mini のローカル重処理ガード」",
    );
    process.exitCode = 97;
  }
}
