/**
 * 常設 Mac の接続用ソフトに渡すフォルダの登録（Epic #240 / B03 #244）。native（`camera_hosted_folders_*`）は path を返さず、
 * ID・名前・今読めるかだけを返す。最初の 1 つを登録すると native が常駐（launchd）を登録し、最後の 1 つを外すと止める。
 * 文言は既存の copy 定数だけを使い、説明文は足さない。外してもフォルダと写真は消えない。
 */
import { useCallback, useEffect, useState } from "react";
import { FolderPlus, HardDrive } from "lucide-react";
import { appDialog } from "niho-ui/app-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "niho-ui/components/popover";
import {
  PHOTO_EDITING_ADD_FOLDER_FAILED_TEXT,
  PHOTO_EDITING_ADD_FOLDER_LABEL,
  PHOTO_EDITING_FOLDERS_LOAD_FAILED_TEXT,
  PHOTO_EDITING_FORGET_FOLDER_CONFIRM_LABEL,
  PHOTO_EDITING_FORGET_FOLDER_FAILED_TEXT,
  PHOTO_EDITING_FORGET_FOLDER_LABEL,
  PHOTO_EDITING_FORGET_FOLDER_TITLE,
  PHOTO_EDITING_LOCAL_PLACE_LABEL,
  photoEditingForgetFolderDescription,
} from "niho-photo-editing/photo-editing-copy";

import type { Invoke } from "../camera-bridge";

export type HostedFolder = { readonly id: string; readonly name: string; readonly available: boolean };

export type HostedFolderCommands = {
  list(): Promise<HostedFolder[]>;
  /** ネイティブの選択ダイアログ。閉じたら null。 */
  add(): Promise<HostedFolder | null>;
  remove(id: string): Promise<void>;
};

function parseFolder(value: unknown): HostedFolder | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, name, available } = value as Record<string, unknown>;
  return typeof id === "string" && typeof name === "string" && typeof available === "boolean" ? { id, name, available } : null;
}

export function createHostedFolderCommands(invoke: Invoke): HostedFolderCommands {
  return {
    async list() {
      const folders = await invoke<unknown>("camera_hosted_folders_list");
      return Array.isArray(folders) ? folders.flatMap((folder) => parseFolder(folder) ?? []) : [];
    },
    async add() {
      return parseFolder(await invoke<unknown>("camera_hosted_folders_add"));
    },
    async remove(id) {
      await invoke("camera_hosted_folders_remove", { request: { id } });
    },
  };
}

const ROW_BUTTON =
  "shrink-0 rounded-lg px-2 py-1 text-xs font-bold text-niho-text-sub hover:bg-niho-pale/60 hover:text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-wait";

/** 登録したフォルダの一覧と、追加・外す。 */
export function HostedFolderList({ commands }: { commands: HostedFolderCommands }) {
  const [folders, setFolders] = useState<HostedFolder[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setFolders(await commands.list());
    } catch {
      setFailure(PHOTO_EDITING_FOLDERS_LOAD_FAILED_TEXT);
    }
  }, [commands]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (work: () => Promise<void>, failed: string) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
    } catch {
      setFailure(failed);
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const add = () =>
    run(async () => {
      await commands.add();
    }, PHOTO_EDITING_ADD_FOLDER_FAILED_TEXT);

  const remove = (folder: HostedFolder) =>
    run(async () => {
      const confirmed = await appDialog.confirm({
        title: PHOTO_EDITING_FORGET_FOLDER_TITLE,
        description: photoEditingForgetFolderDescription(folder.name),
        confirmLabel: PHOTO_EDITING_FORGET_FOLDER_CONFIRM_LABEL,
      });
      if (confirmed) await commands.remove(folder.id);
    }, PHOTO_EDITING_FORGET_FOLDER_FAILED_TEXT);

  return (
    <section aria-label={PHOTO_EDITING_LOCAL_PLACE_LABEL} className="flex flex-col gap-1">
      <h2 className="px-2 pb-1 text-xs font-bold text-niho-text-sub">{PHOTO_EDITING_LOCAL_PLACE_LABEL}</h2>
      {folders && folders.length > 0 ? (
        <ul className="flex flex-col">
          {folders.map((folder) => (
            <li key={folder.id} className="flex min-h-11 items-center gap-2 rounded-lg px-2">
              <span className={`min-w-0 flex-1 truncate text-sm ${folder.available ? "text-niho-text" : "text-niho-text-sub opacity-60"}`}>
                {folder.name}
              </span>
              <button type="button" disabled={busy} onClick={() => void remove(folder)} className={ROW_BUTTON}>
                {PHOTO_EDITING_FORGET_FOLDER_LABEL}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => void add()}
        className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-bold text-niho-accent-ink hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-wait"
      >
        <FolderPlus className="h-4 w-4" aria-hidden />
        {PHOTO_EDITING_ADD_FOLDER_LABEL}
      </button>
      {failure ? (
        <p role="alert" className="px-2 text-xs text-niho-danger">
          {failure}
        </p>
      ) : null}
    </section>
  );
}

/** header の入口（trusted host が `hostedFolders` を渡したときだけ出す）。 */
export function HostedFolders({ commands }: { commands: HostedFolderCommands }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={PHOTO_EDITING_LOCAL_PLACE_LABEL}
          title={PHOTO_EDITING_LOCAL_PLACE_LABEL}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-niho-text-sub transition hover:bg-niho-pale/60 hover:text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
        >
          <HardDrive className="h-[18px] w-[18px]" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <HostedFolderList commands={commands} />
      </PopoverContent>
    </Popover>
  );
}
