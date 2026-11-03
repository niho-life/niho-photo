import { PersonalPhotoCloudError } from "./errors";

export type MemoryLease = {
  resize(bytes: number): void;
  release(): void;
};

/**
 * Adapterが同時に所有するmaterialization用メモリの保守的な予約。
 * 出力Blob/File/ArrayBufferをcallerへ返した後のブラウザ全体RSSは対象外で、実機測定の代用ではない。
 */
export class MaterializationBudget {
  private usedBytes = 0;

  constructor(readonly limitBytes: number) {}

  reserve(bytes: number): MemoryLease {
    if (!safeBytes(bytes) || bytes > this.limitBytes - this.usedBytes) {
      throw new PersonalPhotoCloudError("too_large");
    }
    this.usedBytes += bytes;
    let heldBytes = bytes;
    return {
      resize: (nextBytes) => {
        if (!safeBytes(nextBytes)) throw new PersonalPhotoCloudError("too_large");
        const delta = nextBytes - heldBytes;
        if (delta > this.limitBytes - this.usedBytes) throw new PersonalPhotoCloudError("too_large");
        this.usedBytes += delta;
        heldBytes = nextBytes;
      },
      release: () => {
        if (heldBytes === 0) return;
        this.usedBytes -= heldBytes;
        heldBytes = 0;
      },
    };
  }
}

export function conservativeBytes(sizeBytes: number, copies: 2 | 3): number {
  const result = sizeBytes * copies;
  if (!safeBytes(result)) throw new PersonalPhotoCloudError("too_large");
  return result;
}

function safeBytes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
