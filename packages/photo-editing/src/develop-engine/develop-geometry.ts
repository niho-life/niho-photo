import { FIXED_ASPECT_PATTERN, isDevelopAspect } from "./develop-aspect";
export { isDevelopAspect } from "./develop-aspect";
import {
  DEVELOP_PERSPECTIVE_FIELDS,
  constrainCropBoxToPerspective,
  developPerspectiveWarp,
  isIdentityDevelopPerspective,
  perspectiveToCanvas,
  perspectiveToFrame,
  transformDevelopPerspective,
} from "./develop-perspective";
import { developSettingsVersion, hasDevelopGeometry, type DevelopSettings } from "./develop-settings";

/**
 * `developSettings.geometry`（90° 回転・反転・角度補正・切り抜き。F3 移行元設計）の計算（React に依存しない純粋な関数。切り抜きの道具と、
 * 幾何のある写真の開き方が使う）。座標は crate の `geometry.rs` / `frame.rs`（`packages/develop-engine/README.md`「geometry と v 2」）と
 * 同じ:
 *
 * - 枠（frame）は作業画像（向きは反映済み）を `rotate` だけ時計回りに回し、`flipH`（左右）・`flipV`（上下）で鏡映したもの
 * - `crop` の `(left, top)` / `(right, bottom)` は切り抜き枠の左上・右下の角が枠の上で実際にある位置（x は枠の幅・y は高さで 0〜1、
 *   y は下向き）。`angle`（度）は切り抜き枠を中心の回りに時計回りに回す角度
 * - 枠の画素 `W×H` で `UL = (left·W, top·H)`・`d = (right·W, bottom·H) − UL`・`u = (cos a, sin a)`・`v = (−sin a, cos a)`、切り抜きの
 *   幅 `d·u`・高さ `d·v`、出力の画素 `(x, y)` は枠の `UL + x·u + y·v`
 *
 * 画面は切り抜きを {@link CropBox}（枠の画素での中心と、切り抜きの自分の軸での幅・高さ）で扱う。数値は倍精度のまま計算し、保存する
 * とき（{@link writeDevelopGeometry}）だけ `crop` を 0〜1 に収めて小数 6 桁に丸める。
 *
 * `aspect`（画面が守る縦横比。描画は読まない）の `original` は**枠の**比率（回した後の見えている向き）、`originalSwapped` はその逆数。
 * 無いのは `original` と同じ。
 *
 * 遠近（`perspective`。Lightroom の変形。niho-photo#46。計算は `develop-perspective.ts`）は、枠を同じ大きさの「補正後の枠」に射影で
 * 写す（回転・反転の後・切り抜きの前）。`crop` と `angle` は補正後の枠の上の座標なので、上の式も箱の計算もそのまま補正後の枠で
 * 成り立つ。「余白を埋める」（`constrain`）は描くときに切り抜きを補正した写真の中に収める（保存する `crop` は変えない）。
 */

export type DevelopGeometryRotate = 0 | 90 | 180 | 270;

export type DevelopCrop = { left: number; top: number; right: number; bottom: number };

/** 遠近（Lightroom の変形の 7 本。XMP の `Perspective*` と同じ単位・範囲。恒等は 0・0・0・0・100・0・0）。 */
export type DevelopPerspective = {
  /** 垂直方向（−100〜100。負で上が広がる） */
  vertical: number;
  /** 水平方向（−100〜100。正で右が広がる） */
  horizontal: number;
  /** 回転（度。−10〜10。正で写真が反時計回り。角度補正と同じ向き） */
  rotate: number;
  /** 縦横比（−100〜100。正で横に伸びる） */
  aspect: number;
  /** 拡大・縮小（%。50〜150） */
  scale: number;
  /** X オフセット（−100〜100。正で右へ。100 で枠の幅の半分） */
  x: number;
  /** Y オフセット（−100〜100。正で下へ。100 で枠の高さの半分） */
  y: number;
};

export type DevelopGeometry = {
  /** 時計回りの 90° 回転 */
  rotate: DevelopGeometryRotate;
  flipH: boolean;
  flipV: boolean;
  /** 角度補正（度。−45〜45。切り抜き枠を中心の回りに時計回りに回す） */
  angle: number;
  crop: DevelopCrop;
  /** 画面が守る縦横比（`free`・`original`・`originalSwapped`・`<w>:<h>`。無ければ `original` と同じ） */
  aspect?: string;
  /** 遠近（無ければ恒等。恒等なら保存しない） */
  perspective?: DevelopPerspective;
  /** 余白を埋める（無ければ off。遠近が無いときは描画に効かない） */
  constrain?: boolean;
  /** Lightroom の Upright の種類（0〜5。保持のみで描かない。無ければ 0） */
  upright?: number;
  /** 知らないキー（そのまま持って書き戻す） */
  extra?: Readonly<Record<string, unknown>>;
};

/** 画素の大きさ（作業画像・枠）。 */
export type DevelopSize = { width: number; height: number };

/** 切り抜きの箱: 枠の画素での中心と、切り抜きの自分の軸（`u`・`v`）での幅・高さ。 */
export type CropBox = { cx: number; cy: number; width: number; height: number };

/** 切り抜き枠のつまみ（辺の中点と角。切り抜きの自分の向きで上が `n`）。 */
export type CropHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type Vec = [number, number];

export const DEVELOP_GEOMETRY_MAX_ANGLE = 45;

