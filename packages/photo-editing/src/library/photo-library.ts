import type { DevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoEditingSettings } from "../photo-editing-types";

/**
 * 写真の読み書きを提供するPhotoLibraryの接続口。
 *
 * 編集面（packages/photo-editing）が写真を読み書きする唯一の口。編集面は API クライアント・Tauri・Next を直接 import せず、ここに
 * 書いた形だけを読む。アプリごとに違ってよいのは実装と `capabilities` だけで、編集面は `capabilities` で道具と文言の出し分けだけを
 * 行う（できないことは理由と次の一歩の 1 行にする）。
 *
 * - ストレージや端末機能への接続はホストが実装する。
 * - 写真の行（{@link PhotoLibraryPhoto} / {@link PhotoLibraryItem}）は、今の編集面が読むクラウドの行と同じ項目・同じ型にしてある
 *   （ブラウザ版の挙動を変えずに編集面を package へ移すため）。クラウドだけの項目は、この Mac の実装では決まった値を返す（各項目の説明）
 * - 失敗は投げる（`Error`）。状態として返す結果（作業コピーの準備中・補正の版の競合など）だけを型で返し、投げた失敗の読み方は
 *   {@link PhotoLibraryErrors}
 * - 編集面はどの URL も自分で読まない（fetch しない）。バイト列（オリジナル・作業コピー・記事の画像）は library のメソッドから受け取り、
 *   URL（一覧のプレビュー・記事の画像の表示）は `<img src>`・`<a href>` に入れるだけ。`ref` は発行した library だけが解釈する不透明な
 *   参照で、編集面は受け取ったものをそのまま渡し返す
 * - library は状態を隠し持たない（一覧の条件・選んだフォルダは `list` の query で渡す）
 * - クラウドだけの道具（お気に入り・アルバム・記事の画像・補正後のプレビュー・ファイルの追加）と、NIHO Desktop だけの道具
 *   （原寸の書き出し・書き出し先のフォルダ・この Mac からの追加）は省略できる。無ければ編集面はその道具を出さない。持っていても
 *   使えるかは `capabilities` で確かめる（クラウドの実装は NIHO Desktop の外でも持ち、そこでは `capabilities` が false）。選別の
 *   フラグ（`flags`）も省略でき、`capabilities.flags` を省けば使えない
 *
 * React からは `PhotoLibraryProvider` で渡し、編集面は `usePhotoLibrary()` で読む（./photo-library-context.tsx。この型は React に依らない）。
 */
