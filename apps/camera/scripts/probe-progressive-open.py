#!/usr/bin/env python3
"""macOSの専用e2e bundleで、実入力→state→canvas paintとcanonical切替を検証する。"""
import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

BENCH_IDENTIFIER = "life.niho.photo.raw-bench"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--runtime", required=True, help="app/apple/render/calibrationを持つ非公開JSON")
parser.add_argument("--input", required=True)
parser.add_argument("--cache", required=True)
parser.add_argument("--condition", choices=["cold", "warm"], required=True)
parser.add_argument("--iteration", type=int, required=True)
args = parser.parse_args()


def remove_owned(path):
    # 製品のidentifierは受け取らず、このprobe専用namespaceだけを初期化する。
    if path.name != BENCH_IDENTIFIER or path.is_symlink():
        raise RuntimeError("unexpected benchmark state")
    if path.exists():
        shutil.rmtree(path)


def main():
    runtime = json.loads(Path(args.runtime).read_text())
    bundle = Path(runtime["app"]).resolve()
    identifier = subprocess.check_output([
        "/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier",
        str(bundle / "Contents/Info.plist"),
    ], text=True, stderr=subprocess.DEVNULL).strip()
    if identifier != BENCH_IDENTIFIER:
        raise RuntimeError("use the isolated e2e bundle")
    work = Path(args.cache).resolve()
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    source = Path(args.input).resolve()
    if source.suffix.lower() not in [".rw2", ".arw", ".dng", ".nef", ".cr2", ".cr3", ".raf", ".orf"]:
        raise RuntimeError("unsupported benchmark input")
    template = (Path(__file__).parent / "e2e/progressive-open.js").read_text()
    native_cache = Path.home() / "Library/Caches" / BENCH_IDENTIFIER

    def launch(iteration):
        for parent in ["Library/Application Support", "Library/WebKit"]:
            remove_owned(Path.home() / parent / BENCH_IDENTIFIER)
        if args.condition == "cold":
            remove_owned(native_cache)
        config = {"label": "sample", "fileName": source.name, "addPhotos": True,
                  "mode": args.condition, "iteration": iteration}
        script = work / "probe.js"
        script.write_text(template.replace("__BENCH_CONFIG__", json.dumps(config)))
        report = work / "report.json"
        report.unlink(missing_ok=True)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("APPLE_", "TAURI_SIGNING_", "NIHO_FIREBASE_", "NIHO_ACCOUNT_", "NIHO_CAMERA_E2E_"))}
        env.update(NIHO_CAMERA_E2E_SCRIPT=str(script), NIHO_CAMERA_E2E_REPORT=str(report),
                   NIHO_CAMERA_E2E_TRACE=str(work / "trace.log"),
                   NIHO_CAMERA_E2E_WINDOW="foreground", NIHO_CAMERA_E2E_PICK_PHOTOS=str(source),
                   NIHO_APPLE_RAW_LINEAR_PATH=runtime["apple"], NIHO_DEVELOP_RENDER_PATH=runtime["render"],
                   NIHO_DEVELOP_CALIBRATION_DIR=runtime["calibration"], NIHO_CAMERA_SIGNED_RAW="1")
        native_started_ms = int(time.time() * 1000)
        with (work / "app.log").open("w") as log:
            process = subprocess.Popen([str(bundle / "Contents/MacOS/niho_camera")],
                                       env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                # rAFによる実paint計測を止めないよう、専用bundleだけを前面にする。
                subprocess.run(["/usr/bin/osascript", "-e", "delay 1", "-e",
                                "tell application " + json.dumps(str(bundle)) + " to activate"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                process.wait(timeout=80)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
                raise RuntimeError("test app timeout")
        result = json.loads(report.read_text())
        if not result.get("ok"):
            raise RuntimeError("UI probe failed at " + str(result.get("stage", "unknown")))
        native_started_ms = result.get("nativeMeasurementStartedMs", native_started_ms)
        native_times = {}
        allowed = {"nativeHash", "cacheLookup", "cacheStore", "info", "decode", "lens", "whiteBalance", "color", "downsample", "encode"}
        native_log = Path.home() / "Library/Logs" / BENCH_IDENTIFIER / "camera.log"
        for log_path in [native_log.with_name("camera.log.1"), native_log]:
            if not log_path.exists():
                continue
            for line in log_path.read_text().splitlines():
                try:
                    record = json.loads(line)
                    if record.get("epochMs", 0) < native_started_ms or record.get("kind") not in ["camera.photo_stage", "photo_editing.develop_stage"]:
                        continue
                    data = record.get("data", {})
                    stage, elapsed = data.get("stage"), data.get("elapsedMs")
                    if stage in allowed and type(elapsed) in [int, float] and math.isfinite(elapsed) and elapsed >= 0:
                        native_times[stage] = native_times.get(stage, 0) + elapsed
                except (ValueError, TypeError):
                    continue
        result["nativeStagesMs"] = native_times
        return result

    # warmは各launch内で正規入力まで開き、一覧へ戻って同じsessionを再表示する。
    result = launch(args.iteration)
    # プリセット更新の内訳（押してから変わった画が出るまでの区間。許可した名前の有限な時間だけ）
    preset_stages = {"presetResolve", "presetRenderQueue", "presetWorkerWait", "presetRender", "presetThumbnailBlocked",
                     "presetThumbnailSession", "presetDeveloperRebuild", "presetThumbnail"}
    breakdown = result.get("presetBreakdownMs")
    preset_times = {stage: elapsed for stage, elapsed in (breakdown.items() if isinstance(breakdown, dict) else [])
                    if stage in preset_stages and type(elapsed) in [int, float] and math.isfinite(elapsed) and elapsed >= 0}
    print(json.dumps({"stagesMs": {
        **preset_times,
        **result["nativeStagesMs"],
        "editable": result["timeToEditableMs"], "inputAccepted": result["inputAcceptedMs"],
        "renderUpdated": result["exposurePaintMs"], "presetRenderUpdated": result["presetPaintMs"],
        **({"presetFinalRenderUpdated": result["presetFinalPaintMs"]}
           if type(result.get("presetFinalPaintMs")) in [int, float] and math.isfinite(result["presetFinalPaintMs"]) and result["presetFinalPaintMs"] >= 0 else {}),
        **({"proxyReady": result["proxyReadyMs"]} if result.get("proxyReadyMs") is not None else {}),
        **({"canonicalReady": result["canonicalReadyMs"]} if result.get("canonicalReadyMs") is not None else {}),
    }, "settingsRetained": result["settingsRetained"], "presetRetained": result["presetRetained"]}))


try:
    # 専用bundleのcache namespaceを共有するため、probeを同時に2本走らせない。
    lock_path = Path.home() / "Library/Caches/niho-photo-raw-benchmark-probe.lock"
    with lock_path.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        activity = subprocess.Popen(["/usr/bin/caffeinate", "-d", "-i", "-u", "-t", "90", "-w", str(os.getpid())],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            main()
        finally:
            activity.terminate()
except Exception:
    # 例外文字列には入力pathが入ることがある。公開stdout/stderrへ転送しない。
    print("progressive RAW UI probe failed", file=sys.stderr)
    sys.exit(1)
