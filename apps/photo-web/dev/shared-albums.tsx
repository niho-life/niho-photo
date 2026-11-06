/**
 * Development only (B08 #249): the shared-album screens in the Photo Web shell, on the synthetic in-memory server with
 * canvas-drawn gradient photos. No real photo, person, secret or server. `?as=owner|member|viewer` picks the viewer,
 * `?scene=list|album|share|settings|invite-unavailable|held` the starting screen, and `#frame:<query>:<width>:<height>` shows
 * that page in a fixed-size frame (narrow screenshots).
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  createSharedAlbumItems,
  createSharedAlbumMembership,
  createSharedAlbumMockServer,
  createSharedAlbumScreensPort,
} from "@niho/photo-cloud-library/sharing";
import { PHOTO_STORAGE_LOCATION_COPY } from "niho-photo-editing/photo-editing-copy";
import { PhotoLibraryScreenTabs } from "niho-photo-editing/shared-album/photo-shared-album-list";
import type { PhotoSharedAlbumOpenedInvite, PhotoSharedAlbumPort } from "niho-photo-editing/shared-album/photo-shared-album-port";
import { PhotoSharedAlbumWorkspace } from "niho-photo-editing/shared-album/photo-shared-album-workspace";
import { PhotoStorageSettingsDialog } from "niho-photo-editing/shared-album/photo-storage-settings-dialog";
import { AppDialogHost } from "niho-ui/components/app-dialog-host";

import "../src/styles.css";
import "../src/view/PhotoWebView.css";

const USERS = {
  owner: { userId: "synthetic-owner", displayName: "佐藤 花子" },
  member: { userId: "synthetic-member", displayName: "鈴木 一郎" },
  viewer: { userId: "synthetic-viewer", displayName: "高橋 葵" },
} as const;
type Who = keyof typeof USERS;
const HUES = [[24, 200], [200, 280], [140, 40], [330, 210], [48, 160], [260, 20], [180, 300], [10, 90], [220, 120], [300, 60], [90, 220], [160, 340]];

async function gradientPhoto(index: number, width = 1200, height = 800): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  const [from, to] = HUES[index % HUES.length] as [number, number];
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${from} 70% 62%)`);
  gradient.addColorStop(1, `hsl(${to} 55% 38%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(255,255,255,0.28)";
  context.beginPath();
  context.arc(width * (0.25 + (index % 3) * 0.2), height * 0.45, height * 0.22, 0, Math.PI * 2);
  context.fill();
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value as Blob), "image/jpeg", 0.85));
  return new File([blob], `synthetic-${index}.jpg`, { type: "image/jpeg" });
}

const steps: string[] = [];
const step = (name: string) => {
  steps.push(name);
  const element = document.getElementById("seed-steps");
  if (element) element.textContent = steps.join(" > ");
};

async function seed() {
  step("start");
  const server = createSharedAlbumMockServer({ users: Object.values(USERS) });
  const signal = new AbortController().signal;
  const ports = Object.fromEntries((Object.keys(USERS) as Who[]).map((who) => {
    const client = server.clientFor(USERS[who].userId);
    const port = createSharedAlbumScreensPort({
      items: createSharedAlbumItems({ client, uploader: server.uploader }),
      membership: createSharedAlbumMembership({ client }),
      download: (request, downloadSignal) => client.download(request, downloadSignal),
      inviteUrl: (secret) => `${location.origin}/#invite=${encodeURIComponent(secret)}`,
      saveFile: async () => undefined,
      storageLocations: async () => [
        { locationId: "nihoCloud", kind: "nihoCloud", name: null, hostedMacStatus: null, usage: { usedBytes: 1.2e9, quotaBytes: 5e9 } },
        { locationId: "hosted", kind: "hostedMac", name: "自宅の Mac mini", hostedMacStatus: "sleeping", usage: null },
      ],
    });
    return [who, port];
  })) as Record<Who, PhotoSharedAlbumPort>;
  const items = createSharedAlbumItems({ client: server.clientFor(USERS.member.userId), uploader: server.uploader });

  step("ports");
  const first = await gradientPhoto(0);
  step(`photo ${first.size}`);
  const workshop = await ports.owner.createAlbum("週末のワークショップ", signal);
  step("album");
  const invite = async (albumId: string, from: Who, to: Who, role: "contributor" | "viewer") => {
    const url = await ports[from].copyInviteLink(albumId, role, signal);
    await ports[to].join(decodeURIComponent(url.slice(url.indexOf("#invite=") + 8)), signal);
  };
  await invite(workshop, "owner", "member", "contributor");
  await invite(workshop, "owner", "viewer", "viewer");
  step("invited");
  for (let index = 0; index < 7; index += 1) step(`add ${JSON.stringify(await ports.owner.addFile(workshop, await gradientPhoto(index), signal))}`);
  for (let index = 7; index < 10; index += 1) await ports.member.addFile(workshop, await gradientPhoto(index, 800, 1000), signal);
  // A member's edited photo whose device is asleep: 準備中 for the owner and the member until it comes back.
  const binding = { sourceGeneration: 1, sourceSha256: "a".repeat(64), recipeRevision: 1, settingsSha256: "b".repeat(64), engine: "niho-14", rendererManifestSha256: "c".repeat(64), maskSurfaceIds: [] };
  server.addLibraryPhoto({ ownerId: USERS.member.userId, libraryId: "synthetic-library", photoId: "synthetic-photo", binding, recipe: { revision: 1, settings: { v: 1, engine: "niho-14" }, settingsSha256: "b".repeat(64), baseVersion: null, maskSurfaceIds: [], updatedAt: "2026-11-07T00:00:00.000Z" } as never });
  server.setDeviceOnline(USERS.member.userId, false);
  await items.addLibraryPhotos(workshop, [{ libraryId: "synthetic-library", photoId: "synthetic-photo" }], signal);

  const family = await ports.owner.createAlbum("家族の写真", signal);
  for (let index = 3; index < 5; index += 1) await ports.owner.addFile(family, await gradientPhoto(index), signal);
  const scouting = await ports.member.createAlbum("撮影会の下見", signal);
  await invite(scouting, "member", "owner", "viewer");
  for (let index = 8; index < 11; index += 1) await ports.member.addFile(scouting, await gradientPhoto(index), signal);
  const openWorkshop = async (who: Who) => {
    const url = await ports.owner.copyInviteLink(workshop, "viewer", signal);
    return who === "owner" ? null : decodeURIComponent(url.slice(url.indexOf("#invite=") + 8));
  };
  return { server, ports, workshop, openWorkshop };
}

function Harness(props: { readonly who: Who; readonly scene: string }) {
  const [state, setState] = useState<{ port: PhotoSharedAlbumPort; invite: PhotoSharedAlbumOpenedInvite | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(props.scene === "settings");
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    void seed().catch((error: unknown) => {
      setFailure(JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})));
      throw error;
    }).then(async (seeded) => {
      const port = seeded.ports[props.who];
      // Opening the album goes through the same path as an invite link (joining again changes nothing).
      let secret: string | null = null;
      if (props.scene === "album" || props.scene === "share") {
        secret = props.who === "owner" ? null : await seeded.openWorkshop(props.who);
        if (props.who === "owner") {
          const url = await seeded.ports.owner.copyInviteLink(seeded.workshop, "contributor", new AbortController().signal);
          secret = decodeURIComponent(url.slice(url.indexOf("#invite=") + 8));
        }
      }
      if (props.scene === "invite-unavailable") secret = "synthetic-expired-invite-secret";
      // Opened before signing in: the synthetic BFF holds it and the screen joins with what it holds.
      if (props.scene === "held" && secret === null) {
        const held = await seeded.openWorkshop(props.who);
        if (held !== null) {
          seeded.server.holdPendingInvite(held);
          setState({ port, invite: { kind: "held" } });
          return;
        }
      }
      setState({ port, invite: secret === null ? null : { kind: "link", secret } });
    });
  }, [props.who, props.scene]);
  useEffect(() => {
    if (props.scene !== "share" || !state) return;
    const timer = setInterval(() => {
      const share = document.querySelector<HTMLButtonElement>("button[aria-label='共有']");
      if (share) {
        share.click();
        clearInterval(timer);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [props.scene, state]);
  return (
    <div className="photo-web-root">
      <AppDialogHost />
      <header className="photo-web-header">
        <div className="photo-web-brand"><strong>NIHO photo</strong></div>
        <div className="photo-web-header-actions">
          <span className="photo-web-cloud">クラウド</span>
          <button type="button" onClick={() => setSettingsOpen(true)}>{PHOTO_STORAGE_LOCATION_COPY.settings}</button>
          <button type="button">ログアウト</button>
        </div>
      </header>
      <div className="photo-web-screens">
        <PhotoLibraryScreenTabs current="sharedAlbums" onChange={() => undefined} />
      </div>
      {failure ? <pre role="alert">{failure}</pre> : null}
      <pre id="seed-steps" hidden={!new URLSearchParams(location.search).has("debug")} />
      <main className="photo-web-workspace">
        <div className="photo-web-shared-albums">
          {state ? <PhotoSharedAlbumWorkspace port={state.port} invite={state.invite} onOpenStorage={() => setSettingsOpen(true)} /> : null}
        </div>
        {state ? <PhotoStorageSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} loadLocations={(signal) => state.port.storageLocations(signal)} /> : null}
      </main>
    </div>
  );
}

function Frame(props: { readonly query: string; readonly width: number; readonly height: number }) {
  // `still` turns animations off so a screenshot never catches a dialog half open.
  return <iframe title="frame" src={`${location.pathname}?${props.query}&still`} style={{ width: props.width, height: props.height, border: 0, display: "block" }} />;
}

const frame = /^#frame:([^:]*):(\d+):(\d+)$/u.exec(location.hash);
const params = new URLSearchParams(location.search);
if (params.has("still")) {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }";
  document.head.appendChild(style);
}
const who = (["owner", "member", "viewer"].includes(params.get("as") ?? "") ? params.get("as") : "owner") as Who;
createRoot(document.getElementById("root") as HTMLElement).render(
  frame ? <Frame query={frame[1] as string} width={Number(frame[2])} height={Number(frame[3])} /> : <Harness who={who} scene={params.get("scene") ?? "list"} />,
);
