// NIHO photo #210 の画面E2E。設定にパスを含めず、固定した操作段階だけをreportへ返す。
(() => {
  const config = __PHOTO_PICKER_CONFIG__;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const bodyText = () => document.body?.innerText ?? "";
  const exactButton = (label, root = document) => [...root.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === label && !button.disabled) ?? null;
  const menuItems = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
  const menuItem = (label) => menuItems().find((item) => item.textContent.trim() === label && !item.disabled) ?? null;
  const currentPlace = () => document.querySelector('nav[aria-label="表示中の場所"] [aria-current="page"]')?.textContent.trim() ?? null;
  const selectedRow = () => [...(document.querySelector('aside[aria-label="写真の場所"]')?.querySelectorAll("button") ?? [])]
    .find((button) => button.textContent.includes("選んだ写真")) ?? null;
  const folderRow = () => document.querySelector(`aside[aria-label="写真の場所"] button[title="${config.folderName}"]`);
  const selectedCount = () => {
    const compact = (selectedRow()?.textContent ?? "").replace(/\s/gu, "");
    const match = compact.match(/選んだ写真(\d+)/u);
    return match ? Number(match[1]) : 0;
  };
  const tiles = () => [...(document.querySelector('section[aria-label="写真の一覧"]')?.querySelectorAll("li > button[title]") ?? [])];
  const normalizedName = (name) => name.toLocaleLowerCase("en-US").replace(/\.jpg$/u, ".jpeg");
  const photoExtension = (name) => {
    const extension = name.split(".").at(-1).toUpperCase();
    return extension === "JPG" ? "JPEG" : extension;
  };
  const tile = (name) => tiles().find((button) => normalizedName(button.title) === normalizedName(name)) ?? null;
  const exactTiles = (names) => {
    const actual = tiles().map((button) => normalizedName(button.title)).sort();
    const expected = names.map(normalizedName).sort();
    return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
  };
  const waitFor = async (read, code, timeout = 30000) => {
    const started = performance.now();
    while (performance.now() - started < timeout) {
      const value = read();
      if (value) return value;
      await delay(20);
    }
    const error = new Error(code);
    error.code = code;
    throw error;
  };
  const clickMenuItem = async (trigger, label) => {
    trigger.click();
    const item = await waitFor(() => menuItem(label), "menu-item-missing");
    item.click();
    await waitFor(() => {
      const menu = document.querySelector('[role="menu"]');
      return !menu || menu.getAttribute("data-state") === "closed";
    }, "menu-did-not-close");
  };
  const addPhotos = async () => {
    const tree = document.querySelector('aside[aria-label="写真の場所"]');
    const trigger = tree?.querySelector('button[aria-label="フォルダや写真を追加"]') ?? exactButton("フォルダや写真を追加");
    if (!trigger) throw Object.assign(new Error(), { code: "photo-picker-trigger-missing" });
    await clickMenuItem(trigger, "写真を選ぶ");
  };
  const selectSelectedPhotos = async () => {
    const row = await waitFor(() => selectedRow(), "selected-photos-row-missing", 90000);
    row.click();
    await waitFor(() => currentPlace() === "選んだ写真", "selected-photos-place-missing");
    await waitFor(() => document.querySelector('section[aria-label="写真の一覧"]')?.getAttribute("aria-busy") !== "true", "photo-list-loading");
  };
  const selectFolder = async () => {
    const row = await waitFor(() => folderRow(), "remembered-folder-missing", 90000);
    row.click();
    await waitFor(() => currentPlace() === config.folderName, "folder-place-missing", 90000);
    await waitFor(() => document.querySelector('section[aria-label="写真の一覧"]')?.getAttribute("aria-busy") !== "true", "folder-list-loading", 90000);
  };
  const editAndExport = async (name) => {
    const selected = await waitFor(() => tile(name), "fixture-tile-missing");
    selected.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const exposure = await waitFor(() => {
      const slider = document.querySelector('aside[aria-label="補正"] input[type="range"][aria-label="露光量"]');
      return slider && !slider.disabled ? slider : null;
    }, "editable-photo-missing", 90000);
    const before = Number(exposure.value);
    exposure.focus();
    exposure.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
    const changed = await waitFor(() => {
      const current = Number(document.querySelector('aside[aria-label="補正"] input[type="range"][aria-label="露光量"]')?.value);
      return Number.isFinite(current) && current !== before ? current : null;
    }, "exposure-did-not-change");
    await delay(1100);

    const exportButton = await waitFor(() => exactButton("書き出す"), "export-button-missing");
    exportButton.click();
    const sheet = await waitFor(() => document.querySelector('[role="dialog"][aria-label="書き出す"]'), "export-sheet-missing");
    const jpeg = [...sheet.querySelectorAll('input[type="radio"]')].find((input) => input.value === "jpeg");
    if (!jpeg) throw Object.assign(new Error(), { code: "jpeg-export-option-missing" });
    if (!jpeg.checked) jpeg.click();
    const download = await waitFor(() => exactButton("ダウンロード", sheet), "jpeg-export-action-missing");
    download.click();
    await waitFor(() => !document.querySelector('[role="dialog"][aria-label="書き出す"]') && bodyText().includes("を保存しました"), "jpeg-export-did-not-save", 90000);
    const grid = await waitFor(() => document.querySelector('button[aria-label="一覧"]:not([disabled])'), "grid-button-missing");
    grid.click();
    await waitFor(() => tile(name) && currentPlace() === "選んだ写真", "return-to-grid-failed");
    return changed;
  };
  const openDecoderFixture = async (name) => {
    const selected = await waitFor(() => tile(name), "decoder-fixture-tile-missing");
    selected.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await waitFor(() => {
      const slider = document.querySelector('aside[aria-label="補正"] input[type="range"][aria-label="露光量"]');
      return slider && !slider.disabled ? slider : null;
    }, "decoder-fixture-did-not-open", 90000);
    const grid = await waitFor(() => document.querySelector('button[aria-label="一覧"]:not([disabled])'), "grid-button-missing");
    grid.click();
    await waitFor(() => tile(name) && currentPlace() === "選んだ写真", "return-to-grid-failed");
  };
  const report = (value) => {
    const url = `https://niho-e2e.invalid/report?data=${encodeURIComponent(JSON.stringify(value))}`;
    location.href = url;
    setInterval(() => { location.href = url; }, 1000);
  };

  (async () => {
    let stage = "boot";
    try {
      await waitFor(() => document.querySelector('section[aria-label="写真の一覧"]'), "photo-list-missing");
      if (config.phase === "seed") {
        stage = "initial-options";
        const add = await waitFor(() => exactButton("フォルダや写真を追加"), "initial-add-button-missing");
        add.click();
        const initialOptions = await waitFor(() => {
          const options = menuItems().map((item) => item.textContent.trim());
          return options.length === 2 ? options : null;
        }, "initial-menu-missing");
        if (initialOptions.length !== 2 || !initialOptions.includes("フォルダを追加") || !initialOptions.includes("写真を選ぶ")) {
          throw Object.assign(new Error(), { code: "initial-menu-incomplete" });
        }
        const folder = menuItem("フォルダを追加");
        if (!folder) throw Object.assign(new Error(), { code: "folder-picker-option-missing" });
        folder.click();
        await waitFor(() => document.querySelector(`aside[aria-label="写真の場所"] button[title="${config.folderName}"]`), "folder-not-remembered");
        await waitFor(() => tile(config.folderPhotoName), "folder-photo-not-listed");
        stage = "multi-select";
        await addPhotos();
        await waitFor(() => currentPlace() === "選んだ写真" && selectedCount() === config.fixtureNames.length, "multi-select-not-remembered", 90000);
        await waitFor(() => exactTiles(config.fixtureNames), "selected-photos-incomplete", 90000);
        report({ ok: true, phase: "seed", initialOptions: ["folder", "photos"], selectedCount: selectedCount(), formats: config.extensions });
        return;
      }

      if (config.phase === "restart") {
        stage = "restore";
        await waitFor(() => selectedRow() && document.querySelector(`aside[aria-label="写真の場所"] button[title="${config.folderName}"]`), "remembered-sources-missing", 90000);
        await selectSelectedPhotos();
        await waitFor(() => exactTiles(config.fixtureNames), "restart-list-incomplete", 90000);
        stage = "duplicate";
        await addPhotos();
        await waitFor(() => exactTiles(config.fixtureNames) && selectedCount() === config.fixtureNames.length, "duplicate-created-entry", 90000);
        const editResults = {};
        stage = "shared-format-decoder-fixture";
        await openDecoderFixture(config.rawName);
        stage = "edit-export";
        for (const name of config.editNames) {
          editResults[name] = await editAndExport(name);
        }
        report({ ok: true, phase: "restart", restored: true, duplicateCount: selectedCount(), decodedExistingRawFixture: true, editedAndExported: config.editNames.map((name) => name.split(".").at(-1)), expectedExposure: editResults[config.jpegName] });
        return;
      }

      if (config.phase === "cancel") {
        stage = "cancel";
        await selectSelectedPhotos();
        const before = tiles().map((button) => button.title).sort();
        const count = selectedCount();
        await addPhotos();
        await delay(800);
        const after = tiles().map((button) => button.title).sort();
        if (currentPlace() !== "選んだ写真" || selectedCount() !== count || JSON.stringify(after) !== JSON.stringify(before)) {
          throw Object.assign(new Error(), { code: "cancel-changed-selection" });
        }
        report({ ok: true, phase: "cancel", selectionUnchanged: true, selectedCount: count });
        return;
      }

      if (config.phase === "missing") {
        stage = "missing-media";
        await delay(1500);
        await selectSelectedPhotos();
        if (tiles().length !== 0) {
          throw Object.assign(new Error(), { code: "moved-photos-still-listed" });
        }
        if (folderRow()) {
          throw Object.assign(new Error(), { code: "moved-folder-source-still-listed" });
        }
        report({ ok: true, phase: "missing", missingPhotosOmitted: true, missingFolderSourceHidden: true });
        return;
      }

      if (config.phase === "reappear") {
        stage = "media-restored";
        await waitFor(() => selectedRow(), "selected-source-not-restored", 90000);
        await selectSelectedPhotos();
        await waitFor(() => exactTiles(config.fixtureNames), "restored-media-not-listed", 90000);
        await selectFolder();
        await waitFor(() => tiles().length === 1 && tile(config.folderPhotoName), "restored-folder-media-not-listed", 90000);
        report({ ok: true, phase: "reappear", selectedPhotosRestored: true, folderMediaRestored: true, selectedCount: selectedCount() });
        return;
      }

      if (config.phase === "forget") {
        stage = "forget-reference";
        await selectSelectedPhotos();
        const trigger = await waitFor(() => document.querySelector('aside[aria-label="写真の場所"] button[aria-label="選んだ写真のメニュー"]'), "forget-menu-missing");
        await clickMenuItem(trigger, "一覧から外す");
        const dialog = await waitFor(() => [...document.querySelectorAll('[role="dialog"]')].find((item) => item.innerText.includes("選んだ写真を一覧から外しますか？")), "forget-confirmation-missing");
        const confirm = exactButton("一覧から外す", dialog);
        if (!confirm) throw Object.assign(new Error(), { code: "forget-confirmation-action-missing" });
        confirm.click();
        await waitFor(() => !selectedRow() && !config.fixtureNames.some((name) => tile(name)), "forget-reference-failed", 90000);
        report({ ok: true, phase: "forget", referenceRemoved: true, sourceFilesUntouched: true });
        return;
      }

      if (config.phase === "readd") {
        stage = "readd-after-forget";
        await addPhotos();
        await waitFor(() => currentPlace() === "選んだ写真" && selectedCount() === config.fixtureNames.length, "readd-failed", 90000);
        await waitFor(() => exactTiles(config.fixtureNames), "readd-list-incomplete", 90000);
        const photo = await waitFor(() => tile(config.jpegName), "readded-jpeg-missing");
        photo.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        const exposure = await waitFor(() => {
          const slider = document.querySelector('aside[aria-label="補正"] input[type="range"][aria-label="露光量"]');
          return slider && !slider.disabled ? slider : null;
        }, "readded-photo-not-editable", 90000);
        const restoredExposure = Number(exposure.value);
        if (!Number.isFinite(config.expectedExposure) || restoredExposure !== config.expectedExposure) {
          throw Object.assign(new Error(), { code: "saved-edit-not-restored" });
        }
        report({ ok: true, phase: "readd", referenceRestored: true, editRestored: true });
        return;
      }

      throw Object.assign(new Error(), { code: "unknown-phase" });
    } catch (error) {
      const observedExtensions = [...new Set(tiles().map((button) => photoExtension(button.title)))].sort();
      report({
        ok: false,
        phase: config.phase,
        stage,
        reason: typeof error?.code === "string" ? error.code : "probe-failed",
        tileCount: tiles().length,
        missingFormats: config.extensions.filter((extension) => !observedExtensions.includes(extension)),
        observedFormats: observedExtensions,
      });
    }
  })();
})();