function identityGeometry(): DevelopGeometry {
  return { rotate: 0, flipH: false, flipV: false, angle: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } };
}

const FROZEN_IDENTITY: DevelopGeometry = identityGeometry();
Object.freeze(FROZEN_IDENTITY.crop);

/** 恒等の幾何（枠は作業画像そのもの・全体）。 */
export const IDENTITY_DEVELOP_GEOMETRY: Readonly<DevelopGeometry> = Object.freeze(FROZEN_IDENTITY);

const KNOWN_GEOMETRY_KEYS: ReadonlySet<string> = new Set([
  "rotate",
  "flipH",
  "flipV",
  "angle",
  "crop",
  "aspect",
  "perspective",
  "constrain",
  "upright",
]);
/** 保存する遠近の小数の桁（スライダーの刻みは 0.1。XMP の細かい値も揺らさない）。 */
const PERSPECTIVE_DIGITS = 6;
/** Upright の種類の上限（crate の `MAX_UPRIGHT`）。 */
const MAX_UPRIGHT = 5;

/** 保存する `crop` の小数の桁（長辺 6000px で 0.003px。保存のたびに揺れない）。 */
const CROP_DIGITS = 6;
/** 「その角度で内接する最大の箱か」「同じ比率か」を比べる相対の許容（保存の丸めより十分大きく、1px より十分小さい）。 */
const MAX_BOX_TOLERANCE = 2e-5;
const RATIO_TOLERANCE = 1e-4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readRotate(value: unknown): DevelopGeometryRotate | null {
  if (value === undefined) return 0;
  return value === 0 || value === 90 || value === 180 || value === 270 ? value : null;
}

function isCropKey(key: string): key is keyof DevelopCrop {
  return key === "left" || key === "top" || key === "right" || key === "bottom";
}

function readCrop(value: unknown): DevelopCrop | null {
  if (value === undefined) return { left: 0, top: 0, right: 1, bottom: 1 };
  if (!isRecord(value)) return null;
  const crop: DevelopCrop = { left: 0, top: 0, right: 1, bottom: 1 };
  for (const [key, item] of Object.entries(value)) {
    // crate と同じく、left / top / right / bottom 以外のキーと数でない値は壊れた形
    if (!isCropKey(key) || !isFiniteNumber(item)) return null;
    crop[key] = item;
  }
  return crop;
}

/** `perspective` を読む（欠けた項目は恒等の値。知らないキー・数でない値は壊れた形で null。crate と同じ）。 */
function readPerspective(value: unknown): DevelopPerspective | null {
  if (!isRecord(value)) return null;
  const perspective: DevelopPerspective = { vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, x: 0, y: 0 };
  for (const [key, item] of Object.entries(value)) {
    const field = DEVELOP_PERSPECTIVE_FIELDS.find((candidate) => candidate.key === key);
    if (!field || !isFiniteNumber(item)) return null;
    perspective[field.key] = item;
  }
  return perspective;
}

/**
 * `geometry` の値を読む。無ければ（undefined / null）恒等、欠けた項目は既定で補い、知らないキーは `extra` に保つ。形が壊れていれば
 * null（crate の `Geometry::from_value` が拒む形。範囲は見ない）。
 */
export function parseDevelopGeometry(value: unknown): DevelopGeometry | null {
  if (value === undefined || value === null) return identityGeometry();
  if (!isRecord(value)) return null;
  const rotate = readRotate(value.rotate);
  const crop = readCrop(value.crop);
  const flipH = value.flipH === undefined ? false : value.flipH;
  const flipV = value.flipV === undefined ? false : value.flipV;
  const angle = value.angle === undefined ? 0 : value.angle;
  if (rotate === null || crop === null || typeof flipH !== "boolean" || typeof flipV !== "boolean") return null;
  if (!isFiniteNumber(angle)) return null;
  const geometry: DevelopGeometry = { rotate, flipH, flipV, angle, crop };
  // `aspect` は無い（null も同じ）か文字列
  const aspect = value.aspect;
  if (typeof aspect === "string") geometry.aspect = aspect;
  else if (aspect !== undefined && aspect !== null) return null;
  if (value.perspective !== undefined) {
    const perspective = readPerspective(value.perspective);
    if (!perspective) return null;
    geometry.perspective = perspective;
  }
  if (value.constrain !== undefined) {
    if (typeof value.constrain !== "boolean") return null;
    geometry.constrain = value.constrain;
  }
  if (value.upright !== undefined) {
    if (!isFiniteNumber(value.upright)) return null;
    geometry.upright = value.upright;
  }
  const extra: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!KNOWN_GEOMETRY_KEYS.has(key)) extra[key] = item;
  }
  if (Object.keys(extra).length > 0) geometry.extra = extra;
  return geometry;
}

/**
 * 編集内容の幾何を読む（無ければ恒等）。形の壊れた幾何も恒等として返すので、壊れているかを見分けたい所は
 * {@link parseDevelopGeometry} を使う（壊れた幾何の写真は wasm が描かないので、画面の道具には来ない）。
 */
export function readDevelopGeometry(settings: DevelopSettings | null | undefined): DevelopGeometry {
  return parseDevelopGeometry(settings?.geometry) ?? identityGeometry();
}

function roundCropValue(value: number): number {
  const scale = 10 ** CROP_DIGITS;
  // `+ 0` は −0 を 0 にする
  return Math.round(clamp(Number.isFinite(value) ? value : 0, 0, 1) * scale) / scale + 0;
}

function clampAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  return clamp(angle, -DEVELOP_GEOMETRY_MAX_ANGLE, DEVELOP_GEOMETRY_MAX_ANGLE) + 0;
}

/** 遠近を範囲に収めて小数 6 桁に丸める（数でない値は恒等の値）。 */
export function normalizeDevelopPerspective(perspective: DevelopPerspective): DevelopPerspective {
  const scale = 10 ** PERSPECTIVE_DIGITS;
  const next = { ...perspective };
  for (const { key, min, max, neutral } of DEVELOP_PERSPECTIVE_FIELDS) {
    const value = perspective[key];
    next[key] = Number.isFinite(value) ? Math.round(clamp(value, min, max) * scale) / scale + 0 : neutral;
  }
  return next;
}

/**
 * 幾何を編集内容に書く。幾何が恒等で `aspect` も既定（無い・`original`）・「余白を埋める」も Upright も無いなら `geometry` のキーを
 * 消し、ほかは書く（`crop` は 0〜1 に収めて小数 6 桁、`angle` は −45〜45 に収める。遠近は範囲に収めて小数 6 桁、恒等なら書かない）。
 * 形の版 `v` は書いた幾何から決め直す（遠近があれば 7、ほかの恒等でない幾何は 2）。ほかのキーは触らない。
 */
export function writeDevelopGeometry(settings: DevelopSettings, geometry: DevelopGeometry): DevelopSettings {
  const next: Record<string, unknown> = { ...settings };
  const written: Record<string, unknown> = {
    rotate: geometry.rotate,
    flipH: geometry.flipH,
    flipV: geometry.flipV,
    angle: clampAngle(geometry.angle),
    crop: {
      left: roundCropValue(geometry.crop.left),
      top: roundCropValue(geometry.crop.top),
      right: roundCropValue(geometry.crop.right),
      bottom: roundCropValue(geometry.crop.bottom),
    },
  };
  if (geometry.aspect !== undefined) written.aspect = geometry.aspect;
  if (geometry.perspective) {
    const perspective = normalizeDevelopPerspective(geometry.perspective);
    if (!isIdentityDevelopPerspective(perspective)) written.perspective = perspective;
  }
  if (geometry.constrain === true) written.constrain = true;
  const upright = geometry.upright;
  if (upright !== undefined && Number.isInteger(upright) && upright > 0 && upright <= MAX_UPRIGHT) written.upright = upright;
  const extra = geometry.extra ?? {};
  for (const [key, value] of Object.entries(extra)) {
    if (!KNOWN_GEOMETRY_KEYS.has(key)) written[key] = value;
  }
  const defaultAspect = geometry.aspect === undefined || geometry.aspect === "original";
  const switches = written.constrain !== undefined || written.upright !== undefined;
  const hasExtra = Object.keys(written).some((key) => !KNOWN_GEOMETRY_KEYS.has(key));
  if (!hasDevelopGeometry({ geometry: written }) && defaultAspect && !switches && !hasExtra) delete next.geometry;
  else next.geometry = written;
  return { ...next, v: developSettingsVersion(next), engine: settings.engine };
}

/** 遠近（無ければ恒等）。 */
export function developGeometryPerspective(geometry: DevelopGeometry): DevelopPerspective {
  return geometry.perspective ?? { vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, x: 0, y: 0 };
}

/**
 * ジオメトリの節の「初期化」: 遠近・「余白を埋める」・Upright を既定に戻す（角度・反転・回転・切り抜き・縦横比は触らない）。
 */
export function resetGeometryPerspective(geometry: DevelopGeometry): DevelopGeometry {
  const { perspective: _perspective, constrain: _constrain, upright: _upright, ...rest } = geometry;
  return rest;
}

/** 遠近が恒等でない・「余白を埋める」が on・Upright がある（ジオメトリの節の「初期化」で戻すものがある）か。 */
export function hasGeometryPerspectiveEdits(geometry: DevelopGeometry): boolean {
  return (
    !isIdentityDevelopPerspective(geometry.perspective) ||
    geometry.constrain === true ||
    (geometry.upright !== undefined && geometry.upright !== 0)
  );
}

/**
 * 描かれる切り抜きの箱: 「余白を埋める」が on で遠近があれば、箱を補正した写真の中に収める（crate の `constrain_corners`。
 * 保存する `crop` は変えない）。ほかはそのまま。`frame` は {@link developFrameSize}。
 */
export function constrainedCropBox(geometry: DevelopGeometry, box: CropBox, frame: DevelopSize): CropBox {
  if (geometry.constrain !== true) return box;
  const warp = developPerspectiveWarp(geometry.perspective, frame);
  return warp ? constrainCropBoxToPerspective(box, geometry.angle, warp) : box;
}

/** 切り抜きの「初期化」: 幾何を消して `v: 1` にする（色の補正は触らない）。 */
export function resetDevelopGeometry(settings: DevelopSettings): DevelopSettings {
  const next: Record<string, unknown> = { ...settings };
  delete next.geometry;
  return { ...next, v: developSettingsVersion(next), engine: settings.engine };
}

/** 枠の大きさ（作業画像を `rotate` だけ回したもの。90 / 270 は幅と高さが入れ替わる）。 */
export function developFrameSize(source: DevelopSize, rotate: number): DevelopSize {
  const quarter = ((rotate % 180) + 180) % 180 === 90;
  return quarter ? { width: source.height, height: source.width } : { width: source.width, height: source.height };
}