export type PhotoLibrary = {
  /** 置き場（`capabilities` を読む前から決まっている）。 */
  readonly place: PhotoLibraryPlace;
  /**
   * すぐ分かる値（読めていなければ閉じた値。fail closed）。{@link PhotoLibrary.capabilities} が返るまでこれで描く（クラウドは
   * 確かめ済みの NIHO Desktop の能力があればそれを反映する）
   */
  readonly initialCapabilities: PhotoLibraryCapabilities;
  /**
   * できること。クラウドは NIHO Desktop の handshake（ブラウザ・スマホアプリではすぐ返る）を読んで決める。読めなければ
   * {@link PhotoLibrary.initialCapabilities} と同じ閉じた値。
   */
  capabilities(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryCapabilities>;
  /** 受入まで拠点を絞る機能（クラウドは拠点ごと。読めなければ全部出さない）。この Mac は全部出す */
  rollout(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryRollout>;
  /** 段 2 の wasm の読み込み先（決まりごと 4。web は `/develop-engine/<engine>/…`、camera は `.app` の中） */
  readonly engineAssets: PhotoLibraryEngineAssets;
  /** 1 回で送れる数などの上限 */
  readonly limits: PhotoLibraryLimits;
  /** 投げた失敗の読み方 */
  readonly errors: PhotoLibraryErrors;

  // ---- 一覧・1 枚
  /**
   * 一覧の 1 ページ（並び・絞り込みは実装がする）。続きは同じ条件で `cursor` に `next` を渡す。フォルダ（{@link PhotoLibrary.folders}）
   * のある置き場は `folderId` のフォルダ（とその下）の写真
   */
  list(query: PhotoLibraryListQuery, options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryListPage>;
  /**
   * 1 枚を ID で読む（一覧をたどらない）。無い・置き終えていない写真は null。中身を読んだ行なので `contentSha256` は埋まっている
   * （{@link PhotoLibraryItem.contentSha256}。一覧の行を替えるのに使う）
   */
  get(photoId: string, options?: PhotoLibraryRequestOptions): Promise<(PhotoLibraryItem & { contentSha256: string }) | null>;
  /**
   * 中身の SHA-256 で写真を探す（{@link PhotoLibraryLimits.lookupMaxCount} 件まで）。読むだけで、オリジナルを出さない
   * （別の端末で直した補正の読み直しに使う）。照らすのは library が中身を知っている写真だけ（クラウドは置いた写真全部、この Mac は
   * 開いた写真だけ）
   */
  lookup(contentSha256s: readonly string[], options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryLookupMatch[]>;
  /**
   * 写真の情報（撮影条件・カメラ・レンズ・撮影日時・寸法・場所。`capabilities.info`。右パネルの「情報」。niho-photo#43）。読めた項目
   * だけを入れ、読めない項目は null か省略。読めないファイルは全部 null で返してよい（編集面は失敗の表示をせず、写真の行の項目だけを
   * 出す）。無い・置き終えていない写真は null。ファイル名・形式・大きさは写真の行（{@link PhotoLibraryPhoto}）で足りるので返さない
   */
  info?(photoId: string, options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryPhotoInfo | null>;

  // ---- 開く
  /**
   * オリジナルの読み方（不透明な参照）と、開いた時点の写真（補正と版）。バイト列は {@link PhotoLibrary.loadOriginal} で読む。
   * オリジナルの無い写真は投げる
   */
  openOriginal(photoId: string, options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryOriginal>;
  /**
   * {@link PhotoLibrary.openOriginal} の `source` のオリジナルを読む（`fileName` の File にする）。`maxBytes` を超えたら読むのを
   * やめて `BrowserPhotoSourceError("too_large")`、読めなければ `BrowserPhotoSourceError("fetch_failed")`（どちらも
   * `browser-photo-source.ts`）。止めたら（`signal`）AbortError をそのまま投げる
   */
  loadOriginal(
    photoId: string,
    source: PhotoLibraryOriginalSource,
    options: { signal: AbortSignal; fileName: string; maxBytes: number },
  ): Promise<File>;
  /** 作業コピー（段 1 の出力）があるか。無ければ準備を始め、状態を返す（クラウドはワーカーか NIHO Desktop、この Mac は sidecar） */
  ensureWorkingCopy(photoId: string, options?: PhotoLibraryWorkingCopyRequestOptions): Promise<PhotoLibraryWorkingCopyResult>;
  /** できている作業コピーを読む（{@link PhotoLibrary.ensureWorkingCopy} の `ready` の `download` を渡す。作業コピーの唯一の読み口） */
  loadWorkingCopy(
    photoId: string,
    download: PhotoLibraryWorkingCopyDownload,
    options: { signal: AbortSignal },
  ): Promise<PhotoLibraryWorkingCopy>;
  /**
   * canonical 作業コピーを待つ間だけ使う、長辺 1280〜2048px の編集可能な仮入力。この口を持たない置き場は従来どおり
   * canonical を待つ。返す JPEG は canonical の土台ではなく、通常保存・原寸書き出し・補正後プレビューには使わない。
   */
  loadInteractivePreview?(
    photoId: string,
    options: { signal: AbortSignal; maxDimension: number },
  ): Promise<PhotoLibraryInteractivePreview>;
  /** 選択写真の前後 1 枚だけを idle 時に温める。失敗は呼び出し側へ表示しない。 */
  prefetchInteractivePreview?(
    photoId: string,
    options: { signal: AbortSignal; maxDimension: number },
  ): Promise<void>;
  /** content SHA-256 に結び付けた provisional 編集値。画像・path・元名は保存しない。 */
  loadProvisionalDraft?(photoId: string, contentSha256: string): Promise<PhotoLibraryProvisionalDraft | null>;
  saveProvisionalDraft?(
    photoId: string,
    contentSha256: string,
    settings: DevelopSettings,
  ): Promise<PhotoLibraryProvisionalDraft>;
  /** canonical 保存が確認できた世代だけ消す（後発の draft を消さない）。 */
  removeProvisionalDraft?(photoId: string, contentSha256: string, generation: number): Promise<boolean>;
  /** 作れなかった作業コピー（`failed`）を待ちに戻す */
  retryWorkingCopy(photoId: string): Promise<PhotoLibraryWorkingCopyRetry>;
  /**
   * 記事の画像（元の写真の無い写真の中身。`capabilities.articleImages`）の表示用の URL と形式。元の写真のある写真・記事用の画像の無い
   * 写真は null。写真の面は記事用の画像の列を読まない（元の写真の無い行だけ）
   */
  readArticleImage?(
    photo: Pick<PhotoLibraryItem, "id" | "hasOriginal" | "hasWebImage">,
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoLibraryArticleImage | null>;
  /**
   * {@link PhotoLibrary.readArticleImage} の記事の画像の中身を読む（`fileName` の File にする。書き出し用）。読めなければ
   * `BrowserPhotoSourceError("fetch_failed")`
   */
  loadArticleImage?(
    photoId: string,
    image: PhotoLibraryArticleImage,
    options: { signal: AbortSignal; fileName: string },
  ): Promise<File>;

  // ---- 補正
  /**
   * 補正（`developSettings`）を保存する。`expectedRevision`（直し始めた版）を渡すと、今の版と同じときだけ保存し、別の端末が先に
   * 保存していれば `stale`（今の写真）。版の照合は niho-develop-engine 決まりごと 4 のまま。`editedPreviewBy` は補正後のプレビューの
   * 描き手（一括の保存は `server`）。ほかの失敗は投げる
   */
  saveDevelopSettings(
    photoId: string,
    settings: DevelopSettings,
    options?: { expectedRevision?: number; editedPreviewBy?: "client" | "server" },
  ): Promise<PhotoLibrarySaveResult>;
  /**
   * いま表示している補正後の画（長辺 1280px までと一覧のタイル用の 512px まで）を写真に付ける（`capabilities.editedPreview`）。
   * 同じか新しい版がもう付いていれば何も上げない
   */
  attachEditedPreview?(
    photoId: string,
    developRevision: number,
    jpegs: PhotoLibraryEditedPreviewJpegs,
    options: { signal: AbortSignal },
  ): Promise<PhotoLibraryEditedPreviewAttached>;
  /**
   * 写真の補正の版（`capabilities.versions`。右パネルの「版」。niho-photo#42。Lightroom の「バージョン」）。名前を付けて残した補正と、
   * 版を切り替える前に残した自動の版。写真の行（{@link PhotoLibraryPhoto}）には載せず、版の面を開いたときだけ読む。版の無い写真は
   * 空の配列と `revision` 0。無い・置き終えていない写真は投げる（`errors.isNotFound`）
   */
  developVersions?(photoId: string, options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryDevelopVersions>;
  /**
   * 版の配列をまるごと保存する（作る・名前を変える・消す・切り替える前の自動の版）。`expectedRevision`（読んだ・前に保存したときの
   * `revision`）と今の `revision` が違えば保存せず `stale`（今の配列と `revision`）。版は `developSettings` に入れず、写真の補正
   * （{@link PhotoLibrary.saveDevelopSettings}）とは別の置き場・別の `revision` で持つ。ほかの失敗は投げる
   */
  saveDevelopVersions?(
    photoId: string,
    versions: readonly PhotoLibraryDevelopVersion[],
    options: { expectedRevision: number },
  ): Promise<PhotoLibraryDevelopVersionsSaveResult>;
  /**
   * 部分補正のマスク（ブラシ・被写体・空）の面を写真に保存する（`capabilities.maskSurfaces`。`docs/local-adjustments.md`「面の受け渡し」）。
   * `png` は 8bit グレーの PNG（wasm の `encodeMaskSurface` が作る形・8 MiB 以下・1〜4096 画素）。`id` は中身の sha256 で、同じ中身は
   * 同じ `id`（補正を保存する前でも保存できる）。補正の `masks[].surface` は `id` で面を呼ぶ。保存できなければ投げる
   */
  saveMaskSurface?(photoId: string, png: Uint8Array): Promise<{ id: string; width: number; height: number }>;
  /**
   * 写真の面の PNG（中身の sha256 を `surfaceId` と照らしたもの）。置き場に無ければ null（被写体・空の面も同じ口で読む。
   * `maskSurfaces` が無い置き場でも、読めるなら読む）
   */
  loadMaskSurface?(photoId: string, surfaceId: string): Promise<Uint8Array | null>;
  /**
   * 写真の作業画像（マスクの座標の基準。RAW は作業コピー）から被写体・空のマスクの面を作って写真に保存する
   * （`capabilities.maskDetection` の種類だけ。niho-photo#135・`docs/local-adjustments.md`「面の検出」）。`developSettings` は編集面が
   * いま描いている補正（作業画像を描く数式と土台を読むだけで、補正・幾何・マスクは当てない）。面は {@link PhotoLibrary.saveMaskSurface}
   * と同じ置き場・同じ形で、補正の `masks[].surface` に `id`・`width`・`height` をそのまま書く。見つからなければ `notFound`。
   * `signal` で止めたら AbortError で reject。ほかの失敗は投げる
   */
  detectMaskSurface?(
    photoId: string,
    kind: PhotoLibraryMaskDetectionKind,
    options: { developSettings: object; signal?: AbortSignal },
  ): Promise<PhotoLibraryMaskDetectionResult>;

  // ---- 書き出す
  /** 「オリジナル」の書き出し（オリジナルのバイト列と元の名前）。補正を当てた JPEG は編集面が段 2 の wasm で描く */
  downloadOriginal(
    photo: Pick<PhotoLibraryItem, "id" | "fileName" | "sizeBytes" | "hasOriginal">,
    options?: PhotoLibraryRequestOptions,
  ): Promise<{ blob: Blob; fileName: string }>;
  /**
   * native の段 2 で原寸の JPEG にして保存する（`capabilities.nativeExport`）。`folderId` が無ければ保存ダイアログ、あれば
   * そのフォルダへ。ダイアログを閉じたら `saved: false`。失敗は画面に出せる 1 行の `Error`（フォルダが無くなったときだけ
   * {@link PhotoLibraryErrors.isExportFolderNotFound}）
   */
  exportNative?(request: PhotoLibraryNativeExportRequest): Promise<PhotoLibraryNativeExportResult>;
  /** 複数枚の書き出し先のフォルダを選ぶ（`capabilities.exportFolder`）。閉じたら null。返すのは不透明な ID */
  chooseExportFolder?(): Promise<string | null>;

  // ---- 足す
  /** ファイル（ブラウザのファイル選択・ドロップ）を足す（`capabilities.addFiles`）。同じ写真があれば `alreadyStored` */
  addFile?(file: File, options?: PhotoLibraryAddFileOptions): Promise<PhotoLibraryAddResult>;
  /** この Mac の写真を足す（NIHO Desktop の中のクラウド。`capabilities.addFromDevice`） */
  readonly device?: PhotoLibraryDeviceImport;

  // ---- 消す
  /**
   * 写真を消す（1 枚ずつ。ほかの人が先に消していた写真は消せたとみなす）。消せなかった写真の失敗は `errors` に入れて残りを続ける。
   * この Mac は「一覧から外す」だけで原本を消さない
   */
  delete(photoIds: readonly string[]): Promise<PhotoLibraryDeleteResult>;
  /** 写真を記事で使っている数（消す前の確かめ。`capabilities.articleImages`。{@link PhotoLibraryLimits.referencesMaxCount} 件まで） */
  countArticleReferences?(
    photoIds: readonly string[],
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoLibraryArticleReference[]>;

  // ---- フォルダ・お気に入り・アルバム・プリセット
  /**
   * 写真のフォルダ（この Mac）。あるときだけ編集面は左にフォルダの面を出し、選んだフォルダを {@link PhotoLibrary.list} の
   * `folderId` で渡す（library は選んだフォルダを持たない）。クラウドは持たない
   */
  readonly folders?: PhotoLibraryFolders;
  /** ネイティブの選択ダイアログで追加した、この Mac の写真。あるときだけ「選んだ写真」のソースを出す。 */
  readonly selectedPhotos?: PhotoLibrarySelectedPhotos;
  /** お気に入り（♥。`capabilities.favorites`） */
  readonly favorites?: PhotoLibraryFavorites;
  /**
   * 選別のフラグ（採用 / 却下。`capabilities.flags`。niho-photo#47。Lightroom のフラグ）。♥ とは別の印で、同じ写真に両方付いてよい。
   * 却下しても写真は消えない（消すのは {@link PhotoLibrary.delete}）
   */
  readonly flags?: PhotoLibraryFlags;
  /** アルバム（`capabilities.albums`） */
  readonly albums?: PhotoLibraryAlbums;
  /** 保存したプリセット（クラウドは拠点のプリセット、この Mac は取り込んだ XMP。同梱 3 本は段 2 の wasm が返す） */
  readonly presets: PhotoLibraryPresets;
};

/** 写真の置き場（クラウドか、この Mac か）。 */
export type PhotoLibraryPlace = "cloud" | "local";

export type PhotoLibraryRequestOptions = { signal?: AbortSignal };

/** native の作業コピーproducerへ渡す、今の写真と編集中の設定の状態。cloud provider は解釈しない。 */
export type PhotoLibraryDevelopSourceContext = {
  /** 保存した補正があるか。native は自分の保存ストアでも再確認する。 */
  hasSavedDevelopSettings: boolean;
  /** 今の補正が neutral でない、または未保存draftを復元中か。 */
  hasDevelopEdits: boolean;
  /** 保存済み/draft が使う作業コピーの版。オリジナル直描き・旧 `base: null` は null。 */
  baseVersion: string | null;
};

export type PhotoLibraryWorkingCopyRequestOptions = PhotoLibraryRequestOptions & {
  sourceContext?: PhotoLibraryDevelopSourceContext;
};

/** 写真から作るマスクの面の種類（{@link PhotoLibrary.detectMaskSurface}）。 */
export type PhotoLibraryMaskDetectionKind = "subject" | "sky";

/** 写真から作れるマスクの面の種類ごとの可否（{@link PhotoLibraryCapabilities.maskDetection}）。 */
export type PhotoLibraryMaskDetectionCapabilities = Readonly<Record<PhotoLibraryMaskDetectionKind, boolean>>;

/** {@link PhotoLibrary.detectMaskSurface} の答え（面を保存した・その種類の範囲が写真に無かった）。 */
export type PhotoLibraryMaskDetectionResult =
  | { kind: "detected"; id: string; width: number; height: number }
  | { kind: "notFound" };

/**
 * 原寸の書き出しの描画（Mac の `niho-develop-render`）が描ける設定（`niho-develop-render capabilities`。niho-photo#131）。原寸へ
 * 渡せる設定は、描画の版ではなくこれで決める（`photo-editing-native-export.ts`）。
 */
export type PhotoLibraryNativeRenderer = {
  /** 読める `developSettings.v` */
  settingsVersions: readonly number[];
  /** 描ける `developSettings.engine` */
  engines: readonly string[];
  /** `v` を上げずに足した描画（`colorGradingLuminance`: 中間調・全体の輝度）。古い描画は黙って描かない */
  features: readonly string[];
  /** 描けるマスクの種類（`brush`・`subject`・`sky` は面） */
  maskKinds: readonly string[];
  /** 読める元（オリジナル・作業コピー）の最大の画素数 */
  maxPixels: number;
};

/** 編集面が道具と文言を出し分ける、できること。 */
export type PhotoLibraryCapabilities = {
  place: PhotoLibraryPlace;
  /** RAW・HEIC / HEIF・TIFF・大きな PNG を作業コピー（段 1）で直せる */
  rawWorkingCopy: boolean;
  /** native の段 2 で原寸の JPEG にできる（{@link PhotoLibrary.exportNative}。クラウドは NIHO Desktop の中だけ） */
  nativeExport: boolean;
  /**
   * 原寸の書き出し（1 枚と、書き出し先のフォルダへの複数枚）を出すが、アプリの更新が要る（押すと更新の 1 行を出し、書き出さない。
   * `nativeExport` と同時には true にならない）。クラウドは原寸の書き出しの土台を戻せない v20〜v22 の NIHO Desktop
   */
  nativeExportUpdateRequired: boolean;
  /** 原寸の書き出しで、書き出し先のフォルダを 1 回選んで複数枚を書ける（{@link PhotoLibrary.chooseExportFolder}） */
  exportFolder: boolean;
  /**
   * 原寸の書き出しで HEIC / HEIF・TIFF も描ける（NIHO camera の段 1 の `raster` の原寸。省略 = 描けない = NIHO Desktop は RAW・JPEG・
   * PNG だけ）
   */
  nativeExportRaster?: boolean;
  /**
   * 原寸の書き出しで部分補正（`developSettings.masks`）のある設定も描ける（NIHO camera の同梱の niho-develop-render が描ける版。省略 =
   * 描けない。画面の扱いは M3 #67）
   */
  nativeExportMasks?: boolean;
  /**
   * 原寸の書き出しの描画が描ける設定（NIHO camera の同梱の niho-develop-render が答えたとき。省略 = 答えない古い描画〔0.16.0
   * など〕= 遠近・修復・レンズ補正・中間調 / 全体の輝度は原寸へ渡さない）
   */
  nativeExportRenderer?: PhotoLibraryNativeRenderer;
  /**
   * マスクの面（ブラシ）を写真に保存できる（{@link PhotoLibrary.saveMaskSurface}。省略 = 保存できない = 画面はブラシを出さない。
   * 面を読むだけなら {@link PhotoLibrary.loadMaskSurface} の有無で決まる）
   */
  maskSurfaces?: boolean;
  /**
   * 写真から作れるマスクの面の種類（{@link PhotoLibrary.detectMaskSurface}。niho-photo#135）。省略・false = 作れない = 画面は
   * 「被写体」「空」の追加を出さない（クラウド・古い Mac・macOS 13 など）
   */
  maskDetection?: PhotoLibraryMaskDetectionCapabilities;
  /** 背景除去（C4） */
  cutout: boolean;
  favorites: boolean;
  albums: boolean;
  /** 記事の画像（元の写真の無い写真・記事用の画像・記事で使っている数） */
  articleImages: boolean;
  /** 一覧で複数枚を選ぶ（一括の補正・書き出し・消す） */
  multiSelect: boolean;
  /** スマホの面を出せる（拠点ごとの受入は {@link PhotoLibraryRollout.mobileEditing}） */
  mobile: boolean;
  /** 補正後のプレビューを写真に付ける（{@link PhotoLibrary.attachEditedPreview}） */
  editedPreview: boolean;
  /** ファイルを足す（{@link PhotoLibrary.addFile}） */
  addFiles: boolean;
  /** この Mac の写真を足す（{@link PhotoLibrary.device}） */
  addFromDevice: boolean;
  /** この Mac から足すときにフォルダを選べる（{@link PhotoLibraryDeviceImport.pick} の `folder`） */
  addFromDeviceFolder: boolean;
  /**
   * 写真の情報（撮影条件・カメラ・レンズなど）を読める（{@link PhotoLibrary.info}）。省略 = 読めない（右パネルの「情報」は写真の
   * 行のファイルの項目だけを出す）
   */
  info?: boolean;
  /**
   * 補正の版を残せる（{@link PhotoLibrary.developVersions}・{@link PhotoLibrary.saveDevelopVersions}。niho-photo#42）。省略 = 残せない
   * （右端の帯に「版」を出さない）
   */
  versions?: boolean;
  /**
   * 選別のフラグ（採用 / 却下）を付け外しし、一覧を絞れる（{@link PhotoLibrary.flags}・{@link PhotoLibraryListQuery.flag}。
   * niho-photo#47）。省略 = 使えない（P / X / U のキー・下段のボタン・絞り込みの「選別」を出さない）
   */
  flags?: boolean;
};

/** 受入まで拠点を絞る機能（F9 ）。 */
export type PhotoLibraryRollout = {
  /** 切り抜き・回転・角度補正の道具 */
  crop: boolean;
  /** スマホ（1024px 未満）で写真を直す面 */
  mobileEditing: boolean;
};

export type PhotoLibraryEngineAssets = {
  /** 版固定の manifest（`manifest-<crate 版>.json`）の URL。作れない環境（server など）では null */
  manifestUrl(): string | null;
  /** camera の Worker だけが native を先に試す。省略時は従来どおり wasm。 */
  preferNative?: boolean;
};

export type PhotoLibraryLimits = {
  /** 一覧の 1 ページの件数 */
  listPageSize: number;
  /** {@link PhotoLibrary.lookup} 1 回で調べられる数 */
  lookupMaxCount: number;
  /** {@link PhotoLibrary.countArticleReferences} 1 回で調べられる数 */
  referencesMaxCount: number;
  /** お気に入り・選別のフラグ・アルバムの出し入れ 1 回で送れる写真の数 */
  photosPerRequest: number;
};

/** 投げた失敗の読み方（画面の 1 行・やり直すか）。 */
export type PhotoLibraryErrors = {
  /** 画面に出す 1 行（理由が分からなければ `fallback`） */
  describe(error: unknown, fallback: string): string;
  /**
   * 置き場（クラウドは写真置き場の API）が断った失敗なら、オリジナルの読み書き（書き出す・追加する）の言い方の 1 行（理由が
   * 分からなければ `fallback`）。置き場の失敗でなければ null（呼ぶ側が自分の 1 行にする）
   */
  describeStorageError(error: unknown, fallback: string): string | null;
  /** 消せなかった写真（{@link PhotoLibraryDeleteResult.errors}）の 1 行（1 枚なら理由、2 枚以上なら枚数） */
  describeDeleteFailure(errors: readonly unknown[]): string;
  /**
   * アプリの native の道具（原寸の書き出し・書き出し先のフォルダの選択・この Mac から足す）の失敗か。文は
   * {@link PhotoLibraryErrors.describeNative}
   */
  isNativeError(error: unknown): boolean;
  /**
   * native の道具の失敗の 1 行（クラウドは NIHO Desktop の失敗の文）。理由の分からない失敗は「もう一度お試しください」の決めた 1 行
   */
  describeNative(error: unknown): string;
  /**
   * 補正の保存（{@link PhotoLibrary.saveDevelopSettings}）の失敗のうち、送り直しても通らないもの（写真が無い・形が違う・権限が
   * 無い。クラウドは 404・400・403）。ほかの失敗は値を残して後で送り直す
   */
  isPermanentSaveFailure(error: unknown): boolean;
  /** 写真が無くなっていた（ほかの人が消した） */
  isNotFound(error: unknown): boolean;
  /** 使用量の上限を超えるので足せなかった（そのときの使用量と上限） */
  readQuotaExceeded(error: unknown): PhotoLibraryQuotaExceeded | null;
  /** 上限を超えたときの 1 行 */
  describeQuotaExceeded(usage: { usedBytes: number; quotaBytes: number }): string;
  /** 補正の保存を、別の端末が先に保存していたので断られた（今の写真） */
  readDevelopRevisionStale(error: unknown): PhotoLibraryPhoto | null;
  /** 原寸の書き出しで、書き出し先のフォルダが無くなっていた（残りも書けない） */
  isExportFolderNotFound(error: unknown): boolean;
};

export type PhotoLibraryQuotaExceeded = {
  usedBytes: number;
  quotaBytes: number;
  /** 足そうとした写真に要る大きさ（分からなければ null） */
  requiredBytes: number | null;
};

// ---------------------------------------------------------------------------
// 写真の行

/** 作業コピーの準備の状態。 */
export type PhotoLibraryWorkStatus = "queued" | "rendering" | "ready" | "failed";

export type PhotoLibraryUser = { userId: string; displayName: string | null };

/** 補正後のプレビュー（補正を保存した端末が、いま表示している画を縮めて付ける）。 */
export type PhotoLibraryEditedPreview = {
  /** 画を描いたときの `developRevision`（写真の `developRevision` より小さければ、最新の補正の前の画） */
  revision: number;
  width: number;
  height: number;
  /** 長辺 1280px までの画の URL（一覧だけが出す。無ければ null） */
  url: string | null;
  /** 一覧のタイル用の長辺 512px までの画の URL（一覧だけが出す。無ければ null） */
  thumbUrl: string | null;
};

/**
 * 写真 1 枚（開いた時点・保存した直後の行）。クラウドの写真置き場の行と同じ項目。この Mac の実装では、`uploadedBy` は null、
 * `hasWebImage`・`favorite` は false、`webRenderedRevision` は null を返す。
 */
export type PhotoLibraryPhoto = {
  id: string;
  /** 元のファイル名（表示用） */
  fileName: string;
  /** 拡張子（小文字・ドットなし） */
  fileExtension: string;
  /** オリジナルの大きさ（バイト） */
  sizeBytes: number;
  /**
   * オリジナル（ファイル全体）の SHA-256（16 進の小文字 64 文字）。この Mac の補正の鍵も同じ。一覧の行（{@link PhotoLibraryItem}）
   * では null のことがある
   */
  contentSha256: string;
  /** 置いた日時 */
  createdAt: string;
  /** 撮影日時（読めなければ null） */
  capturedAt?: string | null;
  /** 置いた人（クラウドだけ） */
  uploadedBy: PhotoLibraryUser | null;
  /** オリジナルがあるか（false なら閲覧用の画像だけ。記事の画像） */
  hasOriginal: boolean;
  /** 閲覧用のプレビューがあるか */
  hasPreview: boolean;
  /** 記事用の画像が付いているか（クラウドだけ） */
  hasWebImage: boolean;
  /** 補正を保存したことがあるか */
  hasDevelopSettings: boolean;
  /** 保存した補正（保存したことが無ければ null）。保存したとおりに返す */
  developSettings: DevelopSettings | null;
  developSettingsUpdatedAt: string | null;
  /** 補正の版（保存ごとに 1 増える。保存したことが無ければ 0） */
  developRevision: number;
  /** 記事用の画像を描いたときの `developRevision`（クラウドだけ） */
  webRenderedRevision: number | null;
  /** 作業コピーの準備の状態（準備を求めていない写真は null か省略） */
  workStatus?: PhotoLibraryWorkStatus | null;
  /** 作業コピーの準備を待ち始めた日時（10 分を超えたら遅れの表示） */
  workQueuedAt?: string | null;
  /** お気に入り（♥） */
  favorite?: boolean;
  /** 選別のフラグ（採用 / 却下。niho-photo#47）。省略・null はフラグなし。♥ とは別 */
  flag?: PhotoLibraryFlag | null;
  /** 補正済みか（「初期化」を保存した写真は false） */
  hasEdits?: boolean;
  editedPreview?: PhotoLibraryEditedPreview | null;
};

/**
 * 写真の情報（{@link PhotoLibrary.info}。オリジナルのメタデータ（EXIF など）から読めた項目）。読めない項目は null か省略。単位は
 * 秒・mm・度にそろえ、整形は編集面がする（`photo-editing-info.ts`）。
 */
export type PhotoLibraryPhotoInfo = {
  /** カメラのメーカーと機種（EXIF の Make・Model） */
  camera?: { make: string | null; model: string | null } | null;
  lens?: string | null;
  /** ISO 感度 */
  iso?: number | null;
  /** シャッター速度（秒） */
  exposureTimeSeconds?: number | null;
  /** 絞り（F 値） */
  fNumber?: number | null;
  /** 焦点距離（mm。35mm 判換算ではない） */
  focalLengthMm?: number | null;
  /**
   * 撮影日時（ISO 8601）。時差の無い値（`2024-05-01T10:30:15`）は撮影した場所の時計のまま出し、時差・`Z` の付いた値は日本時間で
   * 出す。無ければ写真の行の `capturedAt`
   */
  capturedAt?: string | null;
  /** 向きを反映した寸法（画素） */
  width?: number | null;
  height?: number | null;
  /** 撮影した場所（10 進の度。南緯・西経は負） */
  gps?: { latitude: number; longitude: number } | null;
};

/** 一覧の 1 枚（{@link PhotoLibraryPhoto} に一覧だけが出すものを足したもの）。 */
export type PhotoLibraryItem = Omit<PhotoLibraryPhoto, "contentSha256"> & {
  /**
   * オリジナルの SHA-256（{@link PhotoLibraryPhoto.contentSha256}）。一覧で中身を読まない置き場（この Mac）は開くまで null で、開いた
   * 写真の行（{@link PhotoLibrary.get}・{@link PhotoLibrary.openOriginal}・{@link PhotoLibrary.ensureWorkingCopy} の後）で埋める
   */
  contentSha256: string | null;
  /** 補正前のプレビュー（長辺 1024px）の URL（無ければ null） */
  previewUrl: string | null;
  /** 今の版の補正後のプレビューを描いている途中か（true の間だけ一覧を読み直す） */
  editedPreviewPending?: boolean;
};

// ---------------------------------------------------------------------------
// 一覧

/** 一覧の並び（`added` は追加日、`captured` は撮影日。どちらも新しい順）。 */
export type PhotoLibrarySort = "added" | "captured";

/** 一覧の種類の絞り込み（RAW は JPEG / PNG / TIFF / HEIC / HEIF 以外）。 */
export type PhotoLibraryKindFilter = "raw" | "jpeg" | "heic";

/** 選別のフラグ（`pick` = 採用、`reject` = 却下。niho-photo#47）。 */
export type PhotoLibraryFlag = "pick" | "reject";

/** 一覧の選別の絞り込み（`pick` = 採用だけ、`notRejected` = 却下を隠す〔採用とフラグなし〕）。 */
export type PhotoLibraryFlagFilter = "pick" | "notRejected";

export type PhotoLibraryListQuery = {
  /** 続きのページ（前のページの `next`） */
  cursor?: string | null;
  /** 1 ページの件数（{@link PhotoLibraryLimits.listPageSize} まで） */
  limit?: number;
  sort?: PhotoLibrarySort;
  /** オリジナルの有無（「写真」は true、「記事の画像」は false） */
  hasOriginal?: boolean;
  kind?: PhotoLibraryKindFilter;
  favorite?: boolean;
  albumId?: string | null;
  /** 補正済み（true）/ 未補正（false） */
  edited?: boolean;
  /** 選別（`capabilities.flags` の置き場だけ。省くと絞らない。niho-photo#47） */
  flag?: PhotoLibraryFlagFilter;
  /** フォルダ（{@link PhotoLibraryFolder.folderId}。そのフォルダとその下の写真）。フォルダの無い置き場（クラウド）は読まない */
  folderId?: string;
  /** この Mac の仮想ソース。`folderId` と同時には指定しない。 */
  localSource?: "selected";
};

export type PhotoLibraryListPage = {
  items: PhotoLibraryItem[];
  /** 次のページ（無ければ null） */
  next: string | null;
  /** 使用量と上限（この Mac は null） */
  usage: PhotoLibraryUsage | null;
  /** 木の件数と今の条件での総数（最初のページだけ。無ければ null） */
  counts: PhotoLibraryCounts | null;
};

export type PhotoLibraryUsage = {
  usedBytes: number;
  quotaBytes: number;
  /** `usedBytes` のうちオリジナルの分 */
  originalBytes?: number;
};

export type PhotoLibraryCounts = {
  /** オリジナルのある写真の数（木の「写真」） */
  photos: number;
  /** オリジナルの無い写真の数（木の「記事の画像」） */
  articleImages: number;
  /** お気に入りの数 */
  favorites: number;
  /** 今の条件での総数 */
  matching: number;
};

export type PhotoLibraryLookupMatch = { contentSha256: string; photo: PhotoLibraryPhoto };

// ---------------------------------------------------------------------------
// 開く

export type PhotoLibraryOriginal = {
  source: PhotoLibraryOriginalSource;
  /** 開いた時点の写真（補正・版・記事用の画像の有無） */
  photo: PhotoLibraryPhoto;
};

/**
 * オリジナルの読み方（不透明な参照。{@link PhotoLibrary.loadOriginal} と、原寸の書き出し {@link PhotoLibrary.exportNative} に渡し返す）。
 */
export type PhotoLibraryOriginalSource = {
  /** 発行した library だけが解釈する参照（クラウドは期限つきの署名付き URL、この Mac は開いた写真の token） */
  ref: string;
  /** 参照の期限（無ければ null） */
  expiresAt: string | null;
};

/** 記事の画像（元の写真の無い写真の中身）。`url` は表示用（`<img src>`）で、中身は {@link PhotoLibrary.loadArticleImage} で読む。 */
export type PhotoLibraryArticleImage = { url: string; contentType: string | null };

/** できている作業コピーの読み方と、その土台の版・大きさ・メタデータ。 */
export type PhotoLibraryWorkingCopyDownload = {
  /**
   * 発行した library だけが解釈する参照（クラウドは期限つきの署名付き URL、この Mac は作業コピーの token）。編集面は読まず、
   * {@link PhotoLibrary.loadWorkingCopy} に渡し返す
   */
  ref: string;
  expiresAt: string;
  work: {
    /** 土台の版（`developSettings.base` と照合する） */
    baseVersion: string;
    sizeBytes: number;
    width: number;
    height: number;
    /** 段 1 が返したメタデータ（実装は中身を解釈しない） */
    meta: Record<string, unknown>;
    renderedAt: string;
  };
};

/** {@link PhotoLibrary.ensureWorkingCopy} の結果（できていない・作らない写真は失敗ではなく状態）。 */
export type PhotoLibraryWorkingCopyResult =
  | { kind: "ready"; download: PhotoLibraryWorkingCopyDownload }
  | {
      kind: "notReady";
      workStatus: Exclude<PhotoLibraryWorkStatus, "ready">;
      /** 待ち始めた日時（10 分を超えたら遅れの表示） */
      workQueuedAt: string | null;
      /** 最後の失敗の種類（無ければ null） */
      lastErrorCode: string | null;
    }
  | { kind: "notApplicable" }
  | { kind: "incompatible"; message: string }
  | { kind: "baseUnavailable"; message: string };

/** 作業コピーの中身（`png16` は 16bit PNG、`jpeg8` は ICC 付きの 8bit JPEG）。 */
export type PhotoLibraryWorkingCopyEncoding = "png16" | "jpeg8";

export type PhotoLibraryWorkingCopy = {
  photoId: string;
  baseVersion: string;
  bytes: ArrayBuffer;
  encoding: PhotoLibraryWorkingCopyEncoding;
  /** メタデータの JSON（段 2 の `openWorkingCopy` に渡す） */
  metaJson: string;
};

/** canonical を名乗らない編集用 JPEG。写真の行は content hash と保存済み設定を確定するためにだけ使う。 */
export type PhotoLibraryInteractivePreview = {
  photo: PhotoLibraryPhoto;
  file: File;
  width: number;
  height: number;
};

export type PhotoLibraryProvisionalDraft = {
  contentSha256: string;
  settings: DevelopSettings;
  generation: number;
  updatedAt: string;
};

export type PhotoLibraryWorkingCopyRetry =
  | { kind: "queued"; workQueuedAt: string }
  | { kind: "notFailed"; workStatus: PhotoLibraryWorkStatus | null }
  | { kind: "notApplicable" };

// ---------------------------------------------------------------------------
// 補正

/** 補正の保存の結果（`stale` は別の端末が先に保存していた。今の写真で開き直す）。 */
export type PhotoLibrarySaveResult = { kind: "saved"; photo: PhotoLibraryPhoto } | { kind: "stale"; photo: PhotoLibraryPhoto };

/** 版の種類（`named` は名前を付けて残した版、`auto` は版を切り替える前の補正を残した自動の版）。 */
export type PhotoLibraryDevelopVersionKind = "named" | "auto";

/** 補正の版 1 つ（niho-photo#42）。 */
export type PhotoLibraryDevelopVersion = {
  /** 写真の中で重ならない不透明な ID（英数字・`-`・`_`。64 文字まで） */
  id: string;
  /** 名前（前後の空白を除いた 1〜40 文字） */
  name: string;
  /** 作った日時（ISO 8601） */
  createdAt: string;
  kind: PhotoLibraryDevelopVersionKind;
  /** 版の補正（作ったときの写真の `developSettings` のまま。当てるときは今の土台に載せる） */
  developSettings: DevelopSettings;
};

/** 写真の版の配列（作った順。古いものが先）と、保存の番号 `revision`（保存のたびに 1 増える。版の無い写真は 0）。 */
export type PhotoLibraryDevelopVersions = { versions: PhotoLibraryDevelopVersion[]; revision: number };

/** 版の保存の結果（`stale` は別の操作が先に保存していた。今の配列と `revision`）。 */
export type PhotoLibraryDevelopVersionsSaveResult = ({ kind: "saved" } | { kind: "stale" }) & PhotoLibraryDevelopVersions;

export type PhotoLibraryEditedPreviewJpeg = { blob: Blob; width: number; height: number };

export type PhotoLibraryEditedPreviewJpegs = { preview: PhotoLibraryEditedPreviewJpeg; thumb: PhotoLibraryEditedPreviewJpeg };

export type PhotoLibraryEditedPreviewAttached = {
  /** 付けた後の写真（同じか新しい版がもう付いていて、今の写真を持っていなければ null） */
  photo: PhotoLibraryPhoto | null;
  /** 付けたタイルの画（何も上げなかったときは null） */
  thumbBlob: Blob | null;
};

// ---------------------------------------------------------------------------
// 書き出す

export type PhotoLibraryNativeExportRequest = {
  photoId: string;
  /**
   * 開いたオリジナル（{@link PhotoLibrary.openOriginal} の `source` の参照と、中身の SHA-256・名前・拡張子・大きさ）。省けば library が
   * `photoId` から開く（この Mac は開いた写真を知っているので読まない）
   */
  source?: { ref: string; contentSha256: string; fileName: string; fileExtension: string; sizeBytes: number };
  /** 描く補正 */
  developSettings: DevelopSettings;
  /** 保存した補正があるか（土台の無い旧い補正と未編集を見分ける） */
  hasSavedDevelopSettings: boolean;
  /** 今の補正が neutral でないか */
  hasDevelopEdits: boolean;
  /** 保存の既定名 */
  suggestedFileName: string;
  /** 書き出し先のフォルダ（{@link PhotoLibrary.chooseExportFolder}）。無ければ保存ダイアログ */
  folderId?: string;
};

export type PhotoLibraryNativeExportResult = {
  /** 保存ダイアログを閉じたら false */
  saved: boolean;
  /** 実際に保存した名前 */
  fileName: string | null;
};

// ---------------------------------------------------------------------------
// 足す

export type PhotoLibraryAddProgress =
  | { phase: "preparing" }
  | { phase: "uploading"; fraction: number }
  | { phase: "completing" };

export type PhotoLibraryAddFileOptions = {
  signal?: AbortSignal;
  /** 置き場を取った（一覧に追加中のタイルを出す。`preview` は手元で作ったプレビュー） */
  onReserved?: (photo: PhotoLibraryPhoto, preview: Blob | null) => void;
  onProgress?: (progress: PhotoLibraryAddProgress) => void;
};

export type PhotoLibraryAddResult = {
  photo: PhotoLibraryPhoto;
  /** 同じ写真（SHA-256）がもうあり、上げなかった */
  alreadyStored: boolean;
  /** 手元で作ったプレビュー（一覧のタイルに、プレビューを読み直すまで出す） */
  preview: Blob | null;
};

/** この Mac の写真をどこから選ぶか（`photos` は写真の選択ダイアログ、`folder` はフォルダの選択ダイアログ）。 */
export type PhotoLibraryDevicePickKind = "photos" | "folder";

/** 開いたこの Mac の写真（不透明な `photoId` と、中身の SHA-256・大きさ・この Mac に保存した Photo Bench の補正）。 */
export type PhotoLibraryDevicePhoto = {
  photoId: string;
  fileName: string;
  contentSha256: string | null;
  sizeBytes: number | null;
  savedSettings: PhotoEditingSettings | null;
};

/**
 * 足すこの Mac の写真 1 枚。写真の選択ダイアログで選んだ写真は開いている（`photo`）。フォルダの写真は開かずに一覧の不透明な ID
 * （`entryId`）で持ち、足す直前に開く。編集面は `key`・`fileName`・`sizeBytes` だけを読み、`pick` が返したものをそのまま渡し返す。
 */
export type PhotoLibraryDeviceCandidate = {
  /** 見分ける鍵 */
  key: string;
  fileName: string;
  /** ファイルの大きさ（分からなければ null） */
  sizeBytes: number | null;
  /** 開いている写真（フォルダの写真は開くまで null） */
  photo: PhotoLibraryDevicePhoto | null;
  /** フォルダの写真の ID（ダイアログで開いた写真は null） */
  entryId: string | null;
};

/** 足せなかった写真 1 枚（`retry` は「再試行」でもう一度足す写真。試しても入らないものは null）。 */
export type PhotoLibraryDeviceAddFailure = { fileName: string; message: string; retry: PhotoLibraryDeviceCandidate | null };

export type PhotoLibraryDevicePick = {
  /** ダイアログを閉じた */
  cancelled: boolean;
  candidates: PhotoLibraryDeviceCandidate[];
  /** 開けなかった写真（もう一度試せない） */
  failures: PhotoLibraryDeviceAddFailure[];
  /** RAW と同じ写真なので足さない JPEG の数 */
  rawPairedJpegCount: number;
  /** フォルダが上限を超え、読めた分だけにした */
  truncated: boolean;
};

export type PhotoLibraryDeviceAddProgress = { fileName: string; index: number; total: number };

export type PhotoLibraryDeviceAddOutcome = {
  /** 止めた（画面を閉じた・拠点や権限が変わった） */
  aborted: boolean;
  /** 残りを止めた理由（容量超え・拠点が許可していない） */
  stopMessage: string | null;
  failures: PhotoLibraryDeviceAddFailure[];
  /** 新しく入った写真があった（一覧・使用量を読み直す） */
  storedAny: boolean;
  /** 最後に足した写真（終わったら選ぶ） */
  lastPhoto: Pick<PhotoLibraryPhoto, "id" | "hasOriginal"> | null;
};

/**
 * この Mac の写真を足す（NIHO Desktop）。選ぶ → 足す（1 枚ずつ開いて足し、終わった写真は手放す）→ 足さなかった写真を手放す。
 * オリジナルも置くか・作業コピーを手元で作って一緒に上げるかは、実装が足す直前に決める（拠点の許可・この Mac の設定・Desktop の版）。
 */
export type PhotoLibraryDeviceImport = {
  pick(kind: PhotoLibraryDevicePickKind): Promise<PhotoLibraryDevicePick>;
  /** 選ぶ・開くのに失敗したときの 1 行（ほかのダイアログが開いていたなど、出さないときは null） */
  describePickError(kind: PhotoLibraryDevicePickKind, error: unknown): string | null;
  /**
   * 選んだ写真を順に足す。止める（`signal`・`canContinue` が false）と次の写真を始めない。1 枚ごとの足し方は `addPhoto`
   * （ふつうは {@link PhotoLibraryDeviceImport.addPhoto} に画面の表示を添えたもの）
   */
  run(
    candidates: readonly PhotoLibraryDeviceCandidate[],
    options: {
      signal: AbortSignal;
      canContinue: () => boolean;
      onProgress: (progress: PhotoLibraryDeviceAddProgress) => void;
      addPhoto: (photo: PhotoLibraryDevicePhoto, context: { signal: AbortSignal }) => Promise<PhotoLibraryAddResult>;
    },
  ): Promise<PhotoLibraryDeviceAddOutcome>;
  /** 開いた 1 枚を足す（置き場を取ったら `onPrepared`、プレビューができたら `onPreview`） */
  addPhoto(
    photo: PhotoLibraryDevicePhoto,
    options: {
      signal?: AbortSignal;
      onPrepared?: (photo: PhotoLibraryPhoto) => void;
      onPreview?: (photo: PhotoLibraryPhoto, preview: Blob) => void;
    },
  ): Promise<PhotoLibraryAddResult>;
  /** 足さなかった写真を手放す（失敗しない） */
  release(candidates: readonly PhotoLibraryDeviceCandidate[]): Promise<void>;
};

// ---------------------------------------------------------------------------
// 消す・お気に入り・アルバム・プリセット

export type PhotoLibraryDeleteResult = { deleted: string[]; errors: unknown[] };

/** 写真のフォルダ（この Mac。{@link PhotoLibraryFolders.tree}）。写真は {@link PhotoLibrary.list} の `folderId` で読む。 */
export type PhotoLibraryFolder = {
  /** 不透明な ID（{@link PhotoLibraryListQuery.folderId} に渡す） */
  folderId: string;
  name: string;
  children: PhotoLibraryFolder[];
  /** 上限を超え、読めた分だけにした */
  truncated: boolean;
};

export type PhotoLibraryFolders = {
  /** 覚えているフォルダの木（足した順） */
  tree(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryFolder[]>;
  /** フォルダを選んで覚える（選ぶダイアログを閉じたら null） */
  add(): Promise<PhotoLibraryFolder | null>;
  /** 覚えたフォルダを忘れる（写真は消さない） */
  forget(folderId: string): Promise<void>;
};

/** ネイティブの選択ダイアログで覚えた写真。元のファイルは変更せず、忘れるのは参照だけ。 */
export type PhotoLibrarySelectedPhotos = {
  /** 現在も読める写真の数。見つからない写真は数えない。 */
  count(options?: PhotoLibraryRequestOptions): Promise<number>;
  /** 複数の写真を選ぶ。ダイアログを閉じたら空。返す行は選択順で、一覧は `localSource: "selected"` で読む。 */
  add(): Promise<PhotoLibraryItem[]>;
  /** 選んだ写真の参照をすべて忘れる。元の写真・フォルダ登録・補正には触れない。 */
  forget(): Promise<void>;
};

export type PhotoLibraryArticleReference = { photoId: string; articleCount: number };

/** 入れなかった・変えなかった写真の数え分け（無い・上げている途中は `notFound`、記事の画像は `noOriginal`）。 */
export type PhotoLibrarySkippedPhotos = { notFound: number; noOriginal: number };

export type PhotoLibraryFavorites = {
  /** お気に入りを付ける・外す（{@link PhotoLibraryLimits.photosPerRequest} 件まで。オリジナルのある写真だけ） */
  set(photoIds: readonly string[], favorite: boolean): Promise<{ updated: number; skipped: PhotoLibrarySkippedPhotos }>;
};

export type PhotoLibraryFlags = {
  /**
   * 選別のフラグを付ける（`pick` / `reject`）・外す（null）（{@link PhotoLibraryLimits.photosPerRequest} 件まで。オリジナルのある写真
   * だけ）。同じフラグを付け直しても変わらない（付けたことに数える）。無い写真は `skipped.notFound`
   */
  set(
    photoIds: readonly string[],
    flag: PhotoLibraryFlag | null,
  ): Promise<{ updated: number; skipped: PhotoLibrarySkippedPhotos }>;
};

export type PhotoLibraryAlbum = {
  id: string;
  name: string;
  /** オリジナルのある写真の数 */
  photoCount: number;
  cover: { photoId: string; imageUrl: string | null } | null;
  createdAt: string;
  updatedAt: string;
  createdBy: PhotoLibraryUser | null;
};

export type PhotoLibraryAlbums = {
  list(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryAlbum[]>;
  create(name: string): Promise<PhotoLibraryAlbum>;
  rename(albumId: string, name: string): Promise<PhotoLibraryAlbum>;
  /** アルバムを消す（写真は消えない） */
  delete(albumId: string): Promise<void>;
  /** 写真を入れる（{@link PhotoLibraryLimits.photosPerRequest} 件まで。オリジナルのある写真だけ） */
  addPhotos(
    albumId: string,
    photoIds: readonly string[],
  ): Promise<{ album: PhotoLibraryAlbum; added: number; alreadyInAlbum: number; skipped: PhotoLibrarySkippedPhotos }>;
  /** 写真を外す（写真は消えない） */
  removePhotos(albumId: string, photoIds: readonly string[]): Promise<{ album: PhotoLibraryAlbum; removed: number }>;
};

/** どこから来たプリセットか（`xmp` は Lightroom のプリセットを取り込んだもの、`user` は「今の補正をプリセットに保存」）。 */
export type PhotoLibraryPresetSource = "xmp" | "user";

export type PhotoLibraryPreset = {
  id: string;
  name: string;
  /** Lightroom のプリセット（XMP）の本文 */
  xmp: string;
  source: PhotoLibraryPresetSource;
  createdAt: string;
};

export type PhotoLibraryPresets = {
  /** 作成順（古いものが先） */
  list(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryPreset[]>;
  /** 作る（`source` を省けば取り込んだ XMP と同じ扱い。クラウドは API の既定） */
  create(preset: { name: string; xmp: string; source?: PhotoLibraryPresetSource }): Promise<PhotoLibraryPreset>;
  rename(presetId: string, name: string): Promise<PhotoLibraryPreset>;
  delete(presetId: string): Promise<void>;
  /** 名前の上限（前後の空白を除いた文字数） */
  readonly nameMaxChars: number;
  /** XMP の本文の上限（UTF-8 のバイト数） */
  readonly xmpMaxBytes: number;
  /** プリセットの失敗の 1 行（同じ名前・大きすぎる・形が違う。分からなければ `fallback`） */
  describeError(error: unknown, fallback: string): string;
  /** 作る・名前を変えるのを、同じ名前のプリセットがあるので断られた（入力の下に出す） */
  isNameTaken(error: unknown): boolean;
};
