/**
 * Pairing, credential rotation and revocation (B03 #244). The connector creates its poll secret and device credential
 * and registers only their SHA-256, so no bearer ever travels from NIHO and every lost response can be replayed.
 * Every secret is written to the vault before the request that depends on it is sent.
 */
import type { HostConnectorClient } from "../../photo-library-sharing-contract/src/v1.ts";
import { randomSecret, sha256Text } from "./crypto.ts";
import type { ConnectorTransport, CredentialVault, VaultContents } from "./ports.ts";

export type ConnectorErrorCode = "not_paired" | "revoked" | "pairing_expired";
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  constructor(code: ConnectorErrorCode) {
    super(`photo-hosted-connector: ${code}`);
    this.name = "ConnectorError";
    this.code = code;
  }
}

const codeOf = (error: unknown): string | null => {
  const code = error !== null && typeof error === "object" ? (error as { readonly code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
};
export const isUnauthenticated = (error: unknown): boolean => codeOf(error) === "unauthenticated";

const EMPTY: VaultContents = { installSalt: null, credential: null, pairing: null, rotation: null };

export interface CredentialManager {
  /** Install salt for localKeys; created once and kept across index loss. */
  installSalt(): Promise<string>;
  /** Starts (or resumes) a pairing; returns the short code to show on the Mac. */
  startPairing(displayName: string, signal: AbortSignal): Promise<{ readonly userCode: string; readonly expiresAt: string }>;
  pollPairing(signal: AbortSignal): Promise<
    | { readonly state: "pending"; readonly userCode: string; readonly expiresAt: string }
    | { readonly state: "approved"; readonly connectorId: string; readonly libraryId: string }
    | { readonly state: "expired" }
  >;
  /** Client authenticated by the current credential. Throws not_paired. */
  client(): Promise<Pick<HostConnectorClient, "request">>;
  paired(): Promise<{ readonly connectorId: string; readonly libraryId: string; readonly generation: number } | null>;
  /** Registers a new credential and fences the previous one. `probe` must be a harmless authenticated call. */
  rotate(probe: (client: Pick<HostConnectorClient, "request">) => Promise<unknown>, signal: AbortSignal): Promise<number>;
  /**
   * Call when the current credential was refused. Finishes a rotation whose response was lost; otherwise the device
   * was revoked: the credential is wiped and `revoked` is thrown. Originals and the local index are untouched.
   */
  onUnauthenticated(probe: (client: Pick<HostConnectorClient, "request">) => Promise<unknown>, signal: AbortSignal): Promise<void>;
  /** Local disconnect: wipes the credential and any pairing/rotation; keeps the install salt. */
  forget(): Promise<void>;
}

export function createCredentialManager(options: {
  readonly vault: CredentialVault;
  readonly transport: ConnectorTransport;
  readonly newKey?: () => string;
}): CredentialManager {
  const { vault, transport } = options;
  const newKey = options.newKey ?? (() => `connector-${randomSecret()}`);
  const read = async (): Promise<VaultContents> => ({ ...EMPTY, ...(await vault.read()) });
  /**
   * Every credential operation runs one at a time, in call order. A disconnect queued behind an in-flight rotation
   * runs after it and wins; nothing written before it can resurrect the credential.
   */
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  };

  /** Adopts the next credential only if the vault still holds the same credential and rotation. */
  const adoptNext = async (snapshot: VaultContents, generation: number): Promise<void> => {
    const current = await read();
    if (!snapshot.credential || !snapshot.rotation || !current.credential || !current.rotation) return;
    if (current.credential.secret !== snapshot.credential.secret || current.rotation.key !== snapshot.rotation.key) return;
    await vault.write({ ...current, credential: { ...current.credential, secret: current.rotation.nextSecret, generation }, rotation: null });
  };

  const replayRotation = async (signal: AbortSignal): Promise<number> => {
    const current = await read();
    if (!current.credential || !current.rotation) throw new ConnectorError("not_paired");
    const receipt = await transport(current.credential.secret).request(
      "connector.rotateCredential",
      { nextCredentialSha256: await sha256Text(current.rotation.nextSecret) },
      { signal, idempotencyKey: current.rotation.key },
    );
    await adoptNext(current, receipt.value.credentialGeneration);
    return receipt.value.credentialGeneration;
  };

  /** A rotation whose response was lost: if the next credential already works, adopt it; else replay the rotation. */
  const recoverRotation = async (probe: (client: Pick<HostConnectorClient, "request">) => Promise<unknown>, signal: AbortSignal): Promise<boolean> => {
    const current = await read();
    if (!current.credential || !current.rotation) return false;
    try {
      await probe(transport(current.rotation.nextSecret));
      await adoptNext(current, current.credential.generation + 1);
      return true;
    } catch (error) {
      if (!isUnauthenticated(error)) throw error;
    }
    try {
      await replayRotation(signal);
      return true;
    } catch (error) {
      if (isUnauthenticated(error)) return false;
      throw error;
    }
  };

  const onUnauthenticated = async (probe: (client: Pick<HostConnectorClient, "request">) => Promise<unknown>, signal: AbortSignal): Promise<void> => {
    const current = await read();
    if (current.rotation && (await recoverRotation(probe, signal))) return;
    await vault.write({ ...current, credential: null, rotation: null, pairing: null });
    throw new ConnectorError("revoked");
  };

  const startPairing = async (displayName: string, signal: AbortSignal) => {
      let current = await read();
      if (current.credential) throw new ConnectorError("revoked");
      if (!current.pairing || current.pairing.displayName !== displayName) {
        current = {
          ...current,
          pairing: { key: newKey(), pollSecret: randomSecret(), credentialSecret: randomSecret(), displayName, pairingId: null, userCode: null, expiresAt: null },
        };
        await vault.write(current);
      }
      const pairing = current.pairing as NonNullable<VaultContents["pairing"]>;
      const receipt = await transport(null).request(
        "connector.startPairing",
        {
          platform: "macos",
          displayName,
          pollSecretSha256: await sha256Text(pairing.pollSecret),
          credentialSha256: await sha256Text(pairing.credentialSecret),
        },
        { signal, idempotencyKey: pairing.key },
      );
      const started = receipt.value;
      await vault.write({ ...current, pairing: { ...pairing, pairingId: started.pairingId, userCode: started.userCode, expiresAt: started.expiresAt } });
      return { userCode: started.userCode, expiresAt: started.expiresAt };
  };
  const pollPairing = async (signal: AbortSignal): Promise<Awaited<ReturnType<CredentialManager["pollPairing"]>>> => {
      const current = await read();
      const pairing = current.pairing;
      if (!pairing?.pairingId || !pairing.userCode || !pairing.expiresAt) throw new ConnectorError("not_paired");
      try {
        const answer = await transport(null).request("connector.pollPairing", { pairingId: pairing.pairingId, pollSecret: pairing.pollSecret }, { signal });
        if (answer.state === "pending") return { state: "pending", userCode: pairing.userCode, expiresAt: pairing.expiresAt };
        await vault.write({
          ...current,
          pairing: null,
          credential: {
            secret: pairing.credentialSecret,
            generation: answer.credentialGeneration,
            connectorId: answer.connector.id,
            libraryId: answer.connector.libraryId,
          },
        });
        return { state: "approved", connectorId: answer.connector.id, libraryId: answer.connector.libraryId };
      } catch (error) {
        if (codeOf(error) !== "pairing_unavailable") throw error;
        await vault.write({ ...current, pairing: null });
        return { state: "expired" };
      }
  };
  const rotate = async (probe: (client: Pick<HostConnectorClient, "request">) => Promise<unknown>, signal: AbortSignal): Promise<number> => {
      let current = await read();
      if (!current.credential) throw new ConnectorError("not_paired");
      if (current.rotation) {
        if (await recoverRotation(probe, signal)) return (await read()).credential?.generation ?? 0;
        current = await read();
      }
      current = { ...current, rotation: { key: newKey(), nextSecret: randomSecret() } };
      await vault.write(current);
      try {
        return await replayRotation(signal);
      } catch (error) {
        if (!isUnauthenticated(error)) throw error;
        await onUnauthenticated(probe, signal);
        return (await read()).credential?.generation ?? 0;
      }
  };

  return {
    installSalt: () => exclusive(async () => {
      const current = await read();
      if (current.installSalt) return current.installSalt;
      const installSalt = randomSecret();
      await vault.write({ ...current, installSalt });
      return installSalt;
    }),
    startPairing: (displayName, signal) => exclusive(() => startPairing(displayName, signal)),
    pollPairing: (signal) => exclusive(() => pollPairing(signal)),
    rotate: (probe, signal) => exclusive(() => rotate(probe, signal)),
    onUnauthenticated: (probe, signal) => exclusive(() => onUnauthenticated(probe, signal)),
    forget: () => exclusive(async () => {
      const current = await read();
      await vault.write({ ...current, credential: null, rotation: null, pairing: null });
    }),
    async client() {
      const current = await read();
      if (!current.credential) throw new ConnectorError("not_paired");
      return transport(current.credential.secret);
    },
    async paired() {
      const current = await read();
      return current.credential
        ? { connectorId: current.credential.connectorId, libraryId: current.credential.libraryId, generation: current.credential.generation }
        : null;
    },
  };
}