function axes(angle: number): { u: Vec; v: Vec } {
  const theta = (angle * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return { u: [cos, sin], v: [-sin, cos] };
}

/** README の式のまま（長方形にならない値も返す。回転・反転は値をそのまま写すのでこれを使う）。 */
function rawCropBox(crop: DevelopCrop, angle: number, frame: DevelopSize): CropBox {
  const { u, v } = axes(angle);
  const left = crop.left * frame.width;
  const top = crop.top * frame.height;
  const dx = crop.right * frame.width - left;
  const dy = crop.bottom * frame.height - top;
  return { cx: left + dx / 2, cy: top + dy / 2, width: dx * u[0] + dy * u[1], height: dx * v[0] + dy * v[1] };
}

/**
 * 幾何の `crop` と `angle` から切り抜きの箱を作る（README の式）。その角度で長方形にならない（幅か高さが正でない。crate の
 * `invalidCrop`）なら null。角が枠から出ていてもそのまま返す（収めるのは {@link fitCropBox}）。
 */
export function cropBoxFromGeometry(geometry: Pick<DevelopGeometry, "crop" | "angle">, frame: DevelopSize): CropBox | null {
  const box = rawCropBox(geometry.crop, geometry.angle, frame);
  return box.width > 0 && box.height > 0 ? box : null;
}

/** 切り抜きの箱を `crop`（左上・右下の角の枠の上の位置。0〜1）にする（{@link cropBoxFromGeometry} の逆。丸めない）。 */
export function cropFromBox(box: CropBox, angle: number, frame: DevelopSize): DevelopCrop {
  const { u, v } = axes(angle);
  const hx = (box.width * u[0] + box.height * v[0]) / 2;
  const hy = (box.width * u[1] + box.height * v[1]) / 2;
  return {
    left: (box.cx - hx) / frame.width,
    top: (box.cy - hy) / frame.height,
    right: (box.cx + hx) / frame.width,
    bottom: (box.cy + hy) / frame.height,
  };
}

/** 4 つの角の枠の上の位置（左上・右上・右下・左下。切り抜きの自分の向きで）。 */
export function cropBoxCorners(box: CropBox, angle: number): Vec[] {
  const { u, v } = axes(angle);
  const corner = (a: number, b: number): Vec => [
    box.cx + (a * box.width * u[0] + b * box.height * v[0]) / 2,
    box.cy + (a * box.width * u[1] + b * box.height * v[1]) / 2,
  ];
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

/** 回した箱が枠の軸で占める半分の幅・高さ。 */
function halfExtents(width: number, height: number, angle: number): Vec {
  const { u } = axes(angle);
  const cos = Math.abs(u[0]);
  const sin = Math.abs(u[1]);
  return [(width * cos + height * sin) / 2, (width * sin + height * cos) / 2];
}

/** 4 つの角がすべて枠の中か（`epsilon` は画素。既定は枠の長辺の 100 万分の 1）。 */
export function isCropBoxInsideFrame(box: CropBox, angle: number, frame: DevelopSize, epsilon?: number): boolean {
  const tolerance = epsilon ?? Math.max(frame.width, frame.height) * 1e-6;
  const [ex, ey] = halfExtents(box.width, box.height, angle);
  return (
    box.cx - ex >= -tolerance &&
    box.cx + ex <= frame.width + tolerance &&
    box.cy - ey >= -tolerance &&
    box.cy + ey <= frame.height + tolerance
  );
}

/** 最小の大きさ（枠の短辺の 2%・少なくとも 8px。枠がそれより小さければ枠の短辺）。 */
export function minCropBoxSize(frame: DevelopSize): number {
  const short = Math.min(frame.width, frame.height);
  return Math.min(short, Math.max(8, short * 0.02));
}

/** 角が枠から出るとき、中心の回りに一様に縮めて収める倍率（crate の `crop_corners`。出ていなければ 1）。 */
function inscribedScale(box: CropBox, angle: number, frame: DevelopSize): number {
  const [ex, ey] = halfExtents(box.width, box.height, angle);
  let scale = 1;
  if (box.cx + ex > frame.width) scale = Math.min(scale, (frame.width - box.cx) / ex);
  if (box.cx - ex < 0) scale = Math.min(scale, box.cx / ex);
  if (box.cy + ey > frame.height) scale = Math.min(scale, (frame.height - box.cy) / ey);
  if (box.cy - ey < 0) scale = Math.min(scale, box.cy / ey);
  return scale;
}

/** 枠の中心に置いた、比率 `baseWidth : baseHeight` の、その角度で枠に内接する最大の箱。 */
function maxCropBoxOf(frame: DevelopSize, angle: number, baseWidth: number, baseHeight: number): CropBox {
  const { u } = axes(angle);
  const cos = Math.abs(u[0]);
  const sin = Math.abs(u[1]);
  const scale = Math.min(
    frame.width / (baseWidth * cos + baseHeight * sin),
    frame.height / (baseWidth * sin + baseHeight * cos),
  );
  return { cx: frame.width / 2, cy: frame.height / 2, width: baseWidth * scale, height: baseHeight * scale };
}

function validRatio(ratio: number | null | undefined): number | null {
  return typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/**
 * 枠の中心に置いた、その角度で枠に内接する最大の箱。`aspectRatio` は幅 ÷ 高さ（null は枠の比率）。角度 0 で比率が枠と同じなら
 * 枠全体。
 */
export function maxCropBox(frame: DevelopSize, angle: number, aspectRatio: number | null): CropBox {
  const ratio = validRatio(aspectRatio);
  return ratio === null ? maxCropBoxOf(frame, angle, frame.width, frame.height) : maxCropBoxOf(frame, angle, ratio, 1);
}

/** 中心を、箱が枠に収まる範囲へ寄せる（収まらない軸は枠の中央）。 */
function clampCenter(value: number, halfExtent: number, limit: number): number {
  return halfExtent * 2 <= limit ? clamp(value, halfExtent, limit - halfExtent) : limit / 2;
}

/**
 * 箱を枠の中に収める。4 つの角が枠から出るなら中心の回りに一様に縮める（crate の「最大の内接」と同じ結果）。最小の大きさ
 * （{@link minCropBoxSize}）を下回るとき・中心が枠の外のときは、最小の大きさで止めて中心を枠の中へ寄せる。
 */
export function fitCropBox(box: CropBox, angle: number, frame: DevelopSize): CropBox {
  if (!(box.width > 0 && box.height > 0) || !Number.isFinite(box.cx) || !Number.isFinite(box.cy)) {
    return maxCropBox(frame, angle, null);
  }
  const min = minCropBoxSize(frame);
  const grow = Math.max(1, min / Math.min(box.width, box.height));
  let next: CropBox = {
    cx: clamp(box.cx, 0, frame.width),
    cy: clamp(box.cy, 0, frame.height),
    width: box.width * grow,
    height: box.height * grow,
  };
  const scale = inscribedScale(next, angle, frame);
  if (scale >= 1) return grow === 1 && next.cx === box.cx && next.cy === box.cy ? box : next;
  const floor = min / Math.min(next.width, next.height);
  if (scale >= floor) return { ...next, width: next.width * scale, height: next.height * scale };
  // 最小の大きさで止め、その箱が収まる所へ中心を寄せる
  next = { ...next, width: next.width * floor, height: next.height * floor };
  const [ex, ey] = halfExtents(next.width, next.height, angle);
  next = { ...next, cx: clampCenter(next.cx, ex, frame.width), cy: clampCenter(next.cy, ey, frame.height) };
  if (isCropBoxInsideFrame(next, angle, frame)) return next;
  // 最小の大きさの箱も収まらない比率（極端に細長い）: 枠から出さない方を優先して縮める
  const shrink = inscribedScale(next, angle, frame);
  return { ...next, width: next.width * shrink, height: next.height * shrink };
}

/** 箱を枠の軸で `(dx, dy)` 動かす（大きさは変えない。角が枠から出ない所で止まる）。 */
export function moveCropBox(box: CropBox, dx: number, dy: number, angle: number, frame: DevelopSize): CropBox {
  const [ex, ey] = halfExtents(box.width, box.height, angle);
  return {
    ...box,
    cx: clampCenter(box.cx + dx, ex, frame.width),
    cy: clampCenter(box.cy + dy, ey, frame.height),
  };
}

/** つまみの向き（切り抜きの自分の軸。e は +u、s は +v）。 */
const HANDLE_DIRECTIONS: Readonly<Record<CropHandle, Vec>> = {
  n: [0, -1],
  s: [0, 1],
  e: [1, 0],
  w: [-1, 0],
  ne: [1, -1],
  nw: [-1, -1],
  se: [1, 1],
  sw: [-1, 1],
};

/**
 * つまみを切り抜きの自分の軸で `(dx, dy)` 動かして大きさを変える（`dx` は切り抜きの右向き・`dy` は下向き。画面で枠がまっすぐ立って
 * 見える向き）。反対側の辺・角は動かさない。`aspectRatio`（幅 ÷ 高さ）があれば比率を守る（角のつまみは対角線へ射影、辺のつまみは
 * 直交する方向を中心線の回りに伸縮）。枠から出ない所・最小の大きさで止まる。自由な比率の角のつまみは、幅 → 高さの順にそれぞれ
 * 止める（片方が枠に当たっても、もう片方は動く）。
 */
export function resizeCropBox(
  box: CropBox,
  handle: CropHandle,
  dx: number,
  dy: number,
  angle: number,
  frame: DevelopSize,
  aspectRatio: number | null,
): CropBox {
  const [hx, hy] = HANDLE_DIRECTIONS[handle];
  const { u, v } = axes(angle);
  // 動かさない点（反対側の角。辺のつまみは反対側の辺の中点）
  const anchorX = box.cx - (hx * box.width * u[0] + hy * box.height * v[0]) / 2;
  const anchorY = box.cy - (hx * box.width * u[1] + hy * box.height * v[1]) / 2;
  const place = (width: number, height: number): CropBox => ({
    cx: anchorX + (hx * width * u[0] + hy * height * v[0]) / 2,
    cy: anchorY + (hx * width * u[1] + hy * height * v[1]) / 2,
    width,
    height,
  });
  /** `from` から `to` の大きさへ、角が枠から出ない所まで進める。 */
  const step = (from: Vec, to: Vec): Vec => {
    const start = cropBoxCorners(place(from[0], from[1]), angle);
    const end = cropBoxCorners(place(to[0], to[1]), angle);
    let t = 1;
    for (let index = 0; index < start.length; index += 1) {
      for (const axis of [0, 1] as const) {
        const limit = axis === 0 ? frame.width : frame.height;
        const a = start[index][axis];
        const b = end[index][axis];
        if (b > limit && b > a) t = Math.min(t, (limit - a) / (b - a));
        else if (b < 0 && b < a) t = Math.min(t, a / (a - b));
      }
    }
    t = clamp(t, 0, 1);
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  };

  const min = minCropBoxSize(frame);
  const ratio = validRatio(aspectRatio);
  let targetWidth = box.width + hx * dx;
  let targetHeight = box.height + hy * dy;
  if (ratio !== null) {
    if (hx !== 0 && hy !== 0) {
      const t = (targetWidth * ratio + targetHeight) / (ratio * ratio + 1);
      targetWidth = ratio * t;
      targetHeight = t;
    } else if (hx !== 0) {
      targetHeight = targetWidth / ratio;
    } else {
      targetWidth = targetHeight * ratio;
    }
    if (!(Math.min(targetWidth, targetHeight) >= min)) {
      targetWidth = ratio >= 1 ? min * ratio : min;
      targetHeight = ratio >= 1 ? min : min / ratio;
    }
    const [width, height] = step([box.width, box.height], [targetWidth, targetHeight]);
    return place(width, height);
  }
  if (hx !== 0) targetWidth = Math.max(min, targetWidth);
  if (hy !== 0) targetHeight = Math.max(min, targetHeight);
  const widened = step([box.width, box.height], [targetWidth, box.height]);
  const [width, height] = step(widened, [widened[0], targetHeight]);
  return place(width, height);
}

/** `aspect` の比率を「幅 : 高さ」の組で（`free`・読めない値は null。無いのは `original`）。 */
function aspectBase(aspect: string | undefined, frame: DevelopSize): Vec | null {
  if (aspect === undefined || aspect === "original") return [frame.width, frame.height];
  if (aspect === "originalSwapped") return [frame.height, frame.width];
  const fixed = FIXED_ASPECT_PATTERN.exec(aspect);
  return fixed ? [Number(fixed[1]), Number(fixed[2])] : null;
}

/**
 * `aspect` の比率（幅 ÷ 高さ）。`free`（と読めない値）は null。`original`（と無い）は枠の比率、`originalSwapped` はその逆数、
 * `<w>:<h>` は w ÷ h。
 */
export function developAspectRatio(aspect: string | undefined, frame: DevelopSize): number | null {
  const base = aspectBase(aspect, frame);
  return base ? base[0] / base[1] : null;
}

/** 縦横の入れ替え（`original` ⇄ `originalSwapped`、`4:5` ⇄ `5:4`。`1:1`・`free`・読めない値はそのまま）。 */
export function swapDevelopAspect(aspect: string): string {
  if (aspect === "original") return "originalSwapped";
  if (aspect === "originalSwapped") return "original";
  const fixed = FIXED_ASPECT_PATTERN.exec(aspect);
  return fixed ? `${fixed[2]}:${fixed[1]}` : aspect;
}

function sameRatio(width: number, height: number, base: Vec): boolean {
  return Math.abs(width * base[1] - height * base[0]) <= RATIO_TOLERANCE * height * base[0];
}

/**
 * 箱が「その角度で、自分の比率で枠の中心に内接する最大の箱」か（＝まだ自分で枠を動かしていない。保存の丸めの分の許容つき）。
 */
export function isMaxCropBox(box: CropBox, angle: number, frame: DevelopSize): boolean {
  if (!(box.width > 0 && box.height > 0)) return false;
  const max = maxCropBoxOf(frame, angle, box.width, box.height);
  const tolerance = Math.max(frame.width, frame.height) * MAX_BOX_TOLERANCE;
  return (
    Math.abs(box.cx - max.cx) <= tolerance &&
    Math.abs(box.cy - max.cy) <= tolerance &&
    Math.abs(box.width - max.width) <= tolerance &&
    Math.abs(box.height - max.height) <= tolerance
  );
}

/**
 * 角度補正を変える（−45〜45 に収める）。切り抜きが「その角度で内接する最大の箱」だったとき（まだ自分で枠を動かしていない）は、
 * 新しい角度の最大の箱にする（比率は `aspect` か枠の比率と同じならその比率、ほかは箱の比率。角度を 0 に戻すと枠全体に戻る）。
 * そうでなければ中心と大きさを保って {@link fitCropBox}（枠から出る分だけ縮める）。`frame` は {@link developFrameSize}。
 */
export function setGeometryAngle(geometry: DevelopGeometry, angle: number, frame: DevelopSize): DevelopGeometry {
  const nextAngle = clampAngle(angle);
  const raw = cropBoxFromGeometry(geometry, frame);
  // 描かれている箱（角が枠から出ている保存値は、crate と同じく収めたもの）
  const box = raw ? fitCropBox(raw, geometry.angle, frame) : null;
  let nextBox: CropBox;
  if (!box) {
    nextBox = maxCropBox(frame, nextAngle, developAspectRatio(geometry.aspect, frame));
  } else if (isMaxCropBox(box, geometry.angle, frame)) {
    // 保存の丸めで比率が揺れないよう、`aspect` か枠の比率と同じならその値で作る
    const frameBase: Vec = [frame.width, frame.height];
    const candidates: (Vec | null)[] = [aspectBase(geometry.aspect, frame), frameBase];
    const base = candidates.find((candidate) => candidate !== null && sameRatio(box.width, box.height, candidate)) ?? null;
    nextBox = maxCropBoxOf(frame, nextAngle, base ? base[0] : box.width, base ? base[1] : box.height);
  } else {
    nextBox = fitCropBox(box, nextAngle, frame);
  }
  return { ...geometry, angle: nextAngle, crop: cropFromBox(nextBox, nextAngle, frame) };
}

/**
 * 縦横比を選ぶ。`aspect` を書き、その比率で枠の中心に内接する最大の箱にする（`free` は箱を変えない。書けない値は何もしない）。
 */
export function setGeometryAspect(geometry: DevelopGeometry, aspect: string, frame: DevelopSize): DevelopGeometry {
  if (!isDevelopAspect(aspect)) return geometry;
  const base = aspectBase(aspect, frame);
  if (!base) return { ...geometry, aspect };
  const box = maxCropBoxOf(frame, geometry.angle, base[0], base[1]);
  return { ...geometry, aspect, crop: cropFromBox(box, geometry.angle, frame) };
}

/**
 * 表示される結果を時計回りに 90° 回す（反転があっても）。`rotate` を 90 進めて `flipH` と `flipV` を入れ替え（回した後に鏡映する
 * 順なので、先に回すと左右と上下の鏡映が入れ替わる）、切り抜きの箱も枠と一緒に回す（幅と高さが入れ替わる。角度はそのまま）。
 * `aspect` は `<w>:<h>` の縦横を入れ替える（`original` / `originalSwapped` は枠の比率に対する値で、枠ごと回るのでそのまま）。
 * 遠近も結果がいっしょに回るように写す（垂直と水平・X と Y が入れ替わり、縦横比の符号が反転する。`transformDevelopPerspective`）。
 * `source` は作業画像（向き反映済み・幾何を当てる前）の大きさ。
 */
export function rotateGeometryClockwise(geometry: DevelopGeometry, source: DevelopSize): DevelopGeometry {
  const frame = developFrameSize(source, geometry.rotate);
  const box = rawCropBox(geometry.crop, geometry.angle, frame);
  const rotate = ((geometry.rotate + 90) % 360) as DevelopGeometryRotate;
  // 枠の点 (x, y) は回した枠の (H − y, x) へ移る
  const turned: CropBox = { cx: frame.height - box.cy, cy: box.cx, width: box.height, height: box.width };
  const next: DevelopGeometry = {
    ...geometry,
    rotate,
    flipH: geometry.flipV,
    flipV: geometry.flipH,
    crop: cropFromBox(turned, geometry.angle, { width: frame.height, height: frame.width }),
  };
  if (geometry.aspect !== undefined && FIXED_ASPECT_PATTERN.test(geometry.aspect)) {
    next.aspect = swapDevelopAspect(geometry.aspect);
  }
  if (geometry.perspective) next.perspective = transformDevelopPerspective(geometry.perspective, "clockwise");
  return next;
}

/**
 * 表示される結果を反時計回りに 90° 回す（{@link rotateGeometryClockwise} を 3 回と同じ）。枠の点 (x, y) は回した枠の (y, W − x)
 * へ移る。`rotate`・反転・`aspect`・遠近の扱いは時計回りと同じ。
 */
export function rotateGeometryCounterClockwise(geometry: DevelopGeometry, source: DevelopSize): DevelopGeometry {
  const frame = developFrameSize(source, geometry.rotate);
  const box = rawCropBox(geometry.crop, geometry.angle, frame);
  const rotate = ((geometry.rotate + 270) % 360) as DevelopGeometryRotate;
  const turned: CropBox = { cx: box.cy, cy: frame.width - box.cx, width: box.height, height: box.width };
  const next: DevelopGeometry = {
    ...geometry,
    rotate,
    flipH: geometry.flipV,
    flipV: geometry.flipH,
    crop: cropFromBox(turned, geometry.angle, { width: frame.height, height: frame.width }),
  };
  if (geometry.aspect !== undefined && FIXED_ASPECT_PATTERN.test(geometry.aspect)) {
    next.aspect = swapDevelopAspect(geometry.aspect);
  }
  if (geometry.perspective) next.perspective = transformDevelopPerspective(geometry.perspective, "counterClockwise");
  return next;
}

/**
 * 表示される結果を上下に鏡映する（{@link rotateGeometryClockwise} を 2 回してから {@link flipGeometryHorizontal} と同じ結果）。
 * `flipV` を切り替え、切り抜きの箱も枠の上で上下に鏡映し、角度の符号を反転する（`rotate` は変えない）。遠近は垂直・回転・
 * Y オフセットの符号を反転する。
 */
export function flipGeometryVertical(geometry: DevelopGeometry, source: DevelopSize): DevelopGeometry {
  const frame = developFrameSize(source, geometry.rotate);
  const box = rawCropBox(geometry.crop, geometry.angle, frame);
  const angle = -geometry.angle + 0;
  return {
    ...geometry,
    flipV: !geometry.flipV,
    angle,
    crop: cropFromBox({ ...box, cy: frame.height - box.cy }, angle, frame),
    ...(geometry.perspective ? { perspective: transformDevelopPerspective(geometry.perspective, "flipVertical") } : {}),
  };
}

/**
 * 表示される結果を左右に鏡映する。`flipH` を切り替え、切り抜きの箱も枠の上で鏡映し、角度の符号を反転する。遠近は水平・回転・
 * X オフセットの符号を反転する。`source` は作業画像の大きさ。
 */
export function flipGeometryHorizontal(geometry: DevelopGeometry, source: DevelopSize): DevelopGeometry {
  const frame = developFrameSize(source, geometry.rotate);
  const box = rawCropBox(geometry.crop, geometry.angle, frame);
  const angle = -geometry.angle + 0;
  return {
    ...geometry,
    flipH: !geometry.flipH,
    angle,
    crop: cropFromBox({ ...box, cx: frame.width - box.cx }, angle, frame),
    ...(geometry.perspective ? { perspective: transformDevelopPerspective(geometry.perspective, "flipHorizontal") } : {}),
  };
}

/**
 * 出力の位置 `(px, py)`（切り抜いた結果の左上が 0,0・右下が 1,1）が、作業画像（向き反映済み・幾何を当てる前）のどこ
 * `(sx, sy)`（0〜1）に当たるか。crate の描き方どおり: 切り抜き枠の上の位置（角が枠から出る角度つきの切り抜きは中心の回りに縮めて
 * 収める。「余白を埋める」は補正した写真の中に収める）→ 遠近を戻す → 反転を戻す → 回転を戻す。長方形にならない・角度つきで中心が
 * 枠の外の切り抜き（crate の `invalidCrop`）・消失線の向こうの点は null。
 */
export function geometryOutputToSource(
  geometry: DevelopGeometry,
  source: DevelopSize,
  px: number,
  py: number,
): [number, number] | null {
  const frame = developFrameSize(source, geometry.rotate);
  let box = cropBoxFromGeometry(geometry, frame);
  if (!box) return null;
  if (geometry.angle !== 0) {
    if (!(box.cx > 0 && box.cx < frame.width && box.cy > 0 && box.cy < frame.height)) return null;
    const scale = inscribedScale(box, geometry.angle, frame);
    if (scale < 1) box = { ...box, width: box.width * scale, height: box.height * scale };
  }
  box = constrainedCropBox(geometry, box, frame);
  const { u, v } = axes(geometry.angle);
  const a = (px - 0.5) * box.width;
  const b = (py - 0.5) * box.height;
  let x = box.cx + a * u[0] + b * v[0];
  let y = box.cy + a * u[1] + b * v[1];
  const warp = developPerspectiveWarp(geometry.perspective, frame);
  if (warp) {
    const point = perspectiveToFrame(warp, [x, y]);
    if (!point) return null;
    [x, y] = point;
  }
  if (geometry.flipH) x = frame.width - x;
  if (geometry.flipV) y = frame.height - y;
  let sx: number;
  let sy: number;
  switch (geometry.rotate) {
    case 90:
      [sx, sy] = [y, source.height - x];
      break;
    case 180:
      [sx, sy] = [source.width - x, source.height - y];
      break;
    case 270:
      [sx, sy] = [source.width - y, x];
      break;
    default:
      [sx, sy] = [x, y];
  }
  return [sx / source.width, sy / source.height];
}

/**
 * {@link geometryOutputToSource} の逆: 作業画像の位置 `(sx, sy)`（0〜1）が出力（切り抜いた結果。左上 0,0・右下 1,1）のどこに見えるか。
 * 作業画像へ回転・反転を当てる → 遠近で補正後の枠へ写す → 「余白を埋める」を反映した切り抜き枠の自分の軸へ射影する（角が枠から
 * 出る角度つきの切り抜きは、描き方と同じく中心の回りに縮めた枠で）。出力の外の点もそのまま返す（0〜1 の外）。順方向が null を返す
 * 切り抜き（長方形にならない・角度つきで中心が枠の外）や消失線の向こうの点は null。部分補正（マスク）の画面のつまみを、写真の上の
 * 見えている位置に置くために使う。
 */
export function geometrySourceToOutput(
  geometry: DevelopGeometry,
  source: DevelopSize,
  sx: number,
  sy: number,
): [number, number] | null {
  const frame = developFrameSize(source, geometry.rotate);
  let box = cropBoxFromGeometry(geometry, frame);
  if (!box) return null;
  if (geometry.angle !== 0) {
    if (!(box.cx > 0 && box.cx < frame.width && box.cy > 0 && box.cy < frame.height)) return null;
    const scale = inscribedScale(box, geometry.angle, frame);
    if (scale < 1) box = { ...box, width: box.width * scale, height: box.height * scale };
  }
  box = constrainedCropBox(geometry, box, frame);
  const px = sx * source.width;
  const py = sy * source.height;
  let x: number;
  let y: number;
  switch (geometry.rotate) {
    case 90:
      [x, y] = [source.height - py, px];
      break;
    case 180:
      [x, y] = [source.width - px, source.height - py];
      break;
    case 270:
      [x, y] = [py, source.width - px];
      break;
    default:
      [x, y] = [px, py];
  }
  if (geometry.flipH) x = frame.width - x;
  if (geometry.flipV) y = frame.height - y;
  const warp = developPerspectiveWarp(geometry.perspective, frame);
  if (warp) {
    const point = perspectiveToCanvas(warp, [x, y]);
    if (!point) return null;
    [x, y] = point;
  }
  // u・v は正規直交なので、枠の中心からのずれを軸へ射影すれば切り抜きの自分の座標になる
  const { u, v } = axes(geometry.angle);
  const dx = x - box.cx;
  const dy = y - box.cy;
  return [(dx * u[0] + dy * u[1]) / box.width + 0.5, (dx * v[0] + dy * v[1]) / box.height + 0.5];
}
